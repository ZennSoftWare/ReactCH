'use strict';

/**
 * Adapter provider reaction — VERSI SCRAPE (react.nexapanel.my.id).
 *
 * Pengganti adapter lama (react.keyysspanel.web.id + solver FGSI) memakai mesin
 * lib/panel.js + lib/proxyPool.js:
 *   - Axios + cheerio melalui pool rotasi proxy (cf_clearance dipertahankan per IP proxy).
 *   - Browser stealth untuk menyelesaikan Cloudflare, lalu reaction dieksekusi di dalam
 *     halaman panel sehingga cookie sesi & widget provider tetap valid.
 *   - 1 proxy mati/limit => otomatis diganti proxy baru (praktis unlimited: pool 100x).
 *
 * Kontrak tidak berubah — dipakai api/reactch.js tanpa penyesuaian:
 *   sendReact(link, emoji) -> Promise<{ state, delivered }>
 *     state     : 'success' | 'verification_required' | 'rejected' | 'unavailable' | 'timeout' | 'unexpected'
 *     delivered : true | false | null
 *
 * Env utama (opsional):
 *   PROXY_LIST, PROXY_SOURCE_URL, PROXY_SLOTS, PROXY_MAX_USES, SCRAPER_FREE_PROXIES
 *   REACT_PROVIDER_BASE   (default https://react.nexapanel.my.id)
 *   REACT_PROVIDER_MODE   (auto | http-only | browser-only)
 *   REACT_HTTP_ATTEMPTS, REACT_BROWSER_ATTEMPTS, REACT_SOLVE_WAIT_MS, REACT_RESULT_WAIT_MS
 *
 * CLI:
 *   node api/rch.js "https://whatsapp.com/channel/ID/MSG" "😀,🔥"
 */

const { sendReact } = require('../lib/panel');

module.exports = { sendReact };

if (require.main === module) {
  (async () => {
    const link = process.argv[2];
    const emoji = process.argv[3] || '❤️';
    if (!link) {
      console.log('node api/rch.js "https://whatsapp.com/channel/ID/MSG" "😀,🔥"');
      process.exit(1);
    }
    if (!/whatsapp\.com\/channel\/[^/]+\/\d+/.test(link)) {
      console.log(JSON.stringify({
        status: false,
        message: 'Link harus .../channel/CHANNEL_ID/MESSAGE_ID (ada nomor di belakang).'
      }));
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
