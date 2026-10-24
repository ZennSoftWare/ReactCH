'use strict';

/**
 * Mesin reaction "versi scrape" untuk provider react.nexapanel.my.id.
 *
 * Cascade:
 *   1) HTTP via axios + pool proxy (cf_clearance dipertahankan per IP proxy).
 *   2) Browser stealth (playwright-core): menyelesaikan challenge Cloudflare,
 *      lalu reaksi dieksekusi DI DALAM halaman (atas tombol/endpoint panel),
 *      supaya cookie sesi & status widget Turnstile panel tetap valid.
 *
 * Kontrak hasil identik dengan adapter lama:
 *   { state, delivered } dengan state: success | verification_required | rejected |
 *   unavailable | timeout | unexpected; delivered: true | false | null.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { ProxyPool, parseProxyListEnv } = require('./proxyPool');

const BASE = (process.env.REACT_PROVIDER_BASE || 'https://react.nexapanel.my.id').replace(/\/+$/, '');
const ROOT_PATHS = ['/', '/index.php'];
const FALLBACK_ENDPOINTS = ['/api/react', '/api/reaction', '/api/send', '/api/kirim'];
const CF_BODY_RE = /just a moment|__cf_chl_opt|cf_chl_prog|challenge-platform|cf-chl|cf_challenge|attention required/i;
const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let engine = null;

function getEngine() {
  if (engine) return engine;
  engine = { pool: null, ready: null };
  engine.pool = new ProxyPool({
    slots: process.env.PROXY_SLOTS,
    maxUsesPerProxy: process.env.PROXY_MAX_USES,
    list: parseProxyListEnv(process.env.PROXY_LIST),
    sourceUrl: process.env.PROXY_SOURCE_URL || undefined,
    freeSource: (process.env.SCRAPER_FREE_PROXIES || '1') === '1',
    logger: console
  });
  engine.ready = engine.pool.init();
  return engine;
}

function cookieHeader(cookies) {
  return (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
}

function headersFromSlot(slot, extra) {
  const ua = (slot && slot.userAgent) || HTTP_UA;
  return Object.assign({
    'User-Agent': ua,
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8'
  }, slot && slot.clearance && slot.clearance.length ? { Cookie: cookieHeader(slot.clearance) } : {}, extra);
}

function looksLikeCf(req) {
  const o = req || {};
  const mit = String((o.headers && (o.headers['cf-mitigated'] || o.headers['CF-Mitigated'])) || '').toLowerCase();
  if (mit.indexOf('challenge') !== -1) return true;
  const server = String((o.headers && (o.headers.server || o.headers.Server)) || '').toLowerCase();
  const body = String(o.html == null ? o.data : o.html).toLowerCase();
  if (o.status === 403 || o.status === 503 || o.status === 429) {
    if (server.indexOf('cloudflare') !== -1) return true;
    if (CF_BODY_RE.test(body)) return true;
  }
  if (server.indexOf('cloudflare') !== -1 && CF_BODY_RE.test(body)) return true;
  return false;
}

/** Klasifikasi respons provider — semantik sama dengan adapter lama. */
function classify(data, httpStatus) {
  if (typeof data === 'string' && CF_BODY_RE.test(data)) {
    return { state: 'verification_required', delivered: false };
  }
  const p = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const msg = typeof p.message === 'string' ? p.message : '';
  const code = typeof p.code === 'string' ? p.code : '';
  const needsVerify =
    /verification|verifikasi|turnstile|captcha|challenge|verif/i.test(msg) ||
    /VERIFICATION|TURNSTILE|CAPTCHA/i.test(code);
  const ok =
    p.success === true || p.status === true || p.ok === true || p.status === 'success' || p.status === 'ok' ||
    (msg && /success|berhasil|sukses|terkirim/i.test(msg) && p.success !== false && p.ok !== false);
  if (needsVerify) return { state: 'verification_required', delivered: false };
  if (ok) return { state: 'success', delivered: true };
  if (httpStatus >= 400 && httpStatus < 500) return { state: 'rejected', delivered: false };
  return { state: 'unexpected', delivered: null };
}

function parseMaybeJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') {
    try { return JSON.parse(t); } catch (_) { return null; }
  }
  return null;
}

