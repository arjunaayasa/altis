# Kunci rilis dan rilis bertanda tangan

**Untuk:** pengelola proyek, atau fork, yang menerbitkan rilis produksi ALTIS Edisi Komunitas sendiri.

Build `-test` (`pnpm release --profile test …`) memakai kunci pengembangan publik di `tools/keys/dev` dan hanya
untuk uji. Build produksi membutuhkan kunci Anda sendiri. Dokumen ini menjelaskan cara membuatnya, membangun rilis
bertanda tangan, menerbitkan feed pembaruan, dan merotasi kunci.

## Model kepercayaan

- **Root** (`use: root`, minimal dua: satu aktif dan satu cadangan). Kunci publiknya ditanam di `app.js` dan
  `server.mjs` saat build (`--root-keys`). Root hanya menandatangani dokumen *keyset*, tidak pernah rilis atau feed.
- **Keyset** (`keyset.json`): daftar dokumen `altis-keyset/1` bertanda tangan root, yang mempercayai kunci-kunci lain.
  Dokumen tidak pernah bisa menambah, mencabut, atau mengubah root.
- **Release** (`use: release`): menandatangani `manifest.json` setiap rilis dan `feed.json`.
- **Timestamp** (`use: timestamp`): menandatangani `freshness.json` feed (masa berlaku paling lama 14 hari).
- Kegunaan `license` dan `device` di format kunci adalah kegunaan cadangan (*reserved*); Edisi Komunitas tidak
  memakainya dan tidak memerlukannya.

Instalasi hanya menerima rilis dan feed yang ditandatangani kunci di bawah root yang tertanam di `app.js`-nya. Rilis
yang ditandatangani kunci lain ditolak.

## Persiapan

- *Clone* git repositori pada commit yang akan dirilis, lalu `pnpm install --frozen-lockfile`.
- Simpan kunci privat **di luar repositori**, sebaiknya di mesin atau media yang tidak tersambung ke jaringan. Semua
  kunci dibuat dengan `--encrypt` (frasa sandi; scrypt + AES-256-GCM), sehingga berkasnya tidak berguna tanpa frasa
  sandi. Frasa sandi diketik di prompt, atau diambil dari `ALTIS_KEY_PASSPHRASE` (hanya untuk otomasi).
- `pnpm --filter @altis/sign-cli altis-sign …` menjalankan alatnya di folder `tools/sign-cli`, jadi beri **path
  absolut** untuk setiap berkas.
- **Fork:** tautan "Kode sumber" di footer OPAC dan di halaman Tentang memakai `COMMUNITY_SOURCE_URL` di
  `packages/shared/src/edition.ts`, dan image Docker membawa label `org.opencontainers.image.source` di
  `docker/Dockerfile`. Fork yang menjalankan versi yang diubah mengganti keduanya dengan repositorinya sendiri sebelum
  build, sebab AGPL-3.0 pasal 13 mewajibkan kode sumber versi itu ditawarkan kepada penggunanya.

Contoh di bawah memakai variabel berikut, dari akar repositori:

```sh
sign() { pnpm --filter @altis/sign-cli altis-sign "$@"; }
N=altisku                          # awalan kid Anda; jangan pernah diawali dev-
OFF=/media/offline/altis-keys      # folder kunci privat (absolut, di luar repositori)
PUB="$PWD/tools/keys/community"    # folder berkas publik di repositori
mkdir -p "$OFF" "$PUB"
```

## 1. Buat kunci

```sh
sign keygen --use root      --kid "$N-root-1" --out "$OFF" --encrypt
sign keygen --use root      --kid "$N-root-2" --out "$OFF" --encrypt
sign keygen --use release   --kid "$N-rel-1"  --out "$OFF" --encrypt
sign keygen --use timestamp --kid "$N-ts-1"   --out "$OFF" --encrypt
```

Setiap perintah menulis `<kid>.key.json` (mode 0600, tidak pernah menimpa berkas yang ada) dan menambahkan kunci
publiknya ke `trusted.json` di folder yang sama. Kid hanya boleh berisi huruf, angka, `.`, `_`, dan `-` (paling
panjang 64). `root-2` adalah cadangan: simpan offline dan jangan dipakai selama `root-1` aman.

Lalu ekspor separuh publiknya (sekaligus membuktikan frasa sandinya benar):

```sh
for k in root-1 root-2 rel-1 ts-1; do
  sign pub --key "$OFF/$N-$k.key.json" --out "$OFF/$N-$k.pub.json"
done
```

## 2. Susun `roots.json`

`roots.json` berisi kunci publik kedua root, `[{kid, use: "root", pub}]`:

```sh
node -e '
  const fs = require("fs");
  const [off, n, pub] = process.argv.slice(1);
  const read = (k) => JSON.parse(fs.readFileSync(`${off}/${n}-${k}.pub.json`, "utf8"));
  fs.writeFileSync(`${pub}/roots.json`, JSON.stringify([read("root-1"), read("root-2")], null, 2) + "\n");
' "$OFF" "$N" "$PUB"
```

