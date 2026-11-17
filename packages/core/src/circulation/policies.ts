import { countGrouped, type DB } from '@altis/db';
import { DomainError, newId, type PolicyRankReason } from '@altis/shared';
import {
  PolicyBody,
  PolicyPatchBody,
  type PolicyCandidateView,
  type PolicyListQuery,
  type PolicyResolveQuery,
  type PolicyResolveResponse,
  type PolicyView,
  type TypeLoanRule,
} from '@altis/shared/api/circulation';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { codeKey } from '../catalog/data/keys.js';
import { formatPrice, parsePrice } from '../catalog/items/service.js';
import type { TxCtx } from '../context.js';
import { memberValidationFailed, parseMemberBody, type Db } from '../members/common.js';
import { readSettings } from '../settings/service.js';

// Loan rules (`policies`). A rule has four dimensions, each null for "all": member type, collection type, material type
// and branch (always null in this edition: the API refuses any other value). Its
// `scope_key` is the tuple `<member type|*>/<collection type|*>/<material type|*>/<branch|*>`, unique, so two live rules
// never share their dimensions; an archived rule's scope becomes `~<id>`, which frees the tuple for a new rule.
//
// Resolution (resolvePolicy): the live rules whose every dimension is null or equal to the loan's are candidates; the
// one with the most dimensions filled wins, and a tie goes to the rule whose first filled dimension comes earlier in the
// order member type, collection type, material type, branch. No candidate: 422 CIRC_NO_POLICY (there is no hidden
// default; the seeded general rule `DEFAULT` covers a new library). A loan copies the winner's terms, so editing or
// archiving a rule never changes a running loan.
//
// A rule's `loan_limit` counts the member's open loans whose stored `policy_id` is that rule (never re-resolved): a new,
// more specific rule starts from zero, and loans made under an archived rule count only towards the member type's
// limit. `loanable = 0` refuses the loan (CIRC_NOT_LOANABLE `policy`), which the desk may force; a forced loan takes
// the rule's terms as they are. Fines are minor units in the library's currency; the API speaks decimal strings.

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

/** The live rules every dimension of which is null or the loan's: the candidates of the loan `d`. */
async function candidatesOf(db: Db, d: PolicyDimensions): Promise<PolicyRow[]> {
  const dims: [('member_type_id' | 'collection_type_id' | 'material_type_id' | 'branch_id'), string | null][] = [
    ['member_type_id', d.memberTypeId],
    ['collection_type_id', d.collectionTypeId],
    ['material_type_id', d.materialTypeId],
    ['branch_id', d.branchId],
  ];
  let q = db.selectFrom('policies').selectAll().where('archived_at', 'is', null);
  for (const [column, value] of dims) {
    q = q.where((eb) => (value === null ? eb(column, 'is', null) : eb.or([eb(column, 'is', null), eb(column, '=', value)])));
  }
  return q.execute();
}

/** The live rule that applies to the loan `d`, or null. */
export async function resolvePolicy(db: Db, d: PolicyDimensions): Promise<PolicyRow | null> {
  return pickPolicy(await candidatesOf(db, d), d);
}

/** How many dimensions `r` fills. */
function specificityOf(r: RuleDims): number {
  return filled(r).reduce((x, y) => x + y, 0);
}

/**
 * The candidates of `rules` for `d`, best first, each with why it stands where it does: the winner is `only`,
 * `more_specific` (more dimensions filled than the next) or `earlier_dimension`; every other is `less_specific` or
 * `later_dimension` than the one before it. Pure.
 */
export function rankPolicies<R extends RuleDims>(rules: readonly R[], d: PolicyDimensions): { rule: R; reason: PolicyRankReason }[] {
  const ranked: R[] = [];
  let rest = [...rules];
  for (;;) {
    const best = pickPolicy(rest, d);
    if (best === null) break;
    ranked.push(best);
    rest = rest.filter((r) => r !== best);
  }
  return ranked.map((rule, i) => {
    if (ranked.length === 1) return { rule, reason: 'only' };
    const other = i === 0 ? ranked[1]! : ranked[i - 1]!;
    const sameCount = specificityOf(rule) === specificityOf(other);
    if (i === 0) return { rule, reason: sameCount ? 'earlier_dimension' : 'more_specific' };
    return { rule, reason: sameCount ? 'later_dimension' : 'less_specific' };
  });
}

/** The "which rule applies" tool: every live rule that fits `q`, ranked, the winner first. */
export async function explainPolicy(db: Db, q: PolicyResolveQuery): Promise<PolicyResolveResponse> {
  const d: PolicyDimensions = {
    memberTypeId: q.memberTypeId ?? null,
    collectionTypeId: q.collectionTypeId ?? null,
    materialTypeId: q.materialTypeId ?? null,
    branchId: null,
  };
  const ranked = rankPolicies(await candidatesOf(db, d), d);
  const open = await openLoansUnder(
    db,
    ranked.map((r) => r.rule.id),
  );
  const candidates: PolicyCandidateView[] = ranked.map((r, i) => ({ policy: toView(r.rule, open.get(r.rule.id) ?? 0), rank: i + 1, reason: r.reason }));
  return { winner: candidates[0]?.policy ?? null, candidates };
}

