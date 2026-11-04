/**
 * `ceremony check`: the check of freshly made production key material before a build embeds it (spec §8.3, ruling R65;
 * decision D1d-28; preflight 1D-16; docs/ops/release-signing.md).
 *
 *   altis-sign ceremony check --roots <roots.json> --keyset <keyset.json> [--pub <file>…]
 *
 * It passes only when:
 * - nothing is dev material: no kid starting with `dev-` and no public key of tools/keys/dev, among the roots, the
 *   keyset documents (signers and keys) and the --pub files (DEV_KEY);
 * - there are at least two roots (the active one and the offline spare, R65e: ROOTS_TOO_FEW) with distinct kids and
 *   public keys (ROOTS_DUPLICATE);
 * - `resolveTrustedKeys(roots, docs, {refuseDevKids: true})`, what a production app.js does, accepts every document and
 *   finds no kid bound to two keys (KEYSET_INVALID);
 * - the keyset trusts at least one key of each use `release` and `timestamp` (KEYSET_MISSING_USE:<use>), what a
 *   signed release and its update feed need; keys of the reserved uses `license` and `device` may be there too;
 * - every --pub file (`{kid, use, pub}`, as `altis-sign pub` writes it) is a key the roots or the keyset trust
 *   (PUB_NOT_TRUSTED:<kid>): the keys just made are the ones the keyset names.
 * It then prints kid, use and fingerprint of every trusted key, to be recorded with the release keys.
 * The fingerprint is the SHA-256 of the raw 32-byte Ed25519 public key, in hex groups of four ({@link keyFingerprint}).
 *
 * The dev public keys are those of tools/keys/dev/trusted.json; only the test hooks of `runCliForTest` (src/testing.ts,
 * not published) name another file, never `CliIo` (preflight M10).
 */
import { createHash } from 'node:crypto';
import {
  KEYSET_MAX_FILE_BYTES,
  decodeBase64Url,
  isKeyset,
  isTrustedKey,
  parseKeysetDocs,
  parseStrictJson,
  resolveTrustedKeys,
  type KeyUse,
  type KeysetDoc,
  type TrustedKey,
} from '@altis/crypto';
import {
  CliError,
  DEV_KID_PREFIX,
  devPublicKeys,
  hasExactKeys,
  isKeysetDocShape,
  isRecord,
  messageOf,
  parseOptions,
  readRootKeys,
  readStrictJson,
  readText,
  type CliIo,
  type TestHooks,
} from './common.js';

/** The uses the initial keyset must trust: `rel` signs releases and feeds, `ts` the feed's freshness. */
export const CEREMONY_USES: readonly KeyUse[] = Object.freeze(['release', 'timestamp'] as KeyUse[]);

/** The fewest root keys a production build embeds (ruling R65e). */
export const MIN_ROOTS = 2;

/** SHA-256 of the raw public key (base64url, as in `{kid, use, pub}`), lower-case hex in groups of four. */
export function keyFingerprint(pub: string): string {
  const raw = decodeBase64Url(pub);
  if (raw === null) throw new TypeError('keyFingerprint: pub must be base64url');
  return (createHash('sha256').update(raw).digest('hex').match(/.{4}/g) as string[]).join(' ');
}

async function readKeysetDocs(file: string): Promise<KeysetDoc[]> {
  const text = await readText(file, 'keyset file');
  try {
    if (Buffer.byteLength(text, 'utf8') > KEYSET_MAX_FILE_BYTES) throw new Error(`larger than ${KEYSET_MAX_FILE_BYTES} bytes`);
    const docs = parseKeysetDocs(parseStrictJson(text));
    // A production keyset holds documents only: an entry of another shape is a mistake to fix, not one to skip.
    const bad = docs.findIndex((doc) => !isKeysetDocShape(doc));
    if (bad !== -1) throw new Error(`entry ${bad} is not {raw, env: {typ, kid, alg, sig}}`);
    return docs;
  } catch (err) {
    throw new CliError(`KEYSET_INVALID (${file} is not an array of keyset documents [{raw, env}]: ${messageOf(err)})`);
  }
}

async function readPubFile(file: string): Promise<TrustedKey> {
  const value = await readStrictJson(file, '--pub file');
  if (!isRecord(value) || !hasExactKeys(value, ['kid', 'pub', 'use']) || !isTrustedKey(value)) {
    throw new CliError(`--pub file ${file} must be exactly {kid, use, pub}, as altis-sign pub writes it`);
  }
  return { kid: value.kid, use: value.use, pub: value.pub };
}

/** The keys a document's payload adds and the kid that signed it, unverified: for the dev check only. */
function documentKeys(doc: KeysetDoc): { signer: string; keys: TrustedKey[] } {
  let payload: unknown;
  try {
    payload = parseStrictJson(doc.raw);
  } catch (err) {
    void err; // not JSON: resolveTrustedKeys rejects it (KEYSET_INVALID)
    payload = undefined;
  }
  return { signer: String(doc.env.kid), keys: isKeyset(payload) ? payload.keys : [] };
}

