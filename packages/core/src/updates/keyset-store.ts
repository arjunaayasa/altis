import {
  KEYSET_FILE,
  KEYSET_MAX_DOCS,
  KEYSET_MAX_DOC_BYTES,
  KEYSET_MAX_FILE_BYTES,
  canonicalize,
  collectInstalledKeysets,
  parseStrictJson,
  readKeysetWithBak,
  resolveTrustedKeys,
  type CollectedKeysets,
  type KeysetDoc,
  type KeysetSkip,
  type TrustedKey,
} from '@altis/crypto';
import { withTx, type DbHandle } from '@altis/db';
import { atomicWriteJson, dataPath, ensureDir, releaseDir, withFileLock, type CurrentState, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { errorFields, type CoreLogger } from '../context.js';
import { writeSettings } from '../settings/service.js';

// The keyset store, DATA_DIR/releases/keyset.json (spec §8.3; rulings R65a, R65c; plan Task 10, decision D1d-27).
//
// It keeps every root-signed keyset document the installation has seen: those the feed brings when it is fetched and
// those of every release installed or adopted (at install or adoption, and at every start). Revocation only grows and
// only root-signed documents count, so a revocation (a leaked release key, Review Focus 3) keeps applying after the
// feed entry or the release that carried it is gone. app.js and doctor read it with its `.bak` through
// collectInstalledKeysets, in the frozen format of R65c.
//
// - Append-only union: the writer reads the file and its `.bak` together (as the readers do), keeps every document
//   they hold, and appends after them. It writes atomically with a `.bak` (atomicWriteJson) under
//   `releases/keyset.lock`, so writers in several processes never lose one another's documents.
// - Only verified documents are appended (D1d-27): each candidate on its own against the roots, as
//   `resolveTrustedKeys(roots, [doc], {refuseDevKids})` judges it. A file ALTIS wrote therefore holds no document that
//   wastes a reader's time, and no total time bound on verification is needed.
// - A document already present is skipped. Present means: the same raw text and canonical envelope (the identity the
//   resolver uses), or, more broadly, the same canonical payload and canonical envelope. The signature covers the
//   canonical form, so two such documents verify alike and say the same thing; without the broader rule whoever holds
//   a release key could fill the store with whitespace variants of one genuine document and keep a later revocation
//   out (R65c cap).
// - The frozen limits are never passed: at most 4096 documents, each at most 64 KiB as stored JSON, the whole file at
//   most 8 MiB as written. The writer appends in input order and stops before the first document that would pass one
//   of them (`full`); nothing past it is written. persistKeysetDocs raises the Diagnostik alert `system.keyset_full`.
// - A store it cannot read is never overwritten: the file and its `.bak` both unusable (or the only one present
//   unusable) is STATE_CORRUPT, since a revocation the writer cannot read would otherwise be lost.
//
// Files, the lock and verification never run inside a re-runnable withTx callback; the setting is written after the
// file, in a transaction of its own.

const STORE_FILE = 'keyset.json';
const STORE_LOCK = 'keyset.lock';
/** The name readers give the store in reports (collectInstalledKeysets). */
const STORE_NAME = 'DATA_DIR/releases/' + KEYSET_FILE;
/** At most this many rejected documents are logged one by one per call. */
const MAX_LOGGED = 20;
/** `[]` and the newline atomicWriteJson ends a file with: the size of a store with no document. */
const EMPTY_FILE_BYTES = 3;
/** `,\n` between two documents (or `[\n` ... `\n]` around the first): what each document adds besides its own text. */
const PER_DOC_BYTES = 2;

export type AppendKeysetOptions = {
  dataDir: string;
  /** The embedded root keys (`__TRUSTED_KEYS__`): the only signers of keyset documents. */
  roots: readonly TrustedKey[];
  /** The candidate documents, in the order they are appended. */
  docs: readonly KeysetDoc[];
  /** Production builds: a document that adds a `dev-` kid is rejected (ruling R65b). */
  refuseDevKids: boolean;
  log: CoreLogger;
};

/**
 * What one call did with its candidates; each candidate counts in exactly one of the four numbers.
 * - `added`: verified, new, written;
 * - `present`: verified, already in the store (or earlier in the same call);
 * - `rejected`: does not verify against the roots (`resolveTrustedKeys` rejects it);
 * - `refused`: verified and new, but not written because the store is full;
 * - `full`: a candidate would have passed one of the frozen limits (R65c), so the call stopped appending there.
 */
export type AppendKeysetResult = { added: number; present: number; rejected: number; refused: number; full: boolean };

/** A candidate after verification: whether it is accepted, and its identity in the store. */
type Candidate = { accepted: false; reason: string } | { accepted: true; key: string; entry: KeysetDoc };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The identity of a stored or candidate document: its canonical payload and canonical envelope; failing that (a raw
 * text that is not strict JSON, an envelope with no canonical form), its raw text and canonical envelope; undefined
 * for an entry that is not `{raw: string, env: object}`. Documents with one identity verify alike.
 */
function identity(doc: unknown): string | undefined {
  if (!isRecord(doc) || typeof doc['raw'] !== 'string' || !isRecord(doc['env'])) return undefined;
  let env: string;
  try {
    env = canonicalize(doc['env']);
  } catch (err) {
    void err; // never accepted: a verified envelope always has a canonical form
    return undefined;
  }
  try {
    return JSON.stringify(['payload', canonicalize(parseStrictJson(doc['raw'])), env]);
  } catch (err) {
    void err; // a raw text that does not parse is never accepted; it still has its raw identity
    return JSON.stringify(['raw', doc['raw'], env]);
  }
}

/** The key that tells two entries of the file and its `.bak` apart: exact copies are kept once. */
function exactKey(entry: unknown): string {
  if (isRecord(entry) && typeof entry['raw'] === 'string' && isRecord(entry['env'])) {
    try {
      return JSON.stringify(['doc', entry['raw'], canonicalize(entry['env'])]);
    } catch (err) {
      void err; // no canonical form: fall back to the entry's own text
    }
  }
  return JSON.stringify(['entry', entry]);
}

/** The bytes `entry` takes in the file atomicWriteJson writes (indented by two spaces, the indentation included). */
function laidOutBytes(entry: unknown): number {
  return Buffer.byteLength(JSON.stringify([entry], null, 2), 'utf8') - 4;
}

function corrupt(cause: unknown): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      'Berkas DATA_DIR/releases/keyset.json dan salinan .bak-nya rusak; pulihkan dari cadangan / ' +
      'DATA_DIR/releases/keyset.json and its .bak copy are both unusable; restore them from a backup',
    meta: { reason: 'state_unreadable', path: STORE_NAME },
    cause,
  });
}

