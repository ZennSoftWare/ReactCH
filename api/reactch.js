'use strict';

/**
 * Endpoint website:
 *   GET  /api/reactch  -> konfigurasi publik (URL channel untuk tombol Kunjungi)
 *   POST /api/reactch  -> { link, emoji } kirim reaction lewat adapter provider (api/rch.js)
 *
 * Bentuk respons selalu: { ok, message, code?, data? }
 * data.delivered: true (terkirim) | false (dipastikan belum terkirim) | null (tidak dapat dipastikan)
 * Tidak ada detail mentah provider, header, atau kredensial yang dikembalikan.
 */
const { createRateLimiter, getClientKey } = require('../utils/rateLimiter');
const V = require('../utils/validate');
const { sendReact } = require('./rch');

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const limiter = createRateLimiter({
  windowMs: intEnv('RATE_LIMIT_WINDOW_SEC', 600) * 1000,
  max: intEnv('RATE_LIMIT_MAX', 10)
});

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ERRORS = {
  METHOD_NOT_ALLOWED: [405, 'Metode tidak didukung.'],
  FORBIDDEN_ORIGIN: [403, 'Permintaan ditolak.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Format permintaan tidak didukung.'],
  BAD_REQUEST: [400, 'Permintaan tidak valid.'],
  INVALID_LINK: [400, 'Link tidak valid.'],
  INVALID_EMOJI: [400, 'Emoji tidak valid.'],
  RATE_LIMITED: [429, 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.'],
  PROVIDER_VERIFICATION_REQUIRED: [503, 'Layanan reaction meminta verifikasi yang belum tersedia di website ini. Hubungi admin.'],
  PROVIDER_REJECTED: [502, 'Layanan reaction menolak permintaan ini.'],
  PROVIDER_UNAVAILABLE: [502, 'Layanan reaction sedang tidak dapat dihubungi.'],
  PROVIDER_TIMEOUT: [504, 'Layanan reaction tidak merespons tepat waktu. Hasil pengiriman tidak dapat dipastikan.'],
  PROVIDER_UNEXPECTED: [502, 'Respons layanan reaction tidak dikenali. Hasil pengiriman tidak dapat dipastikan.'],
  INTERNAL: [500, 'Terjadi kesalahan pada server.']
};

const STATE_TO_CODE = {
  verification_required: 'PROVIDER_VERIFICATION_REQUIRED',
  rejected: 'PROVIDER_REJECTED',
  unavailable: 'PROVIDER_UNAVAILABLE',
  timeout: 'PROVIDER_TIMEOUT',
  unexpected: 'PROVIDER_UNEXPECTED'
};

function send(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (extraHeaders) Object.keys(extraHeaders).forEach((k) => res.setHeader(k, extraHeaders[k]));
  res.end(JSON.stringify(body));
}

function fail(res, code, delivered, message, extraHeaders) {
  const def = ERRORS[code] || ERRORS.INTERNAL;
  send(res, def[0], { ok: false, code, message: message || def[1], data: { delivered } }, extraHeaders);
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch (_) { return false; }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (host && o.host.toLowerCase() === host) return true;
  return ALLOWED_ORIGINS.indexOf(o.origin.toLowerCase()) !== -1;
}

function readBody(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (_) { return null; }
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

function publicConfig() {
  const check = V.validateChannelProfileUrl(process.env.WHATSAPP_CHANNEL_URL || '');
  return { channelUrl: check.ok ? check.url : null, maxEmoji: V.MAX_EMOJI };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return send(res, 200, { ok: true, message: 'OK', data: publicConfig() });
    }
    if (req.method !== 'POST') {
      return fail(res, 'METHOD_NOT_ALLOWED', false, null, { Allow: 'GET, POST' });
    }
    if (!isSameOrigin(req)) return fail(res, 'FORBIDDEN_ORIGIN', false);
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return fail(res, 'UNSUPPORTED_MEDIA_TYPE', false);
    }

    const rl = limiter.check(getClientKey(req));
    if (!rl.allowed) {
      return fail(res, 'RATE_LIMITED', false, null, { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) });
    }

    const body = readBody(req);
    if (!body || typeof body.link !== 'string' || typeof body.emoji !== 'string') {
      return fail(res, 'BAD_REQUEST', false);
    }
    const link = V.validateChannelUrl(body.link);
    if (!link.ok) return fail(res, 'INVALID_LINK', false, link.message);
    const emoji = V.parseEmojiList(body.emoji);
    if (!emoji.ok) return fail(res, 'INVALID_EMOJI', false, emoji.message);

    const result = await sendReact(link.url, emoji.tokens.join(','));

    if (result.state === 'success' && result.delivered === true) {
      return send(res, 200, {
        ok: true,
        message: 'Reaction berhasil dikirim.',
        data: { delivered: true, count: emoji.tokens.length }
      });
    }
    const code = STATE_TO_CODE[result.state] || 'PROVIDER_UNEXPECTED';
    return fail(res, code, result.delivered === false ? false : null);
  } catch (err) {
    console.error('[reactch] internal error:', err && err.name);
    return fail(res, 'INTERNAL', null);
  }
};
