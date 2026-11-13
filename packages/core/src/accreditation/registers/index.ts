// The five registers of the library (spec §3.2, §10.6): activities, staff with their trainings, partnerships, budgets
// and documents. Each register's list, create, update (optimistic `version`) and soft archive dispatch to its own
// module; the shared rules (row lock, trail, audit with field names only, the files claimed from the
// `accreditation.evidence` uploads) live in common.ts and claims.ts. The registers are the library's administration:
// they stay editable while a period is frozen.
import type { DB } from '@altis/db';
import type {
  ActivityBody,
  ActivityPatchBody,
  ActivityView,
  BudgetBody,
  BudgetPatchBody,
  BudgetView,
  DocumentBody,
  DocumentPatchBody,
  DocumentView,
  PartnershipBody,
  PartnershipPatchBody,
  PartnershipView,
  RegisterKind,
  StaffBody,
  StaffPatchBody,
  StaffView,
  TrainingBody,
  TrainingPatchBody,
} from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely } from 'kysely';
import type { TxCtx } from '../../context.js';
import { archiveActivity, createActivity, listActivities, updateActivity } from './activities.js';
import { archiveBudget, createBudget, listBudgets, updateBudget } from './budgets.js';
import { archiveDocument, createDocument, listDocuments, updateDocument } from './documents.js';
import { archivePartnership, createPartnership, listPartnerships, updatePartnership } from './partnerships.js';
import { archiveStaff, createStaff, listStaff, updateStaff } from './staff.js';
import { archiveStaffTraining, createStaffTraining, updateStaffTraining } from './trainings.js';

export { ACCRED_UPLOAD_CONTEXT, claimUpload, releaseUpload, replaceUpload } from './claims.js';
export type { AccredFileOwner, ClaimedUpload } from './claims.js';
export { REGISTER_TABLE } from './common.js';
export type { RegisterTable } from './common.js';

/** Each register's create body, patch body and view. */
export interface RegisterShapes {
  activities: { body: ActivityBody; patch: ActivityPatchBody; view: ActivityView };
  staff: { body: StaffBody; patch: StaffPatchBody; view: StaffView };
  partnerships: { body: PartnershipBody; patch: PartnershipPatchBody; view: PartnershipView };
  budgets: { body: BudgetBody; patch: BudgetPatchBody; view: BudgetView };
  documents: { body: DocumentBody; patch: DocumentPatchBody; view: DocumentView };
}

/** One register's services. */
interface RegisterModule<K extends RegisterKind> {
  list(db: Kysely<DB>): Promise<RegisterShapes[K]['view'][]>;
  create(tx: TxCtx, body: RegisterShapes[K]['body'], now: number): Promise<StoreResponse>;
  update(tx: TxCtx, id: string, patch: RegisterShapes[K]['patch'], now: number): Promise<StoreResponse>;
  archive(tx: TxCtx, id: string, now: number): Promise<StoreResponse>;
}

const MODULES: { readonly [K in RegisterKind]: RegisterModule<K> } = Object.freeze({
  activities: { list: listActivities, create: createActivity, update: updateActivity, archive: archiveActivity },
  staff: { list: listStaff, create: createStaff, update: updateStaff, archive: archiveStaff },
  partnerships: { list: listPartnerships, create: createPartnership, update: updatePartnership, archive: archivePartnership },
  budgets: { list: listBudgets, create: createBudget, update: updateBudget, archive: archiveBudget },
  documents: { list: listDocuments, create: createDocument, update: updateDocument, archive: archiveDocument },
});

/** The register `kind`'s module (a known kind; anything else is a programming error). */
function moduleOf<K extends RegisterKind>(kind: K): RegisterModule<K> {
  const m = (MODULES as unknown as Readonly<Record<string, RegisterModule<K> | undefined>>)[kind];
  if (m === undefined) throw new TypeError(`unknown register ${JSON.stringify(kind)}`);
  return m;
}

/** The live rows of a register (staff with their live trainings), in the register's own order. */
export async function listRegister<K extends RegisterKind>(db: Kysely<DB>, kind: K): Promise<{ rows: RegisterShapes[K]['view'][] }> {
  return { rows: await moduleOf(kind).list(db) };
}

/**
 * Records a row of register `kind` and audits `accreditation.register.create` (`entity` = its table).
 *
 * @throws DomainError VALIDATION_FAILED (the contract; a budget's `year` `taken`; a document's `aspectCodes.<i>`
 *   `invalid`; an upload field `not_found`)
 */
export async function createRegisterRow<K extends RegisterKind>(tx: TxCtx, kind: K, body: RegisterShapes[K]['body'], now: number): Promise<StoreResponse> {
  return moduleOf(kind).create(tx, body, now);
}

/**
 * Changes the fields `body` sends of row `id` of register `kind` (`body.version` is the row's) and audits
 * `accreditation.register.update` with the names of the changed fields.
 *
 * @throws DomainError NOT_FOUND (unknown or archived); CONFLICT_STALE; VALIDATION_FAILED
 */
export async function updateRegisterRow<K extends RegisterKind>(
  tx: TxCtx,
  kind: K,
  id: string,
  body: RegisterShapes[K]['patch'],
  now: number,
): Promise<StoreResponse> {
  return moduleOf(kind).update(tx, id, body, now);
}

/**
 * Archives row `id` of register `kind` (`archived_at`; a budget also frees its year) and audits
 * `accreditation.register.archive`.
 *
 * @throws DomainError NOT_FOUND (unknown or archived already)
 */
export async function archiveRegisterRow(tx: TxCtx, kind: RegisterKind, id: string, now: number): Promise<StoreResponse> {
  return moduleOf(kind).archive(tx, id, now);
}

/**
 * Adds a training to the live staff member `staffId` (audit `accreditation.register.create`, `entity`
 * `staff_trainings`).
 *
 * @throws DomainError NOT_FOUND (an unknown or archived staff member); VALIDATION_FAILED
 */
export async function createTraining(tx: TxCtx, staffId: string, body: TrainingBody, now: number): Promise<StoreResponse> {
  return createStaffTraining(tx, staffId, body, now);
}

/** Changes a training of a live staff member (`body.version` is the training's). */
export async function updateTraining(tx: TxCtx, id: string, body: TrainingPatchBody, now: number): Promise<StoreResponse> {
  return updateStaffTraining(tx, id, body, now);
}

/** Archives a training of a live staff member. */
export async function archiveTraining(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return archiveStaffTraining(tx, id, now);
}
