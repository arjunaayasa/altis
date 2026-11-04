# Memasang ALTIS di cPanel CloudLinux (Setup Node.js App)

> **Ikuti panduan ALTIS, bukan artikel KB hosting.** Artikel bantuan penyedia hosting ditulis untuk aplikasi
> Node.js pada umumnya. Banyak di antaranya menyuruh menaruh aplikasi di `public_html`, menekan **Run NPM Install**,
> atau memakai SQLite. Untuk ALTIS ketiganya salah. Bila panduan ini berbeda dengan artikel hosting, ikuti panduan
> ini.

Panduan ini untuk cPanel di CloudLinux yang memiliki menu **Setup Node.js App**, baik dengan server web Apache
maupun LiteSpeed. Bila cPanel Anda memakai menu **Application Manager**, ikuti [cpanel.md](cpanel.md).

Tidak perlu terminal. Seluruh langkah dikerjakan lewat menu cPanel dan browser, sekitar 15 menit.

## Yang dibutuhkan

- Akun cPanel CloudLinux dengan menu **Setup Node.js App** yang menyediakan Node.js **22** atau **24** (versi
  22.16 ke atas).
- Satu domain atau subdomain khusus untuk ALTIS, misalnya `perpus.sekolah.sch.id`, sudah aktif dengan HTTPS
  (AutoSSL). ALTIS dipasang di **akar** domain, tidak di sub-folder.
- Database **MySQL 8.0** atau **MariaDB 10.6** ke atas. SQLite tidak tersedia di cPanel: server menjalankan beberapa
  proses ALTIS sekaligus, dan SQLite hanya aman untuk satu proses.
