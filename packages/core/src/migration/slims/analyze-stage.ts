import { MIGRATION_SAMPLE_MAX_CHARS, MIGRATION_SAMPLES_PER_COLUMN, type MigrationCharsetSample } from '@altis/shared/api/catalog/migration';
import { z } from 'zod';
import { slimsSources } from './factory.js';
import { SLIMS_CURSOR_MAX, SLIMS_TARGET_TABLES, SlimsRunFailure, cutText, pipelineOf, slimsTargetCounts } from './pipeline.js';
import { slimsUnreadKind } from './report.js';
import type { SlimsRow, SlimsTableInfo } from './source/types.js';
import type { SlimsStage, SlimsStageContext } from './stage.js';
// ---- Komunitas (SLiMS members and circulation) ----
import { memberFacts, sourceMemberTypes, typeGroup } from './stages/members.js';
import { keyOf, oneLine } from './stages/stage-b-kit.js';

// `analyze`, the first stage after the split (Phase 2 spec §11.3 step 1, §11.4, §11.6; plan Task 23, preflight M13):
//
// 1. once, at its start: the version the tables look like (`detectSlimsVersion`, B1: `unknown` ends the run as
//    `source_unsupported`, `8` is best effort and warned), a report row per missing core table, per table with
//    columns this release does not know, and per table no stage reads that is not listed in §11.4 either
//    (`table_not_mapped`); and the rows of the target tables before the run (M13);
// 2. the rows of every table a stage reads (`source`), and of the "Fase 3" and derived tables (`unread`): the count the
//    source reports when it knows it, otherwise the rows read in keyset batches of 500 (an unread table is never read);
// 3. the character set of the text columns of `biblio`, `item`, `mst_author` and `mst_topic` in their first 1 000 rows
//    (M13): per column the cells that are pure ASCII, valid UTF-8, bytes that are no UTF-8 (read as cp1252) and valid
//    UTF-8 shaped like mojibake, with up to 5 problem samples cut to 120 characters;
// 4. a real run then marks the search index `building` (set back to `ready` when the run ends).
//
// It writes nothing but the run's summary and report. Its cursor is its own JSON: the phase, the table, the source's
// cursor and the rows counted so far, so a slice that ends mid-table goes on where it stopped.

const BATCH = 500;
const CHARSET_TABLES: readonly string[] = Object.freeze(['biblio', 'item', 'mst_author', 'mst_topic']);
const CHARSET_ROWS = 1000;
/** Columns sampled per table at most (a table of a crafted dump may have thousands; SLiMS's widest has about 30). */
const CHARSET_COLUMNS_PER_TABLE = 48;
const DETAIL_NAMES_MAX = 40;

const analyzeCursor = z.strictObject({
  p: z.enum(['count', 'charset']),
  t: z.int().min(0),
  c: z.string().min(1).max(SLIMS_CURSOR_MAX - 256).nullable(),
  n: z.int().min(0),
});

type AnalyzeCursor = z.infer<typeof analyzeCursor>;

function parseCursor(cursor: string): AnalyzeCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    throw new TypeError('analyze: the cursor is not JSON');
  }
  const parsed = analyzeCursor.safeParse(raw);
  if (!parsed.success) throw new TypeError('analyze: the cursor is malformed');
  return parsed.data;
}

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
/** cp1252's characters for the bytes 0x80-0x9F, as a byte of a UTF-8 sequence decoded as cp1252 shows. */
const CP1252_HIGH = cp(
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
);
/** A UTF-8 lead byte followed by a continuation byte, both decoded as latin1/cp1252: the shape of doubly decoded text. */
const MOJIBAKE = new RegExp(`[\\xC2-\\xF4][\\x80-\\xBF${CP1252_HIGH}]`);
const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};
const REPLACEMENT = cp(0xfffd);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

