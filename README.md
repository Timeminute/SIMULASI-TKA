# Kelas Senja Multi App Migration

Migrasi arsitektur dari single dashboard menjadi multi aplikasi.

## Struktur
- apps/dashboard: dashboard utama dan navigasi.
- apps/laporan: modul laporan/jadwal laporan.
- apps/keuangan: invoice, pembayaran, transaksi.
- apps/akademik: bank soal dan pelatihan.
- shared: modul bersama.
- api/cloudflare-worker: backend Cloudflare Worker.
- database: referensi struktur D1.

## Perubahan
Dashboard tidak lagi memuat semua fitur besar pada startup. Fitur berat dipisahkan sehingga hanya dibuka ketika aplikasi terkait digunakan.

## Database
Semua aplikasi tetap menggunakan Cloudflare D1 yang sama melalui Worker.

## Catatan
Folder database menyimpan sumber schema dari implementasi database asli. Query dan tabel tetap mengikuti backend lama.
