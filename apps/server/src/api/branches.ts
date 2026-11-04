import { archiveBranch, createBranch, listBranches, updateBranch } from '@altis/core';
import {
  BranchCreateBody,
  BranchListQuery,
  BranchPatchBody,
  type BranchItem,
  type BranchListResponse,
  type BranchView,
} from '@altis/shared/api/branches';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../http/route.js';

// The branches routes of Task 21 (route catalog, spec §6.5, decision D6): the list is open to any signed-in staff
// user (branch names are needed across the UI), the writes need `system.branches.manage`. The services do the work
// in the handler's transaction and audit in it (`branches.create`, `branches.update`, `branches.archive`).
//
// `GET branches` marks each branch `active` (BranchView): whether staff may write to it. The community edition has no
// branch limit, so every live branch is active and an archived one never is (`active = archivedAt === null`).

const BRANCHES = '/api/v1/branches';
const BranchParams = z.strictObject({ id: ulidField });

/** The `active` flag of each branch: in the community edition, every live branch. */
function withActiveFlags(items: BranchItem[]): BranchView[] {
  return items.map((b) => ({ ...b, active: b.archivedAt === null }));
}

/** GET branches: every signed-in staff user (`public` with `session: 'required'`, so a user without any role passes). */
const branchesList = route({
  id: 'branches.list',
  method: 'GET',
  path: BRANCHES,
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  query: BranchListQuery,
  handler: async (rc) => {
    const body: BranchListResponse = { items: withActiveFlags(await listBranches(rc.db.db, rc.query)) };
    return { body };
  },
});

/** POST branches. */
const branchesCreate = route({
  id: 'branches.create',
  method: 'POST',
  path: BRANCHES,
  permission: 'system.branches.manage',
  idempotency: 'store',
  audit: 'branches.create',
  body: BranchCreateBody,
  handler: async (rc) => {
    const body: BranchItem = await createBranch(rc.tx(), rc.body);
    return { status: 201, body };
  },
});

/** PATCH branches/:id. */
const branchesUpdate = route({
  id: 'branches.update',
  method: 'PATCH',
  path: `${BRANCHES}/:id`,
  permission: 'system.branches.manage',
  idempotency: 'store',
  audit: 'branches.update',
  params: BranchParams,
  body: BranchPatchBody,
  handler: async (rc) => {
    const body: BranchItem = await updateBranch(rc.tx(), rc.params.id, rc.body);
    return { body };
  },
});

/** DELETE branches/:id: archives (the default branch refuses). */
const branchesArchive = route({
  id: 'branches.archive',
  method: 'DELETE',
  path: `${BRANCHES}/:id`,
  permission: 'system.branches.manage',
  idempotency: 'store',
  audit: 'branches.archive',
  params: BranchParams,
  handler: async (rc) => {
    const body: BranchItem = await archiveBranch(rc.tx(), rc.params.id);
    return { body };
  },
});

export const BRANCH_ROUTES: RouteDecl[] = [branchesList, branchesCreate, branchesUpdate, branchesArchive];
