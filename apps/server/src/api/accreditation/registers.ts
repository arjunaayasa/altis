import {
  archiveRegisterRow,
  archiveTraining,
  createRegisterRow,
  createTraining,
  listRegister,
  updateRegisterRow,
  updateTraining,
  type RegisterShapes,
} from '@altis/core';
import {
  ActivityBody,
  ActivityPatchBody,
  BudgetBody,
  BudgetPatchBody,
  DocumentBody,
  DocumentPatchBody,
  PartnershipBody,
  PartnershipPatchBody,
  REGISTER_KINDS,
  StaffBody,
  StaffPatchBody,
  TrainingBody,
  TrainingPatchBody,
  type RegisterKind,
} from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The registers of the library (spec §3.2, §5.2, §10.6): for each of `activities`, `staff`, `partnerships`, `budgets`
// and `documents`, four routes on a literal path (never a `:kind` segment, which would shadow `periods`, `evidence`, …):
//
//   GET    accreditation/<register>        accreditation.workspace.read     the live rows (staff with their trainings)
//   POST   accreditation/<register>        accreditation.workspace.manage   201 {id, version}
//   PATCH  accreditation/<register>/:id    accreditation.workspace.manage   {version, …} → {id, version}
//   DELETE accreditation/<register>/:id    accreditation.workspace.manage   archive → {id, version}
//
// and the trainings of a staff member: `POST accreditation/staff/:id/trainings`, `PATCH|DELETE
// accreditation/trainings/:id` (manage). Every write is a `store` route answering `{id, version}` only, audited once
// as `accreditation.register.create|update|archive` with `entity` = the row's table; a stale version is 409
// CONFLICT_STALE, a branch other than null 422 `branch_scope_not_available`. The registers stay editable while a period
// is frozen.

const API = '/api/v1/accreditation';
const IdParams = z.strictObject({ id: ulidField });

/** Each register's create and patch bodies. */
const BODIES: { readonly [K in RegisterKind]: { create: z.ZodType<RegisterShapes[K]['body']>; patch: z.ZodType<RegisterShapes[K]['patch']> } } = {
  activities: { create: ActivityBody, patch: ActivityPatchBody },
  staff: { create: StaffBody, patch: StaffPatchBody },
  partnerships: { create: PartnershipBody, patch: PartnershipPatchBody },
  budgets: { create: BudgetBody, patch: BudgetPatchBody },
  documents: { create: DocumentBody, patch: DocumentPatchBody },
};

/** The four routes of register `kind`: `accreditation.registers.<kind>.{list,create,update,archive}`. */
function registerRoutes<K extends RegisterKind>(kind: K): RouteDecl[] {
  const base = `${API}/${kind}`;
  const bodies = BODIES[kind];
  const list = route({
    id: `accreditation.registers.${kind}.list`,
    method: 'GET',
    path: base,
    permission: 'accreditation.workspace.read',
    idempotency: 'none',
    audit: null,
    handler: async (rc) => ({ body: await listRegister(rc.db.db, kind) }),
  });
  const create = route({
    id: `accreditation.registers.${kind}.create`,
    method: 'POST',
    path: base,
    permission: 'accreditation.workspace.manage',
    idempotency: 'store',
    audit: 'accreditation.register.create',
    body: bodies.create,
    handler: async (rc) => {
      const body: StoreResponse = await createRegisterRow(rc.tx(), kind, rc.body, rc.now);
      return { status: 201, body };
    },
  });
  const update = route({
    id: `accreditation.registers.${kind}.update`,
    method: 'PATCH',
    path: `${base}/:id`,
    permission: 'accreditation.workspace.manage',
    idempotency: 'store',
    audit: 'accreditation.register.update',
    params: IdParams,
    body: bodies.patch,
    handler: async (rc) => {
      const body: StoreResponse = await updateRegisterRow(rc.tx(), kind, rc.params.id, rc.body, rc.now);
      return { body };
    },
  });
  const archive = route({
    id: `accreditation.registers.${kind}.archive`,
    method: 'DELETE',
    path: `${base}/:id`,
    permission: 'accreditation.workspace.manage',
    idempotency: 'store',
    audit: 'accreditation.register.archive',
    params: IdParams,
    handler: async (rc) => {
      const body: StoreResponse = await archiveRegisterRow(rc.tx(), kind, rc.params.id, rc.now);
      return { body };
    },
  });
  return [list, create, update, archive];
}

const trainingsCreate = route({
  id: 'accreditation.trainings.create',
  method: 'POST',
  path: `${API}/staff/:id/trainings`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.register.create',
  params: IdParams,
  body: TrainingBody,
  handler: async (rc) => {
    const body: StoreResponse = await createTraining(rc.tx(), rc.params.id, rc.body, rc.now);
    return { status: 201, body };
  },
});

const trainingsUpdate = route({
  id: 'accreditation.trainings.update',
  method: 'PATCH',
  path: `${API}/trainings/:id`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.register.update',
  params: IdParams,
  body: TrainingPatchBody,
  handler: async (rc) => {
    const body: StoreResponse = await updateTraining(rc.tx(), rc.params.id, rc.body, rc.now);
    return { body };
  },
});

const trainingsArchive = route({
  id: 'accreditation.trainings.archive',
  method: 'DELETE',
  path: `${API}/trainings/:id`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.register.archive',
  params: IdParams,
  handler: async (rc) => {
    const body: StoreResponse = await archiveTraining(rc.tx(), rc.params.id, rc.now);
    return { body };
  },
});

export const REGISTER_ROUTES: RouteDecl[] = [...REGISTER_KINDS.flatMap((kind) => registerRoutes(kind)), trainingsCreate, trainingsUpdate, trainingsArchive];
