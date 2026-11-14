import type { AccredSnapshotsTable, DB } from '@altis/db';
import { uploadPath, type DataPath } from '@altis/platform';
import { DomainError, isUlid } from '@altis/shared';
import type { CompactSnapshot, PrerequisitesView, SnapshotListResponse, SnapshotView } from '@altis/shared/api/accreditation';
import type { Kysely, Selectable } from 'kysely';
import type { CoreLogger } from '../context.js';
import { errorFields } from '../context.js';
import type { StorageDriver } from '../files/serve.js';
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
//
// The copy writes its `files` row first, with status `missing` (its content is not stored yet), then stores the
// content, then in one transaction names it on the snapshot and marks the row `ok` (freeze.ts). A copy killed on the
// way thus leaves a row no snapshot names, never stored content without a row; the reports housekeeping removes such
// a copy (its content, then its row) once it is a day old (sweepUnfinishedSnapshotCopies).

type Db = Kysely<DB>;
type SnapshotRow = Selectable<AccredSnapshotsTable>;

/** The compact values of a snapshot are at most this many bytes of JSON. */
export const SNAPSHOT_VALUES_MAX_BYTES = 60_000;

/** The upload context of a snapshot's evidence file copy, and its owner type. */
export const SNAPSHOT_DOSSIER_CONTEXT = 'accreditation.dossier';
export const SNAPSHOT_DOSSIER_OWNER = 'accred_snapshots';

/** The status of a copy's row until its content is stored and the snapshot names it. */
export const SNAPSHOT_COPY_UNFINISHED = 'missing';
/** An unfinished copy no snapshot names is removed once it is this old (a copy takes seconds). */
export const SNAPSHOT_COPY_ABANDONED_MS = 24 * 3_600_000;
/** Rows per batch of the sweep. */
const COPY_SWEEP_BATCH = 200;

/**
 * Removes the copy `fileId` that its call did not finish: its stored content, then its row. A row no longer
 * unfinished, or one a snapshot names, is left as it is. Answers whether it removed the copy.
 */
export async function removeUnfinishedCopy(db: Db, storage: StorageDriver, fileId: string): Promise<boolean> {
  const named = await db.selectFrom('accred_snapshots').select('id').where('dossier_file_id', '=', fileId).executeTakeFirst();
  if (named !== undefined) return false;
  const row = await db.selectFrom('files').select('status').where('id', '=', fileId).where('context', '=', SNAPSHOT_DOSSIER_CONTEXT).executeTakeFirst();
  if (row !== undefined && row.status !== SNAPSHOT_COPY_UNFINISHED) return false;
  await storage.delete(fileId);
  await db.deleteFrom('files').where('id', '=', fileId).where('context', '=', SNAPSHOT_DOSSIER_CONTEXT).where('status', '=', SNAPSHOT_COPY_UNFINISHED).execute();
  return true;
}

/**
 * The evidence file copies a killed copy left unfinished (status `missing`, named by no snapshot) that are older than
 * {@link SNAPSHOT_COPY_ABANDONED_MS} at `now`: their stored content is removed, then their row. One that cannot be
 * removed is logged and tried again by the next run. Answers how many it removed.
 */
export async function sweepUnfinishedSnapshotCopies(db: Db, o: { storage: StorageDriver; now: number; log: CoreLogger }): Promise<number> {
  const cutoff = o.now - SNAPSHOT_COPY_ABANDONED_MS;
  let removed = 0;
  let after: string | null = null;
  for (;;) {
    let q = db
      .selectFrom('files')
      .select('id')
      .where('context', '=', SNAPSHOT_DOSSIER_CONTEXT)
      .where('status', '=', SNAPSHOT_COPY_UNFINISHED)
      .where('created_at', '<', cutoff);
    if (after !== null) q = q.where('id', '>', after);
    const batch = (await q.orderBy('id').limit(COPY_SWEEP_BATCH).execute()).map((r) => r.id);
    for (const id of batch) {
      if (!isUlid(id)) continue;
      try {
        if (await removeUnfinishedCopy(db, o.storage, id)) removed += 1;
      } catch (error) {
        o.log.warn('accreditation snapshot: an unfinished evidence file copy could not be removed; the next run tries again', { fileId: id, ...errorFields(error) });
      }
    }
    if (batch.length < COPY_SWEEP_BATCH) return removed;
    after = batch[batch.length - 1]!;
  }
}

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
