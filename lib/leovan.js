'use strict';

/**
 * Mesin reaction "versi scrape" untuk provider www.leovan.my.id.
 *
 * Alur:
 *   1) GET  /          -> ambil cookie sesi (disimpan di memori + cache /tmp, TTL 15 menit).
 *   2) POST /api/react -> kirim reaction dengan nama pengirim acak otomatis.
 *
 * Kontrak hasil IDENTIK dengan engine lama, sehingga api/rch.js & api/reactch.js tidak berubah:
 *   sendReact(link, emoji) -> Promise<{ state, delivered }>
 *     state     : 'success' | 'verification_required' | 'rejected' | 'unavailable' | 'timeout' | 'unexpected'
 *     delivered : true | false | null   (null = tidak dapat dipastikan)
 *
 * Sukses hanya diumumkan bila provider benar-benar membalas sukses (tidak ada sukses palsu).
 * Retry otomatis (sesi dibuat ulang) hanya untuk penolakan yang DIPASTIKAN belum terkirim
 * (401/403/419 atau halaman challenge), tidak pernah untuk timeout/error jaringan, agar tidak
 * menggandakan kiriman.
 *
 * Env (semua opsional):
 *   LEOVAN_BASE_URL         default https://www.leovan.my.id
 *   REACT_TOTAL_BUDGET_MS   anggaran waktu total per permintaan (default 35000)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE_URL = (process.env.LEOVAN_BASE_URL || 'https://www.leovan.my.id').replace(/\/+$/, '');
const CACHE_FILE = path.join(os.tmpdir(), '.leovan_react_session.json');
const SESSION_TTL_MS = 15 * 60 * 1000;
const NAME_TIMEOUT_MS = 3000;
const SESSION_TIMEOUT_MS = 10000;
const DEFAULT_BUDGET_MS = 35000;

const CF_BODY_RE = /just a moment|__cf_chl_opt|cf_chl_prog|challenge-platform|cf-chl|cf_challenge|attention required/i;
const VERIFY_RE = /verification|verifikasi|turnstile|captcha|challenge|robot/i;
const FAIL_MSG_RE = /gagal|failed|failure|error|invalid|tidak valid|melebihi|limit|habis|ditolak|denied/i;
const OK_MSG_RE = /success|berhasil|sukses|terkirim|sent/i;

const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const FIRST_NAMES = [
  'Rizky', 'Dimas', 'Fajar', 'Bagas', 'Putra', 'Reza', 'Aldi', 'Ilham', 'Gilang', 'Kevin',
  'Nabila', 'Alya', 'Tiara', 'Siti', 'Putri', 'Anisa', 'Nadya', 'Citra', 'Dewi', 'Zahra'
];
const LAST_NAMES = [
  'Pratama', 'Saputra', 'Nugroho', 'Ramadhan', 'Hidayat', 'Wijaya', 'Santoso', 'Kusuma',
  'Maharani', 'Permata', 'Lestari', 'Pangestu', 'Setiawan', 'Firmansyah', 'Wardhani'
];

let silentVault = { cookie: '', autoName: '', updatedAt: 0 };

/* ------------------------------------------------------------------ */
/* Cache sesi (memori + /tmp)                                          */
/* ------------------------------------------------------------------ */

function loadSilentCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        // Memori instance yang lebih baru tidak ditimpa cache file yang lebih lama.
        if ((parsed.updatedAt || 0) >= (silentVault.updatedAt || 0)) silentVault = { ...silentVault, ...parsed };
      }
    }
  } catch (_) {}
}

function saveSilentCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(silentVault), 'utf-8');
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */

function createBudget(ms) {
  const end = Date.now() + Math.max(5000, ~~ms);
  return {
    left: () => Math.max(0, end - Date.now()),
    out: () => Date.now() >= end,
    cap: (base) => Math.max(1000, Math.min(base, end - Date.now()))
  };
}

/** fetch terikat waktu keras (AbortController). Melempar error bertanda `timedOut` bila batas terlewati. */
async function timedFetch(url, options, ms) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  if (timer.unref) timer.unref();
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } catch (e) {
    if (timedOut) {
      const err = new Error('batas waktu ' + ms + 'ms');
      err.timedOut = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (list.length > 0) return list;
  }
  const raw = headers.get('set-cookie') || '';
  return raw.split(/,(?=\s*[a-zA-Z0-9_-]+=)/).map((c) => c.trim()).filter(Boolean);
}