function createBudget(ms) {
  const end = Date.now() + Math.max(5000, ~~ms);
  return {
    left: () => Math.max(0, end - Date.now()),
    out: () => Date.now() >= end,
    timeout: (base) => Math.max(1500, Math.min(base, end - Date.now()))
  };
}

/** Axios terikat waktu keras: race + AbortController (mengatasi TCP connect hang via proxy mati). */
function boundedAxios(config, budget, baseMs, log) {
  const ctl = new AbortController();
  const ms = budget ? budget.timeout(baseMs) : baseMs;
  const timer = setTimeout(() => {
    try { ctl.abort(new Error('batas waktu ' + ms + 'ms')); } catch (_) { }
  }, ms);
  if (timer.unref) timer.unref();
  return axios.request(Object.assign({}, config, { signal: ctl.signal }))
    .catch((e) => {
      if (e && (e.name === 'AxiosError') && !e.response) throw e;
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

function bodyCandidates(link, emoji) {
  const list = emoji.split(',').map((s) => s.trim()).filter(Boolean);
  return [
    { link, emoji },
    { link, emoji: list }
  ];
}

/* ------------------------------------------------------------------ */
/* Tahap HTTP                                                          */
/* ------------------------------------------------------------------ */

async function discoverEndpoints(slot, rootHtml, log, budget) {
  const found = new Set(FALLBACK_ENDPOINTS);
  try {
    if (budget && budget.out()) return Array.from(found).slice(0, 24);
    const $ = cheerio.load(String(rootHtml || ''));
    const scripts = [];
    $('script[src]').each((i, el) => {
      const src = $(el).attr('src');
      if (src) scripts.push(src);
    });
    for (const src of scripts.slice(0, 3)) {
      if (budget && budget.out()) break;
      try {
        const url = /^https?:\/\//i.test(src) ? src : BASE + (src.startsWith('/') ? '' : '/') + src;
        const res = await boundedAxios({
          url,
          responseType: 'text',
          validateStatus: () => true,
          headers: headersFromSlot(slot),
          ...(slot ? slot.agents : { proxy: false })
        }, budget, 8000);
        if (res.status === 200 && typeof res.data === 'string' && res.data.length < 3 * 1024 * 1024) {
          const rx = /["'`]((?:\/api\/|api\/)[A-Za-z0-9_./-]{2,48})["'`]/g;
          let m;
          while ((m = rx.exec(res.data))) {
            found.add('/' + m[1].replace(/^\/+/, '').toLowerCase());
          }
        }
      } catch (_) { }
      if (found.size > 24) break;
    }
  } catch (_) { }
  log && log('[rch] endpoint kandidat:', found.size);
  return Array.from(found).slice(0, 24);
}

function absorbSetCookies(slot, headers) {
  try {
    const lines = [].concat(headers['set-cookie'] || [], headers['Set-Cookie'] || []);
    const parsed = lines.map((line) => {
      const first = String(line).split(';')[0];
      const eq = first.indexOf('=');
      return eq > 0 ? { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() } : null;
    }).filter((c) => c && /cf|__Host|_cf|csrf|session|sid/i.test(c.name));
    if (!parsed.length || !slot) return;
    const byName = new Map((slot.clearance || []).map((c) => [c.name, c]));
    parsed.forEach((c) => byName.set(c.name, c));
    slot.clearance = Array.from(byName.values());
  } catch (_) { }
}

async function httpCascade(ctx) {
  const { pool, log } = ctx;
  await pool.init();
  const getCap = ctx.httpGetCapMs || 14000;
  const postCap = ctx.httpPostCapMs || 10000;
  for (let i = 0; i < ctx.httpAttempts; i++) {
    if (ctx.budget && ctx.budget.out()) { log && log('[rch] anggaran waktu habis sebelum tahap http'); break; }
    const direct = ctx.directFirst && i === 0;
    const slot = direct ? null : pool.acquire();
    let root = null;
    try {
      root = await boundedAxios({
        url: BASE + ROOT_PATHS[i % ROOT_PATHS.length],
        method: 'GET', maxRedirects: 5, responseType: 'text',
        validateStatus: () => true,
        headers: headersFromSlot(slot, { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
        ...(slot ? slot.agents : { proxy: false })
      }, ctx.budget, getCap);
    } catch (e) {
      if (slot) pool.reportFailure(slot, e, { kind: e.code === 'ECONNABORTED' ? 'timeout' : 'network' });
      log && log('[rch] GET root gagal', direct ? '(direct)' : 'via ' + pool.mask(slot.config) + ',', (e && e.message) || e);
      continue;
    }
    root.headers = root.headers || {};
    if (slot) pool.reportUse(slot);
    if (slot) absorbSetCookies(slot, root.headers);
    if (looksLikeCf({ status: root.status, headers: root.headers, data: root.data })) {
      if (slot) pool.reportFailure(slot, new Error('cf ' + root.status), { kind: 'cf', status: root.status });
      log && log('[rch] CF challenge', direct ? 'terdeteksi langsung (direct)' : 'via ' + pool.mask(slot.config), '(' + root.status + ')');
      continue;
    }
    if (slot) pool.reportSuccess(slot);

    const endpoints = await discoverEndpoints(slot, root.data, log, ctx.budget).then((list) => list.slice(0, 6));
    let sawCf = false;
    let tried = 0;
    outer:
    for (const body of bodyCandidates(ctx.link, ctx.emoji)) {
      for (const ep of endpoints) {
        if (ctx.budget && ctx.budget.out()) break outer;
        tried++;
        if (tried > 10 && ctx.budget && ctx.budget.left() < 20000) break outer;
        let out = null;
        try {
          out = await boundedAxios({
            url: BASE + ep, method: 'POST', maxRedirects: 0, responseType: 'text',
            validateStatus: () => true, data: body,
            headers: headersFromSlot(slot, { 'Content-Type': 'application/json', Accept: 'application/json', Origin: BASE, Referer: BASE + '/' }),
            ...(slot ? slot.agents : { proxy: false })
          }, ctx.budget, postCap);
        } catch (e) {
          if (slot) pool.reportFailure(slot, e, { kind: e.code === 'ECONNABORTED' ? 'timeout' : 'network' });
          continue;
        }
        if (slot) pool.reportUse(slot);
        out.headers = out.headers || {};
        if (slot) absorbSetCookies(slot, out.headers);
        if (looksLikeCf({ status: out.status, headers: out.headers, data: out.data })) {
          sawCf = true;
          if (slot) pool.reportFailure(slot, new Error('cf ' + out.status), { kind: 'cf', status: out.status });
          continue;
        }
        const payload = parseMaybeJson(out.data);
        const verdict = classify(payload, out.status);
        if (verdict.state !== 'unexpected') {
          if (slot) pool.reportSuccess(slot);
          return Object.assign(verdict, { endpoint: ep, proxy: slot ? pool.mask(slot.config) : 'direct', httpStatus: out.status });
        }
      }
    }
    if (sawCf) return { state: 'verification_required', delivered: false, via: 'http-cf', proxy: slot ? pool.mask(slot.config) : 'direct' };
  }
  return { state: 'unavailable', delivered: null, via: 'http' };
}

/* ------------------------------------------------------------------ */
/* Tahap browser                                                       */
/* ------------------------------------------------------------------ */

const INIT_JS = () => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) { }
  try { if (!window.chrome) window.chrome = { runtime: {}, loadTimes: () => { }, csi: () => { }, app: { isInstalled: false } }; } catch (e) { }
  try {
    Object.defineProperty(navigator, 'plugins', { get: () => [{}, {}, {}, {}, {}] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'id'] });
  } catch (e) { }
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return gp.call(this, p);
    };
  } catch (e) { }
};

async function resolveExecutablePath() {
  const fs = require('fs');
  if (!process.env.VERCEL) {
    const systemPaths = [process.env.CHROMIUM_SYSTEM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].filter(Boolean);
    for (const p of systemPaths) {
      try { fs.accessSync(p, fs.constants.F_OK | fs.constants.X_OK); return { path: p, sparticuz: false }; } catch (_) { }
    }
  }
  const mod = await import('@sparticuz/chromium');
  const chromium = mod.default || mod;
  if (!process.env.VERCEL && process.env.CHROMIUM_EXTRACT_DIR) {
    try { fs.mkdirSync(process.env.CHROMIUM_EXTRACT_DIR, { recursive: true }); process.env.TMPDIR = process.env.CHROMIUM_EXTRACT_DIR; } catch (_) { }
  }
  return { path: await chromium.executablePath(), sparticuz: true, chromium };
}

async function launchBrowser(log) {
  const { path, sparticuz, chromium } = await resolveExecutablePath();
  const { chromium: pw } = await import('playwright-core');
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', '--hide-scrollbars',
    '--disable-infobars', '--force-color-profile=srgb', '--mute-audio'
  ];
  if (sparticuz) {
    (chromium.args || []).forEach((a) => {
      if (!/^--(proxy-server|user-agent|lang)|^--no-sandbox|^--disable-setuid|^--disable-dev-shm|^--headless|^--hide-scrollbars|^--mute-audio/.test(a)) args.push(a);
    });
  }
  log && log('[rch] launch browser:', sparticuz ? 'sparticuz' : path);
  return pw.launch({
    args,
    executablePath: path,
    headless: process.env.PROVIDER_HEADED === '1' ? false : true,
    timeout: 60000
  });
}

