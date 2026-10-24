'use strict';

/**
 * Proxy pool rotasi IP untuk provider reaction (versi scrape).
 * Pool berisi hingga PROXY_SLOTS (default 100) slot aktif; round-robin, dan setiap
 * proxy yang mati/limit terpakai otomatis diganti sumber baru (1 proxy habis -> proxy baru),
 * sehingga kiriman praktis tidak kehabisan kuota asalkan daftar sumber tersedia.
 *
 * Sumber proxy:
 *   PROXY_LIST        (opsi) daftar langsung, dipisah koma/baris, format http://user:pass@host:port
 *   PROXY_SOURCE_URL  (opsi) URL kustom berisi daftar proxy (txt/json)
 *   PROXY_SLOTS       (opsi) default 100
 *   PROXY_MAX_USES    (opsi) maksimal pemakaian per proxy sebelum dirotasi, default 100
 *   SCRAPER_FREE_PROXIES  (opsi) "0" untuk menonaktifkan sumber gratis publik
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const DEFAULT_SOURCE_URLS = [
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.json',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.json',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
];

function normalizeEntry(raw) {
  if (!raw) return null;
  let s = typeof raw === 'object' && raw.ip ? `${raw.protocol || 'http'}://${raw.ip}:${raw.port}` : String(raw).trim();
  if (!s || s.startsWith('#')) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname || !u.port) return null;
    return {
      url: s,
      scheme: u.protocol.replace(':', ''),
      host: u.hostname,
      port: u.port,
      auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') } : undefined
    };
  } catch (_) {
    return null;
  }
}

function proxyAgents(config) {
  const auth = config.auth ? `${encodeURIComponent(config.auth.username)}:${encodeURIComponent(config.auth.password)}@` : '';
  const target = config.scheme.startsWith('socks')
    ? new SocksProxyAgent(`${config.scheme}://${auth}${config.host}:${config.port}`)
    : new HttpsProxyAgent(`${config.scheme}://${auth}${config.host}:${config.port}`);
  return { httpAgent: target, httpsAgent: target, proxy: false };
}

class ProxyPool {
  constructor(opts) {
    const o = opts || {};
    this.maxSlots = Math.max(1, parseInt(o.slots, 10) || 100);
    this.maxUses = Math.max(1, parseInt(o.maxUsesPerProxy, 10) || 100);
    this.sourceUrl = o.sourceUrl || null;
    this.sourceUrls = o.sourceUrls || DEFAULT_SOURCE_URLS;
    this.freeSource = o.freeSource !== false;
    this.logger = o.logger || console;
    this.rawSource = (o.list || []).map(normalizeEntry).filter(Boolean);
    this.cursor = 0;
    this.slots = [];
    this.rr = 0;
    this.filling = null;
    this.metrics = { created: 0, replaced: 0, dead: 0, requests: 0, successes: 0, failures: 0, refetches: 0 };
  }

  async init() {
    if (!this.slots.length && this.freeSource) await this.ensureSource();
    this.refill();
    return this;
  }

  ensureSource() {
    if (this.filling) return this.filling;
    this.filling = this._load().catch(() => {}).finally(() => { this.filling = null; });
    return this.filling;
  }

  async _load() {
    const urls = this.sourceUrl ? [this.sourceUrl, ...this.sourceUrls] : this.sourceUrls;
    for (const url of urls) {
      try {
        const res = await axios.get(url, { timeout: 25000, responseType: 'text', validateStatus: () => true });
        if (res.status !== 200 || !res.data) continue;
        const list = parseList(res.data);
        if (list.length < 5) continue;
        this.rawSource = list;
        this.cursor = 0;
        this.metrics.refetches++;
        this.logger && this.logger.log && this.logger.log('[pool] sumber proxy termuat:', list.length, 'refetch #' + this.metrics.refetches);
        return;
      } catch (_) { }
    }
    this.logger && this.logger.log && this.logger.log('[pool] semua sumber proxy gagal dimuat');
  }

  nextProxy() {
    if (!this.rawSource.length) return null;
    if (this.cursor > this.rawSource.length - 10 && this.rawSource.length > 20 && this.freeSource) {
      this.ensureSource().then(() => this.refill());
    }
    if (this.cursor >= this.rawSource.length) this.cursor = 0;
    const raw = this.rawSource[this.cursor];
    this.cursor++;
    if (raw && typeof raw === 'object' && raw.host && raw.port) return raw;
    return normalizeEntry(raw);
  }

  refill() {
    while (this.slots.length < this.maxSlots) {
      const c = this.nextProxy();
      if (!c) break;
      this.slots.push(this.create(c));
    }
  }

  create(config) {
    this.metrics.created++;
    return {
      id: 'p' + this.metrics.created,
      config,
      agents: proxyAgents(config),
      uses: 0,
      maxUses: this.maxUses,
      fails: 0,
      dead: false,
      clearance: null,
      userAgent: null
    };
  }

  acquire() {
    const total = this.slots.length;
    for (let i = 0; i < total; i++) {
      this.rr = total ? (this.rr + 1) % total : 0;
      const slot = this.slots[this.rr];
      if (slot && !slot.dead) return slot;
    }
    this.refill();
    if (this.slots.length) {
      this.rr = (this.rr + 1) % this.slots.length;
      return this.slots[this.rr];
    }
    return null;
  }

  reportUse(slot) {
    if (!slot) return;
    slot.uses++;
    this.metrics.requests++;
  }

  reportSuccess(slot) {
    if (!slot) return;
    this.metrics.successes++;
    slot.fails = 0;
    if (slot.uses >= slot.maxUses) this.kill(slot, 'kuota-habis');
  }

  reportFailure(slot, error, ctx) {
    if (!slot) return;
    this.metrics.failures++;
    slot.fails++;
    const c = ctx || {};
    const msg = String((error && error.message) || error || 'unknown');
    const status = c.status || (error && error.response && error.response.status);
    const hard = c.kind === 'cf' || c.kind === 'timeout' ||
      status === 429 || status === 403 ||
      /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPROTO|socket hang up|ERR_TLS|CERT|ERR_TIMED_OUT|ERR_CONNECTION/i.test(msg);
    if (slot.fails >= 2 || hard) this.kill(slot, c.kind || status || msg.slice(0, 80));
  }

  kill(slot, reason) {
    if (!slot || slot.dead) return;
    slot.dead = true;
    this.metrics.dead++;
    this.rawSource = this.rawSource.filter((p) => !(p && p.host === slot.config.host && p.port === slot.config.port));
    const idx = this.slots.indexOf(slot);
    if (idx !== -1) this.slots.splice(idx, 1);
    if (this.rr > this.slots.length) this.rr = 0;
    const replacement = this.nextProxy();
    if (replacement) {
      this.metrics.replaced++;
      this.slots.push(this.create(replacement));
    } else if (this.freeSource) {
      this.ensureSource().then(() => this.refill());
    }
  }

  stats() {
    return Object.assign({ slots: this.slots.length, maxSlots: this.maxSlots, sourceProxies: this.rawSource.length }, this.metrics);
  }

  mask(config) {
    if (!config) return 'direct';
    try {
      const u = new URL(config.url);
      return u.protocol + '//' + u.hostname + ':' + u.port + (u.username ? '(auth)' : '');
    } catch (_) {
      return 'proxy';
    }
  }
}

function parseList(data) {
  if (typeof data !== 'string') return [];
  const head = data.slice(0, 200);
  let out = [];
  try {
    const parsed = JSON.parse(data.replace(/^\uFEFF/, ''));
    if (Array.isArray(parsed)) out = parsed;
    else if (parsed && Array.isArray(parsed.data)) out = parsed.data;
    else if (parsed && Array.isArray(parsed.proxies)) out = parsed.proxies;
  } catch (_) {
    out = [];
  }
  if (!out.length) out = data.split(/\r?\n/);
  const jsonish = head.trimStart().startsWith('[') || head.trimStart().startsWith('{');
  return out
    .map((e) => (jsonish && e && typeof e === 'string' && !/^[a-z]+:\/\//i.test(e) ? 'http://' + e : e))
    .map(normalizeEntry)
    .filter(Boolean);
}

function parseProxyListEnv(value) {
  if (!value) return [];
  return String(value).split(/[,\n;]+/).map(normalizeEntry).filter(Boolean);
}

module.exports = { ProxyPool, proxyAgents, parseProxyListEnv, normalizeEntry };
