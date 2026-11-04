# Memasang ALTIS di aaPanel

> **Ikuti panduan ALTIS, bukan artikel KB hosting.** Artikel aaPanel tentang aplikasi Node.js biasanya menaruh
> aplikasi di `/www/wwwroot/<situs>` dan memakai project tipe **Default**. Untuk ALTIS keduanya salah: folder itu
> adalah *document root* situs, dan tipe Default tidak menjalankan pekerja latar ALTIS. Bila panduan ini berbeda
> dengan artikel hosting atau tutorial aaPanel, ikuti panduan ini.

Tidak perlu terminal. Seluruh langkah dikerjakan lewat aaPanel dan browser, sekitar 15 menit.

## Yang dibutuhkan

- aaPanel dengan **Node.js version manager** yang menyediakan Node.js **22.16** atau lebih baru, dan **PM2 Manager**.
- **MySQL 8** atau **MariaDB 10.6** ke atas yang dipasang lewat aaPanel (menu **App Store**).
- Satu domain atau subdomain untuk ALTIS, mengarah ke server ini. ALTIS dipasang di **akar** domain.
- Berkas rilis `altis-<versi>.zip` dari halaman Releases GitHub (https://github.com/arjunaayasa/altis/releases).

## 1. Siapkan database

aaPanel → **Databases** → **Add database**: nama database `altis`, pengguna `altis`, sandi yang kuat (catat),
*Permission* **Local server**. Database harus **kosong**.

## 2. Empat langkah aaPanel

1. Buat `/www/altis/<nama>/` lewat File Manager dengan pemilik `www`.
2. Ekstrak zip ke `/www/altis/<nama>/app`.
3. Buat Node Project **tipe PM2** dengan `app.js` dan port 3000.
4. Petakan domain.

Rinciannya:

1. **Folder.** aaPanel → **Files**. Masuk ke `/www`, buat folder `altis`, lalu di dalamnya folder dengan nama pendek
   tanpa spasi untuk perpustakaan ini, misalnya `perpus` → `/www/altis/perpus/`. Klik **Permission** pada folder
   itu: pemilik (*owner*) **www**, centang *Apply to subdirectories*.
2. **Ekstrak.** Buat folder `/www/altis/perpus/app`, unggah `altis-<versi>.zip` ke sana, lalu **Unzip** di tempat.
   Folder itu kini berisi `app.js`, `package.json`, folder `bundled-release`, serta `LICENSE` dan `NOTICE` (AGPL-3.0). Pastikan
   pemilik semua berkas tetap **www**.

   Folder data ALTIS dibuat otomatis di sebelahnya: `/www/altis/perpus/altis-data`. Inilah tata letak aaPanel yang
   didukung. **Jangan** memakai `/www/wwwroot/...`: itu *document root* situs, dan ALTIS menolak berjalan di sana
   supaya konfigurasi dan data Anda tidak bisa diunduh orang.
3. **Node Project tipe PM2.** aaPanel → **Website** → **Node project** → **Add Node project**:

   | Isian | Nilai |
   |---|---|
   | Project type / jenis | **PM2** (bukan **Default**) |
   | Project directory | `/www/altis/perpus/app` |
   | Startup file / Run opt | `app.js` |
   | Project port | `3000` |
   | Run user | `www` |
   | Node version | 22.16 atau lebih baru |
   | Instances / mode | **1** instance, mode **fork** (jangan *cluster*) |

   Bila aaPanel menawarkan "install dependencies" atau `npm install`, lewati: ALTIS tidak memerlukan paket npm.
4. **Petakan domain.** Pada project itu, tambahkan domain ALTIS (**Domain manager** / **Mapping**). aaPanel membuat
   proxy Nginx ke port 3000. Lalu buka tab **SSL**, pasang sertifikat Let's Encrypt, dan aktifkan **Force HTTPS**.

### Tipe Default: hanya peringatan, bukan pilihan

Project aaPanel bertipe **Default** menjalankan `app.js` tanpa PM2. ALTIS tetap terbuka, tetapi tidak punya pekerja
latar (backup harian, e-mail, pembersihan) dan tidak dimulai ulang otomatis setelah pembaruan atau gangguan. Wizard
mendeteksinya dan menampilkan peringatan: *"ALTIS berjalan sebagai project aaPanel bertipe Default. Buat ulang
sebagai Node Project bertipe PM2 dengan berkas app.js ..."*. Bila peringatan itu muncul, hapus project tersebut
(berkas di `/www/altis/<nama>` tidak ikut terhapus) dan buat ulang dengan tipe **PM2**.

## 3. Wizard pemasangan

Buka `https://<domain-ALTIS>/install`.

0. **Klaim.** aaPanel → **Files** → `/www/altis/perpus/altis-data/install-code.txt`, salin nilai `"code"`. Kode
   yang sama juga tercetak di log project (tab **Log** pada Node project). Berlaku 24 jam.
1. **Pemeriksaan.** Runtime terdeteksi **PM2 (misalnya aaPanel)**, tanpa peringatan tipe Default. Base URL
   `https://<domain-ALTIS>`. Pada *Proxy dan alamat IP*, Nginx aaPanel dihitung **1** proxy; cocokkan alamat IP yang
   ditampilkan dengan situs pemeriksa IP, lalu konfirmasi.
2. **Database.** **MySQL** atau **MariaDB**, host `127.0.0.1`, port `3306`, database `altis`, pengguna `altis`, dan
   sandinya. SQLite memang ditawarkan pada PM2 satu instance, tetapi untuk aaPanel pakailah MySQL/MariaDB.
3. **Profil**, 4. **Super admin**.
5. **Penjadwal (opsional).** PM2 sudah menjalankan pekerja latar ALTIS. Bila ingin cadangan pemicu, buat aaPanel →
   **Cron** → tugas tipe **Shell Script**, setiap 5 menit, berisi perintah `curl` dari wizard:

   ```
   curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer <token>" https://<domain-ALTIS>/_cron
   ```

   Tokennya rahasia. Bentuk `GET` atau `?token=` tidak didukung.
6. **Selesai.**

## Pembaruan

Lewat menu **Pembaruan** di admin. ALTIS keluar dengan kode 75 setelah pembaruan disiapkan, dan PM2 menjalankannya
lagi otomatis. Biarkan halaman `/admin/_update` terbuka sampai selesai. Bila gagal, ALTIS kembali otomatis ke versi
sebelumnya dengan data utuh. Tanpa internet: unggah zip rilis dari halaman Releases GitHub
(https://github.com/arjunaayasa/altis/releases) di menu **Pembaruan**.

## Bila ada masalah

- **Project berhenti terus (status merah) atau halaman penyelamat:** buka tab **Log** project; pesan ALTIS menyebut
  penyebab dan langkah perbaikannya.
- **Wizard menolak folder ("di dalam document root"):** aplikasi atau folder datanya berada di `/www/wwwroot`.
  Pindahkan ke `/www/altis/<nama>/app`.
- **"SQLite tidak dapat dipakai di PM2 mode cluster"**: project berjalan lebih dari 1 instance atau mode cluster.
  Ubah ke 1 instance mode fork (lihat [pm2.md](pm2.md)).
- **Diagnostik** di admin menampilkan runtime, folder data, penjadwal, `ip_trust`, edisi, dan pembaruan.
- Masih buntu: laporkan di [GitHub Issues](https://github.com/arjunaayasa/altis/issues) dengan teks Diagnostik
  (tanpa sandi atau token).

Aturan operasional ada di [../ops/operations.md](../ops/operations.md).
