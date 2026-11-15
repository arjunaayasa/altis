import { openAppend, openRead, runWorkPath, statOrNull, truncateFile } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import type { SlimsRunSettings } from './options.js';
import type { SlimsReportRow } from './stage.js';

// The report rows of a SLiMS migration run while it runs (Phase 2 spec §11.6; plan Task 23): every stage's rows, the
// samples of repaired values whole (M6) and the framework's own, appended at the end of each slice to the run's work
// file `tmp/<runId>/report.csv`, one JSON array `[table, legacy_key, code, detail]` per line (a line break inside a
// value never splits a row). The report stage reads them back, after its own summary rows, into the report file that
// writeRunReport stores (CSV through csvRow, the first 10 000 rows).
//
// The summary records the work file's length after each slice (`resume.reportBytes`); the next slice cuts the file back
// to that length first, so the rows of a slice that died before saving its counters are written once, by its re-run.

/** The columns of the report CSV. */
export const SLIMS_REPORT_HEADER: readonly string[] = Object.freeze(['table', 'legacy_key', 'code', 'detail']);

/**
 * §11.4: the tables this phase does not read ("tidak dibaca di Fase 2", read in Phase 3), by name, and the prefixes of
 * `member*`, `loan*` and `group*`.
 */
export const SLIMS_PHASE3_TABLES: readonly string[] = Object.freeze([
  'fines',
  'reserve',
  'holiday',
  'mst_loan_rules',
  'mst_member_type',
  'biblio_mark',
  'comment',
  'visitor_count',
  'mst_visitor_room',
  'user',
  'system_log',
]);
export const SLIMS_PHASE3_PREFIXES: readonly string[] = Object.freeze(['member', 'loan', 'group']);
/** §11.4: the derived tables, never read (the search and index tables, the cache). */
export const SLIMS_DERIVED_TABLES: readonly string[] = Object.freeze(['search_biblio', 'index_words', 'index_documents', 'cache']);

/** Whether SLiMS table `table` is one this phase does not read: a "Fase 3" table, a derived one, or neither (null). */
export function slimsUnreadKind(table: string): 'phase3' | 'derived' | null {
  if (SLIMS_DERIVED_TABLES.includes(table)) return 'derived';
  if (SLIMS_PHASE3_TABLES.includes(table) || SLIMS_PHASE3_PREFIXES.some((p) => table.startsWith(p))) return 'phase3';
  return null;
}

/** A detail keeps at most this many characters (a sample is whole up to a MySQL TEXT value). */
const DETAIL_MAX = 65_535;
/** Lines are read back in pieces of this size. */
const READ_CHUNK = 64 * 1024;
/** A line longer than this (never written here) is dropped on reading rather than held whole. */
const LINE_MAX = 1024 * 1024;

/** `r` as a line of the work file (with its line feed). */
export function slimsReportLine(r: SlimsReportRow): string {
  const detail = typeof r.detail === 'string' ? r.detail : String(r.detail);
  return `${JSON.stringify([String(r.table), r.legacyKey === null ? '' : String(r.legacyKey), String(r.code), detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) : detail])}\n`;
}

/** ENOSPC/EDQUOT of a report write as DISK_QUOTA (P21: the caller of openAppend maps its writes' errors). */
function quota(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  if (code !== 'ENOSPC' && code !== 'EDQUOT') return error;
  return new DomainError('DISK_QUOTA', {
    detail: 'Ruang disk atau kuota hosting habis saat menulis laporan migrasi / The disk or hosting quota ran out while writing the migration report',
    meta: { reason: 'write', code },
    cause: error,
  });
}

/**
 * Appends `lines` (from slimsReportLine) to the run's work file, creating it and its folder when missing, and flushes
 * it. An append that fails is cut back off, so the file holds whole lines only.
 *
 * @returns the file's length afterwards
 * @throws DomainError `DISK_QUOTA` (P21) when the open, a write or the fsync finds the disk full or the quota used up
 */
