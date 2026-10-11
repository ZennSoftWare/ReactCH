'use strict';

/**
 * Adapter provider reaction (react.keyysspanel.web.id) + solver Turnstile (FGSI).
 * Dipakai oleh api/reactch.js lewat:  const { sendReact } = require('./rch')
 *
 * Kontrak:
 *   sendReact(link, emoji) -> Promise<{ state, delivered, raw?, error? }>
 *     state     : 'success' | 'verification_required' | 'rejected' | 'unavailable' | 'timeout' | 'unexpected'
 *     delivered : true (terkirim) | false (dipastikan belum terkirim) | null (tidak dapat dipastikan)
 *
 * Env:
 *   FGSI_KEY            -> API key FGSI utama      (mis. fgsiapi-c8e39dd-6d)
 *   FGSI_KEY_FALLBACK   -> API key FGSI cadangan   (mis. fgsiapi-3b641ef1-6d)
 *
 * CLI (opsional, tetap didukung):
 *   node api/rch.js "https://whatsapp.com/channel/ID/MSG" "☺,🤗,🔥"
 */

const axios = require('axios');

const BASE = 'https://react.keyysspanel.web.id';
const DEFAULT_SITEKEY = '0x4AAAAAAErNYkwC4FusFhKz';
const FGSI_ENDPOINT = 'https://fgsi.dpdns.org/api/tools/cfclearance/turnstile-min';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_SITEKEY = 20000;
const TIMEOUT_TURNSTILE = 120000;
const TIMEOUT_REACT = 60000;

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */

function collectKeys() {
  const keys = [];
  const a = (process.env.FGSI_KEY || '').trim();
  const b = (process.env.FGSI_KEY_FALLBACK || '').trim();
  if (a) keys.push(a);
  if (b) keys.push(b);
  return keys;
}

async function getSitekey() {
  try {
    const res = await axios.get(BASE + '/api/turnstile/status', {
      timeout: TIMEOUT_SITEKEY,
      headers: { 'User-Agent': UA },
      validateStatus: () => true,
    });
    const k = res.data && (res.data.siteKey || res.data.sitekey);
    return typeof k === 'string' && k ? k : DEFAULT_SITEKEY;
  } catch (_) {
    return DEFAULT_SITEKEY;
  }
}

async function solveTurnstile(sitekey, apiKey) {
  const res = await axios.get(FGSI_ENDPOINT, {
    timeout: TIMEOUT_TURNSTILE,
    params: { apikey: apiKey, url: BASE + '/', sitekey },
    headers: { accept: 'application/json' },
    validateStatus: () => true,
  });
  const d = res.data || {};
  const token =
    (d.data && (d.data.token || d.data.cf_turnstile_response)) ||
    d.token ||
    d.cf_turnstile_response ||
    null;
  if (!token) {
    const e = new Error('turnstile_failed');
    e.detail = JSON.stringify(d).slice(0, 300);
    e.httpStatus = res.status;
    throw e;
  }
  return token;
}

async function postReact(link, emoji, cfToken) {
  const res = await axios.post(
    BASE + '/api/react',
    { link, emoji, 'cf-turnstile-response': cfToken },
    {
      timeout: TIMEOUT_REACT,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Origin: BASE,
        Referer: BASE + '/',
      },
      validateStatus: () => true,
    }
  );
  return { httpStatus: res.status, data: res.data };
}

/** Normalisasi respons provider -> { state, delivered }. */
function classify(data, httpStatus) {
  const p = data || {};
  const msg = typeof p.message === 'string' ? p.message : '';
  const code = typeof p.code === 'string' ? p.code : '';

  const needsVerify =
    /verification|verifikasi|turnstile|captcha|challenge|verif/i.test(msg) ||
    /VERIFICATION|TURNSTILE|CAPTCHA/i.test(code);

  const ok =
    p.success === true ||
    p.status === true ||
    p.ok === true ||
    p.status === 'success' ||
    p.status === 'ok' ||
    (msg && /success|berhasil|sukses/i.test(msg) && p.success !== false && p.ok !== false);

  if (needsVerify) return { state: 'verification_required', delivered: false };
  if (ok) return { state: 'success', delivered: true };
  if (httpStatus >= 400 && httpStatus < 500) return { state: 'rejected', delivered: false };
  return { state: 'unexpected', delivered: null };
}

/* ------------------------------------------------------------------ */
/* API utama                                                           */
/* ------------------------------------------------------------------ */

async function sendReact(link, emoji) {
  const keys = collectKeys();
  if (!keys.length) {
    return {
      state: 'verification_required',
      delivered: false,
      error: 'FGSI_KEY / FGSI_KEY_FALLBACK belum diset di environment.',
    };
  }

  // 1) Ambil sitekey terbaru (fallback ke default jika endpoint gagal)
  const sitekey = await getSitekey();

  // 2) Coba solve Turnstile dengan key utama, lalu fallback
  let cfToken = null;
  let lastErr = null;
  for (const key of keys) {
    try {
      cfToken = await solveTurnstile(sitekey, key);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!cfToken) {
    return {
      state: 'verification_required',
      delivered: false,
      error: lastErr ? lastErr.message : 'turnstile_failed',
    };
  }

  // 3) Kirim reaction
  let out;
  try {
    out = await postReact(link, emoji, cfToken);
  } catch (e) {
    if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
      return { state: 'timeout', delivered: null };
    }
    return { state: 'unavailable', delivered: null };
  }

  // === DIAGNOSTIK SEMENTARA — hapus setelah masalah ketemu ===
  console.log('[rch] provider HTTP:', out.httpStatus);
  console.log('[rch] provider body:', JSON.stringify(out.data).slice(0, 500));
  // ===========================================================

  return classify(out.data, out.httpStatus);
}

module.exports = { sendReact };

/* ------------------------------------------------------------------ */
/* CLI opsional (agar pemakaian lama tidak hilang)                     */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  (async () => {
    const link = process.argv[2];
    const emoji = process.argv[3] || '❤️';
    if (!link) {
      console.log('node api/rch.js "https://whatsapp.com/channel/ID/MSG" "☺,🤗"');
      process.exit(1);
    }
    if (!/whatsapp\.com\/channel\/[^/]+\/\d+/.test(link)) {
      console.log(JSON.stringify({
        status: false,
        message: 'Link harus .../channel/CHANNEL_ID/MESSAGE_ID (ada nomor di belakang).',
      }));
      process.exit(1);
    }
    try {
      const out = await sendReact(link, emoji);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.state === 'success' ? 0 : 1);
    } catch (e) {
      console.log(JSON.stringify({ status: false, message: e.message }, null, 2));
      process.exit(1);
    }
  })();
}