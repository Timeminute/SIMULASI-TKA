# Deployment Configuration

## Cara yang benar-benar dipakai (disarankan): deploy Worker saja

`apps/dashboard/public` sudah berisi seluruh website (halaman publik, login,
sampai dashboard admin/laporan lengkap) dan `wrangler.toml` sudah mengikat
folder itu sebagai static assets Worker (`[assets] directory =
"apps/dashboard/public"`). Karena frontend memanggil API lewat path relatif
`/api` (lihat `cloud.js`), ini HARUS satu domain yang sama dengan Worker-nya.
Jadi cukup deploy satu kali:

```
cd api/cloudflare-worker
npx wrangler deploy
```

Jangan menjalankan wrangler deploy dari root repository. Setelah selesai,
seluruh situs (termasuk fitur laporan/keuangan/akademik, karena semuanya
sudah tergabung dalam satu halaman dashboard admin) bisa diakses dari alamat
Worker tersebut, misalnya `https://buatbaru.<subdomain>.workers.dev`.

## Cara alternatif (belum sepenuhnya berfungsi): Cloudflare Pages terpisah

Struktur folder `apps/laporan`, `apps/keuangan`, `apps/akademik` disiapkan
untuk suatu saat di-deploy sebagai project Cloudflare Pages terpisah
(root directory `apps/<nama>`, output directory `public`). **Catatan
penting:** karena `cloud.js` di semua app memanggil API lewat path relatif
`/api`, app yang di-deploy di domain Pages yang berbeda dari Worker tidak
akan bisa memanggil API sama sekali (request akan mengarah ke domain Pages
itu sendiri, bukan ke Worker). Supaya cara ini berfungsi, `LOGIN_SCRIPT_URL`
dan `DATA_SCRIPT_URL` di `cloud.js` tiap app perlu diganti jadi URL Worker
yang absolut (mis. `https://buatbaru.<subdomain>.workers.dev/api`), dan
`ALLOWED_ORIGIN` di Worker perlu diisi sesuai domain Pages tersebut. Selama
itu belum dilakukan, gunakan cara deploy Worker saja di atas.

Juga perlu dicatat, `apps/keuangan` dan `apps/akademik` saat ini tidak
memiliki halaman `index.html` sendiri (hanya modul JS/CSS yang dipakai oleh
halaman dashboard admin di `apps/laporan` / `apps/dashboard`), jadi belum
bisa dijadikan project Pages yang berdiri sendiri sampai halaman masuknya
dibuat.
