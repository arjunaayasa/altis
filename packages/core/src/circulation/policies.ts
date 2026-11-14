import { countGrouped, type DB } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { PolicyBody, PolicyPatchBody, type PolicyListQuery, type PolicyView } from '@altis/shared/api/circulation';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { codeKey } from '../catalog/data/keys.js';
import type { TxCtx } from '../context.js';
import { memberValidationFailed, parseMemberBody, type Db } from '../members/common.js';
import { readSettings } from '../settings/service.js';

// Loan rules (`policies`). A rule has four dimensions, each null for "all": member type, collection type, material type
// and branch; this edition writes the member type only (the others stay "all", the branch is always null). Its
// `scope_key` is the tuple `<member type|*>/<collection type|*>/<material type|*>/<branch|*>`, unique, so two live rules
// never share their dimensions; an archived rule's scope becomes `~<id>`, which frees the tuple for a new rule.
//
// Resolution (resolvePolicy): the live rules whose every dimension is null or equal to the loan's are candidates; the
// one with the most dimensions filled wins, and a tie goes to the rule whose first filled dimension comes earlier in the
// order member type, collection type, material type, branch. No candidate: 422 CIRC_NO_POLICY (there is no hidden
// default; the seeded general rule `DEFAULT` covers a new library). A loan copies the winner's terms, so editing or
// archiving a rule never changes a running loan.

type PolicyRow = Selectable<DB['policies']>;

/** The dimensions of a loan, as rule resolution reads them. */
export interface PolicyDimensions {
  memberTypeId: string | null;
  collectionTypeId: string | null;
  materialTypeId: string | null;
  branchId: string | null;
}

/** The scope key of a rule's dimensions. */
export function policyScopeKey(d: PolicyDimensions): string {
  return [d.memberTypeId, d.collectionTypeId, d.materialTypeId, d.branchId].map((v) => v ?? '*').join('/');
}

type RuleDims = Pick<PolicyRow, 'member_type_id' | 'collection_type_id' | 'material_type_id' | 'branch_id'>;

/** The filled dimensions of a rule, in resolution order, as 1 (filled) or 0. */
function filled(r: RuleDims): number[] {
  return [r.member_type_id, r.collection_type_id, r.material_type_id, r.branch_id].map((v) => (v === null ? 0 : 1));
}

/**
 * The winning rule among `rules` for the loan `d` (see the top of this file), or null when none applies. Archived
 * rules must already be left out. Pure.
 */
export function pickPolicy<R extends RuleDims>(rules: readonly R[], d: PolicyDimensions): R | null {
  const fits = (rule: string | null, value: string | null): boolean => rule === null || rule === value;
  const candidates = rules.filter(
    (r) => fits(r.member_type_id, d.memberTypeId) && fits(r.collection_type_id, d.collectionTypeId) && fits(r.material_type_id, d.materialTypeId) && fits(r.branch_id, d.branchId),
  );
  let best: R | null = null;
  for (const r of candidates) {
    if (best === null) {
      best = r;
      continue;
    }
    const a = filled(r);
    const b = filled(best);
    const sa = a.reduce((x, y) => x + y, 0);
    const sb = b.reduce((x, y) => x + y, 0);
    if (sa > sb) best = r;
    else if (sa === sb) {
      // Lexicographic on the filled flags: the rule whose first filled dimension comes earlier wins.
      for (let i = 0; i < 4; i++) {
        if (a[i] !== b[i]) {
          if (a[i]! > b[i]!) best = r;
          break;
        }
      }
    }
  }
  return best;
}

/** The live rule that applies to the loan `d`, or null. */
export async function resolvePolicy(db: Db, d: PolicyDimensions): Promise<PolicyRow | null> {
  const rules = await db
    .selectFrom('policies')
    .selectAll()
    .where('archived_at', 'is', null)
    .where((eb) => eb.or([eb('member_type_id', 'is', null), ...(d.memberTypeId === null ? [] : [eb('member_type_id', '=', d.memberTypeId)])]))
    .execute();
  return pickPolicy(rules, d);
}

// ---- the rules API ---------------------------------------------------------------------------------------------------

function policyNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Aturan peminjaman tidak ditemukan / Loan rule not found' });
}

function policyStale(): DomainError {
  return new DomainError('CONFLICT_STALE', { detail: 'Aturan peminjaman sudah diubah orang lain; muat ulang / The loan rule was changed by someone else; reload it' });
}

