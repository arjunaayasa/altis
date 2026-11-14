import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import { TrainingBody, TrainingPatchBody, type TrainingView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { claimUpload, replaceUpload } from './claims.js';
import {
  auditRegister,
  changedFields,
  checkVersion,
  fileNames,
  givenFields,
  latestFirst,
  newTrail,
  newestIdFirst,
  parseBody,
  patchText,
  patchValue,
  registerNotFound,
  registerStale,
  textOrNull,
  writeRegisterRow,
  type Db,
} from './common.js';

// A staff member's trainings (the continuing professional development of spec §10.6): title, organizer, date, hours and
// a certificate file (an `accreditation.evidence` upload owned by the training, `owner_type 'staff_trainings'`). A
// training belongs to a live staff member: one on an unknown or archived staff member is NOT_FOUND, for every write.
// A new training first locks its staff member's row (a write that changes nothing), so it never lands on a person
// being archived at the same moment; an update or an archive locks the training's own row first, then its staff
// member's.

const TABLE = 'staff_trainings';

type Row = Selectable<DB['staff_trainings']>;

function toView(row: Row, names: ReadonlyMap<string, string>): TrainingView {
  return {
    id: row.id,
    staffId: row.library_staff_id,
    title: row.title,
    organizer: row.organizer,
    heldOn: row.held_on,
    hours: row.hours === null ? null : Number(row.hours),
    certificateFileId: row.certificate_file_id,
    certificateFileName: row.certificate_file_id === null ? null : (names.get(row.certificate_file_id) ?? null),
    version: Number(row.version),
  };
}

/** The live trainings of each of the staff members `staffIds` (at most 500), latest first. */
export async function listTrainingsOf(db: Db, staffIds: readonly string[]): Promise<Map<string, TrainingView[]>> {
  const out = new Map<string, TrainingView[]>();
  if (staffIds.length === 0) return out;
  const rows = await db.selectFrom(TABLE).selectAll().where('library_staff_id', 'in', [...staffIds]).where('archived_at', 'is', null).execute();
  const names = await fileNames(db, rows.map((r) => r.certificate_file_id));
  for (const view of rows.map((r) => toView(r, names)).sort((a, b) => latestFirst(a.heldOn, b.heldOn) || newestIdFirst(a, b))) {
    const list = out.get(view.staffId) ?? [];
    list.push(view);
    out.set(view.staffId, list);
  }
  return out;
}

/**
 * Locks the live staff member `staffId` (a write that changes nothing, which also tells whether it is live).
 *
 * @throws DomainError NOT_FOUND for an unknown or archived staff member
 */
async function lockLiveStaff(trx: Transaction<DB>, staffId: string): Promise<void> {
  const r = await trx
    .updateTable('library_staff')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', staffId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  // The drivers count matched rows, so a live row counts 1 although nothing changes.
  if (Number(r.numUpdatedRows) !== 1) throw registerNotFound('library_staff');
}

/**
 * Locks training `id` (a write that changes nothing, first), reads it, then locks its staff member; both must be live.
 * Answers the training's row.
 *
 * @throws DomainError NOT_FOUND for an unknown or archived training, or one of an archived staff member
 */
async function lockedTraining(trx: Transaction<DB>, id: string): Promise<Row> {
  await trx
    .updateTable(TABLE)
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
  const row = await trx.selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(TABLE);
  await lockLiveStaff(trx, row.library_staff_id);
  return row;
}

/**
 * Adds a training to the live staff member `staffId`, claiming its certificate upload when one is named.
 *
 * @throws DomainError NOT_FOUND (the staff member); VALIDATION_FAILED (the contract, or `certificateUploadId`
 *   `not_found`)
 */
export async function createStaffTraining(tx: TxCtx, staffId: string, input: TrainingBody, now: number): Promise<StoreResponse> {
  const body = parseBody(TrainingBody, input);
  const { trx } = tx;
  await lockLiveStaff(trx, staffId);
  const id = newId(now);
  const certificate =
    body.certificateUploadId === undefined || body.certificateUploadId === null
      ? null
      : (await claimUpload(trx, body.certificateUploadId, { ownerType: TABLE, ownerId: id })).fileId;
  await trx
    .insertInto(TABLE)
    .values({
      id,
      library_staff_id: staffId,
      title: body.title,
      organizer: textOrNull(body.organizer),
      held_on: body.heldOn,
      hours: body.hours ?? null,
      certificate_file_id: certificate,
      version: 0,
      ...newTrail(now, tx.actor.id),
    })
    .execute();
  await auditRegister(tx, 'accreditation.register.create', TABLE, id, givenFields(body));
  return { id, version: 0 };
}

/**
 * Changes the fields `patch` sends; a new `certificateUploadId` is claimed and the old certificate released, null
 * releases it.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED
 */
export async function updateStaffTraining(tx: TxCtx, id: string, input: TrainingPatchBody, now: number): Promise<StoreResponse> {
  const patch = parseBody(TrainingPatchBody, input);
  const { trx } = tx;
  const row = await lockedTraining(trx, id);
  checkVersion(TABLE, row, patch.version);
  const before = toView(row, new Map());
  const next = {
    title: patch.title,
    organizer: patchText(patch.organizer),
    heldOn: patch.heldOn,
    hours: patchValue(patch.hours),
  };
  const certificate = await replaceUpload(trx, row.certificate_file_id, patch.certificateUploadId, { ownerType: TABLE, ownerId: id });
  const set = { title: next.title, organizer: next.organizer, held_on: next.heldOn, hours: next.hours, certificate_file_id: certificate };
  const version = await writeRegisterRow(tx, TABLE, id, patch.version, set, now);
  const fields = changedFields(next, before);
  if (certificate !== undefined) fields.push('certificateUploadId');
  await auditRegister(tx, 'accreditation.register.update', TABLE, id, fields);
  return { id, version };
}

/**
 * Archives a training (its certificate stays with it).
 *
 * @throws DomainError NOT_FOUND
 */
export async function archiveStaffTraining(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  const { trx } = tx;
  const row = await lockedTraining(trx, id);
  const version = Number(row.version);
  const r = await trx
    .updateTable(TABLE)
    .set((eb) => ({ archived_at: now, updated_at: now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw registerStale(TABLE);
  await auditRegister(tx, 'accreditation.register.archive', TABLE, id, []);
  return { id, version: version + 1 };
}
