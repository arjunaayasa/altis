import {
  MIGRATION_SAMPLE_MAX_CHARS,
  MIGRATION_SAMPLE_MAX_COLUMNS,
  MIGRATION_SAMPLES_PER_COLUMN,
  type MigrationSample,
  type MigrationTableCounts,
} from '@altis/shared/api/catalog/migration';
import type { SlimsCounters, SlimsFixKind } from './stage.js';

// The reconciliation counters of a SLiMS migration run (Phase 2 spec §11.5, §11.6; plan Task 23, preflight M6). The
// stages count every source row they read as migrated, merged, skipped (by reason) or archived, the analyze stage the
// rows of each table, and the text repairs per column; the framework saves them in `catalog_runs.summary` after every
// slice and loads them again at the next one (createCounters(summary)), so a run stopped after any slice ends with the
// counts of a run that never stopped.
//
// The summary is TEXT (≤ 60 000 bytes of JSON), so what grows with the source is bounded here (M6):
// - samples (before/after pairs of a repaired value): at most 5 per column for at most 50 columns, each value cut to
//   120 characters, and at most SLIMS_SAMPLES_MAX_BYTES of them in all. Every sample, uncut, also goes to the report
//   CSV through `onSample`, so nothing is lost;
// - text repairs: at most SLIMS_FIX_COLUMNS_MAX columns, the counts of any further column under `*`;
// - skip reasons: at most 32 per table, any further reason counted as `other`.
//
// Names come from the source (a dump is untrusted): the counts live in Maps and reach JSON through Object.fromEntries,
// so a table called `__proto__` is a key like any other.
//
// The catalogue re-sync adds two counts per table: `vanished`, the mapped rows whose source row is gone and that the run
// archived (they are in `archived` too, and reconcile.ts takes them out again, as they are no source rows), and
// `changes`, the rows the run writes or would write (a sync dry run's `catalogChanges`).

/** The bytes the samples may take in the summary (M6: the summary stays far below its 60 000). */
export const SLIMS_SAMPLES_MAX_BYTES = 24_000;
/** Columns whose text repairs are counted one by one; the counts of any further column go under `*`. */
export const SLIMS_FIX_COLUMNS_MAX = 100;

const REASONS_PER_TABLE_MAX = 32;
const TABLES_MAX = 256;
const NAME_MAX = 64;
const COLUMN_MAX = 129;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const FIX_KINDS: ReadonlySet<string> = new Set<SlimsFixKind>(['nul', 'backslash', 'mojibake', 'cp1252', 'php', 'date', 'year']);

/** The counters as the summary keeps them. */
export interface SlimsCountersJson {
  tables: Record<string, MigrationTableCounts>;
  /** The tables counted with `unread` (not read by this phase, or derived), in the order they were first counted. */
  unread: string[];
  fixes: Record<string, Record<string, number>>;
  samples: MigrationSample[];
  // ---- Komunitas K1 (catalogue re-sync) ----
  /** Per table: the mapped rows archived because their source row is gone (also counted in `archived`). */
  vanished: Record<string, number>;
  /** Per table: the catalogue rows written, or that a dry run would write (new, changed, gone). */
  changes: Record<string, number>;
}

/** What a sample hands the report besides the summary: the column, the repair, both values uncut. */
export type SlimsSampleSink = (column: string, fix: string, before: string, after: string) => void;

interface TableCounts {
  source: number;
  migrated: number;
  merged: number;
  skipped: Map<string, number>;
  archived: number;
}

function count(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`SLiMS counters: ${what} must be a non-negative integer`);
  return n;
}

function tableName(t: unknown): string {
  if (typeof t !== 'string' || t === '' || t.length > NAME_MAX) throw new TypeError(`SLiMS counters: a table name must be 1-${NAME_MAX} characters`);
  return t;
}

/** `s` cut to `max` code points. */
function cut(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('');
}

function sampleBytes(s: MigrationSample): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') + 1;
}

