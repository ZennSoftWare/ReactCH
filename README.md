# xzeerh-reactchannel (REACTCH)

Website untuk mengirim emoji reaction ke pesan WhatsApp Channel. Frontend statis + fungsi serverless Vercel.

## Status integrasi provider (baca dulu)

Backend memanggil panel reaction `https://react.nexapanel.my.id` melalui mesin **versi scrape** di `lib/panel.js` + `lib/proxyPool.js` (pengganti adapter lama keyysspanel + solver FGSI di `api/rch.js`; handler web `api/reactch.js` dan frontend tidak berubah).

Strategi mesin:
1. **HTTP cascade** — axios + cheerio lewat pool rotasi IP (100 slot; proxy mati/limit otomatis diganti proxy baru). Cookie `cf_clearance` dipertahankan per IP proxy.
2. **Browser stealth** — bila Cloudflare menghalangi, playwright-core menjalankan challenge hingga lolos, lalu reaksi dieksekusi **di dalam halaman panel** (form + tombol, cadangan fetch sisi halaman) sehingga cookie sesi & widget provider tetap valid.

Sukses hanya diumumkan bila panel/provider benar-benar menerima reaction: UI tidak pernah menampilkan sukses palsu. Bila challenge tidak terselesaikan, API mengembalikan `PROVIDER_VERIFICATION_REQUIRED` (503) seperti semula.

Anggaran waktu default: `REACT_TOTAL_BUDGET_MS` 55s di Vercel / 90s lokal; komponen lain via env pada `.env.example`. Untuk keandalan di Vercel (IP serverless, sering diblok Cloudflare), isi `PROXY_LIST` dengan proxy bersih (residential/paid).

## Instalasi dan menjalankan

```bash
npm install
npm i -g vercel        # sekali saja
vercel dev             # jalankan lokal (frontend + /api + middleware)
```

Deploy: `vercel --prod`, atau hubungkan repo ke Vercel. Butuh Node.js 18+.

## Environment variables

Isi di Vercel > Settings > Environment Variables (lokal: `.env.local`). Contoh ada di `.env.example`.

| Variabel | Fungsi |
| --- | --- |
| `WHATSAPP_CHANNEL_URL` | URL channel untuk tombol Kunjungi, format `https://whatsapp.com/channel/ID_CHANNEL`. Jika kosong/tidak valid, tombol menampilkan pesan, tidak membuka tautan. |
| `SESSION_SECRET` | Rahasia acak untuk menandatangani cookie sesi di `middleware.js`. Tanpa ini tanda tangan tidak diverifikasi. |
| `ALLOWED_ORIGINS` | Opsional. Origin tambahan yang boleh memanggil API (pisahkan koma). |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SEC` | Opsional. Rate limit server per IP (default 10 permintaan / 600 detik). |
| `PROXY_LIST`, `PROXY_SOURCE_URL`, `PROXY_SLOTS`, `PROXY_MAX_USES`, `SCRAPER_FREE_PROXIES` | Opsional. Pool rotasi IP provider (lihat `.env.example`). Tanpa proxy bersih, Cloudflare provider sering meminta verifikasi. |
| `REACT_PROVIDER_MODE`, `REACT_*_*` | Opsional. Tuning mesin provider (mode, percobaan, anggaran waktu). |

Tidak ada API key di frontend. Jangan commit `.env`. Solver pihak ketiga lama (`FGSI_KEY_*`, ScraperAPI, ScrapingBee) sudah tidak dipakai; gantinya browser stealth + rotasi proxy internal.

## QRIS donasi

Taruh gambar QRIS asli milikmu di `assets/qris.png` (persegi, 1:1). Jika berkas belum ada, modal menampilkan
placeholder "QRIS belum tersedia". Saat berkas belum ada, browser mencatat 404 di console ketika modal donasi dibuka.

## Batasan penting

- **Daily limit (5/hari)** disimpan di `localStorage` per browser. Itu bukan identitas pengguna dan bisa direset dengan
  menghapus data browser atau ganti perangkat. Kebijakan: dihitung saat request valid mulai diproses, dikembalikan hanya
  jika server memastikan belum ada yang terkirim (`data.delivered === false`). Timeout atau hasil tidak pasti tetap terhitung
  agar retry tidak menggandakan kiriman.
- **Rate limit server** (`utils/rateLimiter.js`) hidup di memori tiap instance serverless, jadi best-effort, bukan batas global.
  Batas global butuh penyimpanan bersama (belum dikonfigurasi).
- **Middleware** (cookie sesi, filter user-agent, cek origin) hanya mengurangi request otomatis yang sederhana. Cookie bisa
  didapat siapa pun yang membuka halaman. Validasi dan rate limit sebenarnya ada di `api/reactch.js`.

## Struktur

```
index.html  style.css  script.js  middleware.js  vercel.json  package.json
api/reactch.js     handler web: GET konfigurasi publik, POST kirim reaction (tidak berubah)
api/rch.js         adapter provider versi scrape (kontrak sendReact lama, isi baru)
lib/panel.js       mesin reaction: cascade http + browser stealth (Cloudflare)
lib/proxyPool.js   pool rotasi IP (100 slot, proxy mati -> replace otomatis)
utils/validate.js  validasi URL & emoji, dipakai frontend dan backend
utils/dailyLimit.js  limit harian lokal (browser)
utils/rateLimiter.js rate limit backend
assets/qris.png    (taruh sendiri)
```

Respons API: `{ ok, message, code?, data: { delivered: true | false | null } }`. `null` berarti hasil tidak dapat dipastikan.
