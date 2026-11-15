import { archiveEvidence, attachMinutesEvidence, can, createEvidence, listEvidence, listMinutesForEvidence, stocktakeBranchOf } from '@altis/core';
import { DomainError, EVIDENCE_ENTITIES } from '@altis/shared';
import { EvidenceCreateBody, EvidenceMinutesBody, type EvidenceMinutesListResponse } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The evidence files (spec §5.2, §10.6, §10.9):
//
//   GET    accreditation/evidence?periodId=&indicatorCode=   accreditation.workspace.read
//          (or ?entity=&entityId= for a register row's files): the files, and the size of each component's files of
//          the period (the dossier ZIP's components, against `accreditation.evidence.componentLimitMb`)
//   POST   accreditation/evidence        accreditation.workspace.manage   links an `accreditation.evidence` upload:
//          201 {id, version}; a period's evidence takes the period's lock first (409 ACCRED_PERIOD_FROZEN when frozen)
//   DELETE accreditation/evidence/:id    accreditation.workspace.manage   removes the row and releases its file
//
// Both writes are `store` routes, audited once (`accreditation.evidence.create|archive`).
//
// The stored minutes of a stocktake session as evidence (the indicators whose checklist has the minutes item):
//
//   GET    accreditation/evidence/stocktake-minutes    accreditation.workspace.manage   the finished sessions with
//          stored minutes, of the branches where the caller holds `stocktake.scan.use`
//   POST   accreditation/evidence/stocktake-minutes    accreditation.workspace.manage   EvidenceMinutesBody → 201
//          {id, version}; `stocktake.scan.use` at the session's branch too (a session of no such branch, or none at
//          all, is the field error `stocktakeId` `not_found`); audited `accreditation.evidence.create`

const API = '/api/v1/accreditation/evidence';
const IdParams = z.strictObject({ id: ulidField });

/** `GET accreditation/evidence`: a period (optionally one indicator), or a register row; at least one of them. */
const EvidenceListQuery = z
  .strictObject({
    periodId: ulidField.optional(),
    indicatorCode: z.string().min(1).max(16).optional(),
    entity: z.enum(EVIDENCE_ENTITIES).optional(),
    entityId: ulidField.optional(),
  })
  .check((ctx) => {
    const v = ctx.value;
    const required = (path: string): void => {
      ctx.issues.push({ code: 'custom', path: [path], params: { code: 'required' }, message: 'required', input: undefined });
    };
    if (v.periodId === undefined && v.entity === undefined) required('periodId');
    if ((v.entity === undefined) !== (v.entityId === undefined)) required(v.entity === undefined ? 'entity' : 'entityId');
  });

const evidenceList = route({
  id: 'accreditation.evidence.list',
  method: 'GET',
  path: API,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  query: EvidenceListQuery,
  handler: async (rc) => ({ body: await listEvidence(rc.db.db, rc.query) }),
});

const evidenceCreate = route({
  id: 'accreditation.evidence.create',
  method: 'POST',
  path: API,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.evidence.create',
  body: EvidenceCreateBody,
  handler: async (rc) => {
    const body: StoreResponse = await createEvidence(rc.tx(), rc.body, rc.now);
    return { status: 201, body };
  },
});

const evidenceArchive = route({
  id: 'accreditation.evidence.archive',
  method: 'DELETE',
  path: `${API}/:id`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.evidence.archive',
  params: IdParams,
  handler: async (rc) => {
    const body: StoreResponse = await archiveEvidence(rc.tx(), rc.params.id, rc.now);
    return { body };
  },
});

// ---- the stocktake minutes as evidence ----
const MINUTES_API = `${API}/stocktake-minutes`;

const minutesList = route({
  id: 'accreditation.evidence.minutes_list',
  method: 'GET',
  path: MINUTES_API,
  permission: 'accreditation.workspace.manage',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const grants = rc.auth?.grants;
    const body: EvidenceMinutesListResponse = await listMinutesForEvidence(rc.db.db, (branchId) => grants !== undefined && can(grants, 'stocktake.scan.use', branchId));
    return { body };
  },
});

const minutesAttach = route({
  id: 'accreditation.evidence.minutes_attach',
  method: 'POST',
  path: MINUTES_API,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.evidence.create',
  body: EvidenceMinutesBody,
  // The session's minutes are branch data: whoever links them must read that branch's stocktake. A session of a branch
  // the caller may not read is answered as one that does not exist.
  prepare: async (rc) => {
    const branchId = await stocktakeBranchOf(rc.db.db, rc.body.stocktakeId);
    if (branchId === null || rc.auth === null || !can(rc.auth.grants, 'stocktake.scan.use', branchId)) {
      throw new DomainError('VALIDATION_FAILED', { detail: 'Data belum benar / The data is not valid', meta: { errors: [{ path: 'stocktakeId', code: 'not_found' }] } });
    }
    return branchId;
  },
  handler: async (rc) => {
    const body: StoreResponse = await attachMinutesEvidence(rc.tx(), rc.body, rc.now);
    return { status: 201, body };
  },
});

export const EVIDENCE_ROUTES: RouteDecl[] = [evidenceList, evidenceCreate, evidenceArchive, minutesList, minutesAttach];
