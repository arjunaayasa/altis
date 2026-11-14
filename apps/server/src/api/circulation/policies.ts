import { PolicyBody, PolicyListQuery, PolicyPatchBody } from '@altis/shared/api/circulation';
import { ulidField } from '@altis/shared/api/common';
import { ArchiveBody } from '@altis/shared/api/members';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';
import { notImplemented } from '../not-implemented.js';

// The loan rules (`circulation.policies.manage`, library-wide):
//
//   GET    circulation/policies       PolicyListQuery → PolicyListResponse
//   POST   circulation/policies       PolicyBody → 201 StoreResponse        circulation.policy.create
//   PATCH  circulation/policies/:id   PolicyPatchBody → StoreResponse      circulation.policy.update
//   DELETE circulation/policies/:id   ArchiveBody → StoreResponse          circulation.policy.archive
//
// A rule's dimensions form its `scope_key`; a second live rule for the same member type is the field error
// `{path: 'memberTypeId', code: 'taken'}`, a taken code `{path: 'code', code: 'taken'}`. Archiving renames the scope to
// `~<id>`, so the same member type can get a new rule.

const API = '/api/v1/circulation/policies';
const IdParams = z.strictObject({ id: ulidField });

const policiesList = route({
  id: 'circulation.policies.list',
  method: 'GET',
  path: API,
  permission: 'circulation.policies.manage',
  idempotency: 'none',
  audit: null,
  query: PolicyListQuery,
  handler: notImplemented,
});

const policiesCreate = route({
  id: 'circulation.policies.create',
  method: 'POST',
  path: API,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.policy.create',
  body: PolicyBody,
  handler: notImplemented,
});

const policiesUpdate = route({
  id: 'circulation.policies.update',
  method: 'PATCH',
  path: `${API}/:id`,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.policy.update',
  params: IdParams,
  body: PolicyPatchBody,
  handler: notImplemented,
});

const policiesArchive = route({
  id: 'circulation.policies.archive',
  method: 'DELETE',
  path: `${API}/:id`,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.policy.archive',
  params: IdParams,
  body: ArchiveBody,
  handler: notImplemented,
});

export const POLICY_ROUTES: RouteDecl[] = [policiesList, policiesCreate, policiesUpdate, policiesArchive];
