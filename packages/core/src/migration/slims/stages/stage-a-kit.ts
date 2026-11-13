import { withTx, type DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { lookupLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { cleanText } from '../source/clean-text.js';
import type { SlimsRow, SlimsTableInfo } from '../source/types.js';
import type { SlimsFixKind, SlimsReportRow, SlimsStageContext } from '../stage.js';
import { mappedRows, stateOf } from './stage-b-kit.js';

// What the stages A of the SLiMS migration share (Phase 2 Task 37: masters, records, relations; spec §11.2–§11.6).
//
// - A stage is a list of steps. A scan step reads one source table in keyset batches (500 rows, the source's own
//   cursor) and handles each batch in one transaction of its own; a custom step runs its own calls. The stage's cursor
//   is its own JSON: the step, the source's cursor, and the few counts a step carries from batch to batch (how many
//   repair samples each column gave, a step's running totals), so a slice that stops after any batch, in any process,
//   goes on where it stopped (P7). One batch at least per call, then more while the slice's budget lasts.
// - The source is read outside the transaction. A transaction may run its callback again (R37), so a batch counts and
//   reports into a ledger made afresh for each attempt, applied to the run's counters once the transaction committed.
// - Re-runs and restarts (§11.2, D2-26, K15), the rule of the stages B too (stage-b-kit.ts `stateOf`): a source row
//   mapped under the run's source name by an earlier run is skipped `already_migrated` and never updated. A row mapped
//   by this very run was written by a slice whose process died after the commit and before the framework saved its
//   counters (the next process redoes the batch from the same cursor): it is a replay (`FreshRow.replay`), counted and
//   reported again as it was the first time, and nothing is written for it, so the run ends exactly as one never
//   stopped. What the first attempt decided and the stored rows do not tell (a row merged into an existing master
//   rather than creating it, a scope note kept) it wrote as a mark beside the row's map row (`markOf`: entity
//   `<table>:<mark>`, same source, key, target and run), in the same transaction.
// - A dry run reads the same rows, counts and reports them alike, and writes nothing: `io.trx` is null.
// - Text cells go through cleanText (§11.5 steps 1–3); its repairs are counted per `<table>.<column>`, with at most five
//   before/after samples per column.

/** Rows per batch (§11.1, §11.3: batches of 500). */
export const STAGE_BATCH = 500;
/** Samples per column (§11.5: "5 contoh sebelum/sesudah per kolom"). */
const SAMPLES_PER_COLUMN = 5;
/** Columns whose sample count a cursor carries; a column beyond them gives no samples within the step. */
const SAMPLE_COLUMNS_MAX = 16;
/** Running totals a cursor carries per step. */
const TOTALS_MAX = 32;
/** Report rows per code and table scan; the rest are counted and summed up in one row at the table's end. */
const REPORT_ROWS_PER_CODE = 200;
/** The longest source cursor a stage cursor wraps (SLIMS_CURSOR_MAX is 4096 for the whole cursor). */
const SOURCE_CURSOR_MAX = 1024;
/**
 * A stage cursor stays below this many characters (16 samples and 32 totals, and the source's cursor): when it would
 * not, the sample counts give way first, then the totals (see serialize).
 */
const CURSOR_MAX = 4000;
/** A name a cursor carries (`<table>.<column>`, a total). */
const NAME = /^[A-Za-z0-9_.|:-]{1,96}$/;

let batchOverride: number | null = null;

function testProfile(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test';
}

/** The rows a scan step reads per batch: {@link STAGE_BATCH}, or a test's smaller number (test profile). */
export function stageBatch(): number {
  return batchOverride ?? STAGE_BATCH;
}

/**
 * Test build profile only (R57): scan steps of stages A read `n` rows per batch instead of 500 (null: back to 500), so
 * a test can stop a stage in the middle of a small table.
 *
 * @throws TypeError outside the test build profile, or for `n` that is not an integer from 1 to 500
 */
export function __setSlimsStageBatch(n: number | null): void {
  if (!testProfile()) throw new TypeError('__setSlimsStageBatch is a hook of the test build profile only');
  if (n !== null && (!Number.isSafeInteger(n) || n < 1 || n > STAGE_BATCH)) throw new TypeError('__setSlimsStageBatch: n must be 1-500');
  batchOverride = n;
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger of one batch

/** Counts, report rows and repairs of one batch, applied to the run once its transaction committed. */
export class Ledger {
  private readonly ops: ((c: SlimsStageContext) => void)[] = [];
  /** Samples taken per column (a working copy of the cursor's counts). */
  readonly samples: Map<string, number>;
  /** The step's running totals (a working copy of the cursor's). */
  readonly totals: Map<string, number>;

  constructor(samples: ReadonlyMap<string, number>, totals: ReadonlyMap<string, number>) {
    this.samples = new Map(samples);
    this.totals = new Map(totals);
  }

  migrated(table: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.migrated(table, n));
  }

  merged(table: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.merged(table, n));
  }

  skipped(table: string, reason: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.skipped(table, reason, n));
  }

  /** Catalogue rows a re-sync writes or would write (counters.ts `changed`). */
  changed(table: string, n = 1): void {
    if (n > 0) this.ops.push((c) => c.counters.changed(table, n));
  }

  /**
   * A report row. Past {@link REPORT_ROWS_PER_CODE} rows of one code in the table being read, the rows are only counted
   * (`o:<code>`) and the table's end sums them up in one row: a flood of one problem (zero dates, say) does not push the
   * others out of the report, which keeps 10 000 rows.
   */
  report(table: string, legacyKey: string | null, code: string, detail: string): void {
    const listed = this.totals.get(`r:${code}`);
    if (listed !== undefined && listed >= REPORT_ROWS_PER_CODE && (this.totals.has(`o:${code}`) || this.totals.size < TOTALS_MAX)) {
      this.totals.set(`o:${code}`, (this.totals.get(`o:${code}`) ?? 0) + 1);
      return;
    }
    if (listed !== undefined || this.totals.size < TOTALS_MAX) this.totals.set(`r:${code}`, (listed ?? 0) + 1);
    this.note(table, legacyKey, code, detail);
  }

  /** A report row that is always listed (a table's summary rows). */
  note(table: string, legacyKey: string | null, code: string, detail: string): void {
    const row: SlimsReportRow = { table, legacyKey, code, detail };
    this.ops.push((c) => c.report(row));
  }

  /** The table's summary rows of the report rows counted past the limit of their code. */
  overflow(table: string): void {
    for (const [name, n] of this.totals) {
      if (name.startsWith('o:') && n > 0) this.note(table, null, name.slice(2), `+${n} baris lagi tidak dicantumkan / more rows not listed`);
    }
  }

  /** One repair of `kind` in `column` (`<table>.<column>`), and its sample while the column has fewer than five. */
  fixed(column: string, kinds: readonly SlimsFixKind[], before: string, after: string): void {
    if (kinds.length === 0) return;
    const ks = [...kinds];
    const held = this.samples.get(column);
    const sample = held === undefined ? this.samples.size < SAMPLE_COLUMNS_MAX : held < SAMPLES_PER_COLUMN;
    if (sample) this.samples.set(column, (held ?? 0) + 1);
    this.ops.push((c) => {
      for (const k of ks) c.counters.fix(column, k, 1);
      if (sample) c.counters.sample(column, before, after);
    });
  }

  /** Adds `n` to the running total `name`. */
  add(name: string, n = 1): void {
    if (this.totals.has(name) || this.totals.size < TOTALS_MAX) this.totals.set(name, (this.totals.get(name) ?? 0) + n);
  }

  apply(c: SlimsStageContext): void {
    for (const op of this.ops) op(c);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cells

type Cell = SlimsRow[string] | undefined;

/** How a stored value is shown in a sample: control characters and bytes that are no text as `\xHH`. */
function shown(v: string | Uint8Array): string {
  const s = typeof v === 'string' ? v : Array.from(v, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  return s.replace(/[\p{Cc}]/gu, (ch) => `\\x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
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

/** A legacy key from a cell: a number's digits, text trimmed (bytes decoded), '' for NULL. */
export function keyOf(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  return cleanText(v).value.trim();
}

/** A key that fits `migration_map.legacy_key` (1–191 code points, no outer blank: keyOf trims). */
export function keyFits(key: string): boolean {
  return key !== '' && Array.from(key).length <= 191;
}

/** An integer cell (a number, or digits in text), or null. */
export function intOf(v: Cell): number | null {
  const s = keyOf(v);
  if (!/^[+-]?\d{1,15}$/.test(s)) return null;
  return Number(s);
}

/** Single-line text: every run of control characters as one space, trimmed. */
export function oneLine(s: string): string {
  return s.replace(/\p{Cc}+/gu, ' ').trim();
}

/** Multi-line text: C0 controls but tab, line feed and carriage return removed, DEL too; trailing blanks trimmed. */
export function multiLine(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) continue;
    out += ch;
  }
  return out.trimEnd();
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

/** `s` (null: null) cut to `max` code points, reported as `text_truncated` when cut; '' → null. */
export function fitChars(l: Ledger, table: string, key: string | null, column: string, s: string | null, max: number): string | null {
  if (s === null || s === '') return null;
  const cut = cutChars(s, max);
  if (cut !== s) l.report(table, key, 'text_truncated', `${column}: ${Array.from(s).length} > ${max}`);
  return cut === '' ? null : cut;
}

/** The longest free TEXT value (MySQL TEXT holds 65 535 bytes; Review Focus 3). */
export const TEXT_MAX_BYTES = 60_000;

/** `s` (null: null) cut to {@link TEXT_MAX_BYTES} UTF-8 bytes, reported as `text_truncated` when cut; '' → null. */
export function fitText(l: Ledger, table: string, key: string | null, column: string, s: string | null): string | null {
  if (s === null || s === '') return null;
  const cut = cutBytes(s, TEXT_MAX_BYTES);
  if (cut !== s) l.report(table, key, 'text_truncated', `${column}: ${Buffer.byteLength(s, 'utf8')} > ${TEXT_MAX_BYTES} bytes`);
  return cut === '' ? null : cut;
}

/** A human code (`codeField`): 1–32 printable ASCII characters, trimmed. */
export function codeFits(s: string): boolean {
  return /^[\x20-\x7E]{1,32}$/.test(s) && s.trim() === s;
}

// ---------------------------------------------------------------------------------------------------------------
// Batches and steps

/** What a batch writes through: `trx` in a real run, null in a dry run; `db` for its reads (the transaction, or the handle). */
export interface BatchIo {
  db: Kysely<DB> | Transaction<DB>;
  trx: Transaction<DB> | null;
}

/**
 * Runs `fn` for one batch: inside one transaction of a real run (again from a fresh ledger when the transaction runs
 * its callback again), without one in a dry run; returns the ledger of the attempt that counted.
 */
export async function inBatch(
  c: SlimsStageContext,
  samples: ReadonlyMap<string, number>,
  totals: ReadonlyMap<string, number>,
  fn: (io: BatchIo, l: Ledger) => Promise<void>,
): Promise<Ledger> {
  if (c.dryRun) {
    const l = new Ledger(samples, totals);
    await fn({ db: c.h.db, trx: null }, l);
    return l;
  }
  return withTx(c.h, async (trx) => {
    const l = new Ledger(samples, totals);
    await fn({ db: trx, trx }, l);
    return l;
  });
}

/**
 * The ids of the legacy rows `keys` of `entity` under the run's source name (S13). In a dry run, which maps nothing, a
 * key not mapped yet stands for a row the run would have made: it answers a placeholder that is never written.
 */
export async function refsOf(c: SlimsStageContext, io: BatchIo, entity: string, keys: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(keys.filter(keyFits))];
  const found = wanted.length === 0 ? new Map<string, string>() : await lookupLegacy(io.db, c.options.sourceName, entity, wanted);
  if (c.dryRun) for (const k of wanted) if (!found.has(k)) found.set(k, `~${entity}:${k}`);
  return found;
}

/** One table read in batches. */
export interface ScanStep {
  kind: 'scan';
  table: string;
  /**
   * Columns of the table no ALTIS field takes (§11.4 "tidak dipetakan"): the batch counts their filled values in the
   * rows it handles (countUnmapped), and the table's end reports them once (`column_not_mapped`, 32 columns at most).
   */
  unmapped?: readonly string[];
  /** Handles one batch of rows (`first`: the table's first batch). */
  batch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, first: boolean): Promise<void>;
  /** After the table's last batch, inside its transaction. */
  end?(c: SlimsStageContext, io: BatchIo, l: Ledger): Promise<void>;
}

/** A step with calls of its own (its own transactions and counts): one call per batch of the driver. */
export interface CustomStep {
  kind: 'custom';
  name: string;
  run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }>;
}

export type Step = ScanStep | CustomStep;

const stepCursor = z.strictObject({
  t: z.int().min(0).max(255),
  c: z.string().min(1).max(SOURCE_CURSOR_MAX).nullable(),
  s: z.record(z.string().regex(NAME), z.int().min(0).max(SAMPLES_PER_COLUMN)),
  x: z.record(z.string().regex(NAME), z.int().min(0)),
});

type StepCursor = z.infer<typeof stepCursor>;

function parseCursor(stage: string, cursor: string): StepCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    throw new TypeError(`${stage}: the cursor is not JSON`);
  }
  const parsed = stepCursor.safeParse(raw);
  if (!parsed.success) throw new TypeError(`${stage}: the cursor is malformed`);
  return parsed.data;
}

/** The cursor's maps: only names a cursor can carry (a column of a crafted dump may not fit). */
function carried(m: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...m].filter(([k]) => NAME.test(k)));
}

/**
 * Runs the steps of stage `stage` from `cursor` (see the top of this file): at least one batch, then more while the
 * slice's budget lasts; a table the source does not have is passed over.
 *
 * @throws TypeError for a cursor this function did not write, or a source cursor longer than 1024 characters
 */
export async function runSteps(
  c: SlimsStageContext,
  stage: string,
  steps: readonly Step[],
  cursor: string | null,
): Promise<{ done: boolean; cursor: string | null }> {
  let at: StepCursor = cursor === null ? { t: 0, c: null, s: {}, x: {} } : parseCursor(stage, cursor);
  let present: Set<string> | null = null;
  let batches = 0;
  while (at.t < steps.length) {
    if (batches > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: serialize(at) };
    const step = steps[at.t]!;
    if (step.kind === 'custom') {
      batches += 1;
      const r = await step.run(c, at.c);
      if (r.cursor !== null && r.cursor.length > SOURCE_CURSOR_MAX) throw new TypeError(`${stage}: the cursor of ${step.name} is too long`);
      at = r.done ? { t: at.t + 1, c: null, s: {}, x: {} } : { ...at, c: r.cursor };
      continue;
    }
    present ??= new Set((await c.source.tables()).map((t: SlimsTableInfo) => t.name));
    if (!present.has(step.table)) {
      at = { t: at.t + 1, c: null, s: {}, x: {} };
      continue;
    }
    const batch = await c.source.rows(step.table, at.c, stageBatch());
    batches += 1;
    const next = batch.rows.length === 0 ? null : batch.next;
    if (next !== null && next.length > SOURCE_CURSOR_MAX) throw new TypeError(`${stage}: the source cursor of ${step.table} is too long`);
    const last = next === null;
    const first = at.c === null;
    const unmapped = (step.unmapped ?? []).slice(0, TOTALS_MAX);
    const l = await inBatch(c, new Map(Object.entries(at.s)), new Map(Object.entries(at.x)), async (io, ledger) => {
      if (batch.rows.length > 0) await step.batch(c, batch.rows, io, ledger, first);
      if (!last) return;
      ledger.overflow(step.table);
      for (const column of unmapped) {
        const n = ledger.totals.get(column) ?? 0;
        if (n > 0) ledger.note(step.table, null, 'column_not_mapped', `${column}: ${n} nilai tidak dipetakan / values not mapped`);
      }
      await step.end?.(c, io, ledger);
    });
    l.apply(c);
    at = next === null ? { t: at.t + 1, c: null, s: {}, x: {} } : { t: at.t, c: next, s: carried(l.samples), x: carried(l.totals) };
  }
  return { done: true, cursor: null };
}

/** The cursor as JSON, within {@link CURSOR_MAX}: the sample counts give way first (a column may then sample again). */
function serialize(at: StepCursor): string {
  let json = JSON.stringify(at);
  if (json.length > CURSOR_MAX) json = JSON.stringify({ ...at, s: {} });
  if (json.length > CURSOR_MAX) json = JSON.stringify({ ...at, s: {}, x: {} });
  return json;
}

/** The targets of the legacy rows `keys` of `entity` already mapped under the run's source (S13), by key. */
export async function mappedOf(c: SlimsStageContext, io: BatchIo, entity: string, keys: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(keys.filter(keyFits))];
  return wanted.length === 0 ? new Map() : lookupLegacy(io.db, c.options.sourceName, entity, wanted);
}

/** What the first attempt of a replayed row decided that its map row does not tell (see the top of this file). */
export type ReplayMark = 'merged' | 'scope_kept';

const REPLAY_MARKS: readonly ReplayMark[] = ['merged', 'scope_kept'];

/** A row this very run mapped already (see the top of this file): its target, and the marks its first attempt wrote. */
export interface Replay {
  targetId: string;
  marks: ReadonlySet<ReplayMark>;
}

/** A row of a batch that an earlier run mapped (`catalogMode = sync`): its key, its row and its target. */
export interface DoneRow {
  key: string;
  row: SlimsRow;
  targetId: string;
}

/** One row of a batch that is the stage's to handle, with its legacy key. */
export interface FreshRow {
  key: string;
  row: SlimsRow;
  /** Mapped by this very run: count and report it as the first time, write nothing; null for a row not mapped yet. */
  replay: Replay | null;
}

/**
 * The legacy map row that marks `mark` on the row `key` of `table` (mapped to `targetId`), written with the row's map
 * row so that a replay of the batch counts the row as its first attempt did (see the top of this file).
 */
export function markOf(c: SlimsStageContext, table: string, key: string, targetId: string, mark: ReplayMark): LegacyMapping {
  return { source: c.options.sourceName, entity: `${table}:${mark}`, legacyKey: key, targetId, runId: c.runId };
}

/**
 * The rows of a batch of `table` a stage handles, keyed by `keyColumns` (a composite key joined with `|`): a row with
 * a NULL or blank key part is skipped `empty_key`, a key over 191 characters `key_too_long`, a key seen earlier in the
 * batch `duplicate_key` (a table without a primary key), each reported; then (unless `o.mapped` is false, for the
 * tables that map nothing) a key an earlier run mapped under the run's source is skipped `already_migrated` (§11.2,
 * D2-26: never updated), and a key this very run mapped comes back as a replay with its marks.
 *
 * With `o.done` (a catalogue re-sync) a key an earlier run mapped is not skipped: it is pushed onto `o.done` with its
 * target, and the caller counts it.
 */
export async function freshRows(
  c: SlimsStageContext,
  io: BatchIo,
  l: Ledger,
  table: string,
  rows: readonly SlimsRow[],
  keyColumns: readonly string[],
  o: { mapped?: boolean; done?: DoneRow[] } = {},
): Promise<FreshRow[]> {
  const out: FreshRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parts = keyColumns.map((k) => keyOf(row[k]));
    if (parts.some((p) => p === '')) {
      l.skipped(table, 'empty_key');
      l.report(table, null, 'empty_key', `${keyColumns.join('|')} kosong / empty`);
      continue;
    }
    const key = parts.join('|');
    if (!keyFits(key)) {
      l.skipped(table, 'key_too_long');
      l.report(table, null, 'key_too_long', `${keyColumns.join('|')}: ${cutChars(key, 60)}`);
      continue;
    }
    if (seen.has(key)) {
      l.skipped(table, 'duplicate_key');
      l.report(table, key, 'duplicate_key', `${keyColumns.join('|')} ganda / repeated`);
      continue;
    }
    seen.add(key);
    out.push({ key, row, replay: null });
  }
  if (o.mapped === false || out.length === 0) return out;
  const mapped = await mappedRows(c, io.db, table, out.map((r) => r.key));
  const handled: FreshRow[] = [];
  const replays: FreshRow[] = [];
  for (const r of out) {
    const m = mapped.get(r.key);
    const state = stateOf(c, m);
    if (state === 'done') {
      if (o.done !== undefined) o.done.push({ key: r.key, row: r.row, targetId: m!.targetId });
      else l.skipped(table, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      const replay = { key: r.key, row: r.row, replay: { targetId: m!.targetId, marks: new Set<ReplayMark>() } };
      replays.push(replay);
      handled.push(replay);
    } else handled.push(r);
  }
  if (replays.length > 0) {
    for (const mark of REPLAY_MARKS) {
      const marked = await mappedRows(c, io.db, `${table}:${mark}`, replays.map((r) => r.key));
      for (const r of replays) if (marked.get(r.key)?.runId === c.runId) (r.replay!.marks as Set<ReplayMark>).add(mark);
    }
  }
  return handled;
}

/** A human code made from a name (`Bahan Campuran` → `BAHAN-CAMPURAN`): ASCII letters and digits and `-`, ≤ 32. */
export function codeFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** A value is there: text that is not blank or `0`, a number that is not 0, bytes. */
export function filled(v: SlimsRow[string] | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '' && v.trim() !== '0';
  return v.length > 0;
}

/**
 * Counts, on the ledger's running totals, the filled values of the step's `unmapped` columns in the rows a batch
 * handles (a row skipped as already migrated was counted by the run that migrated it).
 */
export function countUnmapped(l: Ledger, rows: readonly FreshRow[], columns: readonly string[]): void {
  for (const { row } of rows) for (const column of columns.slice(0, TOTALS_MAX)) if (filled(row[column])) l.add(column);
}
