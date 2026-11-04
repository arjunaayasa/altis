# Menjalankan ALTIS dengan Node lokal (satu PC)

> **Ikuti panduan ALTIS, bukan artikel KB hosting.** Tutorial Node.js umum menyuruh `npm install` dan `npm start`.
> ALTIS tidak memerlukan keduanya: zip rilis sudah lengkap, dan satu perintah `node app.js` sudah cukup. Bila panduan
> ini berbeda dengan artikel lain, ikuti panduan ini.

Cara ini untuk satu PC (Windows, macOS, atau Linux), misalnya di perpustakaan sekolah tanpa server, atau untuk
mencoba ALTIS. Paket PC dengan pemasang Windows dan layanan otomatis direncanakan; sampai saat itu ALTIS dijalankan
dari terminal.

## Yang dibutuhkan

- Node.js **22.16** atau lebih baru dari [nodejs.org](https://nodejs.org) (versi LTS). Periksa dengan `node -v`.
- Berkas rilis `altis-<versi>.zip` dari halaman Releases GitHub (https://github.com/arjunaayasa/altis/releases).
- Database: **SQLite** (bawaan, tanpa pemasangan apa pun) cukup untuk satu PC. MySQL, MariaDB, atau PostgreSQL juga
  bisa bila sudah ada.

## 1. Ekstrak dan jalankan

Ekstrak zip ke sebuah folder, misalnya `C:\altis\app` atau `~/altis/app`, lalu dari folder itu:

```sh
node app.js
```

Terminal menampilkan **kode pemasangan**. Biarkan terminal tetap terbuka: menutupnya menghentikan ALTIS. Untuk
berhenti, tekan `Ctrl+C`.

- Folder data dibuat otomatis di sebelah folder aplikasi: `C:\altis\altis-data` atau `~/altis/altis-data`. Simpan
  folder ini baik-baik; isinya konfigurasi, database SQLite, unggahan, dan backup.
- Port bawaan 3000. Bila sudah terpakai, jalankan dengan port lain, misalnya `ALTIS_PORT=3080 node app.js`
  (Windows PowerShell: `$env:ALTIS_PORT=3080; node app.js`).
- `node app.js` mengawasi prosesnya sendiri: setelah pembaruan, ALTIS memulai ulang dirinya tanpa perlu menjalankan
  perintah lagi.

## 2. Wizard pemasangan

Buka `http://127.0.0.1:3000/install` di browser PC itu.

0. **Klaim:** masukkan kode dari terminal (ada juga di `altis-data/install-code.txt`).
1. **Pemeriksaan:** runtime **Proses mandiri (PC)**; base URL `http://127.0.0.1:3000`, atau alamat IP PC di jaringan
   (misalnya `http://192.168.1.10:3000`) bila ALTIS akan dibuka dari komputer lain. Tanpa proxy: hops **0**.
2. **Database:** **SQLite** (tidak perlu isian lain), atau database server yang Anda punya.
3. **Profil**, 4. **Super admin**.
5. **Penjadwal:** opsional; ALTIS menjalankan pekerja latarnya sendiri selama `node app.js` berjalan.
6. **Selesai.**

## Dibuka dari komputer lain di jaringan

ALTIS mendengarkan di semua antarmuka jaringan PC itu. Izinkan port 3000 di firewall PC hanya untuk jaringan lokal,
dan pakai base URL dengan alamat IP tetap PC itu. Jangan membukanya langsung ke internet; untuk itu pakai server
dengan proxy TLS ([docker.md](docker.md) atau [pm2.md](pm2.md)).

## Pembaruan

Lewat menu **Pembaruan** di admin, atau, bila PC tidak tersambung ke internet, unggah zip rilis dari halaman Releases
GitHub (https://github.com/arjunaayasa/altis/releases) di menu itu. Biarkan `node app.js` tetap berjalan; ALTIS
memulai ulang dirinya sendiri.

## Bila ada masalah

- Pesan di terminal menyebut penyebab dan langkah perbaikannya (misalnya Node.js terlalu lama, port terpakai).
- `node app.js doctor` (dari folder aplikasi, di terminal lain) memeriksa seluruh pemasangan.
- Aturan operasional ada di [../ops/operations.md](../ops/operations.md).
- Masih buntu: laporkan di [GitHub Issues](https://github.com/arjunaayasa/altis/issues) dengan keluaran `doctor`
  (tanpa sandi atau token).
