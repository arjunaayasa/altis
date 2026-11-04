# Memasang ALTIS di cPanel (Application Manager)

> **Ikuti panduan ALTIS, bukan artikel KB hosting.** Artikel bantuan penyedia hosting ditulis untuk aplikasi
> Node.js pada umumnya. Banyak di antaranya menyuruh menaruh aplikasi di `public_html`, menjalankan `npm install`,
> atau memakai SQLite. Untuk ALTIS ketiganya salah. Bila panduan ini berbeda dengan artikel hosting, ikuti panduan
> ini.

Panduan ini untuk cPanel yang memiliki menu **Application Manager** (cPanel di AlmaLinux atau Rocky Linux dengan
paket Node.js `ea-nodejs22`). Bila cPanel Anda memakai menu **Setup Node.js App** (CloudLinux), ikuti
[cloudlinux.md](cloudlinux.md).

Tidak perlu terminal. Seluruh langkah dikerjakan lewat menu cPanel dan browser, sekitar 15 menit.

## Yang dibutuhkan

- Akun cPanel dengan menu **Application Manager** dan Node.js **22.16 atau lebih baru**. Bila belum ada, minta
  penyedia hosting memasang paket `ea-nodejs22` (atau yang lebih baru).
- Satu domain atau subdomain khusus untuk ALTIS, misalnya `perpus.sekolah.sch.id`, sudah aktif dengan HTTPS
  (AutoSSL). ALTIS dipasang di **akar** domain, tidak di sub-folder seperti `sekolah.sch.id/perpus`.
- Database **MySQL 8.0** atau **MariaDB 10.6** ke atas. SQLite tidak tersedia di cPanel: cPanel menjalankan beberapa
  proses ALTIS sekaligus, dan SQLite hanya aman untuk satu proses.
