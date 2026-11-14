import { createHash } from 'node:crypto';
import { withTx, type DbHandle } from '@altis/db';
import { openRead, reportExportPath, statOrNull, type DataPath } from '@altis/platform';
import { DomainError, localDate, newId, t, type MessageKey } from '@altis/shared';
import { FreezeBody } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { StoredRunParams } from '@altis/shared/api/reports';
import type { CoreLogger, TxCtx } from '../context.js';
import { errorFields } from '../context.js';
import { safeFileName, type StorageDriver } from '../files/serve.js';
import { reportById } from '../reports/registry.js';
import { loadAccredSettings } from '../settings/accreditation.js';
import { composeResults } from './evaluate/compose.js';
import { readMeta, readStoredResults } from './evaluate/results.js';
import { instrumentById } from './instruments/index.js';
import { parsePeriodBody, periodNotFound } from './periods/errors.js';
import { lastChangeOf } from './periods/last-change.js';
import {
  compactSnapshot,
  removeUnfinishedCopy,
  SNAPSHOT_COPY_UNFINISHED,
  SNAPSHOT_DOSSIER_CONTEXT,
  SNAPSHOT_DOSSIER_OWNER,
  SNAPSHOT_VALUES_MAX_BYTES,
} from './snapshots.js';

// Freezing a period and opening it again (spec §10.10).
//
// - Freeze: the first statement is the conditional update of the period row (`status = 'open'` → `'frozen'`, the
//   version moved on), so a write of the period's data that read it open either committed before (and the freeze
//   reads it) or now finds it frozen; 0 rows is an unknown or archived period (404) or a frozen one (409
//   ACCRED_PERIOD_FROZEN). Then the results must be fresh: an evaluation that finished (`_meta` ready) and started
//   after the period's last change (a change at the very same millisecond counts as later); otherwise, and when the
//   results are gone (a restore empties them), 409 ACCRED_RESULTS_STALE `{computedAt, changedAt}` and the transaction
//   rolls back. The snapshot keeps the compact values (snapshots.ts) with the estimate, its range, the predicate and
//   whether the prerequisites are met. Audited `accreditation.period.freeze {snapshotId, hasNote}` (never the note).
// - After the COMMIT (copySnapshotDossier): the newest evidence file PDF of the whole dossier (never a request letter
//   alone) of this period whose run was started once the results were ready and succeeded before the freeze is copied
//   into the stored files and named on the snapshot. A run started earlier may have printed older results (or results
//   half rewritten by the evaluation) or annex rows gathered before the last change, so it is never kept; a run started
//   after it read what the snapshot holds (any change since would have made the results stale). The copy's `files`
//   row is written first (unfinished), then its content, then the snapshot names it and the row is marked complete in
//   one transaction, so a copy killed on the way leaves a row the reports housekeeping removes with its content
//   (snapshots.ts), never content without a row. A copy that fails leaves the snapshot without one, and is logged.
// - Unfreeze: the first statement is the conditional update `'frozen'` → `'open'`; 0 rows is an unknown period (404)
//   or one that is open (409 CONFLICT_STALE). The snapshots stay as the period's history. Audited
//   `accreditation.period.unfreeze`. The route asks for a fresh re-authentication.

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** 409 ACCRED_RESULTS_STALE: the results are missing, unfinished, or older than the last change. */
function resultsStale(computedAt: number | null, changedAt: number | null): DomainError {
  return new DomainError('ACCRED_RESULTS_STALE', {
    detail:
      'Hasil perhitungan belum ada atau sudah basi; hitung ulang dulu sebelum membekukan / ' +
      'The results are missing or stale; compute them again before freezing',
    meta: { computedAt, changedAt },
  });
}

function periodFrozen(): DomainError {
  return new DomainError('ACCRED_PERIOD_FROZEN', {
    detail: 'Periode ini sudah dibekukan / This period is already frozen',
  });
}

/**
 * Freezes the open period `periodId` whose results are fresh, and keeps its snapshot (see the top of this file).
 * Answers `{id: <snapshot id>, version: <the period's new version>}`.
 *
 * @throws DomainError `NOT_FOUND`, `ACCRED_PERIOD_FROZEN`, `ACCRED_RESULTS_STALE {computedAt, changedAt}`;
 *   `VALIDATION_FAILED` for a body the contract refuses
 * @throws TypeError when the compact values are over 60 000 bytes (they never are for the instruments of this build)
 */
