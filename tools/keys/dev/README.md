# ALTIS dev signing keys: TEST ONLY

**These keys are public. They exist for tests, CI and local development only. Never trust them, never ship
them, never use them for a real release.** The private halves (`*.key.json`) are committed on purpose, so
anybody with this repository can sign anything these keys are trusted for. A test-profile build (a `-test`
version) trusts them: never deploy one.

Kunci di folder ini hanya untuk uji dan CI. Kunci produksi (`root-*`, `rel-*`, `ts-*`) dibuat offline oleh
penerbit rilis (docs/ops/release-signing.md) dan tidak pernah ada di repositori ini.

| kid | use | signs |
|---|---|---|
| `dev-root-1` | `root` | keyset documents only (signs `keyset.json`); the trust anchor test builds embed |
| `dev-rel-1` | `release` | release manifests and feeds (never keysets) |
| `dev-rel-2` | `release` | a second release key, for rotation and revocation tests |
| `dev-lic-1` | `license` | nothing: reserved key use `license`, not used by the community edition |
| `dev-ts-1` | `timestamp` | feed freshness documents |
| `dev-dca-1` | `device` | nothing: reserved key use `device` |

## Trust model (spec §8.3, ruling R65)

A build embeds root keys only (`__TRUSTED_KEYS__` of app.js and server.mjs). Every other key is trusted only
through an `altis-keyset/1` document signed by an embedded root: a test build embeds `dev-root-1`, and every
test release ships `keyset.json`, in which `dev-root-1` trusts the five other keys. A release key never signs a
keyset document, and no document can add, rebind or revoke a root.

## Files

- `<kid>.key.json`: private key, `{kid, use, pkcs8}` (PKCS#8 DER in base64).
- `trusted.json`: every public key, `[{kid, use, pub}]` (`pub` is the raw 32-byte Ed25519 key in base64url),
  as `keygen` appends them. Nothing secret is in it. The same keys as `roots.json` plus those `keyset.json` adds
  (`resolveTrustedKeys`), so test code may pass it to `verifyRelease` as an already resolved key set.
- `roots.json`: the dev trust anchors, `[{kid, use: 'root', pub}]`: the `root` entries of `trusted.json`. This is
  what a test build embeds (`packages/bootloader` build, `pnpm release --profile test` default `--root-keys`), what
  `keyset sign --root-keys` takes, and what test code passes as root keys (`resolveTrustedKeys`,
  `verifyReleaseWithRoots`). A test build needs one root; a production build needs two or more (ruling R65e).
- `keyset.json`: array of signed `altis-keyset/1` documents (`[{raw, env}]`). One document today: `seq` 1, the
  five non-root public keys, nothing revoked, signed by `dev-root-1`. Test releases ship it as their `keyset.json`.

## Rules

- A `dev-` kid must never appear in a production-profile build (spec §8.3), the roots included. The release
  tool enforces this with `DEV_KEY_IN_PRODUCTION`; production builds embed their own offline root keys (public
  halves only: the build never needs a root private key) and ship a keyset signed offline by one of them.
- Test code may read `trusted.json`, `roots.json`, `keyset.json` and the `*.key.json` files directly; nothing
  else should.
- No other `*.key.json` is ever committed anywhere (`.gitignore` refuses them outside this folder).

## Regenerating

From the repository root (`<use>` is `root`, `release`, `license`, `timestamp` or `device`):

```sh
pnpm --filter @altis/sign-cli altis-sign keygen --use <use> --kid <kid> --out "$PWD/tools/keys/dev"
```

`keygen` refuses to overwrite an existing key or reuse a kid in `trusted.json`. To replace a key, delete its
`.key.json` and its entry in `trusted.json` first (for a root, update `roots.json` to the `root` entries of
`trusted.json`), then regenerate `keyset.json` with the root key:

```sh
pnpm --filter @altis/sign-cli altis-sign keyset sign \
  --in keyset-payload.json --key "$PWD/tools/keys/dev/dev-root-1.key.json" \
  --root-keys "$PWD/tools/keys/dev/roots.json" --out "$PWD/tools/keys/dev/keyset.json"
```

where `keyset-payload.json` is `{"seq": <n>, "keys": [<the non-root entries of trusted.json>], "revokedKids": []}`
(a keyset never lists a root). `keyset sign` refuses any key that is not a `root` key, a signing key that is not in
`--root-keys`, and a payload that touches any root of `--root-keys`. A production (not `dev-`) root also refuses a
payload that trusts a `dev-` kid or a public key of `trusted.json`. Signing appends to `keyset.json`; delete the file
first to start again. A keyset file is a JSON array of at most 4096 documents of at most 64 KiB, 8 MiB in all
(ruling R65c). A production root refuses to sign when `trusted.json` cannot be read.
