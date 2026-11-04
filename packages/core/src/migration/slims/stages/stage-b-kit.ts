import { createHash } from 'node:crypto';
import { withTx, type DB } from '@altis/db';
import { ensureHeadroom } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { cleanText } from '../source/clean-text.js';
import { SlimsFileTooLargeError, type SlimsRow, type SlimsTableInfo } from '../source/types.js';
import type { SlimsFixKind, SlimsReportRow, SlimsStageContext } from '../stage.js';

// What the stages B of the SLiMS migration share (Phase 2 Task 38: items, attachments, covers, content, archive; spec
// §11.2–§11.6). Task 37's stages A have a kit of their own (file ownership): the two follow the same rules, and both
// tell a fresh row, a replay and a row of an earlier run apart with `stateOf` below (stage-a-kit.ts imports it), so a
// replay is counted alike in every stage (Task 39).
//
// - A stage reads its tables in batches (500 rows, the source's own cursor) and writes each batch, or each file of a
//   batch, in one transaction of its own. The stage's cursor is its own JSON: the phase, the source's cursor of the
//   batch, the rows of that batch already done, and how many repair samples each column gave; so a slice that stops
//   after any batch or file, in any process, goes on where it stopped (P7). One batch (or file) at least per call, then
//   more while the slice's budget lasts.
// - The source is read and every file is stored outside the transaction. A transaction may run its callback again
//   (R37), so it counts and reports into a ledger made afresh for each attempt, applied to the run's counters once the
//   transaction committed.
// - Re-runs and restarts (§11.2, D2-26, K15): every source row a stage writes has a legacy map row (`migration_map`,
//   source = the run's `sourceName`, S13) or an archive row with the run's id. A row mapped by an earlier run is skipped
//   `already_migrated` and never updated. A row mapped by this very run was written by a slice whose process died after
//   the commit and before the framework saved the counters: it is counted again as it was the first time and its report
//   rows are made again from the source and what is stored, so the run ends exactly as one never stopped.
// - A dry run reads the same rows, counts and reports them alike, and writes nothing (no transaction).
// - Text cells go through cleanText (§11.5 steps 1–3); its repairs are counted per `<table>.<column>`, with at most five
//   before/after samples per column.

/** Rows per batch (§11.1, §11.3: batches of 500). */
export const STAGE_B_BATCH = 500;
/** Samples per column (§11.5: "5 contoh sebelum/sesudah per kolom"). */
const SAMPLES_PER_COLUMN = 5;
/** Columns whose sample count a cursor carries; a further column gives no samples within its stage. */
const SAMPLE_COLUMNS_MAX = 16;
/** The longest source cursor a stage cursor wraps (SLIMS_CURSOR_MAX is 4096 for the whole cursor). */
const SOURCE_CURSOR_MAX = 1024;
/** A column name a cursor carries (`<table>.<column>`). */
const NAME = /^[A-Za-z0-9_.]{1,96}$/;
/** A report code (Task 23's rule). */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** Report rows of one code a stage writes (see Ledger). */
export const ROWS_PER_CODE = 500;
/** Codes whose rows a cursor counts. */
const CODES_MAX = 48;
/** Codes the summary counts from their rows (Task 23): never held back. */
const NEVER_HELD: ReadonlySet<string> = new Set(['missing_file', 'barcode_nonstandard']);

type Db = Kysely<DB> | Transaction<DB>;

let batchOverride: number | null = null;

function testProfile(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test';
}

/** The rows a stage B reads per batch: {@link STAGE_B_BATCH}, or a test's smaller number (test profile). */
export function stageBBatch(): number {
  return batchOverride ?? STAGE_B_BATCH;
}

/**
 * Test build profile only (R57): stages B read `n` rows per batch instead of 500 (null: back to 500), so a test can
 * stop a stage in the middle of a small table.
 *
 * @throws TypeError outside the test build profile, or for `n` that is not an integer from 1 to 500
 */
