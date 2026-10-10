/**
 * Validasi bersama (frontend + backend) agar aturan tidak berbeda antar sisi.
 * UMD: window.RchValidate di browser, module.exports di Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RchValidate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_EMOJI = 5;
  var MAX_INPUT_LENGTH = 200;
  var ALLOWED_HOSTS = ['whatsapp.com', 'www.whatsapp.com'];
  var CHANNEL_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
  var MESSAGE_ID_RE = /^[0-9]{1,24}$/;

  var URL_MESSAGES = {
    empty: 'Tempel atau ketik link pesan channel terlebih dahulu.',
    format: 'Link tidak valid. Gunakan format https://whatsapp.com/channel/ID_CHANNEL/ID_PESAN.',
    host: 'Link harus berasal dari whatsapp.com.',
    path: 'Link harus berupa link pesan channel: /channel/ID_CHANNEL/ID_PESAN.',
    message_id: 'ID pesan di akhir link harus berupa angka.'
  };

  function fail(code) {
    return { ok: false, code: code, message: URL_MESSAGES[code] };
  }

  function parseUrl(raw) {
    var input = String(raw == null ? '' : raw).trim();
    if (!input) return { error: 'empty' };
    if (input.length > 500) return { error: 'format' };
    var u;
    try { u = new URL(input); } catch (_) { return { error: 'format' }; }
    if (u.protocol !== 'https:') return { error: 'format' };
    if (u.username || u.password || u.port) return { error: 'format' };
    // URL parser sudah menurunkan huruf hostname; hostname palsu ditolak lewat daftar host tepat.
    if (ALLOWED_HOSTS.indexOf(u.hostname) === -1) return { error: 'host' };
    return { url: u };
  }

  /** Link pesan: https://whatsapp.com/channel/CHANNEL_ID/MESSAGE_ID */
  function validateChannelUrl(raw) {
    var p = parseUrl(raw);
    if (p.error) return fail(p.error);
    var segs = p.url.pathname.replace(/\/+$/, '').split('/');
    if (segs.length !== 4 || segs[0] !== '' || segs[1] !== 'channel') return fail('path');
    if (!CHANNEL_ID_RE.test(segs[2])) return fail('path');
    if (!MESSAGE_ID_RE.test(segs[3])) return fail('message_id');
    return {
      ok: true,
      url: 'https://whatsapp.com/channel/' + segs[2] + '/' + segs[3],
      channelId: segs[2],
      messageId: segs[3]
    };
  }

  /** Link channel (tanpa ID pesan), untuk tombol Kunjungi: https://whatsapp.com/channel/CHANNEL_ID */
  function validateChannelProfileUrl(raw) {
    var p = parseUrl(raw);
    if (p.error) return fail(p.error);
    var segs = p.url.pathname.replace(/\/+$/, '').split('/');
    if (segs.length !== 3 || segs[0] !== '' || segs[1] !== 'channel') return fail('path');
    if (!CHANNEL_ID_RE.test(segs[2])) return fail('path');
    return { ok: true, url: 'https://whatsapp.com/channel/' + segs[2] };
  }

  var segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    }
  } catch (_) { segmenter = null; }

  var EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
  var LETTER_OR_SPACE_RE = /[\p{L}\s]/u;

  function graphemeCount(s) {
    if (segmenter) {
      var n = 0;
      var it = segmenter.segment(s)[Symbol.iterator]();
      while (!it.next().done) n++;
      return n;
    }
    return null;
  }

  /** Satu token valid = tepat satu grapheme emoji (ZWJ, bendera, keycap, skin tone tetap utuh). */
  function isSingleEmoji(token) {
    if (!token || !EMOJI_RE.test(token)) return false;
    var n = graphemeCount(token);
    if (n !== null) return n === 1;
    // Fallback tanpa Intl.Segmenter: longgar, tapi tolak huruf/spasi dan token terlalu panjang.
    return Array.from(token).length <= 16 && !LETTER_OR_SPACE_RE.test(token);
  }

  /**
   * "🔥, 👍,,😭" -> { ok, tokens:['🔥','👍','😭'], invalid:[], total }
   * Urutan dipertahankan; token kosong akibat koma berulang diabaikan.
   */
  function parseEmojiList(raw) {
    var input = String(raw == null ? '' : raw);
    var out = { ok: false, code: null, message: '', tokens: [], invalid: [], total: 0 };
    if (input.length > MAX_INPUT_LENGTH) {
      out.code = 'too_long';
      out.message = 'Input emoji terlalu panjang.';
      return out;
    }
    var parts = input.replace(/\uFF0C/g, ',').split(',');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (!t) continue;
      out.total++;
      if (isSingleEmoji(t)) out.tokens.push(t);
      else out.invalid.push(t);
    }
    if (out.total === 0) {
      out.code = 'empty';
      out.message = 'Masukkan minimal 1 emoji.';
    } else if (out.invalid.length) {
      out.code = 'invalid';
      out.message = 'Pisahkan setiap emoji dengan koma (,). Hanya emoji yang diterima.';
    } else if (out.tokens.length > MAX_EMOJI) {
      out.code = 'too_many';
      out.message = 'Maksimal ' + MAX_EMOJI + ' emoji.';
    } else {
      out.ok = true;
    }
    return out;
  }

  return {
    MAX_EMOJI: MAX_EMOJI,
    validateChannelUrl: validateChannelUrl,
    validateChannelProfileUrl: validateChannelProfileUrl,
    parseEmojiList: parseEmojiList
  };
});