## 3. Tanda tangani *keyset* awal

Payload `{seq: 1, keys: [rel-1, ts-1], revokedKids: []}`, ditandatangani `root-1`:

```sh
node -e '
  const fs = require("fs");
  const [off, n] = process.argv.slice(1);
  const read = (k) => JSON.parse(fs.readFileSync(`${off}/${n}-${k}.pub.json`, "utf8"));
  const payload = { seq: 1, keys: [read("rel-1"), read("ts-1")], revokedKids: [] };
  fs.writeFileSync(`${off}/keyset-payload.json`, JSON.stringify(payload, null, 2) + "\n");
' "$OFF" "$N"

sign keyset sign --in "$OFF/keyset-payload.json" --key "$OFF/$N-root-1.key.json" \
  --root-keys "$PUB/roots.json" --out "$PUB/keyset.json"
```

`keyset sign` menolak kunci selain `root`, penanda tangan yang tidak ada di `--root-keys`, payload yang menyentuh
root mana pun, dan (untuk root yang bukan `dev-`) payload yang mempercayai kunci dev. Dokumen baru selalu
**ditambahkan** ke `keyset.json`.

## 4. Periksa hasilnya

```sh
sign ceremony check --roots "$PUB/roots.json" --keyset "$PUB/keyset.json" \
  --pub "$OFF/$N-rel-1.pub.json" --pub "$OFF/$N-ts-1.pub.json"
```

Hasil yang benar: kode keluar 0, satu baris per kunci (kid, use, dan sidik jari SHA-256), lalu `OK`. Pemeriksaan
gagal bila ada materi dev (`DEV_KEY`), kurang dari dua root (`ROOTS_TOO_FEW`), root ganda (`ROOTS_DUPLICATE`),
dokumen *keyset* tidak sah (`KEYSET_INVALID`), tidak ada kunci `release` atau `timestamp` yang dipercaya
(`KEYSET_MISSING_USE:<use>`), atau sebuah `--pub` tidak dipercaya (`PUB_NOT_TRUSTED:<kid>`). Catat sidik jarinya di
tempat yang aman.

## 5. Commit berkas publik saja

```sh
git add tools/keys/community/roots.json tools/keys/community/keyset.json
git status --short          # tidak boleh ada *.key.json
git commit -s -m "chore(keys): community release roots and initial keyset"
```

`.gitignore` menolak setiap `*.key.json` di luar `tools/keys/dev`. `trusted.json`, berkas `*.pub.json`, dan
`keyset-payload.json` tidak perlu di-*commit*.

## 6. Bangun rilis produksi

```sh
pnpm release --profile production --version 0.1.0 \
  --signing-key "$OFF/$N-rel-1.key.json" \
  --root-keys tools/keys/community/roots.json \
  --keyset tools/keys/community/keyset.json \
  --feed-url https://<pengguna>.github.io/<situs-feed>
```

- Versi produksi tidak boleh mengandung `test` (`VERSION_PROFILE_MISMATCH`), dan *working tree* harus bersih
  (`DIRTY_TREE`): commit kunci publik dulu.
- Tanpa salah satu berkas kunci, build berhenti dengan `MISSING_RELEASE_KEY`; kunci atau kid `dev-` mana pun ditolak
  (`DEV_KEY_IN_PRODUCTION`). Ketiga berkas juga bisa diberikan lewat `ALTIS_RELEASE_SIGNING_KEY`,
  `ALTIS_RELEASE_ROOT_KEYS`, dan `ALTIS_RELEASE_KEYSET`.
- Build menandatangani manifest dengan `altis-sign release sign` sendiri. Frasa sandi `rel-1` diminta sekali di
  prompt. Jangan menyetel `ALTIS_KEY_PASSPHRASE` untuk build: variabel itu diwariskan ke proses anak build.
- `--feed-url` opsional. Tanpa itu, build menanam URL kosong: instalasi tidak memeriksa pembaruan secara daring,
  kecuali admin mengisi `update.feedUrl` di `config.json` atau `ALTIS_UPDATE_FEED_URL`. Unggah zip di menu
  **Pembaruan** tetap berjalan.
- Hasilnya `dist/altis-<versi>.zip` dan `dist/build-report.json`. *Source map* ditulis terpisah di `dist/` dan tidak
  pernah masuk zip; boleh dilampirkan ke GitHub Release bila perlu.
- Pakai `roots.json` yang sama untuk setiap rilis (lihat bagian 9).

## 7. Feed pembaruan (opsional)

`feed:build` memeriksa setiap zip, lalu menandatangani feed dengan kunci `release` (`altis-sign feed sign`) dan
kesegarannya dengan kunci `timestamp` (`altis-sign freshness sign`):

