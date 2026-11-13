import type { DB } from '@altis/db';
import { STAFF_ROLES, newId, type EducationLevel, type Employment, type StaffRole } from '@altis/shared';
import { StaffBody, StaffPatchBody, type StaffView, type TrainingView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import {
  ID_BATCH,
  archiveRegisterTableRow,
  auditRegister,
  changedFields,
  checkSpan,
  checkVersion,
  flag,
  givenFields,
  isFlag,
  lockRegisterRow,
  newTrail,
  parseBody,
  patchText,
  patchValue,
  registerNotFound,
  textOrNull,
  validationFailed,
  writeRegisterRow,
  type Db,
} from './common.js';
import { listTrainingsOf } from './trainings.js';

// The Staff register (spec §3.2, §10.6): the people who run the library, with their role, whether they are functional
// librarians, their education, training, certificate, association membership and appointment decree, and the span they
// serve. `name` and `appointment_ref` are personal data: they are answered to the workspace's readers only and never
// logged or audited by value. `staff_user_id` may link the person's ALTIS account (an existing staff user; no foreign
// key, the account is not owned). The list embeds each person's live trainings; archiving a person keeps their
// trainings with them (they leave the list together).

const TABLE = 'library_staff';

type Row = Selectable<DB['library_staff']>;

function toView(row: Row, trainings: TrainingView[]): StaffView {
  return {
    id: row.id,
    staffUserId: row.staff_user_id,
    name: row.name,
    position: row.position,
    role: row.role as StaffRole,
    isLibrarian: isFlag(row.is_librarian),
    employment: row.employment as Employment | null,
    educationLevel: row.education_level as EducationLevel | null,
    educationLibrary: isFlag(row.education_library),
    libraryTraining: isFlag(row.library_training),
    competencyCert: isFlag(row.competency_cert),
    associationMember: isFlag(row.association_member),
    appointmentRef: row.appointment_ref,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    trainings,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  };
}

const roleRank = (role: string): number => {
  const i = (STAFF_ROLES as readonly string[]).indexOf(role);
  return i < 0 ? STAFF_ROLES.length : i;
};

/** The live staff by role (head first), then name, each with their live trainings (latest first). */
export async function listStaff(db: Db): Promise<StaffView[]> {
  const rows = await db.selectFrom(TABLE).selectAll().where('archived_at', 'is', null).execute();
  const trainings = new Map<string, TrainingView[]>();
  for (let i = 0; i < rows.length; i += ID_BATCH) {
    for (const [staffId, list] of await listTrainingsOf(db, rows.slice(i, i + ID_BATCH).map((r) => r.id))) trainings.set(staffId, list);
  }
  return rows
    .map((r) => toView(r, trainings.get(r.id) ?? []))
    .sort(
      (a, b) =>
        roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** Checks that `staffUserId` names an existing staff account. */
async function checkStaffUser(trx: Transaction<DB>, staffUserId: string | null | undefined): Promise<void> {
  if (staffUserId === null || staffUserId === undefined) return;
  const user = await trx.selectFrom('staff_users').select('id').where('id', '=', staffUserId).executeTakeFirst();
  if (user === undefined) throw validationFailed([{ path: 'staffUserId', code: 'not_found' }]);
}

/** Records a staff member. */
export async function createStaff(tx: TxCtx, input: StaffBody, now: number): Promise<StoreResponse> {
  const body = parseBody(StaffBody, input);
  checkSpan(body.startsOn, body.endsOn, 'endsOn');
  await checkStaffUser(tx.trx, body.staffUserId);
  const id = newId(now);
  await tx.trx
    .insertInto(TABLE)
    .values({
      id,
      branch_id: null,
      staff_user_id: body.staffUserId ?? null,
      name: body.name,
      position: textOrNull(body.position),
      role: body.role,
      is_librarian: flag(body.isLibrarian),
      employment: body.employment ?? null,
      education_level: body.educationLevel ?? null,
      education_library: flag(body.educationLibrary),
      library_training: flag(body.libraryTraining),
      competency_cert: flag(body.competencyCert),
      association_member: flag(body.associationMember),
      appointment_ref: textOrNull(body.appointmentRef),
      starts_on: body.startsOn,
      ends_on: body.endsOn ?? null,
      version: 0,
      ...newTrail(now, tx.actor.id),
    })
    .execute();
  await auditRegister(tx, 'accreditation.register.create', TABLE, id, givenFields(body));
  return { id, version: 0 };
}

/** Changes the fields `patch` sends (null or a blank text clears an optional one). */
export async function updateStaff(tx: TxCtx, id: string, input: StaffPatchBody, now: number): Promise<StoreResponse> {
  const patch = parseBody(StaffPatchBody, input);
  const { trx } = tx;
  await lockRegisterRow(trx, TABLE, id);
  const row = await trx.selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(TABLE);
  checkVersion(TABLE, row, patch.version);
  const before = toView(row, []);
  const next = {
    staffUserId: patchValue(patch.staffUserId),
    name: patch.name,
    position: patchText(patch.position),
    role: patch.role,
    isLibrarian: patch.isLibrarian,
    employment: patchValue(patch.employment),
    educationLevel: patchValue(patch.educationLevel),
    educationLibrary: patch.educationLibrary,
    libraryTraining: patch.libraryTraining,
    competencyCert: patch.competencyCert,
    associationMember: patch.associationMember,
    appointmentRef: patchText(patch.appointmentRef),
    startsOn: patch.startsOn,
    endsOn: patchValue(patch.endsOn),
  };
  checkSpan(next.startsOn ?? before.startsOn, next.endsOn === undefined ? before.endsOn : next.endsOn, 'endsOn');
  if (next.staffUserId !== before.staffUserId) await checkStaffUser(trx, next.staffUserId);
  const asFlag = (b: boolean | undefined): number | undefined => (b === undefined ? undefined : flag(b));
  const set = {
    staff_user_id: next.staffUserId,
    name: next.name,
    position: next.position,
    role: next.role,
    is_librarian: asFlag(next.isLibrarian),
    employment: next.employment,
    education_level: next.educationLevel,
    education_library: asFlag(next.educationLibrary),
    library_training: asFlag(next.libraryTraining),
    competency_cert: asFlag(next.competencyCert),
    association_member: asFlag(next.associationMember),
    appointment_ref: next.appointmentRef,
    starts_on: next.startsOn,
    ends_on: next.endsOn,
  };
  const version = await writeRegisterRow(tx, TABLE, id, patch.version, set, now);
  await auditRegister(tx, 'accreditation.register.update', TABLE, id, changedFields(next, before));
  return { id, version };
}

/** Archives a staff member (their trainings leave the list with them). */
export function archiveStaff(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return archiveRegisterTableRow(tx, TABLE, id, now);
}
