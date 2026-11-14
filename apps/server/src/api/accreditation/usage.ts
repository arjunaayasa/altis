import { getUsageGrid, getUsageGroups, loadAccredSettings, putUsageCells, putUsageGroups } from '@altis/core';
import { UsageGroupsPutBody, UsagePutBody } from '@altis/shared/api/accreditation';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import type { RouteDecl } from '../../http/route.js';
import { route } from '../../http/route.js';

// The routes of the monthly usage table of a period and the member-type mapping (spec §5.2, §10.7):
// `GET|PUT accreditation/periods/:id/usage` and `GET|PUT accreditation/usage-groups`. Reading needs
// `accreditation.workspace.read`, writing `accreditation.workspace.manage`; accreditation is library-wide in this
// edition, so no route has a branch.
//
// - A usage write is a period write: its service takes the period lock as the first statement of the handler's
//   transaction (a frozen period answers 409 ACCRED_PERIOD_FROZEN) and answers the period's `{id, version}` (a usage
//   write leaves the version as it is). At most 500 cells at once.
// - The mapping belongs to the whole installation (no period lock, so a frozen period does not stop it) and answers
//   how many rows it set. At most 200 rows at once.
// - Both writes are `store` routes; the services audit once in the handler's transaction.

const API = '/api/v1/accreditation';
const IdParams = z.strictObject({ id: ulidField });

const usageGet = route({
  id: 'accreditation.usage.get',
  method: 'GET',
  path: `${API}/periods/:id/usage`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await getUsageGrid(rc.db.db, rc.params.id, await loadAccredSettings(rc.db.db)) }),
});

const usagePut = route({
  id: 'accreditation.usage.put',
  method: 'PUT',
  path: `${API}/periods/:id/usage`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.usage.update',
  params: IdParams,
  body: UsagePutBody,
  handler: async (rc) => {
    const tx = rc.tx();
    await putUsageCells(tx, rc.params.id, rc.body, rc.now);
    const period = await tx.trx.selectFrom('accred_periods').select('version').where('id', '=', rc.params.id).executeTakeFirstOrThrow();
    return { body: { id: rc.params.id, version: Number(period.version) } };
  },
});

const groupsGet = route({
  id: 'accreditation.usage_groups.get',
  method: 'GET',
  path: `${API}/usage-groups`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => ({ body: await getUsageGroups(rc.db.db) }),
});

const groupsPut = route({
  id: 'accreditation.usage_groups.put',
  method: 'PUT',
  path: `${API}/usage-groups`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.usage_groups.update',
  body: UsageGroupsPutBody,
  handler: async (rc) => {
    await putUsageGroups(rc.tx(), rc.body, rc.now);
    return { body: { count: rc.body.groups.length } };
  },
});

export const USAGE_ROUTES: RouteDecl[] = [usageGet, usagePut, groupsGet, groupsPut];