```sh
pnpm --filter @altis/release feed:build --zip dist/altis-0.1.0.zip --channel stable \
  --base-url https://<pengguna>.github.io/<situs-feed> --out ../altis-feed \
  --release-key "$OFF/$N-rel-1.key.json" --timestamp-key "$OFF/$N-ts-1.key.json" \
  --keyset tools/keys/community/keyset.json --root-keys tools/keys/community/roots.json \
  --seq 1 --expires-in-days 14
```

- Hasilnya `<out>/stable/feed.json`, `feed.sig`, `freshness.json`, dan `<out>/packages/<zip>`. `--base-url` harus
  sama dengan `--feed-url` build. `--zip` boleh diulang untuk mencantumkan rilis lama.
- Host seluruh folder `<out>` sebagai situs statis HTTPS, misalnya GitHub Pages. Lampirkan zip yang sama ke GitHub
  Releases untuk unduhan manual dan unggah tanpa internet.
- Setiap `feed.json` baru membutuhkan `freshness.json` baru (`feed:build` membuat keduanya), dan `--seq` tidak pernah
  boleh lebih rendah dari yang sudah terbit (`FEED_SEQ_BACKWARDS`; klien juga menolaknya).

**Kesegaran wajib diperbarui paling lambat setiap 14 hari.** Bila `freshness.json` kedaluwarsa, semua instalasi
menolak feed (`FEED_INVALID:expired`) dan tidak melihat pembaruan. Jadwalkan penandatanganan ulang **seminggu
sekali**:

```sh
FEED=/abs/path/altis-feed        # folder feed yang di-host (absolut)
SEQ=2                            # seq terakhir + 1
sign freshness sign --feed "$FEED/stable/feed.json" --seq "$SEQ" --expires-in-days 14 \
  --key "/secure/$N-ts-1.key.json" --out "$FEED/stable/freshness.json"
```

- Naikkan `SEQ` satu setiap kali dan simpan penghitungnya.
- `issuedAt` selalu diambil dari jam mesin, jadi mesin itu harus sinkron (NTP). `--issued-at` hanya untuk kunci `dev-`.
- Untuk otomasi (misalnya workflow GitHub Actions terjadwal mingguan), simpan berkas `ts` terenkripsi dan frasa
  sandinya sebagai *Actions secrets* (`ALTIS_KEY_PASSPHRASE`). Hanya kunci `timestamp` yang boleh ada di otomasi,
  tidak pernah root atau `release`.

## 8. Rotasi kunci

Urutan rotasi terencana: **tambah, pakai, baru cabut.**

1. Buat kunci baru dengan kid baru (misalnya `$N-rel-2`), lalu ekspor `pub`-nya.
2. Tulis payload `{seq: <seq tertinggi + 1>, keys: [<kunci baru>], revokedKids: []}` dan tanda tangani dengan root
   aktif (`keyset sign … --out "$PUB/keyset.json"`, yang menambahkan dokumen baru). Jalankan `ceremony check`, commit
   `keyset.json`, lalu kirim lewat feed (`feed:build --keyset`) dan rilis berikutnya.
3. Setelah dokumen itu tersebar, mulai memakai kunci baru.
4. Cabut kunci lama dengan dokumen berikutnya: `{seq: <n + 1>, keys: [], revokedKids: ["<kid lama>"]}`.

Kunci bocor: tambah pengganti dan cabut kid yang bocor dalam **satu** dokumen. Aturan yang berlaku:

- Pencabutan permanen. Kid yang dicabut, dan kunci publiknya, tidak pernah dipercaya lagi; pengganti selalu memakai
  kid baru dan pasangan kunci baru.
- `ceremony check` gagal (`KEYSET_MISSING_USE:<use>`) bila pencabutan meninggalkan satu kegunaan tanpa kunci:
  tambahkan penggantinya dulu.
- Kunci `timestamp` yang bocor tidak bisa memalsukan rilis atau isi feed, tetapi bisa membuat feed lama tampak segar
  atau menaikkan `seq` setinggi apa pun. Setelah dokumen yang mencabutnya dipercaya, batas `seq` dari kunci itu
  gugur, dan `freshness.json` dengan kunci `ts` baru boleh melanjutkan `seq` dari penghitung Anda.
- Dokumen *keyset* tidak bisa mengganti root (bagian 9).

## 9. Peringatan: root terkunci di `app.js`

`app.js` dibekukan pada setiap instalasi: pembaruan sekali klik tidak menggantinya, dan root yang ditanam di dalamnya
menentukan rilis mana yang diterima. Mengganti root kelak (atau beralih ke rilis yang ditandatangani root lain)
membutuhkan **pembaruan manual dengan zip**: ekstrak zip rilis baru di atas folder aplikasi (atau pakai image Docker
baru), yang mengganti `app.js`. Databasenya tetap. Karena itu, pilih root sekali dengan hati-hati, simpan `root-2`
offline sebagai cadangan, dan jangan pernah kehilangan keduanya.