function cookieMap(str) {
  const map = new Map();
  String(str || '').split(/;\s*/).forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  });
  return map;
}

/** Gabungkan Set-Cookie baru ke cookie lama (per nama), bukan menimpa seluruhnya. */
function mergeCookies(current, headers) {
  const map = cookieMap(current);
  setCookieLines(headers).forEach((line) => {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!value || /;\s*max-age=0|expires=thu, 01 jan 1970/i.test(line)) map.delete(name);
    else map.set(name, value);
  });
  return Array.from(map, ([k, v]) => k + '=' + v).join('; ');
}

/* ------------------------------------------------------------------ */
/* Nama acak & sesi                                                    */
/* ------------------------------------------------------------------ */

async function getAutoRandomName(forceNew = true, budget) {
  loadSilentCache();
  if (!forceNew && silentVault.autoName) return silentVault.autoName;

  try {
    const ms = budget ? budget.cap(NAME_TIMEOUT_MS) : NAME_TIMEOUT_MS;
    const res = await timedFetch('https://randomuser.me/api/?inc=name&nat=us,gb,au', {}, ms);
    if (res.ok) {
      const data = await res.json();
      const user = data && data.results && data.results[0] && data.results[0].name;
      if (user && user.first && user.last) {
        silentVault.autoName = `${user.first} ${user.last}`;
        saveSilentCache();
        return silentVault.autoName;
      }
    }
  } catch (_) {}

  const fn = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const ln = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  silentVault.autoName = `${fn} ${ln}`;
  saveSilentCache();
  return silentVault.autoName;
}

async function ensureSilentSession(budget, force) {
  loadSilentCache();
  if (!force && silentVault.cookie && Date.now() - (silentVault.updatedAt || 0) < SESSION_TTL_MS) return;
  if (force) silentVault.cookie = '';

  try {
    const res = await timedFetch(`${BASE_URL}/`, {
      method: 'GET',
      headers: { ...BROWSER_HEADERS, Accept: 'text/html' }
    }, budget ? budget.cap(SESSION_TIMEOUT_MS) : SESSION_TIMEOUT_MS);
    silentVault.cookie = mergeCookies(silentVault.cookie, res.headers);
    silentVault.updatedAt = Date.now();
    saveSilentCache();
  } catch (_) {
    // Sesi bersifat best-effort: POST tetap dicoba tanpa cookie sesi.
  }
}

/* ------------------------------------------------------------------ */
/* Klasifikasi respons provider                                        */
/* ------------------------------------------------------------------ */

function parseMaybeJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.parse(t); } catch (_) { return null; }
}

function isCloudflare(status, headers, text) {
  const mit = String(headers.get('cf-mitigated') || '').toLowerCase();
  if (mit.indexOf('challenge') !== -1) return true;
  const server = String(headers.get('server') || '').toLowerCase();
  if ((status === 403 || status === 503 || status === 429) && server.indexOf('cloudflare') !== -1 && CF_BODY_RE.test(text)) return true;
  return CF_BODY_RE.test(text) && (status === 403 || status === 503);
}