/** `v` when it is a plain object (a parsed JSON object), else null. */
function objectOf(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function nonNegative(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/**
 * The counters of a run, starting from the counters a summary holds (`initial`: the parsed `catalog_runs.summary`,
 * or null for none). `toJSON()` gives them as the summary keeps them (bounded, see the top of this file).
 *
 * @param o.onSample receives every sample whole (the report CSV keeps them all)
 * @throws TypeError from a counting call given a count that is not a non-negative integer, a table name that is not
 *   1-64 characters, a skip reason that is not a code, a repair that is not a SlimsFixKind, or a 257th table
 */
export function createCounters(initial: object | null, o: { onSample?: SlimsSampleSink } = {}): SlimsCounters & { toJSON(): SlimsCountersJson } {
  const tables = new Map<string, TableCounts>();
  const unread: string[] = [];
  const fixes = new Map<string, Map<string, number>>();
  const samples: MigrationSample[] = [];
  const perColumn = new Map<string, number>();
  const lastFix = new Map<string, string>();
  const vanished = new Map<string, number>();
  const changes = new Map<string, number>();
  let bytes = 0;

  const table = (t: string): TableCounts => {
    const name = tableName(t);
    let c = tables.get(name);
    if (c === undefined) {
      if (tables.size >= TABLES_MAX) throw new TypeError(`SLiMS counters: more than ${TABLES_MAX} tables`);
      c = { source: 0, migrated: 0, merged: 0, skipped: new Map(), archived: 0 };
      tables.set(name, c);
    }
    return c;
  };
  const keep = (s: MigrationSample): void => {
    const size = sampleBytes(s);
    const held = perColumn.get(s.column) ?? 0;
    if (held >= MIGRATION_SAMPLES_PER_COLUMN) return;
    if (held === 0 && perColumn.size >= MIGRATION_SAMPLE_MAX_COLUMNS) return;
    if (bytes + size > SLIMS_SAMPLES_MAX_BYTES) return;
    samples.push(s);
    perColumn.set(s.column, held + 1);
    bytes += size;
  };

  // The counters the summary holds already.
  const start = objectOf(initial);
  for (const [name, raw] of Object.entries(objectOf(start?.['tables']) ?? {})) {
    const v = objectOf(raw);
    if (v === null || name === '' || name.length > NAME_MAX || tables.size >= TABLES_MAX) continue;
    const skipped = new Map<string, number>();
    for (const [reason, n] of Object.entries(objectOf(v['skipped']) ?? {})) skipped.set(reason, nonNegative(n));
    tables.set(name, { source: nonNegative(v['source']), migrated: nonNegative(v['migrated']), merged: nonNegative(v['merged']), skipped, archived: nonNegative(v['archived']) });
  }
  const startUnread = start?.['unread'];
  if (Array.isArray(startUnread)) for (const t of startUnread) if (typeof t === 'string' && !unread.includes(t)) unread.push(t);
  for (const [column, raw] of Object.entries(objectOf(start?.['fixes']) ?? {})) {
    const kinds = new Map<string, number>();
    for (const [kind, n] of Object.entries(objectOf(raw) ?? {})) kinds.set(kind, nonNegative(n));
    fixes.set(column, kinds);
  }
  for (const [name, n] of Object.entries(objectOf(start?.['vanished']) ?? {})) if (tables.has(name)) vanished.set(name, nonNegative(n));
  for (const [name, n] of Object.entries(objectOf(start?.['changes']) ?? {})) {
    if (name !== '' && name.length <= NAME_MAX && changes.size < TABLES_MAX) changes.set(name, nonNegative(n));
  }
  const startSamples = start?.['samples'];
  if (Array.isArray(startSamples)) {
    for (const raw of startSamples) {
      const v = objectOf(raw);
      if (v === null || typeof v['column'] !== 'string' || typeof v['fix'] !== 'string' || typeof v['before'] !== 'string') continue;
      const after = typeof v['after'] === 'string' ? v['after'] : null;
      keep({ column: v['column'], fix: v['fix'], before: v['before'], after });
    }
  }

  return {
    source(t, n) {
      table(t).source += count(n, 'source');
    },
    migrated(t, n) {
      table(t).migrated += count(n, 'migrated');
    },
    merged(t, n) {
      table(t).merged += count(n, 'merged');
    },
    archived(t, n) {
      table(t).archived += count(n, 'archived');
    },
    unread(t, n) {
      table(t).source += count(n, 'unread');
      if (!unread.includes(t)) unread.push(t);
    },
    skipped(t, reason, n) {
      const c = table(t);
      if (typeof reason !== 'string' || !REASON.test(reason)) throw new TypeError('SLiMS counters: a skip reason must be a lower-case code');
      const key = c.skipped.has(reason) || c.skipped.size < REASONS_PER_TABLE_MAX ? reason : 'other';
      c.skipped.set(key, (c.skipped.get(key) ?? 0) + count(n, 'skipped'));
    },
    fix(column, kind, n) {
      if (!FIX_KINDS.has(kind)) throw new TypeError(`SLiMS counters: ${JSON.stringify(kind)} is not a text repair`);
      const added = count(n, 'fix');
      const name = cut(String(column), COLUMN_MAX);
      lastFix.set(name, kind);
      const key = fixes.has(name) || fixes.size < SLIMS_FIX_COLUMNS_MAX ? name : '*';
      const kinds = fixes.get(key) ?? new Map<string, number>();
      kinds.set(kind, (kinds.get(kind) ?? 0) + added);
      fixes.set(key, kinds);
    },
    vanished(t, n) {
      const added = count(n, 'vanished');
      table(t).archived += added;
      vanished.set(t, (vanished.get(t) ?? 0) + added);
    },
    changed(t, n) {
      const name = tableName(t);
      const added = count(n, 'changed');
      if (!changes.has(name) && changes.size >= TABLES_MAX) throw new TypeError(`SLiMS counters: more than ${TABLES_MAX} tables`);
      changes.set(name, (changes.get(name) ?? 0) + added);
    },
    sample(column, before, after) {
      const name = cut(String(column), COLUMN_MAX);
      const fix = lastFix.get(name) ?? 'fix';
      o.onSample?.(name, fix, String(before), String(after));
      keep({ column: name, fix, before: cut(String(before), MIGRATION_SAMPLE_MAX_CHARS), after: cut(String(after), MIGRATION_SAMPLE_MAX_CHARS) });
    },
    toJSON(): SlimsCountersJson {
      return {
        tables: Object.fromEntries(
          [...tables].map(([name, c]) => [
            name,
            { source: c.source, migrated: c.migrated, merged: c.merged, skipped: Object.fromEntries(c.skipped), archived: c.archived },
          ]),
        ),
        unread: [...unread],
        fixes: Object.fromEntries([...fixes].map(([column, kinds]) => [column, Object.fromEntries(kinds)])),
        samples: samples.map((s) => ({ ...s })),
        vanished: Object.fromEntries(vanished),
        changes: Object.fromEntries(changes),
      };
    },
  };
}