/** The open loans made under each of the rules `ids`. */
async function openLoansUnder(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
  const open = new Map<string, number>();
  if (ids.length === 0) return open;
  const q = db.selectFrom('loans').where('open_item_id', 'is not', null).where('policy_id', 'in', [...ids]);
  for (const row of await countGrouped(q, { p: 'policy_id' })) open.set(String(row.p), row.count);
  return open;
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
    finePerDay: formatPrice(Number(r.fine_per_day_minor)),
    fineCap: r.fine_cap_minor === null ? null : formatPrice(Number(r.fine_cap_minor)),
    graceDays: Number(r.grace_days),
    currency: r.currency,
    specificity: specificityOf(r),
    openLoans,
    archived: r.archived_at !== null,
    version: Number(r.version),
  };
}

/**
 * The live rules (archived ones too with `includeArchived`): the least specific first (the general rule leads), then
 * by the codes of their member type, collection type and material type.
 */
export async function listPolicies(db: Db, q: PolicyListQuery): Promise<PolicyView[]> {
  let query = db.selectFrom('policies').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  const rows = await query.limit(1000).execute();
  const codesOf = async (table: 'member_types' | 'collection_types' | 'material_types', ids: (string | null)[]): Promise<Map<string, string>> => {
    const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
    if (wanted.length === 0) return new Map();
    return new Map((await db.selectFrom(table).select(['id', 'code_key']).where('id', 'in', wanted).execute()).map((t) => [t.id, t.code_key]));
  };
  const types = await codesOf('member_types', rows.map((r) => r.member_type_id));
  const collections = await codesOf('collection_types', rows.map((r) => r.collection_type_id));
  const materials = await codesOf('material_types', rows.map((r) => r.material_type_id));
  const open = await openLoansUnder(
    db,
    rows.map((r) => r.id),
  );
  const code = (m: Map<string, string>, id: string | null): string => (id === null ? '' : `~${m.get(id) ?? ''}`);
  const sortKey = (r: PolicyRow): string =>
    [r.archived_at === null ? 0 : 1, specificityOf(r), code(types, r.member_type_id), code(collections, r.collection_type_id), code(materials, r.material_type_id)].join('|');
  rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : a.id < b.id ? -1 : 1));
  return rows.map((r) => toView(r, open.get(r.id) ?? 0));
}

/** The library's currency (`catalog.currency`). */
async function libraryCurrency(db: Db): Promise<string> {
  return (await readSettings(db, ['catalog.currency'], []))['catalog.currency'] as string;
}

/** The three dimensions a rule names (the branch is always null in this edition). */
interface RuleScope {
  memberTypeId: string | null;
  collectionTypeId: string | null;
  materialTypeId: string | null;
}

/**
 * Field errors of a rule's dimensions and scope: each named dimension must be live (`not_found` on its path), and no
 * other live rule may hold the scope (`{path: 'scope', code: 'taken'}`).
 */
async function scopeErrors(db: Db, dims: RuleScope, exceptId?: string): Promise<{ path: string; code: string }[]> {
  const errors: { path: string; code: string }[] = [];
  const checks: [string, 'member_types' | 'collection_types' | 'material_types', string | null][] = [
    ['memberTypeId', 'member_types', dims.memberTypeId],
    ['collectionTypeId', 'collection_types', dims.collectionTypeId],
    ['materialTypeId', 'material_types', dims.materialTypeId],
  ];
  for (const [path, table, id] of checks) {
    if (id === null) continue;
    const row = await db.selectFrom(table).select('archived_at').where('id', '=', id).executeTakeFirst();
    if (row === undefined || row.archived_at !== null) errors.push({ path, code: 'not_found' });
  }
  if (errors.length > 0) return errors;
  let q = db.selectFrom('policies').select('id').where('scope_key', '=', policyScopeKey({ ...dims, branchId: null }));
  if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) === undefined ? [] : [{ path: 'scope', code: 'taken' }];
}

/** A decimal fine as minor units. The contract's pattern makes every value parse. */
function minorOf(text: string): number {
  return parsePrice(text) ?? 0;
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
    if (error instanceof DomainError && error.code === 'UNIQUE_VIOLATION') throw memberValidationFailed([{ path: 'scope', code: 'taken' }]);
    throw error;
  }
}

/**
 * Creates a loan rule and audits `circulation.policy.create` with the names of the fields given.
 *
 * @throws DomainError VALIDATION_FAILED: the contract, `{path: 'code', code: 'taken'}`, `{path: 'scope', code:
 *   'taken'}`, `{path: 'memberTypeId' | 'collectionTypeId' | 'materialTypeId', code: 'not_found'}`, `{path:
 *   'branchId', code: 'branch_scope_not_available'}`
 */
