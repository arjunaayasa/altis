import type { DB } from '@altis/db';
import { DomainError, isDomainError, newId, type StocktakeSource, type StocktakeStatus } from '@altis/shared';
import type {
  StocktakeActionResponse,
  StocktakeCreateBody,
  StocktakeCreateResponse,
  StocktakeFinishBody,
  StocktakeJobResponse,
  StocktakeListResponse,
  StocktakeView,
} from '@altis/shared/api/stocktake';
import type { Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { takeStagedUpload, uploadOwner } from '../files/uploads.js';
import { enqueue } from '../jobs/enqueue.js';
import type { JobRegistry } from '../jobs/types.js';
import { activeSession, codesKeyPrefix, countsOf, finishKey, lockSession, parseScope, prepareKey, sessionNotFound, wrongState, type Db } from './common.js';

// Stocktake sessions of a branch (inventarisasi): create one (its copies are listed by the job `stocktake.prepare`),
// read them, cancel one, ask for its finish (the job `stocktake.finish`), and hand it a list of scanned codes (the job
// `stocktake.apply_codes`). One session per branch may be preparing, active or finishing: `active_key` holds the
// branch id while it is, under a UNIQUE index (409 STOCKTAKE_ACTIVE). Each action's first statement is the session's
// lock (a write that changes nothing and matches only in the right status), then the reads; an action in another
// status is 409 STOCKTAKE_STATE `{reason: <status>}`.

type StocktakeRow = Selectable<DB['stocktakes']>;

/** What enqueueing a stocktake job needs. */
export interface StocktakeJobDeps {
  registry: JobRegistry;
  keyring: readonly KeyringEntry[];
}

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Data tidak valid / The data is not valid', meta: { errors: [{ path, code }] } });
}

