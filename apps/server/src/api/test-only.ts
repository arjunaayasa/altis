import { createJobRegistry, enqueue, replaceUserRoles } from '@altis/core';
import { ulidField } from '@altis/shared/api/common';
import { BranchUserRolesBody } from '@altis/shared/api/users';
import { z } from 'zod';
import { route, type RouteDecl } from '../http/route.js';
import { jobHandlers } from '../jobs/runtime.js';
import { actorOf } from './users.js';

// Routes of the test build profile only (spec §12.5, S28): they exercise what Phase 1 has no production route for
// yet, and must never ship. `testOnlyRoutes()` returns them only when `__BUILD_PROFILE__ === 'test'` (Vitest, the test
// release); the release build substitutes 'production', the branch is dead code, and the declarations, with the
// test-only permission's name, are left out of the bundle (the release leak scan checks it).
//
// - `test.branch.user_roles`: `PUT /api/v1/_test/branches/:branchId/user-roles {userId, assignments}`, a branch
//   administrator's role assignment (A4, S14, M18). It needs the branch-scoped test permission at `:branchId`, and
//   replaces only the user's assignments at that branch through the users service: a pair at another scope, global
//   included, is AUTHZ_ESCALATION before any other check.
// - `test.jobs.enqueue` (1c Task 13): `POST /api/v1/_test/jobs {type, payload}` queues a `test.slices` or `test.long`
//   job (jobs/runtime.ts, test profile only) as the caller, and wakes this process's worker loop after the commit.

const BranchParams = z.strictObject({ branchId: ulidField });

const TestJobBody = z.strictObject({
  type: z.enum(['test.slices', 'test.long']),
  payload: z.strictObject({
    slices: z.number().int().min(1).max(20),
    k: z.number().int().min(1).max(20),
    exitAt: z.number().int().min(1).max(20).optional(),
  }),
});

/** The test-profile routes; none in a production build. */
export function testOnlyRoutes(): RouteDecl[] {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    return [
      route({
        id: 'test.branch.user_roles',
        method: 'PUT',
        path: '/api/v1/_test/branches/:branchId/user-roles',
        permission: 'test.branch.manage',
        branchParam: 'branchId',
        reauth: true,
        mode: 'system',
        idempotency: 'store',
        audit: 'users.roles.update',
        params: BranchParams,
        body: BranchUserRolesBody,
        handler: async (rc) => ({
          body: await replaceUserRoles(rc.tx(), actorOf(rc), rc.body.userId, rc.body.assignments, {
            onlyBranch: rc.params.branchId,
          }),
        }),
      }),
      route({
        id: 'test.jobs.enqueue',
        method: 'POST',
        path: '/api/v1/_test/jobs',
        permission: 'system.jobs.manage',
        mode: 'system',
        idempotency: 'none',
        audit: null,
        body: TestJobBody,
        handler: async (rc) => {
          const registry = rc.services.jobs?.registry ?? createJobRegistry(jobHandlers());
          const queued = await enqueue(
            rc.tx().trx,
            registry,
            { type: rc.body.type, payload: rc.body.payload, createdBy: rc.auth?.subjectId ?? null },
            { now: rc.now, keyring: rc.config.keyring },
          );
          rc.afterCommit(() => rc.services.jobs?.kick());
          return { body: queued };
        },
      }),
    ];
  }
  return [];
}