/** What a cell's text looks like, and the text to show for it; null for a cell that holds no text. */
export function slimsCharsetOf(v: SlimsRow[string]): { kind: 'ascii' | 'utf8' | 'cp1252' | 'mojibake'; text: string } | null {
  if (v instanceof Uint8Array) {
    if (v.every((b) => b < 0x80)) return { kind: 'ascii', text: Buffer.from(v).toString('latin1') };
    let text: string;
    try {
      text = utf8.decode(v);
    } catch {
      return { kind: 'cp1252', text: cp1252.decode(v) };
    }
    return { kind: MOJIBAKE.test(text) ? 'mojibake' : 'utf8', text };
  }
  if (typeof v !== 'string') return null;
  if (isAscii(v)) return { kind: 'ascii', text: v };
  if (v.includes(REPLACEMENT)) return { kind: 'cp1252', text: v };
  return { kind: MOJIBAKE.test(v) ? 'mojibake' : 'utf8', text: v };
}

/** Adds the text cells of `rows` (of `table`) to `entries`, one entry per `<table>.<column>`. */
function sampleCharset(entries: MigrationCharsetSample[], table: string, rows: readonly SlimsRow[]): void {
  const prefix = `${table}.`;
  let columns = entries.filter((e) => e.column.startsWith(prefix)).length;
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      const seen = slimsCharsetOf(value);
      if (seen === null) continue;
      const key = cutText(`${table}.${column}`, 129);
      let entry = entries.find((e) => e.column === key);
      if (entry === undefined) {
        if (columns >= CHARSET_COLUMNS_PER_TABLE) continue;
        entry = { column: key, rows: 0, ascii: 0, utf8: 0, cp1252: 0, mojibake: 0, samples: [] };
        entries.push(entry);
        columns += 1;
      }
      entry.rows += 1;
      entry[seen.kind] += 1;
      if ((seen.kind === 'cp1252' || seen.kind === 'mojibake') && entry.samples.length < MIGRATION_SAMPLES_PER_COLUMN) {
        entry.samples.push(cutText(seen.text, MIGRATION_SAMPLE_MAX_CHARS));
      }
    }
  }
}

/** `names` for a detail cell: at most 40 of them, and how many more. */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, DETAIL_NAMES_MAX).join(', ');
  return names.length > DETAIL_NAMES_MAX ? `${shown} (+${names.length - DETAIL_NAMES_MAX})` : shown;
}

/** Step 1 of the top of this file. */
async function begin(c: SlimsStageContext, tables: readonly SlimsTableInfo[]): Promise<void> {
  const p = pipelineOf(c);
  const info = slimsSources().detectSlimsVersion([...tables]);
  p.state.version = info.version;
  const present = new Set(tables.map((t) => t.name));
  const missing = [...new Set([...info.missing, ...[...p.readTables()].filter((t) => !present.has(t))])].sort();
  for (const table of missing) {
    c.report({ table, legacyKey: null, code: 'missing_table', detail: 'Tabel tidak ada di sumber / The source has no such table' });
  }
  for (const [table, columns] of Object.entries(info.unknownColumns)) {
    if (columns.length > 0) c.report({ table, legacyKey: null, code: 'unknown_column', detail: listed(columns) });
  }
  if (info.version === 'unknown') {
    throw new SlimsRunFailure(
      'source_unsupported',
      `Sumber tidak tampak seperti SLiMS 8 atau 9 / The source does not look like SLiMS 8 or 9 (${listed(info.missing)})`,
    );
  }
  if (info.version === '8') p.warn('slims8_best_effort');
  for (const t of tables) {
    if (p.readTables().has(t.name) || slimsUnreadKind(t.name) !== null) continue;
    c.report({ table: t.name, legacyKey: null, code: 'table_not_mapped', detail: `rows=${t.rows ?? '?'}` });
  }
  const counts = await slimsTargetCounts(p.db);
  p.state.targets = SLIMS_TARGET_TABLES.map((table) => ({ table, before: counts[table], after: counts[table] }));
  p.state.charset = [];
  if (p.readTables().has('member') && present.has('member')) await memberPrecheck(c);
}

