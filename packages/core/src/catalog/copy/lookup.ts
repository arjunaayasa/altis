// The ISBN lookup of copy cataloguing (Phase 2 spec §6.3; plan Task 32, M13): `GET catalog/lookup/isbn/:isbn`.
//
// 1. The input is normalised to its ISBN-13 (Task 5's parseIsbn: hyphens and spaces dropped, an ISBN-10 converted);
//    one that does not parse, or whose check digit is wrong, is VALIDATION_FAILED `{path: 'isbn', code: 'invalid'}`.
// 2. The catalog first: a live record holding that ISBN (`record_identifiers.value_key`) is `local`, and no source is
//    asked ("Sudah ada di katalog", with a link and "Tambah eksemplar").
// 3. Otherwise the sources (every enabled SRU server) are asked in parallel, at
//    most 3 at a time; the others wait for a free slot. Each has 10 s from its start, and all of them together 12 s
//    from the first start: a source still running, or still waiting, when its budget ends is an error entry
//    (`CATALOG_OUTBOUND_FAILED`), and a source that ignores its signal is left behind, not waited for.
// 4. The drafts are merged in source order (then each source's own order): a draft that does not meet the strict
//    `RecordDraft` contract is dropped, as is one sharing an ISBN key with an earlier draft; at most 10 are kept. Each
//    is scored against the catalog with checkDuplicates (§3.3): its best candidate at or above the threshold
//    (`catalog.dedupe.threshold`) is its duplicate hint.
// 5. Each failed source is `{source, code}` in `errors`, in source order: its DomainError's code, or INTERNAL (logged
//    with names and codes only) for anything else.
//
// No transaction is held while a source runs (the route reads the settings before and scores after); the lookup keeps
// no state between calls, so any number of processes may run it at once.

import type { DB } from '@altis/db';
import { DomainError, isDomainError, type ErrorCode } from '@altis/shared';
import type { DuplicateHint, IsbnLookupResponse } from '@altis/shared/api/catalog/copy';
import { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { DuplicateCheckBody } from '@altis/shared/api/catalog/records';
import type { Kysely } from 'kysely';
import { errorFields, type CoreLogger } from '../../context.js';
import { parseIsbn } from '../lib/identifiers.js';
import { checkDuplicates } from '../records/duplicates.js';
import type { IsbnSource } from './isbn-source.js';

/** Sources asked at once (§6.3, M13). */
const CONCURRENCY = 3;
/** Each source's budget from its start, and all sources' budget from the first start (§6.3). */
const SOURCE_MS = 10_000;
const TOTAL_MS = 12_000;
/** Candidates kept (§6.3). */
const MAX_CANDIDATES = 10;

export interface IsbnLookupOptions {
  /** In the order they are asked and merged (the enabled SRU servers). */
  sources: readonly IsbnSource[];
  /** `catalog.dedupe.threshold`: the score from which a stored record is a candidate's duplicate hint. */
  threshold: number;
  /** Each source's budget; default and ceiling 10 000 ms (tests shorten it). */
  sourceTimeoutMs?: number;
  /** The overall budget; default and ceiling 12 000 ms (tests shorten it). */
  totalTimeoutMs?: number;
  /** Where a source's unexpected failure is logged. */
  log?: CoreLogger;
}

type SourceError = IsbnLookupResponse['errors'][number];

/** A budget a caller may shorten, never lengthen. */
function budget(name: string, value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`lookupIsbn: ${name} must be a positive integer`);
  return Math.min(value, ceiling);
}

function budgetSpent(): DomainError {
  return new DomainError('CATALOG_OUTBOUND_FAILED', { meta: { reason: 'timeout' } });
}

