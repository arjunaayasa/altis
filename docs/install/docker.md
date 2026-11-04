# Memasang ALTIS dengan Docker

> **Ikuti panduan ALTIS, bukan artikel KB hosting.** Tutorial Docker umum sering membuka port database ke luar,
> memakai sandi contoh, atau menjalankan kontainer sebagai root. `compose.yml` ALTIS sudah diperkeras untuk itu;
> jangan mengubahnya mengikuti artikel lain. Bila panduan ini berbeda dengan artikel hosting, ikuti panduan ini.

Hanya tiga perintah yang diketik di terminal: `./altis-init`, `docker compose up -d`, dan (saat pembaruan)
`docker compose pull && docker compose up -d`. Sisanya lewat browser.

## Yang dibutuhkan

- Server Linux (VPS) dengan Docker Engine dan plugin Docker Compose v2 (`docker compose version`).
- Satu domain atau subdomain untuk ALTIS yang mengarah ke server ini, dan proxy TLS di server yang sama (Caddy,
  Nginx, atau Traefik).
- Berkas Docker ALTIS dari folder [`docker/`](https://github.com/arjunaayasa/altis/tree/main/docker) repositori:
  `compose.yml`, `altis-init`, dan (bila image dibangun sendiri) `Dockerfile`, `entrypoint.sh`, `.dockerignore`,
  serta zip rilis dari halaman Releases GitHub (https://github.com/arjunaayasa/altis/releases).

> **Image resmi belum diterbitkan;** bangun image dari zip rilis (langkah 2b). Image publik direncanakan di
> `ghcr.io/arjunaayasa/altis`.

## 1. `./altis-init`

Taruh berkas Docker (dari folder `docker/` repositori) di satu folder, misalnya `~/altis`. Bila berkasnya diunduh
satu per satu, bukan lewat `git clone`, jadikan dulu dapat dijalankan: `chmod +x altis-init`. Lalu dari folder itu:

```sh
cd ~/altis
./altis-init
```

`altis-init` menulis `.env` (mode 600, hanya bisa dibaca pemiliknya) berisi:

- `ALTIS_DB_PASSWORD`: sandi acak 32 karakter untuk pengguna database `altis`;
- `ALTIS_DB_ROOT_PASSWORD`: sandi acak 32 karakter untuk root database (ALTIS tidak memakainya);
- `ALTIS_INSTALL_CODE`: kode pemasangan acak, 26 karakter dalam grup 5-5-5-5-6.

Lalu **menampilkan kode pemasangan**. Catat kodenya; kode itu juga tetap ada di `.env`. Sandi tidak pernah
ditampilkan.

Aturan `.env`:

- Simpan `.env` di folder yang sama dengan `compose.yml`. Jangan dibagikan, jangan di-*commit* ke git, dan buat
  salinannya di tempat aman: tanpa sandi di dalamnya, database tidak bisa dibuka.
- Tanpa `.env`, setiap perintah `docker compose` berhenti dengan pesan `jalankan ./altis-init dulu`.
- `altis-init` tidak pernah menimpa `.env` yang sudah ada (keluar dengan kode 1). `./altis-init --force` membuat
  `.env` baru dan menyimpan yang lama sebagai `.env.bak`, **hanya untuk instalasi baru**: volume database yang
  sudah dibuat tetap memakai sandi lamanya, sehingga ALTIS tidak bisa lagi membukanya dengan sandi baru.
- `.env.bak` tidak pernah ditimpa: selama berkas itu ada, `./altis-init --force` ditolak. Pindahkan dulu ke tempat
  aman (isinya bisa jadi satu-satunya salinan sandi volume database lama). Seperti `.env`, `.env.bak` berisi sandi:
  jangan dibagikan dan jangan di-*commit*.

## 2. Image

**a. Image resmi** (setelah diterbitkan): tambahkan ke `.env` sebuah baris
`ALTIS_IMAGE=ghcr.io/arjunaayasa/altis:<versi>`, lalu `docker compose pull`. Image resmi belum diterbitkan; sampai
saat itu, pakai cara b.

**b. Dibangun dari zip rilis:** ekstrak zip ke `~/altis/release` (folder bawaan `ALTIS_RELEASE_DIR`):

```sh
mkdir -p release && unzip altis-<versi>.zip -d release
```

`docker compose up -d` di langkah berikut membangun image `altis:local` dari folder itu. Image hanya berisi Node.js,
`entrypoint.sh`, dan isi zip: tidak ada `.env`, `.git`, maupun *source map*. Kontainer berjalan sebagai pengguna
`node` (bukan root), sistem berkasnya baca-saja kecuali `/data` dan `/tmp`, dan tidak ada yang ditulis ke `/app`.

## 3. `docker compose up -d`

```sh
docker compose up -d
docker compose ps        # app dan db harus "running" / "healthy"
```

ALTIS menunggu database siap, lalu mendengarkan di `127.0.0.1:8080` saja (tidak terbuka ke internet). Database
tidak membuka port apa pun ke luar kontainer, dan pengguna databasenya (`altis`) hanya berhak atas skema `altis`.

## 4. Proxy TLS dengan hops = 1

Pasang ALTIS di belakang proxy TLS di server yang sama. Contoh Caddy (`/etc/caddy/Caddyfile`):

```
perpus.sekolah.sch.id {
    reverse_proxy 127.0.0.1:8080
}
```

Contoh Nginx: seperti di [pm2.md](pm2.md) bagian 4, dengan `proxy_pass http://127.0.0.1:8080;`.

Dengan satu proxy di depan ALTIS, jumlah proxy tepercaya (*hops*) = **1** (tambah 1 bila ada Cloudflare di depannya).
Wizard mengusulkan nilai ini di langkah **Pemeriksaan**; konfirmasi bila alamat IP yang ditampilkan memang alamat IP
Anda. Nilai yang salah membuat pembatasan percobaan login tidak bekerja dengan benar.

## 5. Wizard pemasangan

Buka `https://<domain-ALTIS>/install`.

0. **Klaim:** masukkan kode yang ditampilkan `altis-init` (ada juga di `.env` sebagai `ALTIS_INSTALL_CODE`).
1. **Pemeriksaan:** runtime **Docker**; hops **1** (lihat langkah 4).
2. **Database:** **MariaDB**, host `db`, port `3306`, database `altis`, pengguna `altis`, **kata sandi dikosongkan**:
   ALTIS mengambilnya dari `.env` (`ALTIS_DB_PASSWORD`), sehingga sandi itu tidak pernah tertulis di konfigurasi.
   Database yang sama sudah ditetapkan di `compose.yml` (variabel `ALTIS_DB_*` layanan `app`), dan nilai itulah yang
   dipakai ALTIS.
3. **Profil**, 4. **Super admin**.
5. **Penjadwal:** opsional, ALTIS di Docker menjalankan pekerja latarnya sendiri.
6. **Selesai.**

## Pembaruan

```sh
docker compose pull && docker compose up -d
```

(Image yang dibangun sendiri: ganti isi `release/` dengan zip versi baru, lalu `docker compose build && docker
compose up -d`.)

Image baru membawa rilis ALTIS yang lebih baru. Saat kontainer baru mulai, ALTIS menjalankan alur pembaruan yang
biasa: pemeriksaan kecocokan, mode pemeliharaan, backup `pre_update`, migrasi, verifikasi. Ikuti progresnya di
`https://<domain-ALTIS>/admin/_update`. Bila gagal, ALTIS kembali ke versi sebelumnya dengan data utuh (versi itu
sudah tersalin di volume `data`). Bila versi sebelumnya tidak tersedia (misalnya dengan `ALTIS_RELEASE_SOURCE=image`),
ALTIS tetap dalam pemeliharaan dan halaman itu menunjukkan langkahnya, misalnya: jalankan lagi image versi
sebelumnya, lalu pulihkan backup `pre_update`. Karena itu, simpan tag image versi sebelumnya sampai pembaruan
selesai, dan pakai tag versi (`:0.2.0`), bukan `:latest`.

Tombol pembaruan satu klik di admin juga bisa dipakai, kecuali bila `ALTIS_RELEASE_SOURCE=image` diatur: dalam mode
itu setiap rilis datang dari image saja.

## Data dan backup

- Volume `data` (`/data` di kontainer) berisi konfigurasi, kunci, unggahan, rilis, dan backup ALTIS. Volume `db`
  berisi database. **Jangan** `docker compose down -v` dan jangan menghapus volume: keduanya hilang bersama data Anda.
- Bila volume `data` hilang atau kosong (misalnya server dipindah dan hanya volume `db` yang ikut) sementara
  databasenya masih berisi instalasi ALTIS, ALTIS menjawab **503 "volume data hilang"** dan tidak membuka wizard.
  Pasang kembali volume `data` yang benar (atau salinannya), lalu `docker compose up -d`. Jangan memasang ulang di
  atas database itu.
- Backup ALTIS tersimpan di `/data/backups` dan bisa diunduh dari menu **Cadangan**. Simpan juga salinan `.env`.
- Kontainer yang dibuat ulang di tengah migrasi (misalnya setelah server mati mendadak) menunggu kunci lama basi
  (hingga sekitar 1 menit; 10 menit bila databasenya SQLite) lalu melanjutkan sendiri. Jangan dibuat ulang
  berkali-kali selama menunggu. Lihat [../ops/operations.md](../ops/operations.md).

## Lebih dari satu ALTIS di satu server

Setiap ALTIS memakai foldernya sendiri. `compose.yml` menetapkan nama proyek `altis`, sehingga folder kedua tanpa
pengaturan tambahan **mengambil alih** kontainer dan volume ALTIS pertama (`altis_data`, `altis_db`): ALTIS pertama
dibuat ulang dengan `.env` folder kedua dan tidak bisa lagi membuka databasenya. Untuk ALTIS kedua, setelah
`./altis-init` di foldernya, tambahkan ke `.env` folder itu nama proyek dan port sendiri, misalnya:

```sh
COMPOSE_PROJECT_NAME=altis-perpus2
ALTIS_HTTP_PORT=8081
```

Lalu `docker compose up -d` dari folder itu, dan arahkan proxy domain kedua ke `127.0.0.1:8081`. Jangan mengubah
`COMPOSE_PROJECT_NAME` setelah instalasi: nama proyek menentukan nama volume datanya.

## Bila ada masalah

- `docker compose logs -f app` (kode pemasangan dan semua pesan ALTIS tercetak di sini).
- `docker compose exec app node /app/app.js doctor`.
- Pesan `jalankan ./altis-init dulu`: `.env` tidak ada di folder `compose.yml`, atau salah satu sandi di dalamnya
  kosong.
- Masih buntu: laporkan di [GitHub Issues](https://github.com/arjunaayasa/altis/issues) dengan keluaran `doctor`
  atau teks **Diagnostik**. Jangan menyertakan isi `.env` atau sandi apa pun.
