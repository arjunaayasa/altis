import type { DB } from '@altis/db';
import { upsert } from '@altis/db';
import { ACCRED_GROUPS, type AccredGroup } from '@altis/shared';
import { UsageGroupsPutBody, type UsageGroupsView } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import type { TxCtx } from '../../context.js';
import { periodFieldErrors, parsePeriodBody, type PeriodFieldError } from '../periods/errors.js';

// The member-type mapping (spec §10.7, `usage_group_map`): the population group each member type of the source system
// counts in, and the group of the members the source no longer has. The SLiMS usage import adds the types it meets; a
// librarian changes their group here, and the usage table reads the mapping whenever it is read, so a change needs no
// new import. The mapping belongs to the whole installation, not to a period, so a frozen period does not stop it (a
// frozen period keeps the values of its snapshot).

const UNKNOWN = 'member_unknown';
const TYPE_PREFIX = 'slims_type:';

const asGroup = (g: string | null): AccredGroup | null => (g !== null && (ACCRED_GROUPS as readonly string[]).includes(g) ? (g as AccredGroup) : null);

/** The order of the mapping: member types by their id (numerically when both are numbers), the deleted members last. */
function compareKeys(a: string, b: string): number {
  if (a === UNKNOWN || b === UNKNOWN) return a === b ? 0 : a === UNKNOWN ? 1 : -1;
  const x = a.startsWith(TYPE_PREFIX) ? a.slice(TYPE_PREFIX.length) : a;
  const y = b.startsWith(TYPE_PREFIX) ? b.slice(TYPE_PREFIX.length) : b;
  if (/^\d+$/.test(x) && /^\d+$/.test(y) && x !== y) return Number(x) - Number(y) || (x < y ? -1 : 1);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The mapping, member types first (by id), the deleted members last; an empty label reads as null. */
export async function getUsageGroups(db: Kysely<DB>): Promise<UsageGroupsView> {
  const rows = await db.selectFrom('usage_group_map').select(['group_key', 'label', 'accred_group', 'updated_at']).execute();
  rows.sort((a, b) => compareKeys(a.group_key, b.group_key));
  return {
    groups: rows.map((r) => ({ groupKey: r.group_key, label: r.label === '' ? null : r.label, accredGroup: asGroup(r.accred_group), updatedAt: Number(r.updated_at) })),
  };
}

/**
 * Sets the group of the member types of `body` the mapping already has, and of the deleted members (their row is
 * created when missing, without a label). Audited `accreditation.usage_groups.update` with `{count}`.
 *
 * @throws DomainError `VALIDATION_FAILED`: `groups.<i>.groupKey` `not_found` for a member type the mapping does not
 *   have, `duplicate` for a key named twice
 */
export async function putUsageGroups(tx: TxCtx, body: UsageGroupsPutBody, now: number): Promise<void> {
  const input = parsePeriodBody(UsageGroupsPutBody, body);
  const { trx } = tx;
  const keys = input.groups.map((g) => g.groupKey);
  const known = new Set((await trx.selectFrom('usage_group_map').select('group_key').where('group_key', 'in', keys).execute()).map((r) => r.group_key));
  const errors: PeriodFieldError[] = [];
  const seen = new Set<string>();
  input.groups.forEach((g, i) => {
    if (seen.has(g.groupKey)) errors.push({ path: `groups.${i}.groupKey`, code: 'duplicate' });
    else if (g.groupKey !== UNKNOWN && !known.has(g.groupKey)) errors.push({ path: `groups.${i}.groupKey`, code: 'not_found' });
    seen.add(g.groupKey);
  });
  if (errors.length > 0) throw periodFieldErrors(errors);

  for (const g of input.groups) {
    const values = { accred_group: g.accredGroup, updated_at: now, updated_by: tx.actor.id };
    if (g.groupKey === UNKNOWN) {
      await upsert(trx, 'usage_group_map', { group_key: UNKNOWN }, { group_key: UNKNOWN, label: '', ...values }, values);
    } else {
      await trx.updateTable('usage_group_map').set(values).where('group_key', '=', g.groupKey).execute();
    }
  }
  await tx.audit({ action: 'accreditation.usage_groups.update', entity: 'usage_group_map', entityId: null, meta: { count: input.groups.length } });
}
