# ☕ Five5Star Coffee — Aplikasi Kasir (POS) Full Stack

Aplikasi kasir untuk **Five5Star Coffee**. Pelanggan memesan sendiri dari **tablet di meja** (atau HP lewat QR).
Pesanan masuk ke **kasir** dan **barista**, lalu tampil di **monitor antrean**. Saat pesanan selesai dibuat,
nomor antrean **otomatis dipanggil dengan suara** ("Nomor antrean A 12, atas nama Rina, Meja 3. Pesanan Anda sudah siap.").

Berjalan di **Cloudflare Workers** (tanpa server sendiri), bisa dibuka dari browser, dipasang sebagai PWA,
atau lewat **APK Android** (WebView) untuk tablet & TV box.

## Fitur

| Layar | Alamat | Untuk |
|---|---|---|
| Menu utama | `/` | Pilih mode perangkat (diingat per perangkat) |
| Tablet meja | `/meja.html` | Pelanggan pilih menu + opsi (ukuran, suhu), keranjang, kirim pesanan, lacak status, panggil pelayan |
| Kasir | `/kasir.html` | Konfirmasi pesanan, order manual, pembayaran (Tunai/QRIS/Debit/Transfer + kembalian), cetak struk, stok masuk/terbuang, catat pengeluaran, ringkasan & tutup kasir harian |
| Barista / Dapur | `/dapur.html` | Tiket pesanan + timer, tombol **Selesai dibuat → Panggil**, panggil ulang, tandai menu habis |
| Monitor antrean | `/antrean.html` | Layar TV: "Sedang Dibuat" & "Silakan Diambil", panggilan suara + bunyi ding-dong |
| Superadmin | `/admin.html` | Laporan & **laba rugi harian / bulanan / tahunan / rentang**, ekspor CSV, menu & resep (HPP), stok bahan & opname, keuangan, meja & QR, pengguna, pengaturan |

**Peran pengguna**

- **Superadmin** — akses penuh semua layar, laporan laba rugi, menu, stok opname, keuangan, pengguna, pengaturan.
- **Kasir** — kasir + layar barista, pembayaran, catat pembelian stok/terbuang & pengeluaran hari ini, ringkasan penjualan harian (tanpa angka laba).

PIN awal: **Superadmin `123456`**, **Kasir `1111`** → segera ganti di *Superadmin → Pengguna*.

**Keuangan & stok**

- Bahan baku dengan satuan, stok minimum (peringatan stok menipis realtime), harga rata-rata tertimbang dari pembelian.
- **Resep per produk** (bisa per opsi, mis. bahan tambahan untuk "Large" atau cup untuk "Ice"). Stok berkurang otomatis saat pesanan diterima dan dikembalikan bila dibatalkan.
- **HPP** dihitung dari resep, atau isi HPP manual per produk.
- **Laba rugi**: Penjualan bersih − HPP = Laba kotor − selisih stok − biaya operasional + pendapatan lain = **Laba bersih**. Pajak dicatat terpisah sebagai titipan.
- Laporan harian (dengan jam ramai), bulanan (rincian per hari), tahunan (rincian per bulan), produk terlaris + margin, metode bayar, ekspor CSV (Excel).

**PPN & biaya tambahan**: harga menu sudah termasuk PPN (default 11%, PPN dihitung dari dalam harga). Biaya tambahan
otomatis (persen/nominal; semua pesanan, makan di tempat, atau bawa pulang) diatur di *Superadmin → Pengaturan*.

**QRIS (statis bank / e-wallet)**: upload foto stiker QRIS di *Superadmin → Pengaturan → QRIS*. Aplikasi membuat QRIS
dengan **nominal otomatis** per pesanan (dana tetap masuk ke akun QRIS toko). Alur: pelanggan pilih *Bayar QRIS* di tablet
→ scan & bayar → tekan *Saya sudah bayar* → kasir mendapat notifikasi realtime → cek dana di aplikasi QRIS merchant →
tekan *QRIS sudah masuk* → pesanan **lunas & otomatis masuk antrean dapur**, tablet meja ikut berubah realtime.
QRIS statis tidak mengirim notifikasi ke aplikasi, sehingga verifikasi dana tetap 1 ketukan kasir; untuk konfirmasi
100% otomatis dibutuhkan QRIS dari payment gateway (mis. Midtrans/Xendit) yang punya webhook.

**Menu** sudah terisi dari *Buku Menu Five5Star (26 Oktober)*: 113 produk dalam 20 kategori lengkap dengan foto
(`public/img/menu/`), harga Regular/Large, dan opsi Hot/Ice. HPP/resep belum diisi — lengkapi di *Superadmin → Menu & Resep*
agar laporan laba akurat.