export function __setSlimsStageBBatch(n: number | null): void {
  if (!testProfile()) throw new TypeError('__setSlimsStageBBatch is a hook of the test build profile only');
  if (n !== null && (!Number.isSafeInteger(n) || n < 1 || n > STAGE_B_BATCH)) throw new TypeError('__setSlimsStageBBatch: n must be 1-500');
  batchOverride = n;
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger

/** What a ledger carries from batch to batch in the stage's cursor: samples per column, report rows per code. */
export interface LedgerState {
  s: Record<string, number>;
  r: Record<string, number>;
}

/**
 * Counts, report rows and repairs, applied to the run once the work they describe committed.
 *
 * A stage writes at most {@link ROWS_PER_CODE} report rows of one code (a SLiMS catalogue where every item has the
 * currency `Rupiah` would otherwise fill the report's 10 000 rows with one message and push out everything after it);
 * the rows past that are counted, and the stage's end writes one `rows_omitted` row per such code. `missing_file` and
 * `barcode_nonstandard` rows are never held back: the summary counts them (Task 23).
 */
export class Ledger {
  private readonly ops: ((c: SlimsStageContext) => void)[] = [];
  /** Samples per column and rows per code so far in the stage (shared by a ledger and its forks). */
  private readonly shared: { samples: Map<string, number>; rows: Map<string, number> };

  constructor(state: LedgerState, shared?: { samples: Map<string, number>; rows: Map<string, number> }) {
    this.shared = shared ?? { samples: new Map(Object.entries(state.s)), rows: new Map(Object.entries(state.r)) };
  }

  /** A ledger that goes on from the cursor `at`. */
  static of(at: LedgerState): Ledger {
    return new Ledger(at);
  }

  /** What the cursor carries on (names a cursor cannot hold are left out). */
  state(): LedgerState {
    return {
      s: Object.fromEntries([...this.shared.samples].filter(([k]) => NAME.test(k))),
      r: Object.fromEntries([...this.shared.rows].filter(([k]) => CODE.test(k))),
    };
  }

  migrated(table: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.migrated(table, n));
  }

  merged(table: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.merged(table, n));
  }

  archived(table: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.archived(table, n));
  }

  skipped(table: string, reason: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.skipped(table, reason, n));
  }

  /** A report row, unless its code had its {@link ROWS_PER_CODE} rows in the stage already (see above). */
  report(table: string, legacyKey: string | null, code: string, detail: string): void {
    if (!NEVER_HELD.has(code)) {
      const held = this.shared.rows.get(code);
      if (held !== undefined || this.shared.rows.size < CODES_MAX) this.shared.rows.set(code, (held ?? 0) + 1);
      if ((held ?? 0) >= ROWS_PER_CODE) return;
    }
    const row: SlimsReportRow = { table, legacyKey, code, detail };
    this.ops.push((c) => c.report(row));
  }

  /** One repair of `kinds` in `column` (`<table>.<column>`), and its sample while the column has fewer than five. */
  fixed(column: string, kinds: readonly SlimsFixKind[], before: string, after: string): void {
    if (kinds.length === 0) return;
    const ks = [...kinds];
    const samples = this.shared.samples;
    const held = samples.get(column);
    const sample = NAME.test(column) && (held === undefined ? samples.size < SAMPLE_COLUMNS_MAX : held < SAMPLES_PER_COLUMN);
    if (sample) samples.set(column, (held ?? 0) + 1);
    this.ops.push((c) => {
      for (const k of ks) c.counters.fix(column, k, 1);
      if (sample) c.counters.sample(column, before, after);
    });
  }

  /**
   * A ledger for one row of a batch that shares this one's counts: a batch plans its rows one by one, then joins their
   * ledgers in row order, so the report reads in source order whatever the batch size.
   */
  fork(): Ledger {
    return new Ledger({ s: {}, r: {} }, this.shared);
  }

  /** Appends what `forks` hold, in their order. */
  join(forks: readonly Ledger[]): void {
    for (const f of forks) this.ops.push(...f.ops);
  }

  /** At a stage's end: one `rows_omitted` row for each code whose rows passed {@link ROWS_PER_CODE}. */
  omitted(stage: string): void {
    for (const [code, n] of [...this.shared.rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (n <= ROWS_PER_CODE) continue;
      const row: SlimsReportRow = { table: stage, legacyKey: null, code: 'rows_omitted', detail: `${code}: ${n - ROWS_PER_CODE} baris lagi / more rows` };
      this.ops.push((c) => c.report(row));
    }
  }

  apply(c: SlimsStageContext): void {
    for (const op of this.ops) op(c);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cells

export type Cell = SlimsRow[string] | undefined;

/** How a stored value is shown in a sample: control characters and bytes that are no text as `\xHH`. */
function shown(v: string | Uint8Array): string {
  const s = typeof v === 'string' ? v : Array.from(v, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  return s.replace(/\p{Cc}/gu, (ch) => `\\x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/**
 * A cell as clean text (§11.5 steps 1–3: NUL, stored backslashes, mojibake, cp1252 bytes), its repairs counted under
 * `<table>.<column>`; a number as its digits; null for NULL.
 */
export function textOf(l: Ledger, table: string, column: string, v: Cell): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(v);
  const { value, fixes } = cleanText(v);
  if (fixes.length > 0) l.fixed(`${table}.${column}`, fixes, shown(v), value);
  return value;
}

/** A cell as clean text without counting its repairs ('' for NULL). */
export function quietText(v: Cell): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : cleanText(v).value;
}

/** A legacy key from a cell: a number's digits, text cleaned and trimmed, '' for NULL. */
export function keyOf(v: Cell): string {
  return quietText(v).trim();
}

/** A key that fits `migration_map.legacy_key` (1–191 code points, no outer blank). */
export function keyFits(key: string): boolean {
  return key !== '' && key.trim() === key && Array.from(key).length <= 191;
}

/** An integer cell (a number, or digits in text), or null. */
export function intOf(v: Cell): number | null {
  const s = keyOf(v);
  if (!/^[+-]?\d{1,15}$/.test(s)) return null;
  return Number(s);
}

/** Single-line text: every run of control characters and blanks as one space, trimmed. */
export function oneLine(s: string): string {
  return s.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** `s` cut to `max` code points without a trailing blank. */
export function cutChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('').trimEnd();
}

/** `s` cut at a code point boundary to at most `max` UTF-8 bytes. */
export function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/** The longest free TEXT value (MySQL TEXT holds 65 535 bytes; Review Focus 3). */
export const TEXT_MAX_BYTES = 60_000;

/** `s` ('' or null: null) cut to `max` code points, reported `text_truncated` when cut. */
export function fitChars(l: Ledger, table: string, key: string | null, column: string, s: string | null, max: number): string | null {
  if (s === null || s === '') return null;
  const cut = cutChars(s, max);
  if (cut !== s) l.report(table, key, 'text_truncated', `${column}: ${Array.from(s).length} > ${max}`);
  return cut === '' ? null : cut;
}

/** `s` ('' or null: null) cut to {@link TEXT_MAX_BYTES} UTF-8 bytes, reported `text_truncated` when cut. */
export function fitText(l: Ledger, table: string, key: string | null, column: string, s: string | null): string | null {
  if (s === null || s === '') return null;
  const cut = cutBytes(s, TEXT_MAX_BYTES);
  if (cut !== s) l.report(table, key, 'text_truncated', `${column}: ${Buffer.byteLength(s, 'utf8')} > ${TEXT_MAX_BYTES} bytes`);
  return cut === '' ? null : cut;
}

// ---------------------------------------------------------------------------------------------------------------
// The cursor

const stageCursor = z.strictObject({
  /** The phase (a table, or a pass over one). */
  p: z.int().min(0).max(63),
  /** The source's cursor of the current batch (null: the table's start). */
  c: z.string().min(1).max(SOURCE_CURSOR_MAX).nullable(),
  /** Rows of that batch already done. */
  i: z.int().min(0).max(STAGE_B_BATCH),
  /** Samples taken per column. */
  s: z.record(z.string().regex(NAME), z.int().min(0).max(SAMPLES_PER_COLUMN)),
  /** Report rows per code (Ledger). */
  r: z.record(z.string().regex(CODE), z.int().min(0)),
  /** Rows of the phase's table read before this batch (a key for a table without a primary key). */
  n: z.int().min(0),
});

export type StageCursor = z.infer<typeof stageCursor>;

/** The cursor of a stage's start. */
export function startCursor(): StageCursor {
  return { p: 0, c: null, i: 0, s: {}, r: {}, n: 0 };
}

/**
 * The cursor `cursor` of stage `stage` (null: its start).
 *
 * @throws TypeError for a cursor this kit did not write
 */
export function readCursor(stage: string, cursor: string | null): StageCursor {
  if (cursor === null) return startCursor();
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    throw new TypeError(`SLiMS stage ${stage}: the cursor is not JSON`);
  }
  const parsed = stageCursor.safeParse(raw);
  if (!parsed.success) throw new TypeError(`SLiMS stage ${stage}: the cursor is malformed`);
  return parsed.data;
}

/** The cursor as the framework keeps it. */
export function writeCursor(at: StageCursor): string {
  return JSON.stringify({
    ...at,
    s: Object.fromEntries(Object.entries(at.s).filter(([k]) => NAME.test(k))),
    r: Object.fromEntries(Object.entries(at.r).filter(([k]) => CODE.test(k))),
  });
}

/** The cursor of the next phase (the counts of samples and rows go on: they are the stage's). */
export function nextPhase(at: StageCursor): StageCursor {
  return { p: at.p + 1, c: null, i: 0, s: at.s, r: at.r, n: 0 };
}

/** The end of stage `stage` at cursor `at`: the `rows_omitted` rows (see Ledger). */
export function endOfStage(c: SlimsStageContext, stage: string, at: StageCursor): { done: true; cursor: null } {
  const l = Ledger.of(at);
  l.omitted(stage);
  l.apply(c);
  return { done: true, cursor: null };
}

/**
 * The source cursor `next` checked for the stage cursor.
 *
 * @throws TypeError when the source's cursor is longer than 1024 characters
 */
export function sourceCursor(stage: string, next: string | null): string | null {
  if (next !== null && next.length > SOURCE_CURSOR_MAX) throw new TypeError(`SLiMS stage ${stage}: the source cursor is too long`);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Transactions

/** What a batch writes through: `trx` in a real run, null in a dry run; `db` for its reads. */
export interface BatchIo {
  db: Db;
  trx: Transaction<DB> | null;
}

/**
 * Runs `fn` once: inside one transaction of a real run (again from a fresh ledger when the transaction runs its
 * callback again), without one in a dry run; returns the ledger of the attempt that counted and `fn`'s answer.
 */
export async function inBatch<T>(
  c: SlimsStageContext,
  at: LedgerState,
  fn: (io: BatchIo, l: Ledger) => Promise<T>,
): Promise<{ ledger: Ledger; value: T }> {
  if (c.dryRun) {
    const ledger = Ledger.of(at);
    const value = await fn({ db: c.h.db, trx: null }, ledger);
    return { ledger, value };
  }
  return withTx(c.h, async (trx) => {
    const ledger = Ledger.of(at);
    const value = await fn({ db: trx, trx }, ledger);
    return { ledger, value };
  });
}

/**
 * `write` (an INSERT whose unique key was checked free just before), with a UNIQUE_VIOLATION thrown as TX_CONFLICT: a
 * concurrent writer (an admin adding a location or a page while the migration runs) committed the same key after the
 * check, so the batch's withTx runs it all again and its check then sees the key (as Task 17's items do).
 */
export async function againOnRace<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'UNIQUE_VIOLATION') throw error;
    throw new DomainError('TX_CONFLICT', {
      detail: 'Kunci yang sama baru saja disimpan oleh permintaan lain; transaksi diulang / The same key was just stored by another request; the transaction is run again',
      meta: { attempts: 1, code: 'MIGRATION_KEY_TAKEN' },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The legacy map

/** A legacy map row: its target, and the run that wrote it. */
export interface Mapped {
  targetId: string;
  runId: string;
}

/** The map rows of the legacy keys `keys` of `entity` under the run's source name (S13), by key. */
export async function mappedRows(c: SlimsStageContext, db: Db, entity: string, keys: readonly string[]): Promise<Map<string, Mapped>> {
  const wanted = [...new Set(keys.filter(keyFits))];
  const found = new Map<string, Mapped>();
  for (let i = 0; i < wanted.length; i += STAGE_B_BATCH) {
    const rows = await db
      .selectFrom('migration_map')
      .select(['legacy_key', 'target_id', 'run_id'])
      .where('source', '=', c.options.sourceName)
      .where('entity', '=', entity)
      .where('legacy_key', 'in', wanted.slice(i, i + STAGE_B_BATCH))
      .execute();
    for (const r of rows) found.set(r.legacy_key, { targetId: r.target_id, runId: r.run_id });
  }
  return found;
}

/** The targets of the legacy keys `keys` of `entity` under the run's source name, by key. */
export async function targetsOf(c: SlimsStageContext, db: Db, entity: string, keys: readonly string[]): Promise<Map<string, string>> {
  return new Map([...(await mappedRows(c, db, entity, keys))].map(([k, m]) => [k, m.targetId]));
}

/**
 * What a source row is to the stage: `fresh` (not mapped under the run's source), `replay` (mapped by this run: a
 * slice that died after its commit, see the top of this file), or `done` (mapped by an earlier run).
 */
export function stateOf(c: SlimsStageContext, m: Mapped | undefined): 'fresh' | 'replay' | 'done' {
  if (m === undefined) return 'fresh';
  return m.runId === c.runId ? 'replay' : 'done';
}

// ---------------------------------------------------------------------------------------------------------------
// The source

/** The source's table `table`, or null when it has none. */
export async function tableOf(c: SlimsStageContext, table: string): Promise<SlimsTableInfo | null> {
  return (await c.source.tables()).find((t) => t.name === table) ?? null;
}

/** Every row of `table`, read in batches of 500, each handed to `each` (nothing when the source has no such table). */
export async function scanAll(c: SlimsStageContext, table: string, each: (row: SlimsRow) => void): Promise<void> {
  if ((await tableOf(c, table)) === null) return;
  let after: string | null = null;
  do {
    const batch: { rows: SlimsRow[]; next: string | null } = await c.source.rows(table, after, STAGE_B_BATCH);
    for (const row of batch.rows) each(row);
    after = batch.rows.length === 0 ? null : batch.next;
  } while (after !== null);
}

/**
 * Values the stages of one run look up again and again (a whole source table's keys, the links of every file), kept
 * in this process for the run `c.runId` only: a value is built on first use, and again in any other process. The
 * source is read only (a dump's staging does not change; a live database may, as in any SELECT-only read).
 */
const runCache = new Map<string, Map<string, unknown>>();

function valuesOf(runId: string): Map<string, unknown> {
  let values = runCache.get(runId);
  if (values === undefined) {
    runCache.clear();
    values = new Map();
    runCache.set(runId, values);
  }
  return values;
}

/** The value `name` of the run (see runCache), built by `build` on first use in this process. */
export async function cachedForRun<T>(c: SlimsStageContext, name: string, build: () => Promise<T>): Promise<T> {
  const values = valuesOf(c.runId);
  if (values.has(name)) return values.get(name) as T;
  const value = await build();
  values.set(name, value);
  return value;
}

/** The value `name` this process keeps for the run, or undefined. */
export function runValue<T>(c: SlimsStageContext, name: string): T | undefined {
  return valuesOf(c.runId).get(name) as T | undefined;
}

/** Keeps `value` as `name` for the run in this process (undefined: forgets it). */
export function setRunValue(c: SlimsStageContext, name: string, value: unknown): void {
  const values = valuesOf(c.runId);
  if (value === undefined) values.delete(name);
  else values.set(name, value);
}

/**
 * Test build profile only (R57): forgets every value kept for a run, as a process that takes the run over starts.
 *
 * @throws TypeError outside the test build profile
 */
export function __forgetSlimsStageBValues(): void {
  if (!testProfile()) throw new TypeError('__forgetSlimsStageBValues is a hook of the test build profile only');
  runCache.clear();
}

/** The keys of `table` (the cleaned, trimmed `column`), from the whole source table (cached for the run). */
export function sourceKeys(c: SlimsStageContext, table: string, column: string): Promise<ReadonlySet<string>> {
  return cachedForRun(c, `keys:${table}:${column}`, async () => {
    const keys = new Set<string>();
    await scanAll(c, table, (row) => {
      const k = keyOf(row[column]);
      if (k !== '') keys.add(k);
    });
    return keys;
  });
}

/** The legacy key of `row` by `columns` (joined with `|`), or `#<n>` (its position) for a table without a key. */
export function rowKey(row: SlimsRow, columns: readonly string[], position: number): string {
  if (columns.length === 0) return `#${position}`;
  const parts = columns.map((k) => keyOf(row[k]));
  return parts.some((p) => p === '') ? '' : parts.join('|');
}

// ---------------------------------------------------------------------------------------------------------------
// Files of the files source (S10)

/** What a file of the files source is: absent, past its limit, or there (its size and SHA-256, and its first bytes). */
export type SourceFile =
  | { kind: 'missing' }
  | { kind: 'too_large'; limit: number }
  | { kind: 'ok'; size: number; sha256: string; head: Uint8Array; bytes: Buffer | null };

/** The first bytes kept of a file read through (for its type, files/magic.ts). */
const HEAD_BYTES = 4096;

/**
 * Reads `rel` from the run's files source within `maxBytes` (S10: only the entries the stages reference are opened,
 * each with its limit): its size and SHA-256 and first bytes, and with `o.keep` its bytes (a small image). A file the
 * source does not have, or will not serve (an unsafe name), is `missing`; one whose declared or produced size passes
 * the limit is `too_large` (SlimsFileTooLargeError). With `o.declaredOnly` (a dry run's attachments) only the declared
 * size is checked and nothing is read.
 */
export async function readSourceFile(
  c: SlimsStageContext,
  rel: string,
  maxBytes: number,
  o: { keep?: boolean; declaredOnly?: boolean } = {},
): Promise<SourceFile> {
  if (c.files === null || rel === '') return { kind: 'missing' };
  const declared = await c.files.size(rel);
  if (declared === null) return { kind: 'missing' };
  if (declared > maxBytes) return { kind: 'too_large', limit: maxBytes };
  if (o.declaredOnly === true) return { kind: 'ok', size: declared, sha256: '', head: new Uint8Array(0), bytes: null };
  const stream = await c.files.open(rel, { maxBytes });
  if (stream === null) return { kind: 'missing' };
  const hash = createHash('sha256');
  const parts: Buffer[] = [];
  const head: Buffer[] = [];
  let headBytes = 0;
  let size = 0;
  try {
    for await (const chunk of stream) {
      const part = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      hash.update(part);
      size += part.byteLength;
      if (headBytes < HEAD_BYTES) {
        const take = part.subarray(0, HEAD_BYTES - headBytes);
        head.push(Buffer.from(take));
        headBytes += take.byteLength;
      }
      if (o.keep === true) parts.push(Buffer.from(part));
    }
  } catch (error) {
    if (error instanceof SlimsFileTooLargeError) return { kind: 'too_large', limit: maxBytes };
    throw error;
  }
  return { kind: 'ok', size, sha256: hash.digest('hex'), head: new Uint8Array(Buffer.concat(head)), bytes: o.keep === true ? Buffer.concat(parts) : null };
}

/** The SHA-256 of no bytes (a `files` row of a missing file has size 0). */
export const EMPTY_SHA256 = createHash('sha256').digest('hex');

/** `bytes`' SHA-256. */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Stores `data` (`size` bytes with SHA-256 `sha256`) under `key` through the run's storage driver, after making sure
 * the disk holds it (S10: `ensureHeadroom` before each blob). Never inside a transaction.
 *
 * @throws DomainError `DISK_QUOTA` (the run fails `disk_full`), `UPLOAD_MISMATCH` when the bytes read are not the ones
 *   measured
 */
export async function storeBlob(c: SlimsStageContext, key: string, data: Uint8Array | AsyncIterable<Uint8Array>, meta: { size: number; sha256: string }): Promise<void> {
  await ensureHeadroom(c.dataDir, meta.size);
  await c.storage.put(key, data, meta);
}
