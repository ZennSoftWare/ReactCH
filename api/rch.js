'use strict';

/**
 * Adapter provider reaction — VERSI SCRAPE (www.leovan.my.id).
 *
 * Memakai mesin lib/leovan.js:
 *   - GET / untuk cookie sesi (di-cache), lalu POST /api/react dengan nama pengirim acak otomatis.
 *   - Sesi dibuat ulang otomatis bila ditolak (401/403/419/challenge); tidak pernah mengirim ulang
 *     saat hasil tidak pasti (timeout/error jaringan).
 *
 * Kontrak tidak berubah — dipakai api/reactch.js tanpa penyesuaian:
 *   sendReact(link, emoji) -> Promise<{ state, delivered }>
 *     state     : 'success' | 'verification_required' | 'rejected' | 'unavailable' | 'timeout' | 'unexpected'
 *     delivered : true | false | null
 *
 * Env (opsional):
 *   LEOVAN_BASE_URL        (default https://www.leovan.my.id)
 *   REACT_TOTAL_BUDGET_MS  (anggaran waktu total, default 35000)
 *
 * CLI:
 *   node api/rch.js "https://whatsapp.com/channel/ID/MSG" "😀,🔥"
 */

const { sendReact } = require('../lib/leovan');

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
