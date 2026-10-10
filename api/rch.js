'use strict';

/**
 * Adapter provider reaction (bagian "kirim react" dari reactch.js lama).
 * Bukan endpoint publik: export default hanya mengembalikan 404 agar Vercel tidak mengekspos helper ini.
 *
 * Yang SENGAJA tidak dibawa dari reactch.js lama:
 *  - solveTurnstile() / getSitekey(): memakai layanan pihak ketiga untuk menyelesaikan Cloudflare
 *    Turnstile milik provider. Itu mengakali proteksi provider, jadi tidak diimplementasikan.
 *  - Header Origin/Referer yang menyamar sebagai situs provider dan User-Agent browser palsu.
 *  - API key bawaan yang tertulis di kode.
 */
const axios = require('axios');

const BASE = 'https://react.keyysspanel.web.id';
const TIMEOUT_MS = 25000;
const UA = 'xzeerh-reactchannel/1.0';
const VERIFICATION_RE = /turnstile|captcha|verifikasi|verification|verify/i;

/**
 * Hasil ternormalisasi, tanpa data mentah provider:
 *  state: 'success' | 'verification_required' | 'rejected' | 'unavailable' | 'timeout' | 'unexpected'
 *  delivered: true | false | null   (null = hasil tidak dapat dipastikan)
 */
function normalizeProviderResponse(status, data) {
  const is2xx = status >= 200 && status < 300;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { state: status >= 500 ? 'unavailable' : 'unexpected', delivered: null };
  }
  if (is2xx && data.success === true) return { state: 'success', delivered: true };

  const text = [data.message, data.error, data.msg]
    .filter((v) => typeof v === 'string')
    .join(' ');
  if (VERIFICATION_RE.test(text)) return { state: 'verification_required', delivered: false };

  if (data.success === false || data.status === false) return { state: 'rejected', delivered: false };
  if (status >= 500) return { state: 'unavailable', delivered: null };
  return { state: 'unexpected', delivered: null };
}

function normalizeNetworkError(err) {
  const code = err && err.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return { state: 'timeout', delivered: null };
  // Gagal sebelum request sampai ke provider: dipastikan belum terkirim.
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
    return { state: 'unavailable', delivered: false };
  }
  return { state: 'unavailable', delivered: null };
}

async function sendReact(link, emoji) {
  try {
    const res = await axios.post(
      BASE + '/api/react',
      { link, emoji },
      {
        timeout: TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: 100000,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true
      }
    );
    return normalizeProviderResponse(res.status, res.data);
  } catch (err) {
    return normalizeNetworkError(err);
  }
}

function notFound(req, res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end('{"ok":false,"message":"Not found"}');
}

module.exports = notFound;
module.exports.sendReact = sendReact;
module.exports.normalizeProviderResponse = normalizeProviderResponse;
module.exports.normalizeNetworkError = normalizeNetworkError;
