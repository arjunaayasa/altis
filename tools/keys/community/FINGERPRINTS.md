# Kunci rilis ALTIS Edisi Komunitas / Community Edition release keys

Kunci publik resmi untuk rilis dari repositori ini. Root ditanam di `app.js` setiap rilis produksi; `keyset.json`
(ditandatangani `arsya-root-1`) mempercayai kunci `release` dan `timestamp`. Periksa sidik jari di bawah dengan:

The official public keys for releases from this repository. The roots are embedded in the `app.js` of every
production release; `keyset.json` (signed by `arsya-root-1`) trusts the `release` and `timestamp` keys. Check the
fingerprints below with:

```sh
pnpm --filter @altis/sign-cli altis-sign ceremony check \
  --roots "$PWD/tools/keys/community/roots.json" --keyset "$PWD/tools/keys/community/keyset.json"
```

| kid | use | SHA-256 of the public key |
| --- | --- | --- |
| `arsya-root-1` | root | `401d 033d fe02 8342 8505 5354 9220 f676 68da e15c e6e6 88ca 95c9 8b49 3b9d 7cce` |
| `arsya-root-2` | root (cadangan / backup) | `1e87 6079 4b9a d3aa f144 d038 2b31 474b 8c20 502d 3480 83e1 d8d4 1d03 8967 b940` |
| `arsya-rel-1` | release | `db51 44a3 4b4a f048 159f 92eb 8cb6 44ee a669 5445 1265 fd3a 3e63 0843 589c 33af` |
| `arsya-ts-2` | timestamp | `2aa6 72ba 4884 5620 eecb 398c 7042 b6d0 83bd 3d73 2541 8e1a a004 67a7 ebf6 3092` |
| `arsya-ts-1` | timestamp, dicabut / revoked (seq 2) | `4606 f7fc f505 6d04 e79d d7ae b682 e867 dd24 e1b2 111d 5c80 bfdd 1f67 1927 825a` |

Keyset seq 1 (rel-1, ts-1) dan seq 2 (ts-2 menggantikan ts-1, tidak pernah dipakai), 2026-11-24. / Keyset seq 1 and seq 2
(ts-2 replaces the never-used ts-1), 2026-11-24. Kunci privat tidak pernah ada di repositori ini. / The private keys are never in this
repository. Lihat / see [docs/ops/release-signing.md](../../../docs/ops/release-signing.md).
