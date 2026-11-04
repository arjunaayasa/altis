/**
 * The altis-sign command line: usage, dispatch, exit codes, and the `release sign` and `keyset sign` commands (the
 * tool is described in index.ts). Internal to the package: `runCli` (index.ts, the package's export) runs it without
 * test hooks, `runCliForTest` (testing.ts, not published) with them, so the hooks never reach the public API
 * (preflight M10).
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import {
  KEYSET_TYP,
  KEY_USES,
  MANIFEST_FILE,
  RELEASE_TYP,
  SIGNATURE_FILE,
  canonicalize,
  isKeyset,
  signDetached,
  validateManifest,
  type Envelope,
  type KeysetDoc,
} from '@altis/crypto';
import { ceremonyCheckCommand } from './ceremony.js';
import {
  CliError,
  DEV_KID_PREFIX,
  UsageError,
  devPublicKeys,
  errorCode,
  isKeysetDocShape,
  json,
  messageOf,
  readRootKeys,
  readStrictJson,
  requiredOptions,
  writeTextAtomic,
  type CliIo,
  type TestHooks,
} from './common.js';
import { feedSignCommand, freshnessSignCommand } from './feed.js';
import { keygenCommand, loadKeyFor, pubCommand } from './key-file.js';

const USAGE = [
  'Usage:',
  '  altis-sign keygen --use <use> --kid <kid> --out <dir> [--encrypt]',
  '      Creates <dir>/<kid>.key.json (private, mode 0600, never over an existing file) and appends the public key',
  `      to <dir>/trusted.json. <use> is one of: ${KEY_USES.join(', ')}.`,
  '      --encrypt: the key file is encrypted with a passphrase (scrypt + AES-256-GCM), typed twice on the',
  '      terminal or taken from ALTIS_KEY_PASSPHRASE. Every command that reads an encrypted key asks the same way.',
  '  altis-sign pub --key <file> [--out <file>]',
  '      Prints (or writes) the public half of a key file: {kid, use, pub}.',
  '  altis-sign release sign --dir <releaseDir> --key <file>',
  '      Signs <releaseDir>/manifest.json with a release key and writes <releaseDir>/manifest.sig.',
  '  altis-sign keyset sign --in <keyset.json> --key <file> --root-keys <file> --out <file>',
  '      Signs the keyset payload {seq, keys, revokedKids} with a root key (never a release key) and',
  '      appends the signed document to the array of documents in <file> (created when absent).',
  '      --root-keys is every root key app.js embeds ([{kid, use: "root", pub}]); the signing key is one of',
  '      them, and the payload never adds, lists or revokes any of them. A production (not dev-) root',
  '      never signs a payload that trusts a dev- kid or a public key of tools/keys/dev.',
  '  altis-sign feed sign --in <feed-src.json> --keyset <keyset.json> --key <file> --out-dir <dir>',
  '      Signs the update feed {v: 1, channel, releases} with a release key: writes <dir>/feed.json (canonical,',
  '      carrying every document of --keyset) and <dir>/feed.sig.',
  '  altis-sign freshness sign --feed <feed.json> --seq <n> --expires-in-days <d> --key <file> --out <file>',
  '                            [--issued-at <ISO date-time>]',
  '      Signs the freshness document of a feed.json with a timestamp key, issued now (this host runs NTP) and',
  '      expiring after <d> days (1 to 14). --issued-at is for dev- keys only, never more than 5 min ahead.',
  '  altis-sign ceremony check --roots <roots.json> --keyset <keyset.json> [--pub <file>...]',
  '      Checks production key material (two roots or more, no dev key, a keyset that trusts release and',
  '      timestamp keys) and prints the fingerprint of every key.',
].join('\n');

// ---------------------------------------------------------------------------------------------------------
// release sign

async function releaseSignCommand(args: string[], io: CliIo): Promise<void> {
  const o = requiredOptions(args, ['dir', 'key']);
  const key = await loadKeyFor(o['key'] as string, RELEASE_TYP);
  const manifestFile = nodePath.join(o['dir'] as string, MANIFEST_FILE);
  const payload = await readStrictJson(manifestFile, 'manifest');
  try {
    validateManifest(payload);
  } catch (err) {
    throw new CliError(`${manifestFile} is not a valid release manifest: ${messageOf(err)}`);
  }
  const env = signDetached(payload, { typ: RELEASE_TYP, kid: key.kid, privateKey: key.privateKey });
  const signatureFile = nodePath.join(o['dir'] as string, SIGNATURE_FILE);
  await writeTextAtomic(signatureFile, json(env));
  io.out(`signed ${manifestFile} as ${key.kid}: wrote ${signatureFile}`);
}

// ---------------------------------------------------------------------------------------------------------
// keyset sign

async function readKeysetDocs(file: string): Promise<KeysetDoc[]> {
  let present = true;
  try {
    await fsp.access(file);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
    present = false;
  }
  if (!present) return [];
  const value = await readStrictJson(file, 'keyset file');
  if (!Array.isArray(value) || !value.every(isKeysetDocShape)) throw new CliError(`keyset file ${file} must be an array of {raw, env} documents`);
  return value;
}

async function keysetSignCommand(args: string[], io: CliIo, hooks: TestHooks): Promise<void> {
  const o = requiredOptions(args, ['in', 'key', 'root-keys', 'out']);
  const key = await loadKeyFor(o['key'] as string, KEYSET_TYP);
  const roots = await readRootKeys(o['root-keys'] as string);
  if (!roots.some((root) => root.kid === key.kid && root.pub === key.pub)) {
    throw new CliError(`the signing key ${key.kid} is not among the root keys of ${o['root-keys']}: app.js would ignore the document`);
  }
  const payload = await readStrictJson(o['in'] as string, 'keyset payload');
  if (!isKeyset(payload)) {
    throw new CliError(
      `${o['in']} is not a keyset payload: expected exactly {seq (integer >= 1), keys: [{kid, use, pub}], revokedKids: [kid]}`,
    );
  }
  // What resolveTrustedKeys rejects as a whole (`root`), against every root: the spare too (ruling R65e).
  const touched =
    payload.keys.find((k) => k.use === 'root' || roots.some((root) => root.kid === k.kid || root.pub === k.pub)) ??
    roots.find((root) => payload.revokedKids.indexOf(root.kid) !== -1);
  if (touched !== undefined) {
    throw new CliError(`${o['in']}: a keyset document never adds, lists or revokes a root key (${touched.kid}); roots are rotated with a new app.js`);
  }
  // Ruling R65b: a production root never trusts a dev key, whose private half is public.
  if (!key.kid.startsWith(DEV_KID_PREFIX)) {
    const devPubs = await devPublicKeys(hooks.devTrustedFile, 'a production root never signs without checking them');
    const dev = payload.keys.find((k) => k.kid.startsWith(DEV_KID_PREFIX) || devPubs.indexOf(k.pub) !== -1);
    if (dev !== undefined) {
      throw new CliError(`${o['in']}: the production root ${key.kid} never trusts a dev key (${dev.kid}); dev keys are for tests only`);
    }
  }
  const out = o['out'] as string;
  const docs = await readKeysetDocs(out);
  const env: Envelope = signDetached(payload, { typ: KEYSET_TYP, kid: key.kid, privateKey: key.privateKey });
  docs.push({ raw: canonicalize(payload), env });
  await fsp.mkdir(nodePath.dirname(nodePath.resolve(out)), { recursive: true });
  await writeTextAtomic(out, json(docs));
  io.out(`signed keyset seq ${payload.seq} as ${key.kid}: ${out} now holds ${docs.length} document(s)`);
}

// ---------------------------------------------------------------------------------------------------------
// Entry

/** A command: its arguments, where it prints, and the test hooks (only `runCliForTest` gives any). */
type Command = (args: string[], io: CliIo, hooks: TestHooks) => Promise<void>;