export async function createPolicy(tx: TxCtx, input: PolicyBody): Promise<{ id: string; version: number }> {
  const b = parseMemberBody(PolicyBody, input);
  const { trx } = tx;
  const key = codeKey(b.code);
  const dims: RuleScope = { memberTypeId: b.memberTypeId, collectionTypeId: b.collectionTypeId, materialTypeId: b.materialTypeId };
  const scope = policyScopeKey({ ...dims, branchId: null });
  const errors = await scopeErrors(trx, dims);
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
        collection_type_id: b.collectionTypeId,
        material_type_id: b.materialTypeId,
        branch_id: null,
        scope_key: scope,
        loanable: b.loanable ? 1 : 0,
        loan_days: b.loanDays,
        loan_limit: b.loanLimit,
        renew_limit: b.renewLimit,
        fine_per_day_minor: minorOf(b.finePerDay),
        fine_cap_minor: b.fineCap === null ? null : minorOf(b.fineCap),
        grace_days: b.graceDays,
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
  const dims: RuleScope = {
    memberTypeId: p.memberTypeId === undefined ? before.member_type_id : p.memberTypeId,
    collectionTypeId: p.collectionTypeId === undefined ? before.collection_type_id : p.collectionTypeId,
    materialTypeId: p.materialTypeId === undefined ? before.material_type_id : p.materialTypeId,
  };
  const dimChanges: [keyof RuleScope, 'member_type_id' | 'collection_type_id' | 'material_type_id'][] = [
    ['memberTypeId', 'member_type_id'],
    ['collectionTypeId', 'collection_type_id'],
    ['materialTypeId', 'material_type_id'],
  ];
  const changedDims = dimChanges.filter(([field, column]) => dims[field] !== before[column]);
  if (changedDims.length > 0) {
    errors.push(...(await scopeErrors(trx, dims, id)));
    for (const [field, column] of changedDims) {
      set[column] = dims[field];
      fields.push(field);
    }
    set.scope_key = policyScopeKey({ ...dims, branchId: before.branch_id });
  }
  if (errors.length > 0) throw memberValidationFailed(errors);
  const simple: [string, keyof Updateable<DB['policies']>, unknown, unknown][] = [
    ['name', 'name', p.name, before.name],
    ['loanable', 'loanable', p.loanable === undefined ? undefined : p.loanable ? 1 : 0, Number(before.loanable)],
    ['loanDays', 'loan_days', p.loanDays, Number(before.loan_days)],
    ['loanLimit', 'loan_limit', p.loanLimit, before.loan_limit === null ? null : Number(before.loan_limit)],
    ['renewLimit', 'renew_limit', p.renewLimit, Number(before.renew_limit)],
    ['finePerDay', 'fine_per_day_minor', p.finePerDay === undefined ? undefined : minorOf(p.finePerDay), Number(before.fine_per_day_minor)],
    [
      'fineCap',
      'fine_cap_minor',
      p.fineCap === undefined ? undefined : p.fineCap === null ? null : minorOf(p.fineCap),
      before.fine_cap_minor === null ? null : Number(before.fine_cap_minor),
    ],
    ['graceDays', 'grace_days', p.graceDays, Number(before.grace_days)],
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

// ---- Komunitas (staff screens' data) ----

/**
 * The general loan terms of each member type of `typeIds` (absent from the map: none given): the rule that applies to
 * the type's loans of any collection and material (resolution as above, with only the member type filled), and how many
 * live rules naming a collection type, a material type or a branch may apply instead to some of its loans (those of the
 * type and those of every type). Null when no rule covers the type. One read of the live rules.
 */
export async function typeLoanRules(db: Db, typeIds: readonly string[]): Promise<Map<string, TypeLoanRule | null>> {
  const out = new Map<string, TypeLoanRule | null>();
  if (typeIds.length === 0) return out;
  const rules = await db
    .selectFrom('policies')
    .select(['id', 'code_display', 'member_type_id', 'collection_type_id', 'material_type_id', 'branch_id', 'loanable', 'loan_days', 'renew_limit'])
    .where('archived_at', 'is', null)
    .execute();
  for (const typeId of typeIds) {
    const rule = pickPolicy(rules, { memberTypeId: typeId, collectionTypeId: null, materialTypeId: null, branchId: null });
    if (rule === null) {
      out.set(typeId, null);
      continue;
    }
    const others = rules.filter(
      (r) => (r.member_type_id === null || r.member_type_id === typeId) && (r.collection_type_id !== null || r.material_type_id !== null || r.branch_id !== null),
    ).length;
    out.set(typeId, {
      policyId: rule.id,
      code: rule.code_display,
      loanDays: Number(rule.loan_days),
      renewLimit: Number(rule.renew_limit),
      loanable: Number(rule.loanable) === 1,
      others,
    });
  }
  return out;
}