## Arsitektur

```
Tablet meja / Kasir / Barista / Monitor / Superadmin  (browser, PWA, atau APK Android WebView)
            │  HTTPS (REST /api/*)        │  WebSocket (/ws) realtime
            ▼                             ▼
   Cloudflare Worker (src/index.js) ──► Durable Object "CafeStore"
     • aset statis /public                 • SQLite bawaan Durable Object (data permanen)
                                           • logika pesanan, stok, laporan (src/store.js)
                                           • siaran realtime ke kasir/barista/monitor/meja
```

Satu Durable Object = satu sumber data yang konsisten untuk kafe (tanpa bentrok nomor antrean), plus WebSocket hibernasi
sehingga hemat biaya. Semua harga dihitung ulang di server (harga dari tablet tidak dipercaya).

## Menjalankan lokal

Butuh Node.js 20+.

```bash
npm install
```

```bash
npm run dev
```

Buka `http://localhost:8787`. Untuk tablet di Wi-Fi yang sama, buka `http://IP-KOMPUTER:8787`.

```bash
npm test
```

(Tes berjalan di runtime Cloudflare asli lewat `wrangler dev`.)

## Deploy ke Cloudflare Workers

1. Login sekali:

```bash
npx wrangler login
```

2. (Disarankan) Set PIN awal sebelum deploy pertama:

```bash
npx wrangler secret put SUPERADMIN_PIN
```

```bash
npx wrangler secret put KASIR_PIN
```

3. Deploy:

```bash
npm run deploy
```

Aplikasi tersedia di `https://kasir-five5star.<akun-anda>.workers.dev` (bisa dipasang domain sendiri di dashboard Cloudflare).
Durable Object SQLite tersedia di paket gratis Workers.

**Deploy otomatis via GitHub Actions**: isi secret repo `CLOUDFLARE_API_TOKEN` dan `CLOUDFLARE_ACCOUNT_ID`;
setiap push ke `main` akan dites lalu dideploy (`.github/workflows/ci.yml`).

## Menyiapkan perangkat

- **Tablet meja**: buka `/meja.html` → *Atur Meja* → login staf → pilih meja. Tablet akan selalu membuka meja itu.
  Atau cetak QR di *Superadmin → Meja & QR* dan tempel di meja — pelanggan bisa scan dengan HP sendiri.
- **Monitor antrean (TV)**: buka `/antrean.html` di TV box/Android TV/PC yang tersambung TV, ketuk *Aktifkan Suara*.
  Pastikan suara **Bahasa Indonesia** terpasang (Android: Setelan → Text-to-speech → Google → Bahasa Indonesia).
- **Barista**: buka `/dapur.html` di tablet bar.
- **Printer struk**: pakai printer thermal 58/80mm yang terpasang sebagai printer sistem; struk dicetak lewat dialog cetak.

## APK Android (WebView)

Proyek ada di `android/` (Kotlin, minSdk 26). Fitur: layar penuh, layar tidak mati, suara panggilan memakai
**TextToSpeech native** (lebih andal daripada Web Speech di WebView), cetak struk via PrintManager, unggah foto menu,
menu tombol *Kembali* untuk ganti alamat server / mode perangkat.

- **Build lewat GitHub Actions**: buka tab *Actions → Build APK Android → Run workflow*. Isi variabel repo `SERVER_URL`
  (alamat Workers) agar APK langsung terarah ke server. Hasil APK ada di *Artifacts*.
  Opsional untuk rilis: secret `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- **Build lokal** (Android Studio / Android SDK):

```bash
cd android && ./gradlew assembleRelease -PserverUrl=https://kasir-five5star.akun-anda.workers.dev
```

Jika `serverUrl` kosong, aplikasi menanyakan alamat server saat pertama dibuka.

## Struktur

```
src/            Worker + Durable Object (index.js, store.js = API & logika, db.js = skema & seed, router.js)
src/menu-seed.js  Menu hasil ekstraksi buku menu PDF
public/         Frontend (HTML/CSS/JS tanpa build step), foto menu, PWA
android/        Aplikasi Android WebView
scripts/        extract_menu.py — ekstrak menu & foto dari PDF buku menu
test/           Tes API end-to-end di runtime Workers
```

Memperbarui menu dari PDF baru (butuh Python + `pymupdf` + `Pillow`), lalu sesuaikan `scripts/menu_data.py`:

```bash
python3 scripts/extract_menu.py BUKU_MENU.pdf
```

Seed menu hanya dipakai saat database masih kosong; setelah berjalan, ubah menu lewat *Superadmin → Menu & Resep*.
