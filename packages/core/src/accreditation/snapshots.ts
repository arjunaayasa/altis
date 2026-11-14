import type { AccredSnapshotsTable, DB } from '@altis/db';
import { uploadPath, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { CompactSnapshot, PrerequisitesView, SnapshotListResponse, SnapshotView } from '@altis/shared/api/accreditation';
import type { Kysely, Selectable } from 'kysely';
import type { ComposedResults } from './evaluate/compose.js';

// The snapshots of a period (spec §10.10): what a freeze kept of its results, in a compact form that no later change
// of the registers, the catalogue or the usage can alter, and the copy of the evidence file made for it.
//
// The compact values hold, per indicator (by catalogue code), its value, numerator and denominator, the final answer
// and how it came (`manual`, `override`, `computed` from the suggestion, or null when unanswered), the basis and the
// keys of the notes; per standard its outcome and value; the prerequisites; and the missing evidence items per
// component as `<indicator>.<item>`. No table, no report link and no fact is kept, so the JSON stays within 60 000
// bytes for the largest instrument.
//
// A snapshot belongs to a live period: an archived period's snapshots are not found. Its evidence file copy is a
// stored file of its own (context `accreditation.dossier`, owner `accred_snapshots`), never served by `/files/:id`: it is
// downloaded through the snapshot, after a fresh re-authentication (it names the staff).

type Db = Kysely<DB>;
type SnapshotRow = Selectable<AccredSnapshotsTable>;

/** The compact values of a snapshot are at most this many bytes of JSON. */
export const SNAPSHOT_VALUES_MAX_BYTES = 60_000;

/** The upload context of a snapshot's evidence file copy, and its owner type. */
export const SNAPSHOT_DOSSIER_CONTEXT = 'accreditation.dossier';
export const SNAPSHOT_DOSSIER_OWNER = 'accred_snapshots';

/** The compact values of `results`, whose prerequisites are `prerequisites`. */
export function compactSnapshot(results: ComposedResults, prerequisites: PrerequisitesView): CompactSnapshot {
  const i: CompactSnapshot['i'] = {};
  for (const ind of results.indicators) {
    const keys: string[] = [];
    for (const n of ind.notes) if (!keys.includes(n.key)) keys.push(n.key);
    i[ind.code] = {
      v: ind.value,
      n: ind.numerator,
      d: ind.denominator,
      a: ind.final,
      m: ind.answer !== null ? ind.answer.mode : ind.final !== null ? 'computed' : null,
      b: ind.basis,
      k: keys,
    };
  }
  const s: CompactSnapshot['s'] = {};
  for (const r of results.snp) s[r.code] = { o: r.outcome, v: r.value };
  const e: CompactSnapshot['e'] = {};
  for (const m of results.missingEvidence) e[m.component] = m.items.map((x) => `${x.indicatorCode}.${x.evidenceCode}`);
  return { i, s, p: prerequisites, e };
}

function snapshotNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Snapshot akreditasi tidak ditemukan / The accreditation snapshot was not found' });
}

function summaryOf(row: SnapshotRow): Omit<SnapshotView, 'values'> {
  return {
    id: row.id,
    periodId: row.period_id,
    instrumentId: row.instrument_id,
    na: row.na,
    naLow: row.na_low,
    naHigh: row.na_high,
    grade: row.grade as SnapshotView['grade'],
    prerequisitesMet: Number(row.prerequisites_met) === 1,
    dossierFileId: row.dossier_file_id,
    note: row.note,
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
  };
}

async function periodIsLive(db: Db, periodId: string): Promise<boolean> {
  const p = await db.selectFrom('accred_periods').select('archived_at').where('id', '=', periodId).executeTakeFirst();
  return p !== undefined && p.archived_at === null;
}

/**
 * The snapshots of the live period `periodId`, newest first, without their values.
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period
 */
export async function listSnapshots(db: Db, periodId: string): Promise<SnapshotListResponse> {
  if (!(await periodIsLive(db, periodId))) {
    throw new DomainError('NOT_FOUND', { detail: 'Periode akreditasi tidak ditemukan / The accreditation period was not found' });
  }
  const rows = await db.selectFrom('accred_snapshots').selectAll().where('period_id', '=', periodId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  return { snapshots: rows.map(summaryOf) };
}

/** The snapshot `id` of a live period, or null. */
async function liveSnapshot(db: Db, id: string): Promise<SnapshotRow | null> {
  const row = await db.selectFrom('accred_snapshots').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || !(await periodIsLive(db, row.period_id))) return null;
  return row;
}

/**
 * One snapshot with its frozen values.
 *
 * @throws DomainError `NOT_FOUND` for an unknown snapshot or one of an archived period
 */
export async function getSnapshot(db: Db, id: string): Promise<SnapshotView> {
  const row = await liveSnapshot(db, id);
  if (row === null) throw snapshotNotFound();
  return { ...summaryOf(row), values: JSON.parse(row.result_values) as CompactSnapshot };
}

/**
 * The evidence file copy of snapshot `id`, to download: where it is stored under `dataDir`, its recorded size, its
 * name and type.
 *
 * @throws DomainError `NOT_FOUND` for an unknown snapshot, one of an archived period, one without a copy, or a copy
 *   whose file row is not the snapshot's own complete one
 */
export async function openSnapshotDossier(
  db: Db,
  id: string,
  dataDir: string,
): Promise<{ path: DataPath; size: number; fileName: string; mime: string; snapshotId: string }> {
  const row = await liveSnapshot(db, id);
  if (row === null) throw snapshotNotFound();
  if (row.dossier_file_id === null) {
    throw new DomainError('NOT_FOUND', { detail: 'Snapshot ini tidak menyimpan berkas bukti / This snapshot keeps no evidence file' });
  }
  const file = await db
    .selectFrom('files')
    .select(['id', 'original_name', 'mime', 'size'])
    .where('id', '=', row.dossier_file_id)
    .where('context', '=', SNAPSHOT_DOSSIER_CONTEXT)
    .where('owner_type', '=', SNAPSHOT_DOSSIER_OWNER)
    .where('owner_id', '=', row.id)
    .where('status', '=', 'ok')
    .executeTakeFirst();
  if (file === undefined) throw new DomainError('NOT_FOUND', { detail: 'Berkas bukti snapshot tidak ditemukan / The snapshot evidence file was not found' });
  return { path: uploadPath(dataDir, file.id), size: Number(file.size), fileName: file.original_name, mime: file.mime, snapshotId: row.id };
}
