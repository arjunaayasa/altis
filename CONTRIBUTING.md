# Berkontribusi ke ALTIS (Contributing)

Terima kasih sudah ingin membantu ALTIS Edisi Komunitas. Diskusi dengan pengelola memakai Bahasa Indonesia; isu dan
PR dalam bahasa Inggris juga diterima.

## Development environment

- Node.js **22.16** atau lebih baru.
- pnpm **10.15** lewat Corepack: `corepack enable` (versinya diambil dari `packageManager` di `package.json`).
  Node.js 25 ke atas tidak lagi membawa Corepack: jalankan dulu `npm install -g corepack`, atau pasang pnpm langsung
  dengan `npm install -g pnpm@10.15.0`.
- Docker dengan Compose v2 untuk uji database (MySQL, MariaDB, PostgreSQL) dan mailpit.
- Jangan menjalankan `npx` atau `pnpm dlx` untuk alat yang tidak ada di `node_modules/.bin`.

## Commands

```sh
pnpm install
pnpm check                 # tsc -b + eslint
pnpm test                  # uji unit dan admin (jsdom)
```

Uji database berjalan pada satu mesin per kali:

```sh
docker compose -f tools/test/compose.yml up -d --wait mailpit <engine>
ALTIS_TEST_DB=<engine> pnpm test:db
docker compose -f tools/test/compose.yml down
```

`<engine>` salah satu dari `sqlite`, `mysql80`, `mysql84`, `mariadb106`, `mariadb114`, `pg15`, `pg17` (`sqlite`
tidak butuh kontainer). Uji ujung ke ujung (Playwright, membangun build `-test` sendiri):

```sh
pnpm e2e
```

Tanpa Chromium bawaan Playwright, arahkan `ALTIS_E2E_EXECUTABLE` ke peramban berbasis Chromium yang ada (lihat
`tools/e2e/playwright.config.ts`).

## Engineering constraints

Aturan ini dijaga oleh pemeriksaan build dan uji; PR yang melanggarnya tidak bisa digabung. Rinciannya ada di
[AGENTS.md](AGENTS.md).

- Node ≥ 22.16; TypeScript strict ESM; dependensi dipin versi persis.
- Tanpa modul native; tanpa `fetch`/`undici` global untuk panggilan keluar.
- `node:sqlite` hanya lewat `await import('node:sqlite')`.
- `app.js` adalah CommonJS ES2017 (tanpa `??`, `?.`, atau *top-level await*).
- Satu `http.Server` per proses.
- *Source map* tidak pernah masuk zip; zip rilis di bawah 15 MB.
- Versi database minimum dihormati; SQL bersama tidak memakai `RETURNING`, `ON CONFLICT`, `ON DUPLICATE KEY`, atau
  fungsi JSON.
- ID berupa ULID `CHAR(26)`; waktu BIGINT epoch ms; tanggal `CHAR(10)`.
- Kunci dev (kid `dev-`) tidak pernah ada di build produksi.

## Code conventions

- Identifier kode dalam bahasa Inggris.
- Teks untuk pengguna ada dalam bahasa Indonesia **dan** Inggris, dengan himpunan kunci yang sama di kedua katalog
  (uji memeriksa paritasnya).
- Migrasi database hanya boleh **ditambah** (*append-only*): jangan mengubah atau menghapus migrasi yang sudah ada.
  Setiap migrasi harus lolos uji N−1: versi sebelumnya tetap berjalan di atas skema baru, sehingga rollback pembaruan
  aman (`pnpm n-1 --from <zip N−1> --to <zip N> --db <engine>`).
- Komentar kode boleh menyebut rujukan seperti `spec §…`, `Task N`, `D1d-xx`, atau `preflight …`. Rujukan itu menunjuk
  ke catatan desain privat asli dan tidak tersedia di repositori ini. Kode baru sebaiknya menjelaskan dirinya sendiri
  tanpa rujukan semacam itu.
- Jangan menambahkan penegakan lisensi atau pembatasan edisi ke Edisi Komunitas (lihat "Edition seam" di
  [AGENTS.md](AGENTS.md)).

## Commits and pull requests

- Pesan commit bergaya [Conventional Commits](https://www.conventionalcommits.org/) (`feat(catalog): …`,
  `fix(server): …`, `docs: …`), dan commit kecil yang masing-masing utuh.
- Satu PR untuk satu perubahan. Sebelum membuka PR: `pnpm check`, `pnpm test`, dan `pnpm test:db` pada mesin yang
  relevan (paling tidak `sqlite`, plus MariaDB/MySQL atau PostgreSQL bila menyentuh SQL).
- Isi templat PR, termasuk kotak centang pemberian lisensi kontributor.

## Contributor licence grant (wajib)

Dengan membuka PR, Anda menyatakan bahwa:

1. kontribusi itu karya Anda sendiri (atau Anda berhak menyerahkannya), dan
2. Anda melisensikannya di bawah **AGPL-3.0-only**, **dan** memberikan kepada Arjuna / Arsya lisensi yang berlaku
   selamanya, di seluruh dunia, non-eksklusif, dan bebas royalti untuk memakai, mengubah, dan melisensikan ulang
   kontribusi itu, termasuk di bawah lisensi lain.

Pemberian ini diperlukan karena kode yang sama juga dipakai untuk edisi komersial ALTIS. Setiap commit wajib
membawa baris `Signed-off-by:` (`git commit -s`) dengan nama dan e-mail Anda, sebagai tanda persetujuan atas
pernyataan di atas.

*English summary: by opening a pull request you confirm the contribution is your own work, license it under
AGPL-3.0-only, and grant Arjuna / Arsya a perpetual, worldwide, non-exclusive, royalty-free licence to use, modify
and relicense it, including under other licences. Every commit carries `Signed-off-by:` (`git commit -s`).*

## Clean-room rule for SLiMS

ALTIS bisa membaca data SLiMS (migrasi, peta CSV), tetapi **jangan pernah menyalin kode atau teks SLiMS**. Yang boleh
dipakai hanya fakta interoperabilitas: nama tabel dan kolom, format berkas, dan perilaku yang terlihat dari data.

## Security

Jangan melaporkan celah keamanan di isu publik; lihat [SECURITY.md](SECURITY.md).