- Berkas rilis `altis-<versi>.zip` dari halaman Releases GitHub (https://github.com/arjunaayasa/altis/releases).

## 1. Siapkan database

Buka cPanel → **MySQL® Database Wizard**.

1. Buat database, misalnya `altis`. cPanel menambahkan nama akun Anda di depannya, misalnya `akunsaya_altis`.
2. Buat pengguna database dengan sandi yang kuat (pakai **Password Generator**). Catat nama pengguna lengkapnya
   (misalnya `akunsaya_altis`) dan sandinya.
3. Beri pengguna itu **ALL PRIVILEGES** pada database tadi.

Database harus **kosong**. Jangan memakai database yang sudah berisi tabel aplikasi lain.

## 2. Unggah dan ekstrak ALTIS

1. Buka cPanel → **File Manager**. Di folder rumah (*home*), **bukan** di `public_html`, buat folder `altis`, lalu
   di dalamnya folder `app`. Hasilnya `~/altis/app`, misalnya `/home/akunsaya/altis/app`.
2. Masuk ke `~/altis/app`, klik **Upload**, lalu unggah `altis-<versi>.zip`.
3. Klik kanan berkas zip → **Extract** ke `/home/akunsaya/altis/app`. Folder itu kini berisi `app.js`,
   `package.json`, `ecosystem.config.cjs`, folder `bundled-release`, serta `LICENSE` dan `NOTICE` (AGPL-3.0).
4. Berkas zip boleh dihapus setelah diekstrak.

Folder data ALTIS dibuat otomatis di `~/altis-data/app` (nama foldernya mengikuti nama folder aplikasi). Folder ini
menyimpan konfigurasi, berkas unggahan, dan backup. Jangan dihapus, dan jangan dipindah ke dalam `public_html`.
ALTIS menolak berjalan bila folder aplikasi atau folder datanya berada di dalam *document root*, supaya konfigurasi
dan data Anda tidak bisa diunduh orang lewat web.

## 3. Daftarkan aplikasi

Buka cPanel → **Application Manager** → **Register Application**, lalu isi:

| Isian | Nilai |
|---|---|
| Application Name | `altis` |
| Deployment Domain | domain ALTIS, misalnya `perpus.sekolah.sch.id` |
| Base Application URL | `/` (akar domain) |
| Application Path | `altis/app` |
| Deployment Environment | **Production** |
| Environment Variables | tidak perlu diisi |

Klik **Deploy**. Jangan menekan **Ensure dependencies**: ALTIS tidak memerlukan paket npm apa pun.

## 4. Wizard pemasangan

Buka `https://<domain-ALTIS>/install` di browser.

0. **Klaim.** Wizard meminta kode pemasangan. Buka **File Manager** → `~/altis-data/app/install-code.txt`, lalu
   salin nilai `"code"` (26 karakter, misalnya `7K2QD-...`). Kode berlaku 24 jam; bila kedaluwarsa, muat ulang
   halaman wizard dan buka berkas itu lagi.
1. **Pemeriksaan.** Periksa bahwa semua pemeriksaan wajib **Lolos** dan runtime terdeteksi **cPanel (Passenger)**.
   Base URL harus `https://<domain-ALTIS>`. Pada bagian *Proxy dan alamat IP*, cocokkan alamat IP yang ditampilkan
   dengan situs pemeriksa IP mana pun, lalu konfirmasi. Di cPanel biasanya terdeteksi **1** proxy.
2. **Database.** Pilih **MySQL** atau **MariaDB** sesuai server Anda. Host `localhost`, port `3306`, nama database
   dan pengguna **lengkap dengan awalan akun** (`akunsaya_altis`), serta sandinya. Klik **Uji koneksi**, lalu
   **Simpan dan buat tabel**, dan tunggu sampai pembuatan tabel selesai.
3. **Profil** perpustakaan, lalu 4. **Super admin** (simpan sandinya baik-baik; tawaran 2FA sangat disarankan).
5. **Penjadwal.** Di cPanel penjadwal **wajib**. Wizard menampilkan baris cron yang siap disalin, misalnya:

   ```
   */5 * * * * /opt/cpanel/ea-nodejs22/bin/node /home/akunsaya/altis/app/app.js jobs:run
   ```

   Selalu salin baris dari wizard (path Node.js di server Anda bisa berbeda). Buka cPanel → **Cron Jobs**, pilih
   *Common Settings* **Once Per Five Minutes (\*/5 \* \* \* \*)**, lalu tempelkan bagian **setelah** `*/5 * * * *`
   ke kolom **Command**. Klik **Add New Cron Job**. Setelah sekitar 5 menit, klik **Uji penjadwal** di wizard.

   Bila cron dengan perintah `node` tidak diizinkan penyedia hosting, pakai baris alternatif dari wizard:

   ```
   curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer <token>" https://<domain-ALTIS>/_cron
   ```

   Token di baris itu rahasia: jangan dibagikan. `--retry 3 --retry-delay 10` wajib ikut disalin, karena panggilan
   pertama ke aplikasi yang sedang dimulai bisa dijawab 503.
6. **Selesai.** Wizard mengarahkan Anda ke halaman masuk.

## Pembaruan

Buka menu **Pembaruan** di admin ALTIS. Saat pembaruan berjalan, ALTIS masuk mode pemeliharaan, membuat backup,
lalu memulai ulang dirinya sendiri (lewat `tmp/restart.txt`, tanpa perlu menekan **Restart** di panel). Biarkan
halaman `/admin/_update` terbuka sampai selesai: selama halaman itu terbuka, pembaruan tetap berjalan walaupun cron
belum sempat jalan. Bila pembaruan gagal, ALTIS kembali otomatis ke versi sebelumnya dengan data utuh.

Bila server tidak bisa mengambil pembaruan dari internet, unggah paket pembaruan (zip rilis dari halaman Releases
GitHub, https://github.com/arjunaayasa/altis/releases) di menu **Pembaruan**. Cara lain: ekstrak zip versi baru ke
`~/altis/app` (timpa berkas lama), lalu buka situs. ALTIS mendeteksi rilis yang lebih baru dan menjalankan alur
pembaruan yang sama, termasuk pemeriksaan kecocokan dan backup.

## Bila ada masalah

- **Halaman "sedang dimulai" (503) lebih dari 1 menit**, atau halaman penyelamat berbahasa Indonesia/Inggris: baca
  pesannya, karena pesan itu menyebut penyebab dan langkah perbaikannya (Node terlalu lama, folder data tidak dapat
  ditulis, folder di dalam `public_html`, dan sebagainya).
- **Wizard menolak database: "tidak kosong".** Buat database baru yang kosong.
- **Setelah masuk:** menu **Diagnostik** menampilkan runtime, folder data, penjadwal, `ip_trust`, edisi, dan
  pembaruan. Bila masalahnya belum terpecahkan, laporkan di
  [GitHub Issues](https://github.com/arjunaayasa/altis/issues) dengan teks Diagnostik itu (tanpa sandi atau token).
- Bila cPanel Anda menyediakan **Terminal**: `/opt/cpanel/ea-nodejs22/bin/node ~/altis/app/app.js doctor`
  memeriksa semua hal di atas dari sisi server.

Aturan operasional (folder data, backup, cron) ada di [../ops/operations.md](../ops/operations.md).