async function solveChallenge(page, waitMs) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const info = await page.evaluate(() => {
      const text = document.documentElement.outerHTML.toLowerCase();
      const t = String(document.title || '').toLowerCase();
      const blocked =
        text.indexOf('just a moment') !== -1 ||
        text.indexOf('__cf_chl_opt') !== -1 ||
        text.indexOf('cf_chl_prog') !== -1 ||
        text.indexOf('challenges.cloudflare.com') !== -1 ||
        text.indexOf('cdn-cgi/challenge-platform') !== -1;
      return { blocked: blocked, len: document.body ? document.body.innerText.length : 0 };
    }).catch(() => ({ blocked: true, len: 0 }));
    if (!info.blocked && info.len > 60) return true;
    await page.waitForTimeout(900).catch(() => { });
  }
  return false;
}

function createCapture(page) {
  const posts = [];
  page.on('response', (res) => {
    try {
      const req = res.request();
      const url = new URL(res.url());
      if (req.method() !== 'POST') return;
      if (!/^https?:\/\//i.test(res.url())) return;
      if (url.host !== new URL(BASE).host) return;
      posts.push(res.text().then((t) => ({ url: res.url(), status: res.status(), text: String(t) }))
        .catch(() => ({ url: res.url(), status: res.status(), text: '' })));
    } catch (_) { }
  });
  return { posts, url: page.url() };
}

async function captureVerdict(capture) {
  const recs = await Promise.all((capture.posts || []).slice(0, 12)).catch(() => []);
  for (const rec of recs) {
    if (CF_BODY_RE.test(rec.text)) return { state: 'verification_required', delivered: false, via: 'net' };
    const v = classify(parseMaybeJson(rec.text), rec.status);
    if (v.state === 'success' || v.state === 'rejected') return Object.assign(v, { via: 'net' });
  }
  return null;
}

async function domPollVerdict(page, waitMs) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const dom = await page.evaluate(() => {
      const txt = (document.body && document.body.innerText) || '';
      const win = /berhasil|sukses|successfully|success|terkirim/i.test(txt);
      const fail = /gagal|failed|error|tidak valid|invalid|melebihi limit|limit harian|telah habis/i.test(txt);
      const verify = /verifica?tion|verifikasi|turnstile|captcha|challenge|robot/i.test(txt);
      return { win, fail, verify, txt: txt.slice(0, 4000) };
    }).catch(() => null);
    if (dom) {
      if (dom.win && !dom.fail) return { state: 'success', delivered: true, via: 'dom' };
      if (dom.fail && dom.verify) return { state: 'verification_required', delivered: false, via: 'dom' };
      if (dom.fail) return { state: 'rejected', delivered: false, via: 'dom' };
    }
    await page.waitForTimeout(1000).catch(() => { });
  }
  return null;
}

