/**
 * Two-tier key sets (spec §8.3, ruling R65).
 *
 * The keys a build embeds (`__TRUSTED_KEYS__` of app.js and server.mjs) are the trust anchors, and they are `root`
 * keys only: the active one and an offline spare. Every other key (release, license, timestamp, device) is trusted
 * only through an `altis-keyset/1` document `{seq, keys, revokedKids}` signed by one of those roots. Release keys
 * sign manifests and feeds, never key sets, so a leaked release key can neither add nor revoke a key. Documents can
 * never add, rebind or revoke a root: rotating a root takes a new app.js (manual upgrade).
 *
 * Resolution depends neither on the order of the documents nor on their `seq`: each document is verified on its own
 * against the roots, and the trusted keys are the roots plus every key a valid document adds, minus every kid a valid
 * document revokes and every public key such a kid was bound to. Revocation is permanent (a replaced key gets a new
 * kid and a new key pair). `seq` is kept for display and storage.
 *
 * The work is bounded (ruling R65c): a keyset file holds at most {@link KEYSET_MAX_DOCS} documents of at most
 * {@link KEYSET_MAX_DOC_BYTES} each, and copies of an accepted document are verified once.
 *
 * Bundled into the ES2017 bootloader: keep the syntax plain and the module dependency-free.
 */
import { Buffer } from 'node:buffer';
import { verifyDetached, type Envelope } from './envelope.js';
import { canonicalize } from './jcs.js';
import { isTrustedKey, type TrustedKey } from './keys.js';

export type Keyset = { seq: number; keys: TrustedKey[]; revokedKids: string[] };

export type KeysetDoc = { raw: string; env: Envelope };

/**
 * A document that has no effect: its index in the `docs` argument of {@link resolveTrustedKeys}, and why: a
 * `SIG_INVALID:<reason>` message of {@link verifyDetached} (not an `altis-keyset/1` signature by an embedded root;
 * a document signed by any other key fails `SIG_INVALID:kid`), `shape` (not exactly `{seq, keys, revokedKids}`), or
 * `root` (it touches a root, see {@link resolveTrustedKeys}), `size` (raw text over {@link KEYSET_MAX_DOC_BYTES}), or
 * `dev` (it adds a `dev-` kid while `refuseDevKids` is set).
 */
export type KeysetRejection = { index: number; reason: string };

export type ResolveTrustedKeysOptions = {
  /**
   * Reject as a whole every document that adds a key whose kid starts with `dev-` (reason `dev`): set by production
   * builds of app.js and server.mjs (ruling R65b), so that no document, even root-signed, trusts a dev key whose
   * private half is public. Revoking a dev kid stays allowed.
   */
  refuseDevKids?: boolean;
};

/** Root-signed documents from one place (a keyset.json file, a feed), named for reports. */
export type KeysetSource = { name: string; docs: KeysetDoc[] };

/** A document of a {@link KeysetSource} that had no effect: the source's name, its index there, and why. */
export type SourcedRejection = { source: string; index: number; reason: string };

/** Result of {@link resolveKeysetSources}: {@link ResolvedKeys} with each rejection named by its source. */
export type KeysetReport = { keys: TrustedKey[]; maxSeq: number; rejected: SourcedRejection[]; conflicts: string[] };

/** Result of {@link resolveTrustedKeys}. */
export type ResolvedKeys = {
  /** The roots (in the order given), then every key that the valid documents add and none revokes, by kid. */
  keys: TrustedKey[];
  /** The highest `seq` of a valid document, 0 when there is none. Never decides trust. */
  maxSeq: number;
  /** The documents that had no effect, in index order. */
  rejected: KeysetRejection[];
  /** Kids that valid documents bind to different keys (use or pub), sorted. None of them is trusted. */
  conflicts: string[];
};

export const KEYSET_TYP = 'altis-keyset/1';

/** Most documents one keyset file may hold (ruling R65c; room for the 1d append-only writer). */
export const KEYSET_MAX_DOCS = 4096;
/** Largest document: its JSON text in a keyset file, and its `raw` text (UTF-8 bytes; ruling R65c). */
export const KEYSET_MAX_DOC_BYTES = 64 * 1024;

/** The key use of the trust anchors and of every signer of a key set. */
const ROOT_USE = 'root';
/** The kid prefix of the test-only keys of tools/keys/dev. */
const DEV_KID_PREFIX = 'dev-';

const KEYSET_FIELDS = 'keys,revokedKids,seq';