/** The ids of `ids` that are no live row of `table` (of `branchId` for locations). */
async function missingIds(trx: Transaction<DB>, table: 'locations' | 'collection_types' | 'material_types', ids: readonly string[], branchId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  let q = trx.selectFrom(table).select('id').where('id', 'in', [...ids]).where('archived_at', 'is', null);
  if (table === 'locations') q = q.where('branch_id' as never, '=', branchId as never);
  const found = new Set((await q.execute()).map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

/**
 * Creates a session of `branchId` with its scope, status `preparing`, and queues its preparation; audits
 * `stocktake.session.create`.
 *
 * @throws DomainError NOT_FOUND (the branch), STOCKTAKE_ACTIVE, VALIDATION_FAILED (`scope.locationIds`,
 *   `scope.collectionTypeIds`, `scope.materialTypeIds`: `not_found`)
 */
export async function createStocktake(tx: TxCtx, branchId: string, body: StocktakeCreateBody, deps: StocktakeJobDeps): Promise<StocktakeCreateResponse> {
  const { trx } = tx;
  const branch = await trx.selectFrom('branches').select('id').where('id', '=', branchId).where('archived_at', 'is', null).executeTakeFirst();
  if (branch === undefined) throw new DomainError('NOT_FOUND', { detail: 'Cabang tidak ditemukan / Branch not found' });
  const live = await trx.selectFrom('stocktakes').select('id').where('active_key', '=', branchId).executeTakeFirst();
  if (live !== undefined) throw activeSession(live.id);
  const scope = body.scope;
  const errors: { path: string; code: string }[] = [];
  if ((await missingIds(trx, 'locations', scope.locationIds ?? [], branchId)).length > 0) errors.push({ path: 'scope.locationIds', code: 'not_found' });
  if ((await missingIds(trx, 'collection_types', scope.collectionTypeIds ?? [], branchId)).length > 0) errors.push({ path: 'scope.collectionTypeIds', code: 'not_found' });
  if ((await missingIds(trx, 'material_types', scope.materialTypeIds ?? [], branchId)).length > 0) errors.push({ path: 'scope.materialTypeIds', code: 'not_found' });
  if (errors.length > 0) throw new DomainError('VALIDATION_FAILED', { detail: 'Cakupan tidak valid / The scope is not valid', meta: { errors } });

  const id = newId(tx.now);
  const stored = {
    ...(scope.locationIds?.length ? { locationIds: [...new Set(scope.locationIds)] } : {}),
    ...(scope.collectionTypeIds?.length ? { collectionTypeIds: [...new Set(scope.collectionTypeIds)] } : {}),
    ...(scope.materialTypeIds?.length ? { materialTypeIds: [...new Set(scope.materialTypeIds)] } : {}),
    ...(scope.classPrefixes?.length ? { classPrefixes: [...new Set(scope.classPrefixes)] } : {}),
  };
  try {
    await trx
      .insertInto('stocktakes')
      .values({
        id,
        branch_id: branchId,
        name: body.name,
        scope: JSON.stringify(stored),
        status: 'preparing',
        active_key: branchId,
        options: null,
        started_at: tx.now,
        started_by: tx.actor.id,
        finished_at: null,
        finished_by: null,
        minutes_file_id: null,
        report_file_id: null,
        source: 'altis',
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  } catch (error) {
    // Another desk created the branch's session after the check: its id is not visible in this snapshot.
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw activeSession('');
    throw error;
  }
  const job = await enqueue(
    trx,
    deps.registry,
    { type: 'stocktake.prepare', payload: { stocktakeId: id, after: null }, uniqueKey: prepareKey(id), createdBy: tx.actor.id },
    { now: tx.now, keyring: deps.keyring },
  );
  await tx.audit({ action: 'stocktake.session.create', entity: 'stocktakes', entityId: id, branchId, meta: { scope: Object.keys(stored).sort() } });
  return { id, version: 0, jobId: job.id };
}

/** The live preparation or finish job of each session of `ids`, and its code-list jobs still alive. */
async function liveJobs(db: Db, ids: readonly string[]): Promise<{ job: Map<string, string>; uploads: Map<string, number> }> {
  const job = new Map<string, string>();
  const uploads = new Map<string, number>();
  if (ids.length === 0) return { job, uploads };
  const keys = ids.flatMap((id) => [prepareKey(id), finishKey(id)]);
  for (const r of await db.selectFrom('jobs').select(['id', 'unique_key']).where('unique_key', 'in', keys).execute()) {
    const key = r.unique_key ?? '';
    job.set(key.slice(key.indexOf(':') + 1), r.id);
  }
  for (const id of ids) {
    const n = await db.selectFrom('jobs').select('id').where('unique_key', 'like', `${codesKeyPrefix(id)}%`).execute();
    if (n.length > 0) uploads.set(id, n.length);
  }
  return { job, uploads };
}

/** Whether a code list of the session `id` is still being applied. */
export async function pendingUploads(db: Db, id: string): Promise<number> {
  return (await liveJobs(db, [id])).uploads.get(id) ?? 0;
}

async function namesOf(db: Db, table: 'locations' | 'collection_types' | 'material_types', ids: readonly string[] | undefined): Promise<string[]> {
  if (ids === undefined || ids.length === 0) return [];
  if (table === 'locations') {
    const rows = await db.selectFrom('locations').select(['id', 'name']).where('id', 'in', [...ids]).execute();
    return rows.map((r) => r.name);
  }
  const rows = await db.selectFrom(table).select(['id', 'name_id']).where('id', 'in', [...ids]).execute();
  return rows.map((r) => r.name_id);
}

/** The views of `rows`, in their order. */
async function viewsOf(db: Db, rows: readonly StocktakeRow[]): Promise<StocktakeView[]> {
  if (rows.length === 0) return [];
  const branchIds = [...new Set(rows.map((r) => r.branch_id))];
  const branches = new Map(
    (await db.selectFrom('branches').select(['id', 'code_display', 'name']).where('id', 'in', branchIds).execute()).map((b) => [b.id, { id: b.id, code: b.code_display, name: b.name }]),
  );
  const staffIds = [...new Set(rows.flatMap((r) => [r.started_by, r.finished_by]).filter((s): s is string => s !== null))];
  const staff = new Map(
    staffIds.length === 0 ? [] : (await db.selectFrom('staff_users').select(['id', 'name']).where('id', 'in', staffIds).execute()).map((s) => [s.id, { id: s.id, name: s.name }]),
  );
  const { job, uploads } = await liveJobs(
    db,
    rows.filter((r) => r.status === 'preparing' || r.status === 'active' || r.status === 'finishing').map((r) => r.id),
  );
  const out: StocktakeView[] = [];
  for (const r of rows) {
    const scope = parseScope(r.scope);
    let options: StocktakeView['options'] = null;
    if (r.options !== null) {
      try {
        const o = JSON.parse(r.options) as { markMissing?: unknown; restoreFound?: unknown };
        options = { markMissing: o.markMissing === true, restoreFound: o.restoreFound === true };
      } catch {
        options = null;
      }
    }
    out.push({
      id: r.id,
      version: Number(r.version),
      branch: branches.get(r.branch_id) ?? { id: r.branch_id, code: '?', name: '?' },
      name: r.name,
      scope,
      scopeNames: {
        locations: await namesOf(db, 'locations', scope.locationIds),
        collectionTypes: await namesOf(db, 'collection_types', scope.collectionTypeIds),
        materialTypes: await namesOf(db, 'material_types', scope.materialTypeIds),
      },
      status: r.status as StocktakeStatus,
      source: r.source as StocktakeSource,
      counts: countsOf(r),
      startedAt: Number(r.started_at),
      startedBy: r.started_by === null ? null : (staff.get(r.started_by) ?? null),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
      finishedBy: r.finished_by === null ? null : (staff.get(r.finished_by) ?? null),
      options,
      jobId: job.get(r.id) ?? null,
      pendingUploads: uploads.get(r.id) ?? 0,
    });
  }
  return out;
}

/** The sessions of `branchId` (all when null), newest first (at most 200). */
export async function listStocktakes(db: Db, branchId: string | null): Promise<StocktakeListResponse> {
  let q = db.selectFrom('stocktakes').selectAll();
  if (branchId !== null) q = q.where('branch_id', '=', branchId);
  const rows = await q.orderBy('started_at', 'desc').orderBy('id', 'desc').limit(200).execute();
  return { items: await viewsOf(db, rows) };
}

/** The session `id` of `branchId`. @throws DomainError NOT_FOUND */
export async function getStocktake(db: Db, branchId: string, id: string): Promise<StocktakeView> {
  const row = await db.selectFrom('stocktakes').selectAll().where('id', '=', id).where('branch_id', '=', branchId).executeTakeFirst();
  if (row === undefined) throw sessionNotFound();
  return (await viewsOf(db, [row]))[0]!;
}

/**
 * Cancels the preparing or active session `id`: no copy changes, its rows stay. Audits `stocktake.session.cancel`.
 *
 * @throws DomainError NOT_FOUND, STOCKTAKE_STATE
 */
export async function cancelStocktake(tx: TxCtx, branchId: string, id: string): Promise<StocktakeActionResponse> {
  const { trx } = tx;
  const done = await trx
    .updateTable('stocktakes')
    .set((eb) => ({ status: 'cancelled', active_key: null, finished_at: tx.now, finished_by: tx.actor.id, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .where('status', 'in', ['preparing', 'active'])
    .executeTakeFirst();
  if (Number(done.numUpdatedRows) !== 1) {
    const row = await trx.selectFrom('stocktakes').select('status').where('id', '=', id).where('branch_id', '=', branchId).executeTakeFirst();
    if (row === undefined) throw sessionNotFound();
    throw wrongState(row.status as StocktakeStatus);
  }
  const row = await trx.selectFrom('stocktakes').select('version').where('id', '=', id).executeTakeFirstOrThrow();
  await tx.audit({ action: 'stocktake.session.cancel', entity: 'stocktakes', entityId: id, branchId, meta: {} });
  return { id, version: Number(row.version), status: 'cancelled' };
}

/**
 * Asks for the finish of the active session `id`: `confirmName` must be its name; refused while a code list is still
 * being applied. The session becomes `finishing` and the job `stocktake.finish` applies it. Audits
 * `stocktake.session.finish`.
 *
 * @throws DomainError NOT_FOUND, STOCKTAKE_STATE (`pending_uploads` too), VALIDATION_FAILED `{path: 'confirmName',
 *   code: 'mismatch'}`
 */
export async function finishStocktake(tx: TxCtx, branchId: string, id: string, body: StocktakeFinishBody, deps: StocktakeJobDeps): Promise<StocktakeJobResponse> {
  const { trx } = tx;
  await lockSession(trx, branchId, id, 'active');
  const row = await trx.selectFrom('stocktakes').select(['name']).where('id', '=', id).executeTakeFirstOrThrow();
  if (body.confirmName.trim() !== row.name.trim()) throw fieldError('confirmName', 'mismatch');
  if ((await pendingUploads(trx, id)) > 0) throw wrongState('pending_uploads');
  const options = { markMissing: body.markMissing, restoreFound: body.restoreFound };
  await trx
    .updateTable('stocktakes')
    .set((eb) => ({ status: 'finishing', options: JSON.stringify(options), finished_by: tx.actor.id, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .execute();
  const job = await enqueue(
    trx,
    deps.registry,
    { type: 'stocktake.finish', payload: { stocktakeId: id }, uniqueKey: finishKey(id), createdBy: tx.actor.id },
    { now: tx.now, keyring: deps.keyring },
  );
  await tx.audit({ action: 'stocktake.session.finish', entity: 'stocktakes', entityId: id, branchId, meta: { ...options } });
  return { id, jobId: job.id };
}

/**
 * Takes the staged code list `uploadId` of the actor for the active session `id` and queues its application (the
 * codes are scanned in the uploader's name, at `locationId` when given). Audits `stocktake.upload`.
 *
 * @throws DomainError NOT_FOUND, STOCKTAKE_STATE, VALIDATION_FAILED (`uploadId`, `locationId`: `not_found`)
 */
export async function uploadStocktakeCodes(
  tx: TxCtx,
  i: { branchId: string; id: string; uploadId: string; locationId?: string; dataDir: string },
  deps: StocktakeJobDeps,
): Promise<StocktakeJobResponse> {
  const { trx } = tx;
  await lockSession(trx, i.branchId, i.id, 'active');
  if (tx.actor.id === null) throw new DomainError('AUTH_REQUIRED');
  if (i.locationId !== undefined && (await missingIds(trx, 'locations', [i.locationId], i.branchId)).length > 0) throw fieldError('locationId', 'not_found');
  try {
    await takeStagedUpload(trx, { uploadId: i.uploadId, owner: uploadOwner(tx.actor.id), context: 'stocktake.codes', dataDir: i.dataDir });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') throw fieldError('uploadId', 'not_found');
    throw error;
  }
  const job = await enqueue(
    trx,
    deps.registry,
    {
      type: 'stocktake.apply_codes',
      payload: { stocktakeId: i.id, branchId: i.branchId, uploadId: i.uploadId, line: 0, locationId: i.locationId ?? null, by: tx.actor.id, applied: 0 },
      uniqueKey: `${codesKeyPrefix(i.id)}${i.uploadId}`,
      createdBy: tx.actor.id,
    },
    { now: tx.now, keyring: deps.keyring },
  );
  await tx.audit({ action: 'stocktake.upload', entity: 'stocktakes', entityId: i.id, branchId: i.branchId, meta: { located: i.locationId !== undefined } });
  return { id: i.id, jobId: job.id };
}
