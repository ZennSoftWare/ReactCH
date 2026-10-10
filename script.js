/* REACTCH — UI & event browser.
   Tanggung jawab: intro, tema, modal donasi, clipboard, validasi awal, preview emoji, toast, status request, limit lokal.
   Aturan validasi ada di utils/validate.js, aturan limit di utils/dailyLimit.js (dipakai bersama, tidak diduplikasi di sini).
   Status sukses HANYA ditampilkan jika backend menjawab ok:true dan data.delivered === true. */
(function () {
  'use strict';

  var root = document.documentElement;
  var V = window.RchValidate;
  var D = window.RchDailyLimit;

  function $(sel) { return document.querySelector(sel); }
  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  if (!V || !D) {
    // Modul bersama gagal dimuat: jangan biarkan layar terkunci oleh intro.
    console.error('[reactch] utils/validate.js atau utils/dailyLimit.js tidak termuat.');
    root.classList.remove('lk', 'hld');
    return;
  }

  var LIMIT_MSG = 'Masa limit anda telah habis, silahkan lanjut besok lagi';
  var FAIL_TOAST = 'Gagal diproses!, silahkan coba lagi.';
  var OK_TOAST = 'Sukses dikirim! silahkan cek pesan channel tersebut di whatsapp';
  var REQUEST_TIMEOUT_MS = 32000;

  var els = {
    ig: $('#ig'), igb: $('#igb'), igi: $('#igi'), igClose: $('#igClose'), visit: $('#visit'), donate: $('#donate'),
    dn: $('#dn'), dnClose: $('#dnClose'), qr: $('#qr'), qrImg: $('#qrImg'),
    th: $('#th'), h1: $('#h1'), ts: $('#ts'),
    f: $('#f'), url: $('#url'), fUrl: $('#fUrl'), cp: $('#cp'), eUrl: $('#eUrl'),
    em: $('#em'), fEm: $('#fEm'), eEm: $('#eEm'),
    pvb: $('#pvb'), pve: $('#pve'), pvc: $('#pvc'),
    go: $('#go'), eGo: $('#eGo'), lim: $('#lim'), limN: $('#limN'), limM: $('#limM')
  };

  var state = { busy: false, locked: false, resetTimer: 0, config: { channelUrl: null }, introClosed: false, qrChecked: false };

  /* ---------- util pesan & status field ---------- */
  function showMsg(el, text, kind) {
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = text;
    el.setAttribute('data-k', kind || 'err');
    el.hidden = false;
  }
  function setBad(field, input, bad) {
    field.classList.toggle('bad', !!bad);
    if (input) input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }
  function shake(field) {
    if (reduced()) return;
    field.classList.remove('sh');
    void field.offsetWidth;
    field.classList.add('sh');
  }
  [els.fUrl, els.fEm].forEach(function (f) {
    f.addEventListener('animationend', function () { f.classList.remove('sh'); });
  });

  /* ---------- toast ---------- */
  function toast(text, kind) {
    var el = document.createElement('div');
    el.className = 't' + (kind === 'err' ? ' e' : '');
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + (kind === 'err' ? 'i-x' : 'i-wa') + '"/></svg><span></span>';
    el.lastChild.textContent = text;
    els.ts.appendChild(el);
    while (els.ts.children.length > 3) els.ts.removeChild(els.ts.firstChild);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, reduced() ? 0 : 450);
    }, 4200);
  }

  /* ---------- tema ---------- */
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    els.th.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
    els.th.setAttribute('aria-label', t === 'light' ? 'Aktifkan mode gelap' : 'Aktifkan mode terang');
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#fafafa' : '#0a0a0a');
  }
  applyTheme(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  els.th.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('rch_theme', next); } catch (_) { /* penyimpanan diblokir */ }
  });

  /* ---------- limit harian lokal ---------- */
  function renderLimit() {
    var s = D.status();
    els.limN.textContent = String(s.used);
    els.limM.textContent = String(s.max);
    els.lim.classList.toggle('full', s.remaining <= 0);
  }
  renderLimit();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) renderLimit(); });
  window.addEventListener('focus', renderLimit);
  window.addEventListener('storage', renderLimit);

  /* ---------- clipboard ---------- */
  function syncClip() {
    var has = els.url.value.length > 0;
    els.cp.setAttribute('data-s', has ? 'clr' : 'idle');
    els.cp.setAttribute('aria-label', has ? 'Hapus isi link' : 'Tempel dari clipboard');
  }
  function clearUrlError() { setBad(els.fUrl, els.url, false); showMsg(els.eUrl, ''); }

  els.cp.addEventListener('click', function () {
    if (els.url.value) {
      els.url.value = '';
      syncClip();
      clearUrlError();
      els.url.focus();
      return;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      showMsg(els.eUrl, 'Browser ini tidak mendukung tempel otomatis. Tempel link secara manual pada kolom.', 'info');
      els.url.focus();
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      text = String(text || '').trim();
      if (!text) { showMsg(els.eUrl, 'Clipboard kosong. Salin link pesan channel lebih dulu.', 'info'); return; }
      els.url.value = text.slice(0, 500);
      clearUrlError();
      syncClip();
    }).catch(function () {
      showMsg(els.eUrl, 'Akses clipboard ditolak browser. Tempel link secara manual pada kolom.', 'info');
      els.url.focus();
    });
  });
  els.url.addEventListener('input', function () { syncClip(); clearUrlError(); });
  els.url.addEventListener('blur', function () {
    if (!els.url.value.trim()) return;
    var r = V.validateChannelUrl(els.url.value);
    if (!r.ok) { setBad(els.fUrl, els.url, true); showMsg(els.eUrl, r.message); }
  });
  syncClip();

  /* ---------- preview emoji ---------- */
  var prevCount = 0;
  function renderPreview() {
    var p = V.parseEmojiList(els.em.value);
    var list = p.tokens;
    els.pvb.textContent = '';
    if (!list.length) {
      els.pvb.appendChild(els.pve);
    } else {
      list.slice(0, 12).forEach(function (tok, i) {
        var s = document.createElement('span');
        s.className = 'ej' + (i >= V.MAX_EMOJI ? ' over' : '') + (i >= prevCount && !reduced() ? ' pop' : '');
        s.textContent = tok;
        s.setAttribute('role', 'img');
        s.setAttribute('aria-label', 'Emoji ' + tok);
        els.pvb.appendChild(s);
      });
    }
    els.pvc.textContent = list.length + '/' + V.MAX_EMOJI + ' EMOJI';
    els.pvc.classList.toggle('over', list.length > V.MAX_EMOJI);
    prevCount = list.length;
  }
  els.em.addEventListener('input', function () {
    setBad(els.fEm, els.em, false);
    showMsg(els.eEm, '');
    renderPreview();
  });
  renderPreview();

  /* ---------- tombol kirim ---------- */
  function setBtn(s) {
    els.go.setAttribute('data-s', s);
    els.go.setAttribute('aria-disabled', (s === 'busy' || s === 'ok') ? 'true' : 'false');
  }
  function scheduleReset(ms) {
    clearTimeout(state.resetTimer);
    state.resetTimer = setTimeout(function () {
      state.locked = false;
      if (!state.busy) setBtn('idle');
    }, ms);
  }

  function post(link, emoji) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch('/api/reactch', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ link: link, emoji: emoji }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var body = null;
        try { body = JSON.parse(txt); } catch (_) { body = null; }
        return { status: res.status, body: body };
      });
    }).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  function succeed() {
    state.busy = false;
    state.locked = true;
    setBtn('ok');
    showMsg(els.eGo, '');
    toast(OK_TOAST, 'ok');
    scheduleReset(3000);
  }
  function failed(detail, refundable) {
    if (refundable) D.refund();
    renderLimit();
    state.busy = false;
    state.locked = false; // boleh coba lagi segera
    setBtn('err');
    showMsg(els.eGo, detail || FAIL_TOAST);
    toast(FAIL_TOAST, 'err');
    scheduleReset(3500);
  }

  function submit() {
    if (state.busy || state.locked) return; // cegah request ganda
    clearTimeout(state.resetTimer);
    if (els.go.getAttribute('data-s') !== 'idle') setBtn('idle');
    showMsg(els.eGo, '');

    // 1) URL  2) emoji  (keduanya dicek agar semua kesalahan tampil sekaligus)
    var u = V.validateChannelUrl(els.url.value);
    var e = V.parseEmojiList(els.em.value);
    if (!u.ok) { setBad(els.fUrl, els.url, true); showMsg(els.eUrl, u.message); shake(els.fUrl); }
    if (!e.ok) { setBad(els.fEm, els.em, true); showMsg(els.eEm, e.message); shake(els.fEm); }
    if (!u.ok || !e.ok) { (u.ok ? els.em : els.url).focus(); return; }

    // 3) limit harian — input tidak valid di atas tidak pernah menghabiskan limit
    var r = D.reserve();
    renderLimit();
    if (!r.ok) {
      showMsg(els.eGo, LIMIT_MSG);
      toast(LIMIT_MSG, 'err');
      return;
    }

    // 4-6) kunci, tampilkan loading, kirim
    state.busy = true;
    setBtn('busy');

    post(u.url, e.tokens.join(',')).then(function (res) {
      var b = res.body;
      if (res.status === 200 && b && b.ok === true && b.data && b.data.delivered === true) {
        succeed();
        return;
      }
      // Kebijakan limit: dikembalikan HANYA jika server memastikan belum ada yang terkirim.
      var definite = !!(b && b.data && b.data.delivered === false);
      var msg = b && typeof b.message === 'string' ? b.message.slice(0, 220) : '';
      failed(msg || 'Server mengembalikan respons yang tidak dikenali. Hasil pengiriman tidak dapat dipastikan.', definite);
    }, function (err) {
      if (err && err.name === 'AbortError') {
        failed('Permintaan melewati batas waktu. Hasil pengiriman tidak dapat dipastikan; cek channel sebelum mencoba lagi.', false);
      } else if (navigator.onLine === false) {
        failed('Tidak ada koneksi internet. Periksa jaringan lalu coba lagi.', true);
      } else {
        failed('Koneksi ke server gagal. Hasil pengiriman tidak dapat dipastikan.', false);
      }
    });
  }
  els.f.addEventListener('submit', function (ev) { ev.preventDefault(); submit(); });

  /* ---------- fokus dalam dialog ---------- */
  function trapTab(container, ev) {
    if (ev.key !== 'Tab') return;
    var f = container.querySelectorAll('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])');
    var items = Array.prototype.filter.call(f, function (n) { return n.offsetParent !== null || n === document.activeElement; });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  /* ---------- donasi ---------- */
  function checkQr() {
    if (state.qrChecked) return;
    state.qrChecked = true;
    var probe = new Image();
    probe.onload = function () { els.qrImg.src = 'assets/qris.png'; els.qr.setAttribute('data-s', 'ok'); };
    probe.onerror = function () { els.qr.setAttribute('data-s', 'missing'); };
    probe.src = 'assets/qris.png';
  }
  function welcomeActive() { return root.classList.contains('lk') && !els.ig.classList.contains('out'); }
  function setBack(inert) {
    if (inert) els.igb.setAttribute('inert', ''); else els.igb.removeAttribute('inert');
  }
  function openDonate() {
    checkQr();
    els.dn.hidden = false;
    setBack(true);
    requestAnimationFrame(function () { requestAnimationFrame(function () { els.dn.classList.add('on'); }); });
    els.dnClose.focus({ preventScroll: true });
  }
  function closeDonate() {
    if (els.dn.hidden) return;
    els.dn.classList.remove('on');
    setTimeout(function () { els.dn.hidden = true; }, reduced() ? 0 : 450);
    setBack(false);
    if (welcomeActive()) els.donate.focus({ preventScroll: true });
  }
  els.donate.addEventListener('click', openDonate);
  els.dnClose.addEventListener('click', closeDonate);
  els.dn.addEventListener('click', function (ev) { if (ev.target === els.dn) closeDonate(); });

  /* ---------- intro: loading -> welcome ---------- */
  function sizeWelcome() {
    var h = Math.min(els.igi.scrollHeight, window.innerHeight - 32);
    els.igb.style.setProperty('--oh', h + 'px');
  }
  function openWelcome() {
    if (state.config.channelUrl) {
      els.visit.setAttribute('href', state.config.channelUrl);
      els.visit.setAttribute('aria-disabled', 'false');
    }
    sizeWelcome();
    els.igb.classList.add('sh'); // 1) mengecil
    setTimeout(function () {
      els.igb.classList.add('o'); // 2) berubah bentuk & melebar, 3) isi diganti welcome
      els.igi.removeAttribute('inert');
      var l = $('#igl'); if (l) l.setAttribute('aria-hidden', 'true');
      setTimeout(function () { els.igClose.focus({ preventScroll: true }); }, reduced() ? 0 : 650);
    }, reduced() ? 0 : 420);
  }
  function closeIntro() {
    if (state.introClosed) return;
    state.introClosed = true;
    els.ig.classList.add('out');
    root.classList.remove('hld');
    setTimeout(function () {
      root.classList.remove('lk');
      els.h1.focus({ preventScroll: true });
    }, reduced() ? 0 : 720);
  }
  els.igClose.addEventListener('click', closeIntro);
  els.visit.addEventListener('click', function (ev) {
    if (!state.config.channelUrl) {
      ev.preventDefault();
      toast('Link channel belum dikonfigurasi oleh admin.', 'err');
    }
  });
  els.ig.addEventListener('keydown', function (ev) { trapTab(els.ig, ev); });
  els.dn.addEventListener('keydown', function (ev) { trapTab(els.dn, ev); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (!els.dn.hidden) closeDonate();
    else if (welcomeActive() && els.igb.classList.contains('o')) closeIntro();
  });
  window.addEventListener('resize', function () {
    if (els.igb.classList.contains('o') && !state.introClosed) requestAnimationFrame(sizeWelcome);
  });

  /* ---------- inisialisasi ---------- */
  function loadConfig() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
    return fetch('/api/reactch', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (j) {
        if (j && j.ok === true && j.data && typeof j.data.channelUrl === 'string') {
          var c = V.validateChannelProfileUrl(j.data.channelUrl);
          if (c.ok) state.config.channelUrl = c.url;
        }
      })
      .catch(function () { /* tanpa konfigurasi: tombol Kunjungi menampilkan penanganan */ })
      .then(function () { clearTimeout(timer); });
  }

  var fontsReady = (document.fonts && document.fonts.ready) ? Promise.race([document.fonts.ready, wait(1500)]) : Promise.resolve();
  Promise.all([loadConfig(), fontsReady, wait(reduced() ? 150 : 1100)]).then(openWelcome);
})();
