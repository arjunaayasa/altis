import { archiveEvidence, createEvidence, listEvidence } from '@altis/core';
import { EVIDENCE_ENTITIES } from '@altis/shared';
import { EvidenceCreateBody } from '@altis/shared/api/accreditation';
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

export const EVIDENCE_ROUTES: RouteDecl[] = [evidenceList, evidenceCreate, evidenceArchive];
