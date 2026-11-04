# Memasang ALTIS dengan PM2 (VPS)

> **Ikuti panduan ALTIS, bukan artikel KB hosting.** Tutorial PM2 di internet sering memakai `pm2 start app.js -i
> max` (mode *cluster*) dan `npm install`. Untuk ALTIS keduanya tidak dipakai: ALTIS berjalan **1 instance dalam
> mode fork**, dan zip rilisnya sudah lengkap. Bila panduan ini berbeda dengan artikel hosting, ikuti panduan ini.

Panduan ini untuk VPS Linux yang Anda kelola sendiri dengan PM2. Untuk aaPanel (yang juga memakai PM2), ikuti
[aapanel.md](aapanel.md).

## Yang dibutuhkan

- Node.js **22.16** atau lebih baru, dan PM2 (`npm install -g pm2`, sekali saja, oleh administrator server).
- Pengguna Linux khusus untuk ALTIS, misalnya `altis` (jangan `root`).
- Database **MySQL 8.0**, **MariaDB 10.6+**, atau **PostgreSQL 15+**, dengan database kosong dan pengguna yang hanya
  berhak atas database itu. SQLite boleh, **hanya** dengan PM2 satu instance mode fork (lihat di bawah).
- Proxy TLS di depan ALTIS (Nginx, Caddy, atau Apache) untuk domain ALTIS.
- Berkas rilis `altis-<versi>.zip` dari halaman Releases GitHub (https://github.com/arjunaayasa/altis/releases).

## 1. Ekstrak

Sebagai pengguna `altis`:

```sh
mkdir -p ~/altis/app
cd ~/altis/app
unzip /path/ke/altis-<versi>.zip
```

Folder data dibuat otomatis di `~/altis/altis-data` (di sebelah folder aplikasi). Bila ingin di tempat lain, isi
variabel `ALTIS_DATA_DIR` di `ecosystem.config.cjs` (lihat di bawah), dan baca aturan folder data di
[../ops/operations.md](../ops/operations.md): harus di disk lokal, bukan NFS, dan tidak dibagi dengan server lain.

## 2. `ecosystem.config.cjs`

Zip ALTIS sudah berisi `ecosystem.config.cjs`:

```js
module.exports = {apps:[{name:'altis', script:'app.js', exec_mode:'fork', instances:1, autorestart:true, max_memory_restart:'450M', env:{NODE_ENV:'production'}}]}
```

Yang wajib dipertahankan:

- `exec_mode: 'fork'` dan `instances: 1`. ALTIS menjalankan pekerja latarnya sendiri di proses itu.
- `autorestart: true`. Setelah pembaruan disiapkan, ALTIS keluar dengan kode 75 dan PM2 menjalankannya lagi.

Variabel tambahan (opsional) masuk ke `env`, misalnya `ALTIS_PORT: '3000'` atau `ALTIS_DATA_DIR: '/srv/altis-data'`.

### SQLite dan mode cluster: ditolak

SQLite hanya aman untuk **satu** proses. Bila database ALTIS adalah SQLite dan PM2 menjalankannya dalam
mode cluster (`exec_mode: 'cluster'`, `pm2 start -i ...`), dengan `instances` lebih dari 1, atau sebagai instance
kedua (`NODE_APP_INSTANCE` selain 0), ALTIS **menolak mulai** dengan galat `SQLITE_NOT_ALLOWED` yang menyebut tanda
dari PM2, misalnya `instances=2` atau `exec_mode=cluster_mode`, dan `node app.js doctor` (bila dijalankan oleh PM2)
menggagalkan pemeriksaan `runtime` dengan alasan yang sama. Perbaikannya: kembalikan ke 1 instance mode fork.

```sh
pm2 delete altis
pm2 start ecosystem.config.cjs
pm2 describe altis      # "exec mode" harus fork_mode, dan hanya ada satu proses altis
```

Dengan MySQL, MariaDB, atau PostgreSQL penolakan ini tidak berlaku, tetapi tetap pakai 1 instance mode fork.

## 3. Jalankan

```sh
cd ~/altis/app
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # ikuti perintah yang dicetaknya (sekali, sebagai root), supaya ALTIS hidup lagi setelah reboot
pm2 logs altis       # kode pemasangan tercetak di sini
```

ALTIS mendengarkan di port 3000 pada semua antarmuka. Tutup port itu dari luar dengan firewall, dan buka ALTIS
hanya lewat proxy TLS.

## 4. Proxy TLS

Contoh Caddy (`/etc/caddy/Caddyfile`):

```
perpus.sekolah.sch.id {
    reverse_proxy 127.0.0.1:3000
}
```

Contoh Nginx (di dalam blok `server` dengan TLS):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;              # supaya progres langsung (SSE) tidak tertahan
    client_max_body_size 20m;         # paket pembaruan dan unggahan berpotongan
}
```

Dengan satu proxy di depan ALTIS, jumlah proxy tepercaya (*hops*) = **1**. Tambah 1 bila ada Cloudflare di depan
proxy itu.

## 5. Wizard pemasangan

Buka `https://<domain-ALTIS>/install`. Kode pemasangan ada di `pm2 logs altis` dan di
`~/altis/altis-data/install-code.txt`. Langkah **Pemeriksaan** harus menunjukkan runtime **PM2** dan mengusulkan
1 proxy. Langkah **Penjadwal** opsional: PM2 sudah menjalankan pekerja latar ALTIS.

## Pembaruan

Lewat menu **Pembaruan** di admin. Biarkan halaman `/admin/_update` terbuka sampai selesai. PM2 menjalankan ulang
ALTIS dengan sendirinya; jangan `pm2 restart` di tengah pembaruan. Bila gagal, ALTIS kembali otomatis ke versi
sebelumnya dengan data utuh. Tanpa internet: unggah zip rilis dari halaman Releases GitHub
(https://github.com/arjunaayasa/altis/releases) di menu **Pembaruan**.

## Bila ada masalah

- `pm2 logs altis` dan `node ~/altis/app/app.js doctor`.
- Proses terus dimulai ulang dengan `SQLITE_NOT_ALLOWED`: lihat bagian **SQLite dan mode cluster** di atas.
- Aturan operasional ada di [../ops/operations.md](../ops/operations.md).
- Masih buntu: laporkan di [GitHub Issues](https://github.com/arjunaayasa/altis/issues) dengan keluaran `doctor`
  (tanpa sandi atau token).
