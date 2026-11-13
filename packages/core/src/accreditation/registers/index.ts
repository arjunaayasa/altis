// Stub: replaced by a later change in this milestone.
// The five registers of the library (activities, staff with their trainings, partnerships, budgets, documents): their
// lists and writers. The signatures are final; every body throws until the registers are written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
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

/** Each register's create body, patch body and view. */
export interface RegisterShapes {
  activities: { body: ActivityBody; patch: ActivityPatchBody; view: ActivityView };
  staff: { body: StaffBody; patch: StaffPatchBody; view: StaffView };
  partnerships: { body: PartnershipBody; patch: PartnershipPatchBody; view: PartnershipView };
  budgets: { body: BudgetBody; patch: BudgetPatchBody; view: BudgetView };
  documents: { body: DocumentBody; patch: DocumentPatchBody; view: DocumentView };
}

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** The live rows of a register (staff with their trainings). */
export async function listRegister<K extends RegisterKind>(db: Kysely<DB>, kind: K): Promise<{ rows: RegisterShapes[K]['view'][] }> {
  return notImplemented();
}

export async function createRegisterRow<K extends RegisterKind>(tx: TxCtx, kind: K, body: RegisterShapes[K]['body'], now: number): Promise<StoreResponse> {
  return notImplemented();
}

export async function updateRegisterRow<K extends RegisterKind>(
  tx: TxCtx,
  kind: K,
  id: string,
  body: RegisterShapes[K]['patch'],
  now: number,
): Promise<StoreResponse> {
  return notImplemented();
}

export async function archiveRegisterRow(tx: TxCtx, kind: RegisterKind, id: string, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** Adds a training to the staff member `staffId`. */
export async function createTraining(tx: TxCtx, staffId: string, body: TrainingBody, now: number): Promise<StoreResponse> {
  return notImplemented();
}

export async function updateTraining(tx: TxCtx, id: string, body: TrainingPatchBody, now: number): Promise<StoreResponse> {
  return notImplemented();
}

export async function archiveTraining(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return notImplemented();
}