function toView(r: PolicyRow, openLoans: number): PolicyView {
  return {
    id: r.id,
    code: r.code_display,
    name: r.name,
    memberTypeId: r.member_type_id,
    collectionTypeId: r.collection_type_id,
    materialTypeId: r.material_type_id,
    branchId: r.branch_id,
    loanable: Number(r.loanable) === 1,
    loanDays: Number(r.loan_days),
    loanLimit: r.loan_limit === null ? null : Number(r.loan_limit),
    renewLimit: Number(r.renew_limit),
    currency: r.currency,
    openLoans,
    archived: r.archived_at !== null,
    version: Number(r.version),
  };
}

/** The live rules, the general one first, then by member type code; archived ones too with `includeArchived`. */
export async function listPolicies(db: Db, q: PolicyListQuery): Promise<PolicyView[]> {
  let query = db.selectFrom('policies').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  const rows = await query.limit(1000).execute();
  const typeIds = [...new Set(rows.map((r) => r.member_type_id).filter((v): v is string => v !== null))];
  const codes = new Map(
    typeIds.length === 0 ? [] : (await db.selectFrom('member_types').select(['id', 'code_key']).where('id', 'in', typeIds).execute()).map((t) => [t.id, t.code_key]),
  );
  const open = new Map<string, number>();
  if (rows.length > 0) {
    const q2 = db.selectFrom('loans').where('open_item_id', 'is not', null).where('policy_id', 'in', rows.map((r) => r.id));
    for (const row of await countGrouped(q2, { p: 'policy_id' })) open.set(String(row.p), row.count);
  }
  const sortKey = (r: PolicyRow): string => `${r.archived_at === null ? 0 : 1}${r.member_type_id === null ? '0' : `1${codes.get(r.member_type_id) ?? ''}`}`;
  rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.id < b.id ? -1 : 1));
  return rows.map((r) => toView(r, open.get(r.id) ?? 0));
}

/** The library's currency (`catalog.currency`). */
async function libraryCurrency(db: Db): Promise<string> {
  return (await readSettings(db, ['catalog.currency'], []))['catalog.currency'] as string;
}

/** Field errors of a rule's member type and scope: the type must be live, and no other live rule may hold the scope. */
async function scopeErrors(db: Db, memberTypeId: string | null, scope: string, exceptId?: string): Promise<{ path: string; code: string }[]> {
  if (memberTypeId !== null) {
    const t = await db.selectFrom('member_types').select('archived_at').where('id', '=', memberTypeId).executeTakeFirst();
    if (t === undefined || t.archived_at !== null) return [{ path: 'memberTypeId', code: 'not_found' }];
  }
  let q = db.selectFrom('policies').select('id').where('scope_key', '=', scope);
  if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) === undefined ? [] : [{ path: 'memberTypeId', code: 'taken' }];
}

/** Whether a rule other than `exceptId` holds the code key `key`. */
async function codeTaken(db: Db, key: string, exceptId?: string): Promise<boolean> {
  let q = db.selectFrom('policies').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** A write that may lose the race for the code or the scope: that UNIQUE_VIOLATION is VALIDATION_FAILED `taken`. */
async function takenOnRace<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof DomainError && error.code === 'UNIQUE_VIOLATION') throw memberValidationFailed([{ path: 'code', code: 'taken' }]);
    throw error;
  }
}

/**
 * Creates a loan rule (member-type dimension only) and audits `circulation.policy.create` with the names of the fields
 * given.
 *
 * @throws DomainError VALIDATION_FAILED: the contract, `{path: 'code', code: 'taken'}`, `{path: 'memberTypeId', code:
 *   'taken' | 'not_found'}`, `{path: 'branchId', code: 'branch_scope_not_available'}`
 */
