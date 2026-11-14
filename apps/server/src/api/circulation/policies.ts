import { archivePolicy, createPolicy, explainPolicy, listPolicies, updatePolicy } from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { PolicyBody, PolicyListQuery, PolicyPatchBody, PolicyResolveQuery, type PolicyListResponse, type PolicyResolveResponse } from '@altis/shared/api/circulation';
import { ulidField } from '@altis/shared/api/common';
import { ArchiveBody } from '@altis/shared/api/members';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The loan rules (`circulation.policies.manage`, library-wide):
//
//   GET    circulation/policies       PolicyListQuery → PolicyListResponse
//   GET    circulation/policies/resolve  PolicyResolveQuery → PolicyResolveResponse  ("which rule applies")
//   POST   circulation/policies       PolicyBody → 201 StoreResponse        circulation.policy.create
//   PATCH  circulation/policies/:id   PolicyPatchBody → StoreResponse      circulation.policy.update
//   DELETE circulation/policies/:id   ArchiveBody → StoreResponse          circulation.policy.archive
//
// A rule's dimensions (member type, collection type, material type; the branch is always "all") form its `scope_key`;
// a second live rule with the same three is the field error `{path: 'scope', code: 'taken'}`, a taken code `{path:
// 'code', code: 'taken'}`. Archiving renames the scope to `~<id>`, so the same dimensions can get a new rule.

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
  handler: async (rc) => {
    const body: PolicyListResponse = { items: await listPolicies(rc.db.db, rc.query) };
    return { body };
  },
});

const policiesResolve = route({
  id: 'circulation.policies.resolve',
  method: 'GET',
  path: `${API}/resolve`,
  permission: 'circulation.policies.manage',
  idempotency: 'none',
  audit: null,
  query: PolicyResolveQuery,
  handler: async (rc) => {
    const body: PolicyResolveResponse = await explainPolicy(rc.db.db, rc.query);
    return { body };
  },
});

const policiesCreate = route({
  id: 'circulation.policies.create',
  method: 'POST',
  path: API,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.policy.create',
  body: PolicyBody,
  handler: async (rc) => {
    const body: StoreResponse = await createPolicy(rc.tx(), rc.body);
    return { status: 201, body };
  },
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
  handler: async (rc) => {
    const body: StoreResponse = await updatePolicy(rc.tx(), rc.params.id, rc.body);
    return { body };
  },
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
  handler: async (rc) => {
    const body: StoreResponse = await archivePolicy(rc.tx(), rc.params.id, rc.body.version);
    return { body };
  },
});

export const POLICY_ROUTES: RouteDecl[] = [
  policiesList,
  // ---- Komunitas (circulation core): before `:id`, so `resolve` is never read as a rule id ----
  policiesResolve,
  policiesCreate,
  policiesUpdate,
  policiesArchive,
];
