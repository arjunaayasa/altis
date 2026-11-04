# Aturan operasional ALTIS

**Untuk:** administrator server dan siapa pun yang memasang, memindahkan, atau mengelola ALTIS.
Panduan pemasangan per lingkungan ada di [`../install/`](../install/).

Aturan di bawah tidak dijaga oleh kode (kecuali yang disebut), jadi harus dipatuhi saat memasang, memindah, atau
menggandakan server.

## 1. `DATA_DIR` harus di disk lokal, bukan NFS

`DATA_DIR` (folder data ALTIS: konfigurasi, kunci, rilis, unggahan, backup, database SQLite) harus berada di disk
lokal server.

- **Alasannya.** Beberapa proses ALTIS (pekerja Passenger, cron, CLI) berbagi `DATA_DIR` lewat berkas kunci
  (`O_EXCL`) dan penulisan atomik (berkas sementara, `fsync`, `rename`). Pemegang kunci menyegarkan kuncinya secara
  sinkron setiap beberapa detik. Pada share NFS yang macet (*hard mount*), setiap penyegaran itu membekukan seluruh
  proses, sehingga situs berhenti menjawab. Semantik `O_EXCL` dan `rename` di NFS juga tidak selalu sama dengan disk
  lokal.
- **Yang boleh:** disk lokal, volume blok (EBS, disk VPS), volume Docker di host yang sama.
- **Yang tidak:** NFS, SMB/CIFS, sshfs, folder sinkronisasi cloud (Dropbox, OneDrive), dan sejenisnya.
- Backup **salinan** ke NAS atau penyimpanan jaringan tetap boleh (salin berkas `.altisbak` dari menu **Cadangan**
  atau dari `DATA_DIR/backups`); yang dilarang adalah `DATA_DIR` yang hidup di sana.

## 2. Jangan pernah berbagi `DATA_DIR` antar-host, termasuk VM hasil kloning

Satu `DATA_DIR` hanya dipakai oleh satu host (satu mesin, satu VM, atau satu set kontainer di satu host).

- **Alasannya.** Kunci berkas ALTIS mengenali pemegangnya dari nama host, *boot id* kernel, dan *namespace* PID.
  Dua host yang memakai satu `DATA_DIR` (misalnya lewat penyimpanan bersama) tidak bisa saling memastikan apakah
  proses pemegang kunci masih hidup. Kunci hanya dinilai dari umurnya, sehingga dua host bisa sama-sama merasa
  memegang kunci yang sama. Akibatnya migrasi, pembaruan, atau restore berjalan ganda dan merusak data.
- **VM atau server yang dikloning** (snapshot lalu dijalankan sebagai mesin kedua) membawa salinan `DATA_DIR` dan
  `config.json` yang sama, termasuk `install.id` dan kunci instalasi. Jangan jalankan kedua salinan terhubung ke
  database yang sama. Bila klon dimaksudkan sebagai server pengganti, matikan yang lama lebih dulu. Bila dimaksudkan
  sebagai instalasi kedua, pasang dari awal dengan `DATA_DIR` dan database baru; kunci instalasinya juga terpisah.
- Satu database juga tidak boleh dipakai dua instalasi ALTIS (dua `DATA_DIR` berbeda): migrasi menganggap satu
  database punya satu `DATA_DIR`.

## 3. Kontainer Docker yang dibuat ulang di tengah migrasi menunggu hingga `staleMs`

Bila server mati atau kontainer `app` dibuat ulang (`docker compose up -d --force-recreate`, reboot host) ketika
ALTIS sedang migrasi atau pembaruan, kontainer baru **menunggu** sebelum melanjutkan.

- **Alasannya.** Kontainer baru mendapat *namespace* PID baru, sehingga ALTIS tidak bisa memeriksa apakah proses
  pemegang kunci lama masih hidup. Kunci itu baru dianggap basi setelah tidak disegarkan selama `staleMs`: 30 detik
  untuk kunci berkas biasa (termasuk `tmp/migrate.lock`), 60 detik untuk `releases/boot.lock` selama boot pembaruan,
  dan **10 menit** untuk `migrate.lock` bila databasenya SQLite.
- **Yang dilakukan:** tunggu. `docker compose logs -f app` menunjukkan ALTIS menunggu kunci, lalu melanjutkan
  migrasi atau pembaruan dari langkah terakhir yang tercatat. Jangan membuat ulang kontainer berkali-kali selama
  menunggu: setiap kali dibuat ulang, hitungan mulai dari awal lagi.
- Pada PM2, layanan sistem, atau proses mandiri setelah listrik padam, kunci dari *boot* sebelumnya dikenali sebagai
  milik proses yang sudah mati dan langsung diambil alih, tanpa menunggu.

## 4. Variabel lingkungan tidak bisa menyelamatkan nilai `config.json` yang tidak valid

ALTIS memeriksa `config.json` **sebelum** menerapkan variabel lingkungan (`ALTIS_PORT`, `ALTIS_BASE_URL`,
`ALTIS_DB_*`, `ALTIS_TRUST_PROXY_HOPS`, ...). Nilai yang tidak valid di berkas, misalnya `"port": "delapan"` atau
`baseUrl` dengan path, menghentikan ALTIS dengan `INVALID_CONFIG` walaupun variabel lingkungan yang menimpanya sudah
diisi dengan benar.

