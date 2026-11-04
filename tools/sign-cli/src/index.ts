/**
 * altis-sign: the release signing tool of ALTIS (spec §8.3, §9.6, §13.4). It makes the keys, signs releases, root-signed
 * keysets and the update feed, and checks production key material; a maintainer or a fork runs it to publish signed
 * releases (docs/ops/release-signing.md). Never part of a release zip.
 *
 *   altis-sign keygen --use <use> --kid <kid> --out <dir> [--encrypt]
 *   altis-sign pub --key <file> [--out <file>]
 *   altis-sign release sign --dir <releaseDir> --key <file>
 *   altis-sign keyset sign --in <keyset.json> --key <file> --root-keys <file> --out <file>
 *   altis-sign feed sign --in <feed-src.json> --keyset <keyset.json> --key <file> --out-dir <dir>
 *   altis-sign freshness sign --feed <feed.json> --seq <n> --expires-in-days <d> --key <file> --out <file>
 *   altis-sign ceremony check --roots <roots.json> --keyset <keyset.json> [--pub <file>…]
 *
 * Private keys live in `<kid>.key.json` files: `{kid, use, pkcs8}` with the PKCS#8 DER in base64, or the same key
 * passphrase-encrypted, `{kid, use, enc}` (key-file.ts). Production root, release and timestamp keys are made offline
 * with `keygen --encrypt` and never pass through CI; CI only signs with the committed `dev-*` keys of tools/keys/dev.
 * Key sets are signed by `root` keys only (ruling R65): `keyset sign` refuses any other key, any payload that touches a
 * root of --root-keys, and, under a production root, any payload that trusts a dev key.
 *
 * This file is the package's only export (`exports: {".": "./src/index.ts"}`): `runCli`, which runs the command line
 * (cli.ts) without test hooks, and the key file loader the release build uses. Tests that need another dev key list run
 * `runCliForTest` from src/testing.ts, which the exports do not publish (preflight M10).
 */
import { runWithHooks } from './cli.js';
import { NO_HOOKS, type CliIo } from './common.js';

export type { CliIo } from './common.js';
export { KEY_FILE_KDF, PASSPHRASE_ENV, loadKeyFile } from './key-file.js';
export type { LoadKeyFileOptions, LoadedKeyFile, PassphraseSource } from './key-file.js';

const STD_IO: CliIo = {
  out: (line) => void process.stdout.write(line + '\n'),
  err: (line) => void process.stderr.write(line + '\n'),
};

/** Runs the CLI and returns the exit code: 0 done, 1 failed, 2 wrong command line. */
export function runCli(argv: string[], io: CliIo = STD_IO): Promise<number> {
  return runWithHooks(argv, io, NO_HOOKS);
}