async function findPanelForm(ctx, page) {
  const form = await page.evaluate(() => {
    function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input,textarea')).filter(visible);
    function sigOf(el) {
      return ((el.placeholder || '') + ' ' + (el.name || '') + ' ' + (el.id || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' + (el.className || '')).toLowerCase();
    }
    const pickBy = (keys) => inputs.find((el) => keys.some((k) => sigOf(el).indexOf(k) !== -1)) || null;
    const linkInput = pickBy(['link', 'tautan', 'url', 'whatsapp', 'channel', 'pesan']) || inputs[0] || null;
    const emojiInput = pickBy(['emoji', 'emot', 'reak', 'simbol']) || inputs.find((el) => el !== linkInput) || null;
    const buttons = Array.prototype.slice.call(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(visible);
    const sendBtn = buttons.find((el) => /kirim|reaksi|react|send|submit|gas|mulai|reaction/.test(((el.innerText || el.value || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase())) || null;
    const idx = (el) => (el ? inputs.indexOf(el) : -1);
    return {
      okInputs: inputs.length,
      linkIdx: idx(linkInput),
      emojiIdx: idx(emojiInput),
      btnIdx: buttons.indexOf(sendBtn),
      labels: inputs.map((el) => ({ ph: (el.placeholder || '').slice(0, 40), id: el.id }))
    };
  });
  return form;
}

async function fieldAt(page, ci) {
  const fields = await page.$$('input,textarea');
  const list = [];
  for (const f of fields) {
    let vis = false;
    try { vis = await f.evaluate((n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)); } catch (_) { }
    if (vis) list.push(f);
  }
  return ci >= 0 && ci < list.length ? list[ci] : null;
}

async function buttonsVisible(page) {
  const all = await page.$$('button,[role="button"],input[type="submit"]');
  const list = [];
  for (const b of all) {
    let vis = true;
    try { vis = await b.evaluate((n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)); } catch (_) { vis = false; }
    if (vis) list.push(b);
  }
  return list;
}

async function drivePanel(ctx) {
  const { page, log } = ctx;
  const form = await findPanelForm(ctx, page);
  log && log('[rch] panel form:', JSON.stringify(form));
  if (!form || form.linkIdx < 0 || form.btnIdx < 0) {
    log && log('[rch] form/tombol panel tidak dikenali (fallback page-fetch dipakai)');
    return null;
  }
  const fLink = await fieldAt(page, form.linkIdx);
  if (!fLink) return null;
  try { await fLink.click({ timeout: 3000 }).catch(() => { }); } catch (_) { }
  await fLink.fill(ctx.link).catch(() => { });
  if (form.emojiIdx >= 0) {
    const fEmoji = await fieldAt(page, form.emojiIdx);
    if (fEmoji) {
      try { await fEmoji.click({ timeout: 3000 }).catch(() => { }); } catch (_) { }
      await fEmoji.fill(ctx.emoji).catch(() => { });
    }
  }
  const buttons = await buttonsVisible(page);
  const btn = form.btnIdx >= 0 && form.btnIdx < buttons.length ? buttons[form.btnIdx] : null;
  if (!btn) return null;
  try { await btn.click({ timeout: 8000 }); } catch (e) { log && log('[rch] klik tombol gagal:', e.message); return null; }
  log && log('[rch] tombol kirim ditekan, menunggu hasil...');
  const direct = await domPollVerdict(page, 4000);
  if (direct) return direct;
  return (await captureVerdict(ctx.capture)) || (await domPollVerdict(ctx.page, ctx.resultWaitMs - 4000 > 0 ? ctx.resultWaitMs - 4000 : 6000));
}

async function pageSidePosts(ctx) {
  const eps = Array.from(new Set(FALLBACK_ENDPOINTS.concat(ctx.endpointsPage || []))).slice(0, 16);
  const bodies = bodyCandidates(ctx.link, ctx.emoji);
  try {
    const recs = await ctx.page.evaluate(async (epList, bodyList) => {
      const out = [];
      for (const ep of epList) {
        for (const body of bodyList) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            const r = await window.fetch(ep, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal
            });
            clearTimeout(timer);
            const text = await r.text();
            out.push({ ep, status: r.status, text: String(text).slice(0, 4000) });
            if (r.status === 200 && text && !/just a moment|cf_chl/i.test(text)) break;
          } catch (e) {
            out.push({ ep, status: 0, text: 'FETCH_ERR ' + ((e && e.message) || e) });
          }
        }
      }
      return out;
    }, eps, bodies);
    for (const rec of recs || []) {
      if (CF_BODY_RE.test(rec.text)) return { state: 'verification_required', delivered: false, via: 'page-fetch', endpoint: rec.ep };
      const v = classify(parseMaybeJson(rec.text), rec.status);
      if (v.state === 'success' || v.state === 'rejected') return Object.assign(v, { via: 'page-fetch', endpoint: rec.ep });
    }
  } catch (e) {
    ctx.log && ctx.log('[rch] page-fetch gagal:', (e && e.message) || e);
  }
  return null;
}

async function browserCascade(ctx) {
  const { pool, log } = ctx;
  const gotoCap = ctx.browserGotoCapMs || 40000;
  for (let a = 0; a < ctx.browserAttempts; a++) {
    const remaining = ctx.budget ? ctx.budget.left() : 999999;
    const launchAllow = ctx.browserLaunchAllowMs || 8000;
    const gotoT = Math.max(0, Math.min(gotoCap, remaining - launchAllow - ctx.solveWaitMs - 3000));
    if (gotoT < 5000) { log && log('[rch] sisa anggaran tidak cukup untuk percobaan browser'); break; }
    const slot = pool.acquire();
    let browser = null;
    try {
      log && log('[rch] browser attempt ' + (a + 1) + ' via ' + pool.mask(slot ? slot.config : null));
      browser = await launchBrowser(log);
      const context = await browser.newContext();
      if (slot && slot.clearance && slot.clearance.length) {
        try { await context.addCookies(slot.clearance); } catch (_) { }
      }
      await context.addInitScript(INIT_JS);
      const page = await context.newPage();
      ctx.page = page;
      ctx.capture = createCapture(page);
      await page.goto(BASE + ROOT_PATHS[a % ROOT_PATHS.length], { waitUntil: 'domcontentloaded', timeout: gotoT });
      const solveWait = Math.min(ctx.solveWaitMs, Math.max(4000, (ctx.budget ? ctx.budget.left() : 999999) - 3000));
      const solved = await solveChallenge(page, solveWait);
      if (!solved) throw new Error('challenge tidak terselesaikan dalam ' + Math.round(solveWait / 1000) + 's');
      log && log('[rch] challenge lolos, panel terlihat:', BASE);
      if (slot) {
        try {
          const cookies = await context.cookies(BASE);
          const keep = [];
          (cookies || []).forEach((c) => { if (/cf|__Host|_cf|turnstile|csrf/i.test(c.name)) keep.push(c); });
          (cookies || []).forEach((c) => { if (keep.length < 40) keep.push(c); });
          slot.clearance = keep;
          slot.userAgent = await page.evaluate(() => navigator.userAgent);
        } catch (_) { }
      }
      let verdict = await drivePanel(ctx).catch((e) => { log && log('[rch] driver error:', (e && e.message) || e); return null; });
      if (!verdict) verdict = await pageSidePosts(ctx);
      if (verdict && (verdict.state === 'success' || verdict.state === 'rejected')) {
        pool.reportSuccess(slot);
        return Object.assign({}, verdict, { proxy: pool.mask(slot ? slot.config : null) });
      }
      if (verdict && verdict.state === 'verification_required') {
        pool.reportFailure(slot, new Error('panel verifikasi'), { kind: 'cf' });
        return Object.assign({}, verdict, { proxy: pool.mask(slot ? slot.config : null) });
      }
      if (verdict) return Object.assign({}, verdict, { proxy: pool.mask(slot ? slot.config : null) });
      throw new Error('tidak ada sinyal hasil dari panel');
    } catch (err) {
      const msg = String((err && err.message) || err);
      log && log('[rch] browser attempt ' + (a + 1) + ' gagal:', msg.slice(0, 160));
      pool.reportFailure(slot, err, { kind: /challenge|Timed out|net::|ECONN/i.test(msg) ? 'cf' : 'browser' });
    } finally {
      try { if (browser) await browser.close(); } catch (_) { }
      delete ctx.page;
      delete ctx.capture;
    }
  }
  return { state: 'verification_required', delivered: false, via: 'browser' };
}

/* ------------------------------------------------------------------ */
/* sendReact — kontrak sama seperti adapter lama                       */
/* ------------------------------------------------------------------ */

async function sendReact(link, emoji) {
  const linkStr = String(link || '').trim();
  const emojiStr = String(emoji || '').trim();
  if (!/^https:\/\/whatsapp\.com\/channel\/[^/\s]+\/\d+$/.test(linkStr)) {
    return { state: 'rejected', delivered: false, error: 'format link tidak valid' };
  }
  if (!emojiStr || !/[^\s,]/.test(emojiStr)) {
    return { state: 'rejected', delivered: false, error: 'emoji kosong' };
  }

  const isVercel = !!process.env.VERCEL;
  const totalBudgetMs = parseInt(process.env.REACT_TOTAL_BUDGET_MS, 10) || (isVercel ? 27000 : 90000);
  const ctx = {
    link: linkStr,
    emoji: emojiStr,
    pool: getEngine().pool,
    log: (...a) => console.log(...a),
    budget: createBudget(totalBudgetMs),
    directFirst: (process.env.REACT_HTTP_DIRECT_FIRST || '1') === '1',
    httpGetCapMs: parseInt(process.env.REACT_HTTP_GET_MS, 10) || (isVercel ? 8000 : 14000),
    httpPostCapMs: parseInt(process.env.REACT_HTTP_POST_MS, 10) || (isVercel ? 7000 : 10000),
    browserGotoCapMs: parseInt(process.env.REACT_BROWSER_GOTO_MS, 10) || (isVercel ? 10000 : 30000),
    browserLaunchAllowMs: parseInt(process.env.REACT_BROWSER_LAUNCH_MS, 10) || 8000,
    httpAttempts: parseInt(process.env.REACT_HTTP_ATTEMPTS, 10) || 2,
    browserAttempts: parseInt(process.env.REACT_BROWSER_ATTEMPTS, 10) || (isVercel ? 1 : 2),
    solveWaitMs: parseInt(process.env.REACT_SOLVE_WAIT_MS, 10) || (isVercel ? 12000 : 25000),
    resultWaitMs: parseInt(process.env.REACT_RESULT_WAIT_MS, 10) || (isVercel ? 10000 : 20000)
  };

  try { await getEngine().ready; } catch (_) { }

  const mode = (process.env.REACT_PROVIDER_MODE || 'auto').toLowerCase();
  let result = null;

  if (mode !== 'browser-only') {
    try { result = await httpCascade(ctx); } catch (e) { ctx.log('[rch] httpCascade error: ' + e.message); }
    ctx.log('[rch] httpCascade -> ' + JSON.stringify({ state: result && result.state, endpoint: result && result.endpoint, proxy: result && result.proxy }));
  }
  if (mode !== 'http-only' && (!result || result.state === 'verification_required' || result.state === 'unavailable' || result.state === 'timeout' || result.state === 'unexpected')) {
    try { result = await browserCascade(ctx); } catch (e) {
      ctx.log('[rch] browserCascade error: ' + e.message);
      if (!result) result = { state: 'unavailable', delivered: null, via: 'browser' };
    }
  }
  if (!result) result = { state: 'unavailable', delivered: null };

  const out = { state: result.state, delivered: result.delivered };
  if (result.error) out.error = String(result.error).slice(0, 200);
  return out;
}

module.exports = { sendReact, classify, looksLikeCf, _internals: { buildBodies: bodyCandidates, BASE } };

/* ------------------------------------------------------------------ */
/* CLI opsional (dipertahankan dari adapter lama)                      */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  (async function () {
    const link = process.argv[2];
    const emoji = process.argv[3] || '❤️';
    if (!link) {
      console.log('node api/rch.js "https://whatsapp.com/channel/ID/MSG" "😀,🔥"');
      process.exit(1);
    }
    try {
      const out = await sendReact(link, emoji);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.state === 'success' ? 0 : 1);
    } catch (e) {
      console.log(JSON.stringify({ status: false, message: (e && e.message) || e }, null, 2));
      process.exit(1);
    }
  })();
}