- **Perbaikannya:** sunting `config.json` itu sendiri (File Manager panel, atau editor di server) dan perbaiki kunci
  yang disebut pesan galat. Pesan itu menyebut path kuncinya, tidak pernah nilainya. `node app.js config:set` juga
  tidak bisa memperbaiki berkas yang tidak valid, karena perintah itu membaca seluruh berkas lebih dulu.
- Berkas yang terpotong (bukan JSON utuh) otomatis diganti `config.json.bak` bila salinan itu utuh. Berkas yang
  utuh tetapi isinya salah **tidak** diganti, supaya perubahan tangan tidak hilang diam-diam.
- `config.json` berisi rahasia (mode 600). Jangan menyalinnya ke laporan masalah (GitHub Issues) atau ke mana pun;
  kirim keluaran `doctor` saja.

## 5. Folder area tidak boleh berupa tautan simbolik: pakai *mount*

Folder di dalam `DATA_DIR` (`releases`, `ops`, `uploads`, `backups`, `logs`, `cache`, `tmp`, `db`) harus folder
sungguhan. Bila salah satunya tautan simbolik (*symlink*) ke tempat lain, ALTIS menolaknya
(`INVALID_PATH_SEGMENT`, alasan `area_escape`), supaya tidak ada berkas yang bisa diarahkan keluar dari `DATA_DIR`.

- **Untuk menaruh backup atau unggahan di disk lain:** *mount* disk itu tepat di folder tersebut (misalnya
  `/etc/fstab` dengan *bind mount* ke `DATA_DIR/backups`, atau volume Docker tambahan), atau pindahkan seluruh
  `DATA_DIR` ke disk itu lewat `ALTIS_DATA_DIR` / `altis-data-dir.txt`.
- Disk itu tetap harus disk lokal (aturan 1).

## 6. Celah antara verifikasi dan *import* rilis menuntut penulis di akun yang sama

Setiap kali mulai, `app.js` memverifikasi tanda tangan dan semua berkas rilis, lalu memuat `server.mjs`-nya. Di
antara keduanya ada jeda singkat. Siapa pun yang dapat **menulis** ke folder rilis (`<appRoot>/bundled-release/` atau
`DATA_DIR/releases/`) bisa menukar berkas di jeda itu, sehingga kode yang tidak terverifikasi ikut dimuat.

- Jeda ini hanya bisa dipakai oleh penulis yang sudah punya akses tulis sebagai **akun yang sama** dengan ALTIS (atau
  root). Pihak seperti itu memang sudah menguasai instalasi, sehingga jeda ini tidak membuka hak baru, **asalkan**:
  - folder aplikasi dan `DATA_DIR` hanya dapat ditulis oleh akun yang menjalankan ALTIS (jangan `chmod 777`, jangan
    beri grup lain hak tulis);
  - akun itu tidak dipakai bersama aplikasi lain yang tidak tepercaya (misalnya plugin PHP yang bisa menulis berkas
    di folder rumah yang sama);
  - akses FTP/SFTP akun itu dijaga seperti akses admin.
- Di Docker, `/app` milik root dan tidak dapat ditulis pengguna `node`; folder rilis yang hidup ada di volume `/data`.

## 7. SQLite hanya untuk satu proses

SQLite hanya dipakai di runtime yang menjalankan **satu** proses ALTIS: Docker, PC (proses mandiri atau layanan),
dan PM2 dengan **1 instance mode fork**. cPanel (Passenger) dan LiteSpeed tidak mendapat pilihan SQLite. Di PM2,
ALTIS membaca tanda yang ditaruh PM2 di lingkungan proses (`exec_mode=cluster_mode`, `instances` > 1,
`NODE_APP_INSTANCE` selain 0) dan menolak mulai dengan `SQLITE_NOT_ALLOWED` bila ada salah satunya (dijaga kode).
Lihat [../install/pm2.md](../install/pm2.md).

## 8. Kunci rilis dan feed

- Setiap rilis ditandatangani (Ed25519). `app.js` hanya mempercayai kunci root yang tertanam saat build; kunci lain
  (rilis, *timestamp*) dipercaya lewat dokumen *keyset* bertanda tangan root. Build `-test` memakai kunci
  pengembangan publik dari `tools/keys/dev`: **jangan pernah dipakai untuk instalasi sungguhan.**
- Cara membuat kunci sendiri, membangun rilis produksi, menerbitkan feed pembaruan, dan merotasi kunci ada di
  [release-signing.md](release-signing.md).
- **Kesegaran feed.** Setiap kanal feed (`stable`, `beta`) wajib punya `freshness.json` bertanda tangan kunci
  `timestamp` yang berlaku paling lama 14 hari. Bila kedaluwarsa, **semua** instalasi menolak feed (`FEED_INVALID`,
  alasan `expired`) dan tidak melihat pembaruan sampai `freshness.json` baru terbit. Setiap `feed.json` baru juga
  membutuhkan `freshness.json` baru, karena kesegaran mengikat SHA-256 feed; `seq`-nya tidak pernah boleh lebih
  rendah dari yang sudah terbit (klien menolaknya).
- Alamat feed diambil dari variabel `ALTIS_UPDATE_FEED_URL`, lalu `update.feedUrl` di `config.json`, lalu URL yang
  tertanam saat build. Tanpa ketiganya, ALTIS tidak memeriksa pembaruan secara daring. Instalasi tanpa internet juga
  tidak bergantung pada feed: zip rilis diunggah di menu **Pembaruan**.