/** `ceremony check --roots <roots.json> --keyset <keyset.json> [--pub <file>…]` (see the top of this file). */
export async function ceremonyCheckCommand(args: string[], io: CliIo, hooks: TestHooks): Promise<void> {
  const o = parseOptions(args, { required: ['roots', 'keyset'], multiple: ['pub'] });
  const rootsFile = o.values['roots'] as string;
  const keysetFile = o.values['keyset'] as string;
  const roots = await readRootKeys(rootsFile);
  const docs = await readKeysetDocs(keysetFile);
  const pubs: TrustedKey[] = [];
  for (const file of o.lists['pub'] ?? []) pubs.push(await readPubFile(file));

  // 1. No dev material anywhere: the dev keys' private halves are public (ruling R65b).
  const devPubs = await devPublicKeys(hooks.devTrustedFile, 'a ceremony is never checked without them');
  const isDev = (kid: string, pub?: string): boolean => kid.startsWith(DEV_KID_PREFIX) || (pub !== undefined && devPubs.indexOf(pub) !== -1);
  const devKey = (kid: string, where: string): CliError =>
    new CliError(`DEV_KEY:${kid} (${where}: dev keys are public test keys of tools/keys/dev; production key material never holds one)`);
  for (const key of roots) if (isDev(key.kid, key.pub)) throw devKey(key.kid, `root key of ${rootsFile}`);
  docs.forEach((doc, index) => {
    const found = documentKeys(doc);
    if (isDev(found.signer)) throw devKey(found.signer, `signer of document ${index} of ${keysetFile}`);
    for (const key of found.keys) if (isDev(key.kid, key.pub)) throw devKey(key.kid, `key of document ${index} of ${keysetFile}`);
  });
  for (const key of pubs) if (isDev(key.kid, key.pub)) throw devKey(key.kid, 'a --pub file');

  // 2. Two roots at least, distinct (R65e).
  if (roots.length < MIN_ROOTS) {
    throw new CliError(`ROOTS_TOO_FEW (${rootsFile} holds ${roots.length} root key(s); production embeds at least ${MIN_ROOTS}: the active root and the offline spare)`);
  }
  const kids = new Set(roots.map((k) => k.kid));
  const pubKeys = new Set(roots.map((k) => k.pub));
  if (kids.size !== roots.length || pubKeys.size !== roots.length) {
    throw new CliError(`ROOTS_DUPLICATE (${rootsFile}: every root needs its own kid and its own key pair)`);
  }

  // 3. The keyset as a production app.js reads it: every document counts, no kid bound to two keys.
  const resolved = resolveTrustedKeys(roots, docs, { refuseDevKids: true });
  const problems = [
    ...resolved.rejected.map(({ index, reason }) => `document ${index}: ${reason}`),
    ...resolved.conflicts.map((kid) => `kid ${kid} is bound to two keys`),
  ];
  if (problems.length > 0) throw new CliError(`KEYSET_INVALID (${keysetFile} against ${rootsFile}: ${problems.join('; ')})`);
  for (const use of CEREMONY_USES) {
    if (!resolved.keys.some((k) => k.use === use)) {
      throw new CliError(`KEYSET_MISSING_USE:${use} (${keysetFile} trusts no ${use} key: the initial keyset trusts rel and ts keys)`);
    }
  }

  // 4. The keys just made are the ones trusted.
  for (const key of pubs) {
    if (!resolved.keys.some((k) => k.kid === key.kid && k.use === key.use && k.pub === key.pub)) {
      throw new CliError(`PUB_NOT_TRUSTED:${key.kid} (its {kid, use, pub} is not among the roots of ${rootsFile} nor the keys ${keysetFile} trusts)`);
    }
  }

  const kidWidth = Math.max(3, ...resolved.keys.map((k) => k.kid.length));
  const useWidth = Math.max(3, ...resolved.keys.map((k) => k.use.length));
  io.out(`${'kid'.padEnd(kidWidth)}  ${'use'.padEnd(useWidth)}  SHA-256 of the public key`);
  for (const key of resolved.keys) io.out(`${key.kid.padEnd(kidWidth)}  ${key.use.padEnd(useWidth)}  ${keyFingerprint(key.pub)}`);
  io.out('');
  io.out(
    `OK: ${roots.length} root keys; ${docs.length} keyset document(s), seq ${resolved.maxSeq}, trust ${CEREMONY_USES.join(', ')} keys; ` +
      `no dev material${pubs.length > 0 ? `; ${pubs.length} --pub file(s) match` : ''}. Record every kid and fingerprint with the keys.`,
  );
}
