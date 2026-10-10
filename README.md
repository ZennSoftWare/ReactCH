# xzeerh-reactchannel (REACTCH)

Website untuk mengirim emoji reaction ke pesan WhatsApp Channel. Frontend statis + fungsi serverless Vercel.

## Status integrasi provider (baca dulu)

Backend memanggil `POST https://react.keyysspanel.web.id/api/react` (diambil dari `reactch.js` lama).
Script CLI lama menyelesaikan Cloudflare Turnstile milik provider memakai layanan solver pihak ketiga. Bagian itu
**sengaja tidak diimplementasikan** karena mengakali proteksi provider.

Akibatnya, jika provider mewajibkan token Turnstile, API mengembalikan `PROVIDER_VERIFICATION_REQUIRED` dan UI
menampilkan "GAGAL DIPROSES" dengan penjelasan. Website tidak pernah menampilkan sukses palsu: sukses hanya jika
provider menjawab `success: true`. Agar pengiriman benar-benar berjalan, butuh cara verifikasi yang resmi dari provider
(mis. API key atau izin lewat mekanisme yang mereka sediakan). Tambahkan di `api/rch.js`, fungsi `sendReact`.

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

Tidak ada API key di frontend. Jangan commit `.env`. `FGSI_KEY_*` tidak dipakai karena hanya melayani solver Turnstile di atas.

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
api/reactch.js     handler web: GET konfigurasi publik, POST kirim reaction
api/rch.js         adapter provider (bukan endpoint publik)
utils/validate.js  validasi URL & emoji, dipakai frontend dan backend
utils/dailyLimit.js  limit harian lokal (browser)
utils/rateLimiter.js rate limit backend
assets/qris.png    (taruh sendiri)
```

Respons API: `{ ok, message, code?, data: { delivered: true | false | null } }`. `null` berarti hasil tidak dapat dipastikan.