/** Respons -> { state, delivered }. Tidak pernah menyatakan sukses tanpa sinyal sukses dari provider. */
function classify(status, headers, text) {
  if (isCloudflare(status, headers, text)) return { state: 'verification_required', delivered: false };

  const data = parseMaybeJson(text);
  const p = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const msg = p && typeof p.message === 'string' ? p.message : (p && typeof p.error === 'string' ? p.error : '');
  const code = p && typeof p.code === 'string' ? p.code : '';

  if (p && (VERIFY_RE.test(msg) || /VERIFICATION|TURNSTILE|CAPTCHA/i.test(code))) {
    return { state: 'verification_required', delivered: false };
  }

  const explicitOk =
    !!p && (p.success === true || p.status === true || p.ok === true || /^(success|ok)$/i.test(String(p.status)));
  const explicitFail =
    !!p && (p.success === false || p.ok === false || p.status === false || /^(error|fail|failed)$/i.test(String(p.status)));

  if (status >= 500) return { state: 'unavailable', delivered: null };
  if (explicitFail) return { state: 'rejected', delivered: false };

  const is2xx = status >= 200 && status < 300;
  if (is2xx) {
    if (explicitOk) return { state: 'success', delivered: true };
    if (p && msg && FAIL_MSG_RE.test(msg) && !OK_MSG_RE.test(msg)) return { state: 'rejected', delivered: false };
    if (p && msg && OK_MSG_RE.test(msg)) return { state: 'success', delivered: true };
    // JSON berisi tanpa penanda gagal -> dianggap diterima (perilaku scrape asli: HTTP 2xx = sukses).
    if (p && Object.keys(p).length > 0 && !p.error) return { state: 'success', delivered: true };
    return { state: 'unexpected', delivered: null };
  }

  if (status >= 400) return { state: 'rejected', delivered: false };
  return { state: 'unexpected', delivered: null };
}

/* ------------------------------------------------------------------ */
/* sendReact — kontrak sama seperti engine lama                        */
/* ------------------------------------------------------------------ */

async function postReact(link, emoji, budget) {
  const autoName = await getAutoRandomName(true, budget);
  const nameCookie = `name=${encodeURIComponent(autoName)}; user_name=${encodeURIComponent(autoName)}`;

  const headers = {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'X-User-Name': /^[\x20-\x7E]+$/.test(autoName) ? autoName : encodeURIComponent(autoName),
    'Cookie': silentVault.cookie ? `${silentVault.cookie}; ${nameCookie}` : nameCookie
  };

  const payload = {
    name: autoName,
    nama: autoName,
    username: autoName,
    url: link,
    link,
    emoji,
    emojis: emoji,
    react: emoji
  };

  const res = await timedFetch(`${BASE_URL}/api/react`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, budget.cap(budget.left()));

  const text = await res.text().catch(() => '');
  const merged = mergeCookies(silentVault.cookie, res.headers);
  if (merged !== silentVault.cookie) {
    silentVault.cookie = merged;
    saveSilentCache();
  }
  return { status: res.status, headers: res.headers, text, verdict: classify(res.status, res.headers, text) };
}

async function sendReact(link, emoji) {
  const linkStr = String(link || '').trim();
  const emojiStr = String(emoji || '').trim();
  if (!/^https:\/\/whatsapp\.com\/channel\/[^/\s]+\/\d+$/.test(linkStr)) {
    return { state: 'rejected', delivered: false, error: 'format link tidak valid' };
  }
  if (!emojiStr || !/[^\s,]/.test(emojiStr)) {
    return { state: 'rejected', delivered: false, error: 'emoji kosong' };
  }

  const budget = createBudget(parseInt(process.env.REACT_TOTAL_BUDGET_MS, 10) || DEFAULT_BUDGET_MS);
  const MAX_ATTEMPTS = 2;
  let last = { state: 'unavailable', delivered: null };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (budget.out()) { last = { state: 'timeout', delivered: null }; break; }
    try {
      await ensureSilentSession(budget, attempt > 0);
      const out = await postReact(linkStr, emojiStr, budget);
      last = out.verdict;

      // Ulangi hanya bila DIPASTIKAN belum terkirim dan penyebabnya sesi/challenge.
      const sessionProblem = last.state === 'verification_required' || out.status === 401 || out.status === 403 || out.status === 419;
      if (last.delivered === false && sessionProblem && attempt < MAX_ATTEMPTS - 1) {
        console.log('[leovan] sesi ditolak (' + out.status + '), membuat sesi baru');
        continue;
      }
      break;
    } catch (e) {
      const timedOut = !!(e && e.timedOut);
      console.log('[leovan] permintaan gagal:', timedOut ? 'timeout' : String((e && e.message) || e).slice(0, 120));
      last = { state: timedOut ? 'timeout' : 'unavailable', delivered: null };
      break; // hasil tidak pasti -> jangan kirim ulang
    }
  }

  const out = { state: last.state, delivered: last.delivered };
  if (last.error) out.error = String(last.error).slice(0, 200);
  return out;
}

module.exports = { sendReact, classify, _internals: { BASE_URL, mergeCookies, getAutoRandomName } };
