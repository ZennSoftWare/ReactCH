'use strict';

/**
 * Adapter provider reaction (react.keyysspanel.web.id) + solver Turnstile (FGSI).
 *
 * Kontrak:
 *   sendReact(link, emoji) -> Promise<{ state, delivered }>
 *     state     : 'success' | 'verification_required' | 'rejected' | 'unavailable' | 'timeout' | 'unexpected'
 *     delivered : true | false | null
 *
 * Strategi: direct -> generic proxy -> ScraperAPI -> ScrapingBee (cascade).
 * Yang pertama mengembalikan JSON valid (bukan halaman Cloudflare) dipakai.
 *
 * Env:
 *   FGSI_KEY              (wajib)  API key FGSI utama
 *   FGSI_KEY_FALLBACK     (opsi)   API key FGSI cadangan
 *   PROXY_URL             (opsi)   http(s)://user:pass@host:port
 *   SCRAPERAPI_KEY        (opsi)   https://scraperapi.com
 *   SCRAPINGBEE_KEY       (opsi)   https://scrapingbee.com
 *
 * CLI:
 *   node api/rch.js "https://whatsapp.com/channel/ID/MSG" "☺,🤗,🔥"
 */

const axios = require('axios');

const BASE = 'https://react.keyysspanel.web.id';
const REACT_PATH = '/api/react';
const DEFAULT_SITEKEY = '0x4AAAAAAErNYkwC4FusFhKz';
const FGSI_ENDPOINT = 'https://fgsi.dpdns.org/api/tools/cfclearance/turnstile-min';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_SITEKEY = 20000;
const TIMEOUT_TURNSTILE = 120000;
const TIMEOUT_REACT = 60000;
const TIMEOUT_VIA_SERVICE = 120000;

const PROXY_URL = (process.env.PROXY_URL || '').trim();
const SCRAPERAPI_KEY = (process.env.SCRAPERAPI_KEY || '').trim();
const SCRAPINGBEE_KEY = (process.env.SCRAPINGBEE_KEY || '').trim();

/* ------------------------------------------------------------------ */
/* Helper dasar                                                        */
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
    throw e;
  }
  return token;
}

function isCfChallenge(data) {
  if (typeof data !== 'string') return false;
  return /Just a moment|cf-browser-verification|cf_chl_opt|challenge-platform|cf-chl|cf_challenge/i.test(data);
}

/** true jika respons harus dicoba ulang lewat service lain. */
function isRetryable(httpStatus, data) {
  if (isCfChallenge(data)) return true;
  if (typeof data === 'string' && (httpStatus === 403 || httpStatus === 503)) return true;
  return false;
}

function parseProxyUrl(raw) {
  const u = new URL(raw);
  return {
    protocol: u.protocol.replace(':', ''),
    host: u.hostname,
    port: parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10),
    auth: u.username
      ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Strategi kirim reaction                                             */
/* ------------------------------------------------------------------ */

const REACT_BODY = (link, emoji, cfToken) => ({
  link,
  emoji,
  'cf-turnstile-response': cfToken,
});

const REACT_HEADERS = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: BASE + '/',
};

/** 1) Direct dari IP serverless (bekerja di lokal, diblok CF di Vercel). */
async function postDirect(link, emoji, cfToken) {
  const res = await axios.post(BASE + REACT_PATH, REACT_BODY(link, emoji, cfToken), {
    timeout: TIMEOUT_REACT,
    headers: REACT_HEADERS,
    validateStatus: () => true,
  });
  return { httpStatus: res.status, data: res.data };
}

/** 2) Lewat HTTP/HTTPS proxy generik. */
async function postViaProxy(link, emoji, cfToken) {
  const res = await axios.post(BASE + REACT_PATH, REACT_BODY(link, emoji, cfToken), {
    timeout: TIMEOUT_REACT,
    headers: REACT_HEADERS,
    proxy: parseProxyUrl(PROXY_URL),
    validateStatus: () => true,
  });
  return { httpStatus: res.status, data: res.data };
}

/** 3) Lewat ScraperAPI (render=true -> Chromium menjalankan JS challenge). */
async function postViaScraperAPI(link, emoji, cfToken) {
  const res = await axios.post(
    'https://api.scraperapi.com/',
    REACT_BODY(link, emoji, cfToken),
    {
      timeout: TIMEOUT_VIA_SERVICE,
      params: {
        api_key: SCRAPERAPI_KEY,
        url: BASE + REACT_PATH,
        method: 'POST',
        render: 'true',
        country_code: 'id',
      },
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );
  return { httpStatus: res.status, data: res.data };
}

/** 4) Lewat ScrapingBee (render_js=true). */
async function postViaScrapingBee(link, emoji, cfToken) {
  const res = await axios.post(
    'https://app.scrapingbee.com/api/v1/',
    REACT_BODY(link, emoji, cfToken),
    {
      timeout: TIMEOUT_VIA_SERVICE,
      params: {
        api_key: SCRAPINGBEE_KEY,
        url: BASE + REACT_PATH,
        method: 'POST',
        render_js: 'true',
        country_code: 'id',
      },
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );
  return { httpStatus: res.status, data: res.data };
}

/* ------------------------------------------------------------------ */
/* Klasifikasi respons                                                 */
/* ------------------------------------------------------------------ */

function classify(data, httpStatus) {
  if (isCfChallenge(data)) {
    return { state: 'verification_required', delivered: false };
  }
  const p = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
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

  const sitekey = await getSitekey();

  let cfToken = null;
  let lastErr = null;
  for (const key of keys) {
    try { cfToken = await solveTurnstile(sitekey, key); break; }
    catch (e) { lastErr = e; }
  }
  if (!cfToken) {
    return {
      state: 'verification_required',
      delivered: false,
      error: lastErr ? lastErr.message : 'turnstile_failed',
    };
  }

  // Susun urutan strategi berdasarkan env yang tersedia.
  const attempts = [{ name: 'direct', fn: () => postDirect(link, emoji, cfToken) }];
  if (PROXY_URL) attempts.push({ name: 'proxy', fn: () => postViaProxy(link, emoji, cfToken) });
  if (SCRAPERAPI_KEY) attempts.push({ name: 'scraperapi', fn: () => postViaScraperAPI(link, emoji, cfToken) });
  if (SCRAPINGBEE_KEY) attempts.push({ name: 'scrapingbee', fn: () => postViaScrapingBee(link, emoji, cfToken) });

  let lastOut = null;

  for (const at of attempts) {
    try {
      const out = await at.fn();
      const cf = isCfChallenge(out.data);
      console.log('[rch] try', at.name, '->', out.httpStatus, cf ? '(CF_CHALLENGE)' : '');
      if (!isRetryable(out.httpStatus, out.data)) {
        return classify(out.data, out.httpStatus);
      }
      lastOut = out;
    } catch (e) {
      console.log('[rch] try', at.name, '-> ERROR', e.code || e.message);
      if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
        lastOut = { httpStatus: 0, data: null, timeout: true };
      } else {
        lastOut = { httpStatus: 0, data: null, error: e.message };
      }
    }
  }

  if (lastOut && lastOut.timeout) return { state: 'timeout', delivered: null };
  if (!lastOut) return { state: 'unavailable', delivered: null };
  return classify(lastOut.data, lastOut.httpStatus);
}

module.exports = { sendReact };

/* ------------------------------------------------------------------ */
/* CLI opsional                                                        */
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