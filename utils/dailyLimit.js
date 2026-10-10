/**
 * Limit harian per browser (localStorage). Hanya tanggung jawab: menghitung & menyimpan pemakaian lokal.
 * Bukan identitas pengguna dan bukan keamanan: pengguna bisa menghapus data browser.
 * Penegakan terhadap abuse ada di backend (utils/rateLimiter.js), terpisah dari modul ini.
 * UMD: window.RchDailyLimit di browser, module.exports di Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RchDailyLimit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_PER_DAY = 5;
  var KEY = 'rch_daily_v1';

  function localDay(d) {
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined') {
        var k = '__rch_t';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return localStorage;
      }
    } catch (_) { /* mode privat / diblokir */ }
    var mem = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); }
    };
  }

  /** storage & clock bisa disuntik untuk pengujian. */
  function create(storage, clock) {
    var store = storage || defaultStorage();
    var now = clock || function () { return new Date(); };

    function read() {
      var today = localDay(now());
      var rec = null;
      try { rec = JSON.parse(store.getItem(KEY)); } catch (_) { rec = null; }
      var valid = rec && typeof rec.date === 'string' && rec.date === today &&
        typeof rec.used === 'number' && isFinite(rec.used) && rec.used >= 0 && rec.used <= MAX_PER_DAY &&
        Math.floor(rec.used) === rec.used;
      return valid ? { date: today, used: rec.used } : { date: today, used: 0 };
    }

    function write(rec) {
      try { store.setItem(KEY, JSON.stringify(rec)); } catch (_) { /* abaikan */ }
    }

    function view(rec) {
      return { date: rec.date, used: rec.used, max: MAX_PER_DAY, remaining: MAX_PER_DAY - rec.used };
    }

    return {
      MAX: MAX_PER_DAY,
      status: function () { return view(read()); },
      /** Dipanggil setelah input valid, tepat sebelum request dikirim. */
      reserve: function () {
        var rec = read();
        if (rec.used >= MAX_PER_DAY) { var v = view(rec); v.ok = false; return v; }
        rec.used += 1;
        write(rec);
        var r = view(rec);
        r.ok = true;
        return r;
      },
      /** Hanya untuk kegagalan yang dipastikan server belum mengirim apa pun. */
      refund: function () {
        var rec = read();
        if (rec.used > 0) { rec.used -= 1; write(rec); }
        return view(rec);
      }
    };
  }

  var api = create();
  api.create = create;
  return api;
});