export async function freezePeriod(tx: TxCtx, periodId: string, body: FreezeBody, now: number): Promise<StoreResponse> {
  const input = parsePeriodBody(FreezeBody, body);
  const { trx } = tx;
  const locked = await trx
    .updateTable('accred_periods')
    .set((eb) => ({ status: 'frozen', frozen_at: now, frozen_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', periodId)
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) !== 1) {
    const row = await trx.selectFrom('accred_periods').select(['status', 'archived_at']).where('id', '=', periodId).executeTakeFirst();
    if (row === undefined || row.archived_at !== null) throw periodNotFound();
    throw periodFrozen();
  }
  const period = await trx.selectFrom('accred_periods').select(['instrument_id', 'version']).where('id', '=', periodId).executeTakeFirstOrThrow();
  const stored = await readStoredResults(trx, periodId);
  const changedAt = await lastChangeOf(trx, periodId);
  const computedAt = stored.meta?.computedAt ?? null;
  if (stored.meta === null || stored.meta.status !== 'ready' || computedAt === null || (changedAt !== null && computedAt <= changedAt)) {
    throw resultsStale(computedAt, changedAt);
  }
  const instrument = instrumentById(period.instrument_id);
  if (instrument === null) throw resultsStale(computedAt, changedAt);
  const results = await composeResults(trx, periodId, instrument, stored.rows);
  const prerequisites = results.prerequisites ?? stored.meta.prerequisites ?? null;
  if (prerequisites === null) throw resultsStale(computedAt, changedAt);

  const values = JSON.stringify(compactSnapshot(results, prerequisites));
  if (bytes(values) > SNAPSHOT_VALUES_MAX_BYTES) {
    throw new TypeError(`the compact snapshot of period ${periodId} is ${bytes(values)} bytes, over ${SNAPSHOT_VALUES_MAX_BYTES}`);
  }
  const note = input.note === undefined || input.note === null || input.note.trim() === '' ? null : input.note;
  const score = results.score;
  const snapshotId = newId(now);
  await trx
    .insertInto('accred_snapshots')
    .values({
      id: snapshotId,
      period_id: periodId,
      instrument_id: period.instrument_id,
      result_values: values,
      na: score?.na ?? null,
      // An instrument without a score (the statistics mode) keeps no range.
      na_low: score?.naLow ?? '',
      na_high: score?.naHigh ?? '',
      grade: score?.grade ?? null,
      prerequisites_met: prerequisites.met ? 1 : 0,
      dossier_file_id: null,
      note,
      created_at: now,
      created_by: tx.actor.id,
    })
    .execute();
  await tx.audit({
    action: 'accreditation.period.freeze',
    entity: 'accred_periods',
    entityId: periodId,
    meta: { snapshotId, hasNote: note !== null },
  });
  return { id: snapshotId, version: Number(period.version) };
}

/**
 * Opens the frozen period `periodId` again; its snapshots stay. Answers `{id: periodId, version}`.
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period; `CONFLICT_STALE` for one that is open
 */
export async function unfreezePeriod(tx: TxCtx, periodId: string, now: number): Promise<StoreResponse> {
  void now;
  const { trx } = tx;
  const opened = await trx
    .updateTable('accred_periods')
    .set((eb) => ({ status: 'open', frozen_at: null, frozen_by: null, version: eb('version', '+', 1) }))
    .where('id', '=', periodId)
    .where('status', '=', 'frozen')
    .executeTakeFirst();
  if (Number(opened.numUpdatedRows) !== 1) {
    const row = await trx.selectFrom('accred_periods').select(['status', 'archived_at']).where('id', '=', periodId).executeTakeFirst();
    if (row === undefined || row.archived_at !== null) throw periodNotFound();
    throw new DomainError('CONFLICT_STALE', { detail: 'Periode ini tidak sedang dibekukan / This period is not frozen' });
  }
  const period = await trx.selectFrom('accred_periods').select('version').where('id', '=', periodId).executeTakeFirstOrThrow();
  await tx.audit({ action: 'accreditation.period.unfreeze', entity: 'accred_periods', entityId: periodId, meta: {} });
  return { id: periodId, version: Number(period.version) };
}

// ---- the evidence file copy ----------------------------------------------------------------------------------------

/** How much one read of the evidence file takes. */
const COPY_CHUNK_BYTES = 256 * 1024;

/** The content of `p`, `size` bytes, read piece by piece. */
async function* fileBytes(p: DataPath, size: number): AsyncIterable<Uint8Array> {
  const handle = await openRead(p);
  try {
    for (let at = 0; at < size; ) {
      const buffer = new Uint8Array(Math.min(COPY_CHUNK_BYTES, size - at));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

async function sha256Of(p: DataPath, size: number): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of fileBytes(p, size)) hash.update(part);
  return hash.digest('hex');
}

/** The run whose PDF a snapshot keeps: of `periodId`, whole, started at or after `readyAt` and succeeded by `frozenAt`. */
async function dossierRunOf(h: DbHandle, periodId: string, readyAt: number, frozenAt: number): Promise<{ id: string; size: number | null } | null> {
  const runs = await h.db
    .selectFrom('report_runs')
    .select(['id', 'params', 'output_size'])
    .where('report_id', '=', 'accreditation.dossier')
    .where('format', '=', 'pdf')
    .where('status', '=', 'succeeded')
    .where('created_at', '>=', readyAt)
    .where('finished_at', '<=', frozenAt)
    .orderBy('finished_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  for (const run of runs) {
    let parsed;
    try {
      parsed = StoredRunParams.safeParse(JSON.parse(run.params));
    } catch {
      continue;
    }
    if (!parsed.success || parsed.data.def['periodId'] !== periodId) continue;
    const part = parsed.data.def['part'];
    // The request letter alone is not the evidence file.
    if (part !== undefined && part !== 'all') continue;
    return { id: run.id, size: run.output_size === null ? null : Number(run.output_size) };
  }
  return null;
}

/**
 * After a freeze committed: copies the evidence file PDF the snapshot `snapshotId` keeps (see the top of this file)
 * into `o.storage` as a stored file of the snapshot and names it on the snapshot. Answers the file id, or null when
 * there is no such run or the copy failed (logged with codes only; the snapshot then keeps none). Never throws.
 */
export async function copySnapshotDossier(
  h: DbHandle,
  snapshotId: string,
  o: { dataDir: string; storage: StorageDriver; now: number; log: CoreLogger },
): Promise<string | null> {
  let stored: string | null = null;
  try {
    const snapshot = await h.db.selectFrom('accred_snapshots').select(['period_id', 'created_at', 'dossier_file_id']).where('id', '=', snapshotId).executeTakeFirst();
    if (snapshot === undefined) return null;
    if (snapshot.dossier_file_id !== null) return snapshot.dossier_file_id;
    const meta = await readMeta(h.db, snapshot.period_id);
    if (meta === null || meta.status !== 'ready' || meta.computedAt === undefined) return null;
    // The results were ready when the evaluation ended: its start plus its duration.
    const run = await dossierRunOf(h, snapshot.period_id, meta.computedAt + (meta.durationMs ?? 0), Number(snapshot.created_at));
    if (run === null) return null;

    const source = reportExportPath(o.dataDir, run.id, 'pdf');
    const info = await statOrNull(source);
    if (info === null || info.kind !== 'file' || (run.size !== null && run.size !== info.size)) {
      o.log.warn('accreditation snapshot: the evidence file of the run is gone', { snapshotId, runId: run.id });
      return null;
    }
    const sha256 = await sha256Of(source, info.size);
    const settings = await loadAccredSettings(h.db);
    const def = reportById('accreditation.dossier');
    const title = def === null ? 'Berkas bukti' : t('id', def.titleKey as MessageKey);
    const originalName = safeFileName(`${title}-${localDate(settings.timezone, Number(snapshot.created_at))}.pdf`);
    const fileId = newId(o.now);

    // The row first, unfinished: a copy killed after this point leaves a row the housekeeping finds.
    await withTx(h, (trx) =>
      trx
        .insertInto('files')
        .values({
          id: fileId,
          original_name: originalName,
          mime: 'application/pdf',
          size: info.size,
          sha256,
          context: SNAPSHOT_DOSSIER_CONTEXT,
          owner_type: SNAPSHOT_DOSSIER_OWNER,
          owner_id: snapshotId,
          access: 'staff',
          status: SNAPSHOT_COPY_UNFINISHED,
          created_at: o.now,
          created_by: null,
        })
        .execute(),
    );
    stored = fileId;
    await o.storage.put(fileId, fileBytes(source, info.size), { size: info.size, sha256 });

    const named = await withTx(h, async (trx) => {
      const r = await trx
        .updateTable('accred_snapshots')
        .set({ dossier_file_id: fileId })
        .where('id', '=', snapshotId)
        .where('dossier_file_id', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) return false;
      const f = await trx.updateTable('files').set({ status: 'ok' }).where('id', '=', fileId).where('status', '=', SNAPSHOT_COPY_UNFINISHED).executeTakeFirst();
      // The row went meanwhile (it never does within a copy's seconds): name nothing.
      if (Number(f.numUpdatedRows) !== 1) throw new Error('the evidence file copy row is gone');
      return true;
    });
    if (!named) {
      // Another copy named one first: this one is not needed.
      await removeUnfinishedCopy(h.db, o.storage, fileId);
      stored = null;
      const again = await h.db.selectFrom('accred_snapshots').select('dossier_file_id').where('id', '=', snapshotId).executeTakeFirst();
      return again?.dossier_file_id ?? null;
    }
    stored = null;
    return fileId;
  } catch (error) {
    o.log.warn('accreditation snapshot: the evidence file could not be copied', { snapshotId, ...errorFields(error) });
    if (stored !== null) await removeUnfinishedCopy(h.db, o.storage, stored).catch(() => undefined);
    return null;
  }
}
