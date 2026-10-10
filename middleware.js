/**
 * Routing Middleware (Vercel). Lapisan pengurang abuse, BUKAN pengganti validasi & rate limit di api/reactch.js.
 *  - Halaman utama: memasang cookie sesi bertanda tangan (tanpa CAPTCHA).
 *  - POST /api/reactch: tolak user-agent scraper yang jelas (403), cek cookie sesi, origin, dan content-type,
 *    serta pembatasan burst kasar per IP.
 * Cookie bisa didapat siapa pun yang membuka halaman, jadi ini hanya gesekan tambahan.
 * Env: SESSION_SECRET (disarankan; tanpa itu tanda tangan cookie tidak diverifikasi).
 */
export const config = { matcher: ['/', '/index.html', '/api/reactch'] };

const COOKIE = 'rch_s';
const TTL_SEC = 12 * 60 * 60;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_MAX = 12;
const hits = new Map();

// Hanya klien otomatis yang jelas; browser normal (termasuk Android) tidak termasuk.
const BAD_UA = /(curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|libwww-perl|scrapy|node-fetch|undici|axios\/|apache-httpclient|postmanruntime|insomnia|headlesschrome|phantomjs|selenium)/i;

function pass(extraHeaders) {
  const h = new Headers(extraHeaders || {});
  h.set('x-middleware-next', '1');
  return new Response(null, { headers: h });
}

function deny(status, code, message) {
  return new Response(JSON.stringify({ ok: false, code, message, data: { delivered: false } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function burstExceeded(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < BURST_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 2000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= BURST_WINDOW_MS) hits.delete(k);
  }
  return arr.length > BURST_MAX;
}

async function hmacHex(message) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeToken() {
  const ts = Math.floor(Date.now() / 1000).toString(36);
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  return ts + '.' + rnd + '.' + (await hmacHex(ts + '.' + rnd));
}

async function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(parts[0], 36);
  if (!Number.isFinite(age) || age < 0 || age > TTL_SEC) return false;
  if (!/^[0-9a-f]{24}$/.test(parts[1])) return false;
  if (!process.env.SESSION_SECRET) return true; // tanpa secret: hanya cek bentuk & umur
  const expected = await hmacHex(parts[0] + '.' + parts[1]);
  if (expected.length !== parts[2].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  return diff === 0;
}

function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}

export default async function middleware(request) {
  const url = new URL(request.url);

  if (url.pathname !== '/api/reactch') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return pass();
    if (await verifyToken(readCookie(request, COOKIE))) return pass();
    const token = await makeToken();
    return pass({ 'set-cookie': `${COOKIE}=${token}; Path=/; Max-Age=${TTL_SEC}; HttpOnly; Secure; SameSite=Strict` });
  }

  if (request.method !== 'POST') return pass(); // GET konfigurasi publik & penolakan metode ditangani handler

  const ua = request.headers.get('user-agent') || '';
  if (!ua || BAD_UA.test(ua)) return deny(403, 'FORBIDDEN_CLIENT', 'Permintaan ditolak.');

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return deny(403, 'FORBIDDEN_ORIGIN', 'Permintaan ditolak.');
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).host !== url.host) return deny(403, 'FORBIDDEN_ORIGIN', 'Permintaan ditolak.');

  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return deny(415, 'UNSUPPORTED_MEDIA_TYPE', 'Format permintaan tidak didukung.');
  }
  if (!(await verifyToken(readCookie(request, COOKIE)))) {
    return deny(403, 'SESSION_REQUIRED', 'Sesi tidak valid. Muat ulang halaman lalu coba lagi.');
  }

  const ip = request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (burstExceeded(ip)) return deny(429, 'RATE_LIMITED', 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.');

  return pass();
}