/**
 * The member precheck: SLiMS member numbers that collide once normalised (`b 001` and `B001`) are listed (the source
 * numbers only) and counted; a real run is refused while any is left (`member_no_collision`): an old card would open
 * the wrong member at the desk, the guestbook and the OPAC once one of them got a suffix. The SLiMS member types with
 * their groups (the wizard's, or guessed from the name) go to the summary for the wizard's group step.
 */
async function memberPrecheck(c: SlimsStageContext): Promise<void> {
  const p = pipelineOf(c);
  const facts = await memberFacts(c);
  let colliding = 0;
  for (const ids of facts.collisions.values()) {
    colliding += ids.length;
    c.report({ table: 'member', legacyKey: ids[0] ?? null, code: 'member_no_collision', detail: ids.join(' | ') });
  }
  p.state.memberNoCollisions = colliding;
  p.state.memberTypes = [...(await sourceMemberTypes(c))].slice(0, 200).map(([id, row]) => {
    const name = cutText(oneLine(keyOf(row['member_type_name'])), 120) || id;
    return { id, name, members: facts.perType.get(id) ?? 0, group: typeGroup(c, id, name) };
  });
  if (colliding > 0 && !p.dryRun) {
    throw new SlimsRunFailure(
      'member_no_collision',
      `${colliding} nomor anggota SLiMS bertabrakan setelah dinormalkan; ubah di SLiMS lalu jalankan uji kering lagi / ${colliding} SLiMS member numbers collide once normalised; change them in SLiMS, then dry-run again`,
    );
  }
}

async function analyze(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
  const p = pipelineOf(c);
  const tables = [...(await c.source.tables())].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (cursor === null) await begin(c, tables);
  let at: AnalyzeCursor = cursor === null ? { p: 'count', t: 0, c: null, n: 0 } : parseCursor(cursor);
  const reads = p.readTables();
  const counted = tables.filter((t) => reads.has(t.name) || slimsUnreadKind(t.name) !== null);
  const pause = (): { done: false; cursor: string } => ({ done: false, cursor: JSON.stringify(at) });
  // One batch at least per call, so a call always moves; then only while the budget lasts.
  let batches = 0;
  const spent = (): boolean => batches > 0 && c.budgetLeftMs() <= 0;

  while (at.p === 'count') {
    const t = counted[at.t];
    if (t === undefined) {
      at = { p: 'charset', t: 0, c: null, n: 0 };
      break;
    }
    if (!reads.has(t.name)) {
      c.counters.unread(t.name, t.rows ?? 0);
    } else if (t.rows !== null) {
      c.counters.source(t.name, t.rows);
    } else {
      for (;;) {
        if (spent()) return pause();
        const batch = await c.source.rows(t.name, at.c, BATCH);
        batches += 1;
        at = { ...at, c: batch.next, n: at.n + batch.rows.length };
        if (batch.next === null || batch.rows.length === 0) break;
      }
      c.counters.source(t.name, at.n);
    }
    at = { p: 'count', t: at.t + 1, c: null, n: 0 };
  }

  const sampled = CHARSET_TABLES.filter((name) => tables.some((t) => t.name === name));
  for (let name = sampled[at.t]; name !== undefined; name = sampled[at.t]) {
    if (spent()) return pause();
    batches += 1;
    const batch = await c.source.rows(name, at.c, Math.min(BATCH, CHARSET_ROWS - at.n));
    sampleCharset(p.state.charset, name, batch.rows.slice(0, CHARSET_ROWS - at.n));
    const n = at.n + batch.rows.length;
    at = batch.next === null || batch.rows.length === 0 || n >= CHARSET_ROWS ? { p: 'charset', t: at.t + 1, c: null, n: 0 } : { ...at, c: batch.next, n };
  }

  await p.markIndexBuilding();
  return { done: true, cursor: null };
}

/** The `analyze` stage (see the top of this file). */
export const slimsAnalyzeStage: SlimsStage = Object.freeze({
  name: 'analyze' as const,
  reads: Object.freeze([]) as readonly string[],
  run: analyze,
});
