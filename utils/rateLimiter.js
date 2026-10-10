'use strict';

/**
 * Rate limiter sliding-window, per kunci (IP klien).
 * PERINGATAN serverless: penyimpanan ada di memori instance. Tiap instance/cold start punya hitungan
 * sendiri, jadi ini perlindungan best-effort, bukan batas global yang pasti. Untuk batas global
 * dibutuhkan penyimpanan bersama (belum dikonfigurasi di project ini).
 * Kunci per IP: satu pengguna tidak menghabiskan jatah pengguna lain.
 */
function createRateLimiter(opts) {
  var windowMs = (opts && opts.windowMs) || 600000;
  var max = (opts && opts.max) || 10;
  var maxKeys = (opts && opts.maxKeys) || 5000;
  var now = (opts && opts.now) || Date.now;
  var hits = new Map();

  function prune(t) {
    if (hits.size <= maxKeys) return;
    hits.forEach(function (arr, key) {
      if (!arr.length || t - arr[arr.length - 1] >= windowMs) hits.delete(key);
    });
    // Masih penuh: buang kunci tertua agar memori tetap terbatas.
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
    check: function (key) {
      var t = now();
      var arr = hits.get(key) || [];
      var cut = t - windowMs;
      var i = 0;
      while (i < arr.length && arr[i] <= cut) i++;
      if (i) arr = arr.slice(i);
      if (arr.length >= max) {
        hits.set(key, arr);
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, arr[0] + windowMs - t) };
      }
      arr.push(t);
      hits.set(key, arr);
      prune(t);
      return { allowed: true, remaining: max - arr.length, retryAfterMs: 0 };
    },
    size: function () { return hits.size; }
  };
}

/** IP klien dari header yang diisi platform (Vercel menimpa header ini, bukan dari klien). */
function getClientKey(req) {
  var h = req.headers || {};
  var ip = h['x-real-ip'] || h['x-vercel-forwarded-for'] ||
    (typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0] : '') ||
    (req.socket && req.socket.remoteAddress) || '';
  ip = String(ip).trim().slice(0, 64);
  return ip || 'unknown';
}

module.exports = { createRateLimiter: createRateLimiter, getClientKey: getClientKey };