/** `p`, or a rejection once `signal` aborts: a source that ignores its signal still ends with its budget. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(budgetSpent());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(budgetSpent());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The live record holding the ISBN-13 `key`, the oldest first, or null. */
async function localRecord(db: Kysely<DB>, key: string): Promise<{ recordId: string; title: string } | null> {
  const row = await db
    .selectFrom('record_identifiers as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .select(['r.id', 'r.title'])
    .where('i.type', '=', 'isbn')
    .where('i.value_key', '=', key)
    .where('r.archived_at', 'is', null)
    .where('r.merged_into', 'is', null)
    .orderBy('r.id')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : { recordId: row.id, title: row.title };
}

/** Asks every source (see the top of this file): each one's drafts, or its error, by position. */
async function askSources(isbn13: string, o: IsbnLookupOptions): Promise<{ answers: (unknown[] | null)[]; errors: (SourceError | null)[] }> {
  const { sources } = o;
  const eachMs = budget('sourceTimeoutMs', o.sourceTimeoutMs, SOURCE_MS);
  const totalMs = budget('totalTimeoutMs', o.totalTimeoutMs, TOTAL_MS);
  const answers: (unknown[] | null)[] = sources.map(() => null);
  const errors: (SourceError | null)[] = sources.map(() => null);

  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), totalMs);

  const ask = async (i: number): Promise<void> => {
    const source = sources[i]!;
    const own = new AbortController();
    const stop = (): void => own.abort();
    overall.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, eachMs);
    try {
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(source.lookup(isbn13, own.signal));
      } catch (e) {
        pending = Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const answer = await untilAborted(pending, own.signal);
      answers[i] = Array.isArray(answer) ? (answer as unknown[]) : [];
    } catch (e) {
      let code: ErrorCode = 'INTERNAL';
      if (isDomainError(e)) code = e.code;
      else o.log?.warn('catalog.copy.isbn_source_failed', { source: source.id, ...errorFields(e) });
      errors[i] = { source: source.id, code };
    } finally {
      clearTimeout(timer);
      overall.signal.removeEventListener('abort', stop);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sources.length && !overall.signal.aborted) await ask(next++);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
  } finally {
    clearTimeout(overallTimer);
  }
  // A source that never got a slot within the overall budget.
  sources.forEach((source, i) => {
    if (answers[i] === null && errors[i] === null) errors[i] = { source: source.id, code: 'CATALOG_OUTBOUND_FAILED' };
  });
  return { answers, errors };
}

/** The ISBN-13 keys of a draft's ISBNs (a wrong check digit still has one). */
function isbnKeys(draft: RecordDraft): string[] {
  const keys: string[] = [];
  for (const i of draft.identifiers) {
    if (i.type !== 'isbn') continue;
    const key = parseIsbn(i.value)?.key;
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

/** What the duplicate check compares a draft by (§3.3): its title, year, identifiers, main agent and publisher. */
function duplicateProbe(draft: RecordDraft): DuplicateCheckBody {
  const main = draft.agents.find((a) => a.isMain);
  return {
    title: draft.title,
    ...(draft.subtitle === undefined ? {} : { subtitle: draft.subtitle }),
    ...(draft.publicationYear === undefined ? {} : { year: draft.publicationYear }),
    identifiers: draft.identifiers,
    ...(main === undefined ? {} : { mainAgentName: main.name }),
    ...(draft.publisher === null ? {} : { publisherName: draft.publisher.name }),
  };
}

/**
 * The stored record a copied `draft` most likely duplicates (§3.3): the best candidate of checkDuplicates at or above
 * `threshold`, as `{recordId, score}`, or null. Used for the ISBN lookup's candidates and for each SRU search result.
 */
export async function copyDuplicateHint(db: Kysely<DB>, draft: RecordDraft, threshold: number): Promise<DuplicateHint | null> {
  const best = (await checkDuplicates(db, duplicateProbe(draft), threshold))[0];
  return best === undefined ? null : { recordId: best.recordId, score: best.score };
}

/**
 * Looks `input` up as an ISBN (see the top of this file): the live record that holds it, or the candidates of the
 * sources with their duplicate hints and the sources' errors.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'isbn', code: 'invalid'}` for an input that is no valid ISBN
 * @throws RangeError for a budget that is not a positive integer
 */
export async function lookupIsbn(db: Kysely<DB>, input: string, o: IsbnLookupOptions): Promise<IsbnLookupResponse> {
  const parsed = typeof input === 'string' ? parseIsbn(input) : null;
  if (parsed === null || !parsed.valid) {
    throw new DomainError('VALIDATION_FAILED', { detail: 'ISBN tidak valid / The ISBN is not valid', meta: { errors: [{ path: 'isbn', code: 'invalid' }] } });
  }
  const isbn13 = parsed.key;
  const local = await localRecord(db, isbn13);
  if (local !== null) return { isbn13, local, candidates: [], errors: [] };

  const { answers, errors } = await askSources(isbn13, o);
  const seen = new Set<string>();
  const picked: { source: string; draft: RecordDraft }[] = [];
  merge: for (const [i, answer] of answers.entries()) {
    for (const raw of answer ?? []) {
      if (picked.length >= MAX_CANDIDATES) break merge;
      const checked = RecordDraft.safeParse(raw);
      if (!checked.success) continue;
      const keys = isbnKeys(checked.data);
      if (keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      picked.push({ source: o.sources[i]!.id, draft: checked.data });
    }
  }

  const candidates: IsbnLookupResponse['candidates'] = [];
  for (const c of picked) candidates.push({ ...c, duplicate: await copyDuplicateHint(db, c.draft, o.threshold) });
  return { isbn13, local: null, candidates, errors: errors.filter((e): e is SourceError => e !== null) };
}