/** Exactly `{seq, keys, revokedKids}`: a safe integer seq >= 1, valid keys, and non-empty kid strings. */
export function isKeyset(value: unknown): value is Keyset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(',') !== KEYSET_FIELDS) return false;
  const v = value as Record<string, unknown>;
  const seq = v['seq'];
  const keys = v['keys'];
  const revokedKids = v['revokedKids'];
  return (
    typeof seq === 'number' &&
    Number.isSafeInteger(seq) &&
    seq >= 1 &&
    Array.isArray(keys) &&
    keys.every(isTrustedKey) &&
    Array.isArray(revokedKids) &&
    revokedKids.every((kid) => typeof kid === 'string' && kid !== '')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The documents of a parsed keyset.json (`DATA_DIR/releases/keyset.json`, or the one a release ships), in the frozen
 * format of ruling R65c: a JSON array (never a bare document) of at most {@link KEYSET_MAX_DOCS} entries, each at most
 * {@link KEYSET_MAX_DOC_BYTES} as JSON text. The entries are not checked here: {@link resolveTrustedKeys} rejects a
 * bad one on its own, so one bad entry never hides the others. Throws TypeError otherwise.
 */
export function parseKeysetDocs(value: unknown): KeysetDoc[] {
  if (!Array.isArray(value)) throw new TypeError('keyset.json: not an array of documents');
  if (value.length > KEYSET_MAX_DOCS) throw new TypeError('keyset.json: too many documents (more than ' + KEYSET_MAX_DOCS + ')');
  for (let i = 0; i < value.length; i++) {
    if (Buffer.byteLength(JSON.stringify(value[i]), 'utf8') > KEYSET_MAX_DOC_BYTES) {
      throw new TypeError('keyset.json: document ' + i + ' is too large (more than ' + KEYSET_MAX_DOC_BYTES + ' bytes)');
    }
  }
  return value.slice() as KeysetDoc[];
}

/**
 * The exact identity of a document: its raw text as it is and the canonical form of its whole envelope. Copies of an
 * ACCEPTED document are skipped (round 2 of ruling R65: a tampered copy, rejected, must never hide the genuine one).
 * Undefined for an entry that is not `{raw: string, env: object}` or whose envelope has no canonical form.
 */
function identity(doc: unknown): string | undefined {
  if (!isRecord(doc) || typeof doc['raw'] !== 'string' || !isRecord(doc['env'])) return undefined;
  try {
    return JSON.stringify([doc['raw'], canonicalize(doc['env'])]);
  } catch (err) {
    void err; // verifyDetached rejects such an envelope with the precise reason
    return undefined;
  }
}

function sameKey(a: TrustedKey, b: TrustedKey): boolean {
  return a.kid === b.kid && a.use === b.use && a.pub === b.pub;
}

const copy = (k: TrustedKey): TrustedKey => ({ kid: k.kid, use: k.use, pub: k.pub });

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The roots as fresh copies, an identical key given twice kept once. @throws TypeError */
function checkedRoots(roots: TrustedKey[]): TrustedKey[] {
  const result: TrustedKey[] = [];
  for (const key of roots) {
    if (!isTrustedKey(key) || key.use !== ROOT_USE) {
      throw new TypeError('resolveTrustedKeys: every embedded key must be a valid root key');
    }
    let existing: TrustedKey | undefined;
    for (const k of result) if (k.kid === key.kid) existing = k;
    if (existing === undefined) result.push(copy(key));
    else if (!sameKey(existing, key)) throw new TypeError('resolveTrustedKeys: embedded kid ' + key.kid + ' is bound to two keys');
  }
  return result;
}

/** A document touches a root when it lists a root kid (in keys or revokedKids), adds a root key, or binds a root's pub. */
function touchesRoot(keyset: Keyset, roots: TrustedKey[]): boolean {
  for (const key of keyset.keys) {
    if (key.use === ROOT_USE) return true;
    for (const root of roots) if (key.kid === root.kid || key.pub === root.pub) return true;
  }
  for (const kid of keyset.revokedKids) {
    for (const root of roots) if (kid === root.kid) return true;
  }
  return false;
}

/**
 * The keys trusted under `roots` (the embedded `root` keys) and the signed keyset documents `docs`. Order- and
 * seq-independent:
 * - a copy of an accepted document (same raw text, same envelope) is skipped; a rejected document suppresses
 *   nothing, so a tampered copy can never hide the genuine one;
 * - each document is verified on its own: raw text of at most {@link KEYSET_MAX_DOC_BYTES} (`size`), an
 *   `altis-keyset/1` signature by one of `roots` over exactly `{seq, keys, revokedKids}`; a document that lists a root
 *   kid in `keys` or `revokedKids`, adds a key of use `root`, or binds a root's public key under another kid, is
 *   rejected as a whole (`root`); with `o.refuseDevKids`, so is one that adds a `dev-` kid (`dev`). Rejected
 *   documents have no effect and are reported in `rejected`; they never throw;
 * - trusted = the roots + the keys added by valid documents − the kids revoked by valid documents − every key whose
 *   public key a revoked or conflicted kid was bound to by a valid document (ruling R65d: a revoked key never comes
 *   back, under any kid or use);
 * - a kid that valid documents bind to different keys (use or pub) is not trusted (fail closed) and is reported in
 *   `conflicts`;
 * - `maxSeq` is the highest `seq` of a valid document (0 when none), for display and storage only.
 *
 * Returns fresh objects. Throws TypeError when an argument is not an array, or an embedded key is not a valid root
 * key or rebinds a kid.
 */
export function resolveTrustedKeys(roots: TrustedKey[], docs: KeysetDoc[], o: ResolveTrustedKeysOptions = {}): ResolvedKeys {
  if (!Array.isArray(roots) || !Array.isArray(docs)) {
    throw new TypeError('resolveTrustedKeys: roots and docs must be arrays');
  }
  const anchors = checkedRoots(roots);
  const refuseDevKids = o !== null && typeof o === 'object' && o.refuseDevKids === true;

  const rejected: KeysetRejection[] = [];
  const valid: Keyset[] = [];
  /** Identities of the documents accepted so far: only those suppress later copies. */
  const accepted = new Set<string>();
  for (let index = 0; index < docs.length; index++) {
    const doc: unknown = docs[index];
    const d = doc !== null && typeof doc === 'object' ? (doc as Partial<KeysetDoc>) : {};
    if (typeof d.raw === 'string' && Buffer.byteLength(d.raw, 'utf8') > KEYSET_MAX_DOC_BYTES) {
      rejected.push({ index, reason: 'size' });
      continue;
    }
    const id = identity(doc);
    if (id !== undefined && accepted.has(id)) continue;
    let payload: unknown;
    try {
      payload = verifyDetached(d.raw as string, d.env as Envelope, anchors, KEYSET_TYP);
    } catch (err) {
      rejected.push({ index, reason: err instanceof Error ? err.message : 'SIG_INVALID' });
      continue;
    }
    if (!isKeyset(payload)) {
      rejected.push({ index, reason: 'shape' });
      continue;
    }
    if (touchesRoot(payload, anchors)) {
      rejected.push({ index, reason: 'root' });
      continue;
    }
    if (refuseDevKids && payload.keys.some((key) => key.kid.indexOf(DEV_KID_PREFIX) === 0)) {
      rejected.push({ index, reason: 'dev' });
      continue;
    }
    if (id !== undefined) accepted.add(id);
    valid.push(payload);
  }

  const bound = new Map<string, TrustedKey>();
  const conflicts = new Set<string>();
  const revoked = new Set<string>();
  let maxSeq = 0;
  for (const keyset of valid) {
    if (keyset.seq > maxSeq) maxSeq = keyset.seq;
    for (const kid of keyset.revokedKids) revoked.add(kid);
    for (const key of keyset.keys) {
      const existing = bound.get(key.kid);
      if (existing === undefined) bound.set(key.kid, copy(key));
      else if (!sameKey(existing, key)) conflicts.add(key.kid);
    }
  }
  // Every public key that a revoked or conflicted kid was bound to, by any valid document (fail closed, R65d).
  const revokedPubs = new Set<string>();
  for (const keyset of valid) {
    for (const key of keyset.keys) if (revoked.has(key.kid) || conflicts.has(key.kid)) revokedPubs.add(key.pub);
  }

  const added: TrustedKey[] = [];
  bound.forEach((key, kid) => {
    if (!revoked.has(kid) && !conflicts.has(kid) && !revokedPubs.has(key.pub)) added.push(key);
  });
  added.sort((a, b) => byText(a.kid, b.kid));
  return {
    keys: anchors.concat(added).map(copy),
    maxSeq,
    rejected,
    conflicts: Array.from(conflicts).sort(byText),
  };
}

/**
 * {@link resolveTrustedKeys} over every document of `sources`, in order, with each rejection named by its source and
 * its index there. A document found in several sources counts once and is reported (if rejected) under the first.
 */
export function resolveKeysetSources(roots: TrustedKey[], sources: KeysetSource[], o: ResolveTrustedKeysOptions = {}): KeysetReport {
  if (!Array.isArray(sources)) throw new TypeError('resolveKeysetSources: sources must be an array');
  const docs: KeysetDoc[] = [];
  const origin: { source: string; index: number }[] = [];
  for (const source of sources) {
    if (source === null || typeof source !== 'object' || !Array.isArray(source.docs)) {
      throw new TypeError('resolveKeysetSources: every source must be {name, docs}');
    }
    for (let i = 0; i < source.docs.length; i++) {
      docs.push(source.docs[i] as KeysetDoc);
      origin.push({ source: String(source.name), index: i });
    }
  }
  const resolved = resolveTrustedKeys(roots, docs, o);
  const rejected = resolved.rejected.map(({ index, reason }) => {
    const at = origin[index] as { source: string; index: number };
    return { source: at.source, index: at.index, reason };
  });
  return { keys: resolved.keys, maxSeq: resolved.maxSeq, rejected, conflicts: resolved.conflicts };
}