function isKeysetCorrupt(error: unknown): boolean {
  return error instanceof Error && error.message.indexOf('KEYSET_CORRUPT') === 0;
}

function logSkipped(log: CoreLogger | undefined, skipped: readonly KeysetSkip[], msg: string): void {
  for (const skip of skipped) log?.warn(msg, { source: skip.name, ...errorFields(skip.error) });
}

/** The documents of the store and its `.bak`, exact copies once, with their identities and laid-out size. */
type Stored = { entries: unknown[]; keys: Set<string>; bytes: number };

/**
 * Reads the store and its `.bak` (both, as the readers do).
 *
 * @throws DomainError `STATE_CORRUPT` when a copy exists but neither can be used; the I/O error otherwise
 */
async function readStore(file: DataPath, log: CoreLogger): Promise<Stored> {
  let found: CollectedKeysets;
  try {
    found = await readKeysetWithBak(file, STORE_NAME);
  } catch (err) {
    if (isKeysetCorrupt(err)) throw corrupt(err);
    throw err;
  }
  logSkipped(log, found.skipped, 'keyset store copy not usable; the other copy is used');
  const stored: Stored = { entries: [], keys: new Set(), bytes: EMPTY_FILE_BYTES };
  const seen = new Set<string>();
  for (const source of found.sources) {
    for (const entry of source.docs as unknown[]) {
      const exact = exactKey(entry);
      if (seen.has(exact)) continue;
      seen.add(exact);
      stored.entries.push(entry);
      stored.bytes += laidOutBytes(entry) + PER_DOC_BYTES;
      const id = identity(entry);
      if (id !== undefined) stored.keys.add(id);
    }
  }
  return stored;
}