export async function createPolicy(tx: TxCtx, input: PolicyBody): Promise<{ id: string; version: number }> {
  const b = parseMemberBody(PolicyBody, input);
  const { trx } = tx;
  const key = codeKey(b.code);
  const scope = policyScopeKey({ memberTypeId: b.memberTypeId, collectionTypeId: null, materialTypeId: null, branchId: null });
  const errors = await scopeErrors(trx, b.memberTypeId, scope);
  if (await codeTaken(trx, key)) errors.unshift({ path: 'code', code: 'taken' });
  if (errors.length > 0) throw memberValidationFailed(errors);
  const id = newId(tx.now);
  const currency = await libraryCurrency(trx);
  await takenOnRace(() =>
    trx
      .insertInto('policies')
      .values({
        id,
        code_display: b.code,
        code_key: key,
        name: b.name,
        member_type_id: b.memberTypeId,
        collection_type_id: null,
        material_type_id: null,
        branch_id: null,
        scope_key: scope,
        loanable: b.loanable ? 1 : 0,
        loan_days: b.loanDays,
        loan_limit: b.loanLimit,
        renew_limit: b.renewLimit,
        fine_per_day_minor: 0,
        fine_cap_minor: null,
        grace_days: 0,
        currency,
        archived_at: null,
        version: 0,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  const fields = Object.keys(b)
    .filter((k) => b[k as keyof typeof b] !== undefined)
    .sort();
  await tx.audit({ action: 'circulation.policy.create', entity: 'policies', entityId: id, meta: { fields } });
  return { id, version: 0 };
}

async function lockPolicyRow(trx: Transaction<DB>, id: string): Promise<PolicyRow> {
  await trx
    .updateTable('policies')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
  const row = await trx.selectFrom('policies').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw policyNotFound();
  return row;
}

/**
 * Changes the fields `patch` sends (running loans keep their terms) and audits `circulation.policy.update` with the
 * names of the fields whose value changed.
 *
 * @throws DomainError NOT_FOUND (none, or archived); CONFLICT_STALE; VALIDATION_FAILED (as createPolicy)
 */
export async function updatePolicy(tx: TxCtx, id: string, input: PolicyPatchBody): Promise<{ id: string; version: number }> {
  const p = parseMemberBody(PolicyPatchBody, input);
  const { trx } = tx;
  const before = await lockPolicyRow(trx, id);
  if (Number(before.version) !== p.version) throw policyStale();
  if (before.archived_at !== null) throw policyNotFound();

  const set: Updateable<DB['policies']> = {};
  const fields: string[] = [];
  const errors: { path: string; code: string }[] = [];
  if (p.code !== undefined && p.code !== before.code_display) {
    const key = codeKey(p.code);
    if (key !== before.code_key && (await codeTaken(trx, key, id))) errors.push({ path: 'code', code: 'taken' });
    set.code_display = p.code;
    set.code_key = key;
    fields.push('code');
  }
  if (p.memberTypeId !== undefined && p.memberTypeId !== before.member_type_id) {
    const scope = policyScopeKey({ memberTypeId: p.memberTypeId, collectionTypeId: before.collection_type_id, materialTypeId: before.material_type_id, branchId: before.branch_id });
    errors.push(...(await scopeErrors(trx, p.memberTypeId, scope, id)));
    set.member_type_id = p.memberTypeId;
    set.scope_key = scope;
    fields.push('memberTypeId');
  }
  if (errors.length > 0) throw memberValidationFailed(errors);
  const simple: [string, keyof Updateable<DB['policies']>, unknown, unknown][] = [
    ['name', 'name', p.name, before.name],
    ['loanable', 'loanable', p.loanable === undefined ? undefined : p.loanable ? 1 : 0, Number(before.loanable)],
    ['loanDays', 'loan_days', p.loanDays, Number(before.loan_days)],
    ['loanLimit', 'loan_limit', p.loanLimit, before.loan_limit === null ? null : Number(before.loan_limit)],
    ['renewLimit', 'renew_limit', p.renewLimit, Number(before.renew_limit)],
  ];
  for (const [field, column, next, old] of simple) {
    if (next === undefined || next === old) continue;
    (set as Record<string, unknown>)[column] = next;
    fields.push(field);
  }
  const updated = await takenOnRace(() =>
    trx
      .updateTable('policies')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw policyStale();
  await tx.audit({ action: 'circulation.policy.update', entity: 'policies', entityId: id, meta: { fields: fields.sort() } });
  return { id, version: p.version + 1 };
}

/**
 * Archives a loan rule (`archived_at`, scope `~<id>`, version + 1) and audits `circulation.policy.archive`. Running
 * loans keep their terms. One already archived is answered as it is (`meta.alreadyArchived`).
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE
 */
export async function archivePolicy(tx: TxCtx, id: string, version: number): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  const before = await lockPolicyRow(trx, id);
  if (Number(before.version) !== version) throw policyStale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'circulation.policy.archive', entity: 'policies', entityId: id, meta: { alreadyArchived: true } });
    return { id, version };
  }
  const updated = await trx
    .updateTable('policies')
    .set((eb) => ({ archived_at: tx.now, scope_key: `~${id}`, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw policyStale();
  await tx.audit({ action: 'circulation.policy.archive', entity: 'policies', entityId: id, meta: {} });
  return { id, version: version + 1 };
}