- Memori proses (PMEM) paling sedikit 512 MB. Tanyakan ke penyedia hosting bila ragu.
- Berkas rilis `altis-<versi>.zip` dari halaman Releases GitHub (https://github.com/arjunaayasa/altis/releases).

## 1. Siapkan database

Buka cPanel → **MySQL® Database Wizard**:

1. Buat database, misalnya `altis` (menjadi `akunsaya_altis`).
2. Buat pengguna database dengan sandi yang kuat. Catat nama pengguna lengkap dan sandinya.
3. Beri pengguna itu **ALL PRIVILEGES** pada database tadi.

Database harus **kosong**.

## 2. Unggah dan ekstrak ALTIS

1. Buka **File Manager**. Di folder rumah (*home*), **di luar** `public_html`, buat folder `altis/app`. Hasilnya
   `~/altis/app`, misalnya `/home/akunsaya/altis/app`.
2. Unggah `altis-<versi>.zip` ke `~/altis/app`, klik kanan → **Extract**. Folder itu kini berisi `app.js`,
   `package.json`, folder `bundled-release`, serta `LICENSE` dan `NOTICE` (AGPL-3.0).

Folder data ALTIS dibuat otomatis di `~/altis-data/app`. Jangan dihapus, dan jangan dipindah ke dalam `public_html`:
ALTIS menolak berjalan bila folder aplikasi atau folder datanya berada di dalam *document root*.

## 3. Buat aplikasi Node.js

Buka cPanel → **Setup Node.js App** → **Create Application**, lalu isi:

| Isian | Nilai |
|---|---|
| Node.js version | **22** atau **24** (22.16 ke atas) |
| Application mode | **Production** |
| Application root | `altis/app` |
| Application URL | domain ALTIS, path dikosongkan (akar domain) |
| Application startup file | `app.js` |
| Passenger log file | boleh dikosongkan; bila diisi, letakkan di luar `public_html`, misalnya `/home/akunsaya/altis/passenger.log` |
| Environment variables | tidak perlu diisi |

Klik **Create**. Jangan menekan **Run NPM Install**: ALTIS tidak memerlukan paket npm apa pun.

Bila panel membuat `app.js` contoh sendiri (misalnya karena aplikasi dibuat sebelum zip diekstrak), ekstrak lagi
zip ALTIS ke `~/altis/app` dan pilih menimpa berkas yang ada, lalu tekan **Restart** di Setup Node.js App.

Di bagian atas halaman aplikasi, panel menampilkan perintah untuk masuk ke lingkungan virtual, misalnya
`source /home/akunsaya/nodevenv/altis/app/22/bin/activate`. Bagian `/home/akunsaya/nodevenv/altis/app/22` itulah
`<nodevenv>` yang dipakai baris cron di bawah.

## 4. Wizard pemasangan

Buka `https://<domain-ALTIS>/install` di browser.

0. **Klaim.** Buka **File Manager** → `~/altis-data/app/install-code.txt`, salin nilai `"code"`, lalu tempelkan di
   wizard. Kode berlaku 24 jam; bila kedaluwarsa, muat ulang halaman wizard dan buka berkas itu lagi.
1. **Pemeriksaan.** Semua pemeriksaan wajib harus **Lolos**. Runtime terdeteksi **cPanel (Passenger)** pada server
   Apache, atau **LiteSpeed** pada server LiteSpeed. Base URL harus `https://<domain-ALTIS>`. Pada bagian *Proxy dan
   alamat IP*, cocokkan alamat IP yang ditampilkan dengan situs pemeriksa IP, lalu konfirmasi (biasanya **1**
   proxy). Bila pemeriksaan WebAssembly gagal, tambahkan variabel lingkungan
   `NODE_OPTIONS=--disable-wasm-trap-handler` di Setup Node.js App, tekan **Restart**, lalu ulangi pemeriksaan.
2. **Database.** **MySQL** atau **MariaDB**, host `localhost`, port `3306`, nama database dan pengguna lengkap dengan
   awalan akun, serta sandinya. **Uji koneksi**, lalu **Simpan dan buat tabel**.
3. **Profil**, 4. **Super admin**.
5. **Penjadwal (wajib).** Wizard menampilkan baris cron, dengan path `<nodevenv>` yang sudah terdeteksi:

   ```
   */5 * * * * /home/akunsaya/nodevenv/altis/app/22/bin/node /home/akunsaya/altis/app/app.js jobs:run
   ```

   Bentuk umumnya `*/5 * * * * <nodevenv>/bin/node <appRoot>/app.js jobs:run`, dengan `<appRoot>` = `~/altis/app`.
   Selalu salin baris dari wizard. Buka cPanel → **Cron Jobs**, pilih *Common Settings* **Once Per Five Minutes**,
   tempelkan bagian **setelah** `*/5 * * * *` ke kolom **Command**, lalu **Add New Cron Job**. Setelah sekitar
   5 menit, klik **Uji penjadwal** di wizard.

   Alternatif bila cron `node` tidak bisa dipakai (salin dari wizard; tokennya rahasia):

   ```
   curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer <token>" https://<domain-ALTIS>/_cron
   ```

   `--retry 3 --retry-delay 10` wajib ikut: panggilan pertama ke proses yang sedang dimulai bisa dijawab 503, dan
   curl mengulanginya.
6. **Selesai.**

## Pembaruan

Lewat menu **Pembaruan** di admin. ALTIS memulai ulang dirinya sendiri (lewat `tmp/restart.txt` di folder aplikasi)
tanpa tombol **Restart** di panel. Biarkan halaman `/admin/_update` terbuka sampai selesai. Bila pembaruan gagal,
ALTIS kembali otomatis ke versi sebelumnya dengan data utuh. Tanpa internet: unggah zip rilis dari halaman Releases
GitHub (https://github.com/arjunaayasa/altis/releases) di menu **Pembaruan**.

Saat mengganti versi Node.js di Setup Node.js App, path `<nodevenv>` ikut berubah (misalnya `.../22/...` menjadi
`.../24/...`). Perbarui juga baris cron, lalu periksa **Diagnostik**.

## Bila ada masalah

- **503 atau halaman penyelamat:** baca pesannya; pesan itu menyebut penyebab dan langkah perbaikannya.
- **Proses berhenti saat beban tinggi:** batas memori (PMEM) terlalu kecil. Minta penyedia hosting menaikkannya.
- **Diagnostik** di admin menampilkan runtime, folder data, penjadwal, `ip_trust`, edisi, dan pembaruan.
- Dengan Terminal cPanel: jalankan perintah `source` dari halaman aplikasi, lalu `node ~/altis/app/app.js doctor`.
- Masih buntu: laporkan di [GitHub Issues](https://github.com/arjunaayasa/altis/issues) dengan teks Diagnostik
  (tanpa sandi atau token).

Aturan operasional ada di [../ops/operations.md](../ops/operations.md).