/** Verifies every candidate on its own (memoised by exact copy), outside the lock. */
function verifyAll(roots: TrustedKey[], docs: readonly KeysetDoc[], refuseDevKids: boolean, log: CoreLogger): Candidate[] {
  const memo = new Map<string, Candidate>();
  const result: Candidate[] = [];
  let logged = 0;
  for (let index = 0; index < docs.length; index++) {
    const doc: unknown = docs[index];
    const exact = exactKey(doc);
    let candidate = memo.get(exact);
    if (candidate === undefined) {
      const rejected = resolveTrustedKeys(roots, [doc as KeysetDoc], { refuseDevKids }).rejected;
      const id = rejected.length === 0 ? identity(doc) : undefined;
      if (id === undefined) {
        candidate = { accepted: false, reason: rejected[0]?.reason ?? 'shape' };
      } else {
        const d = doc as KeysetDoc;
        candidate = { accepted: true, key: id, entry: { raw: d.raw, env: d.env } };
      }
      memo.set(exact, candidate);
    }
    if (!candidate.accepted) {
      if (logged < MAX_LOGGED) log.warn('keyset document rejected', { index, reason: candidate.reason });
      logged += 1;
    }
    result.push(candidate);
  }
  if (logged > MAX_LOGGED) log.warn('more keyset documents rejected', { count: logged - MAX_LOGGED });
  return result;
}

/**
 * Appends the verified documents of `o.docs` to DATA_DIR/releases/keyset.json (see the top of this file), creating
 * `releases/` when it is missing. Writes nothing when no document is added, so the file and its time stamp stay as
 * they were.
 *
 * @throws DomainError `STATE_CORRUPT` when the store cannot be read (`reason: 'state_unreadable'`), or the lock cannot
 *   be taken or was lost (`lock_timeout`, `lock_io`, `lock_lost`); TypeError for invalid roots or a `docs` that is not
 *   an array (before any I/O); the I/O error of any other failure
 */
export async function appendKeysetDocs(o: AppendKeysetOptions): Promise<AppendKeysetResult> {
  if (!Array.isArray(o.roots) || !Array.isArray(o.docs)) throw new TypeError('appendKeysetDocs: roots and docs must be arrays');
  const roots = o.roots.slice();
  resolveTrustedKeys(roots, []); // invalid roots are a programming error: a TypeError before any I/O
  const candidates = verifyAll(roots, o.docs, o.refuseDevKids, o.log);
  const result: AppendKeysetResult = { added: 0, present: 0, rejected: 0, refused: 0, full: false };
  for (const c of candidates) if (!c.accepted) result.rejected += 1;
  if (result.rejected === candidates.length) return result; // nothing to append: no lock, no read

  await ensureDir(dataPath(o.dataDir, 'releases'));
  const file = dataPath(o.dataDir, 'releases', STORE_FILE);
  return withFileLock(dataPath(o.dataDir, 'releases', STORE_LOCK), async (held) => {
    const stored = await readStore(file, o.log);
    const appended: KeysetDoc[] = [];
    let count = stored.entries.length;
    let bytes = stored.bytes;
    for (const c of candidates) {
      if (!c.accepted) continue;
      if (stored.keys.has(c.key)) {
        result.present += 1;
        continue;
      }
      if (result.full) {
        result.refused += 1;
        continue;
      }
      const size = laidOutBytes(c.entry) + PER_DOC_BYTES;
      const fits =
        count + 1 <= KEYSET_MAX_DOCS &&
        Buffer.byteLength(JSON.stringify(c.entry), 'utf8') <= KEYSET_MAX_DOC_BYTES &&
        bytes + size <= KEYSET_MAX_FILE_BYTES;
      if (!fits) {
        result.full = true;
        result.refused += 1;
        continue;
      }
      appended.push(c.entry);
      stored.keys.add(c.key);
      count += 1;
      bytes += size;
    }
    result.added = appended.length;
    if (result.full) {
      o.log.warn('DATA_DIR/releases/keyset.json is full; keyset documents not stored', {
        refused: result.refused,
        docs: count,
        bytes,
      });
    }
    if (appended.length === 0) return result;
    held.assertHeld();
    await atomicWriteJson(file, stored.entries.concat(appended));
    o.log.info('keyset documents stored', { added: result.added, docs: count });
    return result;
  });
}