export async function appendSlimsReport(dataDir: string, runId: string, lines: readonly string[]): Promise<number> {
  const p = runWorkPath(dataDir, runId, 'report.csv');
  const handle = await openAppend(p);
  let before: number | undefined;
  try {
    before = (await handle.stat()).size;
    if (lines.length > 0) {
      const bytes = Buffer.from(lines.join(''), 'utf8');
      let written = 0;
      while (written < bytes.byteLength) {
        const r = await handle.write(bytes, written, bytes.byteLength - written);
        written += r.bytesWritten;
      }
      await handle.sync();
    }
    return (await handle.stat()).size;
  } catch (error) {
    if (before !== undefined) await handle.truncate(before).catch(() => undefined);
    throw quota(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Cuts the run's work file back to `bytes` (what the summary's counters cover).
 *
 * @returns false when the file is shorter than that (its folder was lost): the run cannot go on
 */
export async function truncateSlimsReport(dataDir: string, runId: string, bytes: number): Promise<boolean> {
  const p = runWorkPath(dataDir, runId, 'report.csv');
  const info = await statOrNull(p);
  if (info === null) return bytes === 0;
  if (info.kind !== 'file' || info.size < bytes) return false;
  if (info.size > bytes) await truncateFile(p, bytes);
  return true;
}

/** `line` as a report row's cells, or null when it is not one. */
function cellsOf(line: string): string[] | null {
  if (line === '') return null;
  try {
    const v: unknown = JSON.parse(line);
    return Array.isArray(v) && v.length === 4 && v.every((c) => typeof c === 'string') ? (v as string[]) : null;
  } catch {
    return null;
  }
}

/** The rows of the run's work file, in order (none when it does not exist). */
export async function* slimsReportRows(dataDir: string, runId: string): AsyncGenerator<string[]> {
  const p = runWorkPath(dataDir, runId, 'report.csv');
  if ((await statOrNull(p))?.kind !== 'file') return;
  const handle = await openRead(p);
  try {
    const buffer = Buffer.alloc(READ_CHUNK);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let dropping = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
      if (bytesRead === 0) break;
      let start = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        const piece = buffer.subarray(start, i);
        start = i + 1;
        if (!dropping) {
          const cells = cellsOf(Buffer.concat([...pending, piece]).toString('utf8'));
          if (cells !== null) yield cells;
        }
        pending = [];
        pendingBytes = 0;
        dropping = false;
      }
      if (start < bytesRead && !dropping) {
        pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
        pendingBytes += bytesRead - start;
        if (pendingBytes > LINE_MAX) {
          pending = [];
          pendingBytes = 0;
          dropping = true;
        }
      }
    }
    if (!dropping && pending.length > 0) {
      const cells = cellsOf(Buffer.concat(pending).toString('utf8'));
      if (cells !== null) yield cells;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `name=value` pairs joined for a detail cell. */
function pairs(values: Readonly<Record<string, string | number | boolean>>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('; ');
}

/**
 * The framework's own rows of the final report, before the stages' rows (so a report cut at 10 000 rows keeps them):
 * the run, the reconciliation per table, the rows per target table before and after (M13), the random check sample
 * with each record's admin URL (§11.6), the text repairs and the character-set picture per column, and the two fixed
 * notes: the old SLiMS OAI identifiers are not served (§9.9), and the tables of the Members and Circulation modules are not
 * read (the separate aggregate usage import reads some of their columns, without migrating them). The run row names the
 * catalogue mode, and a sync dry run's count of catalogue changes.
 */
export function slimsSummaryRows(o: {
  summary: MigrationSummary;
  settings: SlimsRunSettings;
  dryRun: boolean;
  status: string;
  /** config.json's baseUrl (P13): the record links. */
  baseUrl: string;
  /** The SLiMS title of each checked `biblio` row, by its id (cut). */
  checkSource: Readonly<Record<string, string>>;
}): string[][] {
  const s = o.summary;
  const base = o.baseUrl.replace(/\/+$/, '');
  const rows: string[][] = [
    [
      '',
      '',
      'run',
      pairs({
        status: o.status,
        dryRun: o.dryRun,
        source: o.settings.sourceKind,
        sourceName: o.settings.sourceName,
        version: s.version ?? 'unknown',
        priceMode: o.settings.priceMode,
        adoptedFrom: o.settings.adoptedFrom ?? '-',
        catalogMode: o.settings.catalogMode ?? 'append',
        skipCatalog: o.settings.skipCatalog ?? false,
        ...(s.catalogChanges === undefined ? {} : { catalogChanges: s.catalogChanges }),
        // ---- Komunitas (SLiMS members and circulation) ----
        membersMode: o.settings.people?.membersMode ?? 'append',
        circulationMode: o.settings.people?.circulationMode ?? 'append',
        staffUsers: o.settings.people?.staffUsers ?? true,
        ...(s.memberNoCollisions === undefined ? {} : { memberNoCollisions: s.memberNoCollisions }),
      }),
    ],
  ];
  for (const r of s.reconciliation?.tables ?? []) {
    const reasons = Object.hasOwn(s.tables, r.table) ? s.tables[r.table]!.skipped : {};
    const skipped = Object.entries(reasons)
      .map(([reason, n]) => `${reason}:${n}`)
      .join(',');
    rows.push([
      r.table,
      '',
      r.unread ? 'unread_table' : r.diff === 0 ? 'reconcile' : 'reconcile_diff',
      pairs({
        source: r.source,
        migrated: r.migrated,
        merged: r.merged,
        skipped: skipped === '' ? r.skipped : `${r.skipped} (${skipped})`,
        archived: r.archived,
        diff: r.diff,
      }),
    ]);
  }
  for (const t of s.targets) rows.push([t.table, '', 'target_count', pairs({ before: t.before, after: t.after, added: t.after - t.before })]);
  for (const c of s.checks) {
    rows.push([
      'biblio',
      c.legacyId,
      'check_sample',
      pairs({
        url: `${base}/admin/catalog/records/${c.recordId}`,
        slims: Object.hasOwn(o.checkSource, c.legacyId) ? o.checkSource[c.legacyId]! : '-',
        altis: c.title,
        match: c.matches ? 'yes' : 'no',
      }),
    ]);
  }
  for (const [column, kinds] of Object.entries(s.fixes)) rows.push([column.split('.')[0] ?? '', '', 'text_fix', `${column}: ${pairs(kinds)}`]);
  for (const c of s.charset) {
    const counts = pairs({ rows: c.rows, ascii: c.ascii, utf8: c.utf8, cp1252: c.cp1252, mojibake: c.mojibake });
    rows.push([c.column.split('.')[0] ?? '', '', 'charset', `${c.column}: ${counts}`]);
  }
  // ---- Komunitas (SLiMS members and circulation): "Cocokkan dengan SLiMS" ----
  for (const m of s.matches ?? []) {
    rows.push(['', m.scope, m.ok ? 'match' : 'match_diff', `${m.key}: ${pairs({ source: m.source, altis: m.altis, explained: m.explained })}`]);
  }
  for (const t of s.memberTypes ?? []) rows.push(['mst_member_type', t.id, 'member_type_group', pairs({ group: t.group, members: t.members })]);
  for (const d of s.dryLists ?? []) rows.push(['', d.key, 'dry_list', `count=${d.count}; samples=${d.samples.join(', ')}`]);
  rows.push([
    '',
    '',
    'oai_identifiers_changed',
    'Pengenal OAI SLiMS lama tidak dilayani; aplikasi pemanen data perlu memanen ulang / ' +
      'The old SLiMS OAI identifiers are not served; harvesters must harvest again',
  ]);
  // The member and circulation tables are read now: the row names the ones of those modules the run still did not read.
  const unread = s.unread.filter((t) => slimsUnreadKind(t) === 'phase3');
  rows.push([
    '',
    '',
    'phase3_tables',
    unread.length === 0
      ? 'Tabel modul Anggota dan Sirkulasi dibaca semua / Every table of the Members and Circulation modules is read'
      : `Tidak dibaca (modul Anggota/Sirkulasi) / Not read (Members/Circulation module): ${unread.join(', ')}`,
  ]);
  return rows;
}
