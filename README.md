# ALTIS — Edisi Komunitas

**Arsya Library Tracking Information System**

ALTIS adalah sistem otomasi perpustakaan modern yang Anda pasang di server sendiri (*self-hosted*): alternatif SLiMS
untuk perpustakaan sekolah, kampus, dan umum. Edisi Komunitas bersifat sumber terbuka di bawah lisensi
[AGPL-3.0-only](LICENSE).

> **Sedang dikembangkan.** Belum ada rilis resmi; API dan skema masih dapat berubah antar versi pra-1.0.

[English](#english)

## Fitur (Edisi Komunitas)

- **Katalog:** bibliografi, eksemplar, master data, kendali otoritas, lokasi/rak, impor-ekspor MARC 21/MARCXML/CSV,
  deteksi duplikat.
- **OPAC:** pencarian bawaan berfaset (FULLTEXT/GIN/FTS5), halaman dan berita, feed, sitemap, JSON-LD.
- **Interoperabilitas:** OAI-PMH, salin katalog lewat SRU, pencarian ISBN.
- **Label dan barcode** (PDF).
- **Migrasi dari SLiMS:** dari dump SQL atau koneksi langsung ke database SLiMS, termasuk berkas lampiran dan sampul.
- **Fondasi:**
  - wizard pemasangan;
  - login dengan 2FA; pengguna, peran, dan cabang;
  - jejak audit berantai;
  - job dan penjadwal, notifikasi, unggahan;
  - backup dan restore (juga lintas mesin database);
  - mode pemeliharaan, Diagnostik, dasbor;
  - pembaruan sekali klik yang aman: rilis ditandatangani Ed25519, pergantian versi atomik dengan backup dan
    rollback otomatis; atau unggah zip tanpa internet, atau image Docker baru.

## Nilai unggulan (segera hadir): Laporan siap akreditasi

Laporan otomatis yang mengikuti indikator akreditasi perpustakaan Perpusnas (koleksi per kelas DDC, kunjungan,
peminjaman, anggota), siap cetak. **Fitur ini sedang dikembangkan** dan belum ada di kode saat ini.

## Persyaratan

- Node.js 22.16 atau lebih baru.
- Database: SQLite (bawaan), MySQL 8.0+, MariaDB 10.6+, atau PostgreSQL 15+.
- Hosting: cPanel/CloudLinux (Passenger), aaPanel, Docker, PM2, atau satu PC.

## Mulai cepat

Zip rilis akan tersedia di halaman [Releases](https://github.com/arjunaayasa/altis/releases). **Sampai rilis pertama
terbit, belum ada zip untuk pemakaian sungguhan.** Build `-test` dari kode sumber hanya untuk evaluasi, jangan pernah
untuk data sungguhan. Zip untuk pemakaian sungguhan adalah build produksi dengan kunci Anda sendiri
([docs/ops/release-signing.md](docs/ops/release-signing.md)).

### Docker

1. Salin berkas folder [`docker/`](docker/) ke satu folder di server, lalu jalankan `./altis-init` (menulis `.env`
   dan menampilkan kode pemasangan).
2. Ekstrak zip rilis ke subfolder `release/`.
3. `docker compose up -d`, lalu pasang proxy TLS di depannya.
4. Buka `https://<domain>/install`.

Panduan lengkap: [docs/install/docker.md](docs/install/docker.md).

### cPanel

1. Buat database MySQL/MariaDB kosong lewat **MySQL® Database Wizard**.
2. Ekstrak zip rilis ke `~/altis/app` (di luar `public_html`).
3. Daftarkan aplikasi di **Application Manager** (atau **Setup Node.js App** di CloudLinux).
4. Buka `https://<domain>/install` dan pasang baris cron dari wizard.

Panduan lengkap: [docs/install/cpanel.md](docs/install/cpanel.md) dan
[docs/install/cloudlinux.md](docs/install/cloudlinux.md).

### Satu PC

1. Pasang Node.js 22.16+ dari [nodejs.org](https://nodejs.org).
2. Ekstrak zip rilis, lalu dari foldernya jalankan `node app.js`.
3. Buka `http://127.0.0.1:3000/install` dan masukkan kode pemasangan dari terminal.

Panduan lengkap: [docs/install/node-lokal.md](docs/install/node-lokal.md). Panduan lain: [aaPanel](docs/install/aapanel.md),
[PM2](docs/install/pm2.md), dan [aturan operasional](docs/ops/operations.md).

## Dari kode sumber

Butuh Node.js 22.16+ dan pnpm 10 (`corepack enable`; Node.js 25 ke atas tidak lagi membawa Corepack, jadi jalankan
dulu `npm install -g corepack`, atau langsung `npm install -g pnpm@10.15.0`), dari *clone* git repositori ini:

```sh
pnpm install
pnpm check      # tsc + eslint
pnpm test       # uji unit dan admin
```

Build evaluasi (zip di `dist/altis-0.1.0-test.zip`):

```sh
pnpm release --profile test --version 0.1.0-test
```

> **Peringatan: build `-test` mempercayai kunci pengembangan publik (`tools/keys/dev`).** Siapa pun dapat
> menandatangani pembaruan untuk build itu. Jangan pernah memakainya di produksi atau untuk data sungguhan.

Build produksi membutuhkan kunci Anda sendiri: lihat [docs/ops/release-signing.md](docs/ops/release-signing.md).

## Peta jalan

- **Laporan siap akreditasi** (nilai unggulan).
- Sirkulasi: peminjaman/pengembalian, reservasi, denda.
- Keanggotaan.
- Laporan.
- Stock opname.

## Edisi komersial

Edisi dengan modul dan layanan tambahan akan menyusul; Edisi Komunitas tetap AGPL dan tanpa batas waktu.

## Kontribusi, keamanan, lisensi

- **Kontribusi:** baca [CONTRIBUTING.md](CONTRIBUTING.md) (termasuk pemberian lisensi kontributor yang wajib).
- **Keamanan:** laporkan celah secara privat, lihat [SECURITY.md](SECURITY.md).
- **Lisensi:** [AGPL-3.0-only](LICENSE); lihat juga [NOTICE](NOTICE). Bila Anda menjalankan versi yang diubah untuk
  pengguna lewat jaringan, AGPL-3.0 pasal 13 mewajibkan Anda menawarkan kode sumber versi itu kepada mereka. Tautan
  "Kode sumber" di footer OPAC dan di halaman Tentang menunjuk ke repositori ini: sebuah fork mengganti
  `COMMUNITY_SOURCE_URL` di `packages/shared/src/edition.ts` (dan label `org.opencontainers.image.source` di
  `docker/Dockerfile`) dengan repositorinya sendiri.

---

## English

ALTIS (Arsya Library Tracking Information System), Community Edition, is a modern self-hosted library automation
system: an alternative to SLiMS for school, academic and public libraries, under [AGPL-3.0-only](LICENSE).

> **In development.** There is no official release yet; the API and schema may still change between pre-1.0
> versions.

**Features:** cataloguing (bibliographic records, items, master data, authority control, locations and shelves,
MARC 21/MARCXML/CSV import and export, duplicate detection); an OPAC with built-in faceted search
(FULLTEXT/GIN/FTS5), pages and news, feeds, sitemap and JSON-LD; OAI-PMH, SRU copy cataloguing and ISBN lookup;
labels and barcodes (PDF); **migration from SLiMS** (SQL dump or direct connection, attachments and covers); and the
foundation: install wizard, 2FA login, users, roles and branches, a chained audit trail, jobs and scheduler,
notifications, uploads, backup and restore (across database engines), maintenance mode, diagnostics, a dashboard,
and safe one-click updates (Ed25519-signed releases, atomic switch with automatic backup and rollback, offline zip
upload or a new Docker image).

**Headline feature (coming soon): accreditation-ready reports**, generated along the Perpusnas library accreditation
indicators (collection by DDC class, visits, loans, members), ready to print. It is in development.

**Requirements:** Node.js 22.16+; SQLite (built in), MySQL 8.0+, MariaDB 10.6+ or PostgreSQL 15+; cPanel/CloudLinux
(Passenger), aaPanel, Docker, PM2 or a single PC.

**Install:** release zips will appear on the [Releases](https://github.com/arjunaayasa/altis/releases) page. **Until
the first release there is no zip for real use:** a `-test` build from source is for evaluation only, never for real
data, and a zip for real use is a production build with your own keys
([docs/ops/release-signing.md](docs/ops/release-signing.md)). The install guides are in Indonesian:
[Docker](docs/install/docker.md), [cPanel](docs/install/cpanel.md), [CloudLinux](docs/install/cloudlinux.md),
[aaPanel](docs/install/aapanel.md), [PM2](docs/install/pm2.md) and [a single PC](docs/install/node-lokal.md).

**From source** (Node.js 22.16+ and pnpm 10 through `corepack enable`; Node.js 25 and later no longer ship Corepack,
so run `npm install -g corepack` first, or `npm install -g pnpm@10.15.0`): `pnpm install`, `pnpm check`, `pnpm test`;
an evaluation build with `pnpm release --profile test --version 0.1.0-test`. **Test builds trust the public
development keys of `tools/keys/dev`: never use them in production.** A production build needs your own keys
([docs/ops/release-signing.md](docs/ops/release-signing.md)).

**Roadmap:** accreditation-ready reports, circulation (loans and returns, reservations, fines), membership, reports,
stocktaking.

**Commercial edition:** an edition with additional modules and services will follow; the Community Edition stays
AGPL and has no time limit.

**Contributing** ([CONTRIBUTING.md](CONTRIBUTING.md), a contributor licence grant is required), **security**
([SECURITY.md](SECURITY.md)) and **licence** ([AGPL-3.0-only](LICENSE), [NOTICE](NOTICE)). The "source code" link in
the OPAC footer and on the Tentang page points at this repository: a fork that runs a modified version sets
`COMMUNITY_SOURCE_URL` in `packages/shared/src/edition.ts` (and the `org.opencontainers.image.source` label in
`docker/Dockerfile`) to its own repository, as AGPL-3.0 section 13 requires.