/**
 * {@link appendKeysetDocs}, then the Diagnostik alert (R65c): with `db`, the instance setting `system.keyset_full`
 * becomes `{at: now, refused}` when the call stopped at a limit, and is cleared after a call that appended documents
 * without stopping. A call that only finds documents already present leaves it as it is. Without `db` only the file is
 * written. Call it outside any withTx callback.
 *
 * @throws as {@link appendKeysetDocs}; the database error of the setting's write (the file is written by then, and a
 *   second call finds its documents present)
 */
export async function persistKeysetDocs(o: AppendKeysetOptions & { db?: DbHandle | undefined; now: number }): Promise<AppendKeysetResult> {
  const result = await appendKeysetDocs(o);
  const db = o.db;
  if (db === undefined) return result;
  if (result.full) {
    const value = { at: o.now, refused: result.refused };
    await withTx(db, (trx) => writeSettings(trx, { 'system.keyset_full': value }, { keyring: [], now: o.now, actorId: null }));
  } else if (result.added > 0) {
    await withTx(db, (trx) => writeSettings(trx, { 'system.keyset_full': null }, { keyring: [], now: o.now, actorId: null }));
  }
  return result;
}

/**
 * The keyset documents of every release the installation holds (R65a): the keyset.json of every SemVer folder of
 * `<appRoot>/bundled-release` (by version), then of the releases current.json names (`active`, `previous`,
 * `pending`), a folder already read skipped, exactly as app.js gathers them (collectInstalledKeysets). The store's own
 * documents are not among them. A release keyset.json that is missing adds nothing; one that cannot be used, or a
 * named release whose folder cannot be located, is logged (with `o.log`) and skipped.
 *
 * @throws DomainError `STATE_CORRUPT` when the store and its `.bak` are both unusable (the readers fail closed there,
 *   and appendKeysetDocs would refuse anyway); the I/O error of the store other than a missing file
 */
export async function releaseKeysetDocs(o: { appRoot: string; dataDir: string; state: CurrentState; log?: CoreLogger | undefined }): Promise<KeysetDoc[]> {
  const releases: { name: string; dir: string }[] = [];
  for (const ref of [o.state.active, o.state.previous, o.state.pending]) {
    if (ref === null) continue;
    const name = (ref.source === 'bundled' ? 'bundled-release/' : 'DATA_DIR/releases/') + ref.version + '/' + KEYSET_FILE;
    try {
      releases.push({ name, dir: releaseDir(o.appRoot, o.dataDir, ref) });
    } catch (err) {
      o.log?.warn('release folder cannot be located; its keyset documents are not stored', { source: name, ...errorFields(err) });
    }
  }
  let found: CollectedKeysets;
  try {
    found = await collectInstalledKeysets({ appRoot: o.appRoot, dataKeyset: dataPath(o.dataDir, 'releases', STORE_FILE), releases });
  } catch (err) {
    if (isKeysetCorrupt(err)) throw corrupt(err);
    throw err;
  }
  const isStore = (name: string): boolean => name === STORE_NAME || name === STORE_NAME + '.bak';
  logSkipped(
    o.log,
    found.skipped.filter((skip) => !isStore(skip.name)),
    'release keyset.json not usable; its documents are not stored',
  );
  const docs: KeysetDoc[] = [];
  for (const source of found.sources) if (!isStore(source.name)) for (const doc of source.docs) docs.push(doc);
  return docs;
}
