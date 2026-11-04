# Common-password lists (spec §7.1, D16)

The password policy refuses any password on these lists, compared case-insensitively after NFKC
(`src/crypto/policy.ts`). `scripts/gen-common-passwords.ts` compiles both into `src/crypto/common-passwords.ts`,
which is what ships; `test/policy.test.ts` fails when the generated file, the lists or this record disagree.

Daftar ini dipakai kebijakan kata sandi: kata sandi yang ada di sini ditolak (tanpa membedakan huruf besar/kecil).

## `common-passwords.txt`: SecLists, vendored

| | |
|---|---|
| Source | `Passwords/Common-Credentials/10k-most-common.txt` of <https://github.com/danielmiessler/SecLists> |
| Commit | `758fecf4925900dd1bd0a3cba39551d6b4f2da8c` |
| URL | <https://raw.githubusercontent.com/danielmiessler/SecLists/758fecf4925900dd1bd0a3cba39551d6b4f2da8c/Passwords/Common-Credentials/10k-most-common.txt> |
| SHA-256 | `68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce` |
| Licence | MIT, `LICENSE-SecLists.txt` (SecLists' `LICENSE` at the same commit, copied unchanged) |

The file is copied byte for byte. Its licence text reaches `THIRD_PARTY_NOTICES.txt` through `VENDORED_NOTICES`
(`tools/release/src/notices.ts`); the build fails without it.

To vendor it, or to move it to a newer commit (`<commit>` = the full SecLists commit hash):

```sh
base=https://raw.githubusercontent.com/danielmiessler/SecLists/<commit>
curl -fsSL "$base/Passwords/Common-Credentials/10k-most-common.txt" -o packages/core/data/common-passwords.txt
curl -fsSL "$base/LICENSE" -o packages/core/data/LICENSE-SecLists.txt
shasum -a 256 packages/core/data/common-passwords.txt   # record it above, with the commit and the URL
pnpm --filter @altis/core gen:common-passwords
pnpm vitest run --project unit packages/core tools/release/test/notices.test.ts
```

## `id-common-passwords.txt`: ours

Indonesian passwords that an international list misses (`perpustakaan`, `bismillah123`, `merdeka45`, ...),
written for ALTIS, one per line, lower case. Entries shorter than 10 characters never matter to the policy (the
length check refuses them first) but keep `isCommonPassword` honest. Add to it freely, then regenerate.