async function dispatch(argv: string[], io: CliIo, hooks: TestHooks): Promise<void> {
  const [command, ...rest] = argv;
  const nested = (subcommands: Record<string, Command>): Promise<void> => {
    const [sub, ...args] = rest;
    const run = sub === undefined ? undefined : subcommands[sub];
    if (run === undefined || !Object.prototype.hasOwnProperty.call(subcommands, sub as string)) {
      throw new UsageError(`${command}: expected one of: ${Object.keys(subcommands).join(', ')}`);
    }
    return run(args, io, hooks);
  };
  switch (command) {
    case 'keygen':
      return keygenCommand(rest, io);
    case 'pub':
      return pubCommand(rest, io);
    case 'release':
      return nested({ sign: releaseSignCommand });
    case 'keyset':
      return nested({ sign: keysetSignCommand });
    case 'feed':
      return nested({ sign: feedSignCommand });
    case 'freshness':
      return nested({ sign: freshnessSignCommand });
    case 'ceremony':
      return nested({ check: ceremonyCheckCommand });
    case undefined:
      throw new UsageError('missing command');
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

/**
 * Runs the CLI with `hooks` and returns the exit code: 0 done, 1 failed, 2 wrong command line. `runCli` passes no hook;
 * only `runCliForTest` (testing.ts) passes any.
 */
export async function runWithHooks(argv: string[], io: CliIo, hooks: Readonly<TestHooks>): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    io.out(USAGE);
    return 0;
  }
  try {
    await dispatch(argv, io, hooks);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${messageOf(err)}`);
    return 1;
  }
}
