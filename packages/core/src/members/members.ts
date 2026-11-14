import type { DB } from '@altis/db';
import { DomainError, addDays, isUlid, newId, type Gender, type MemberEventType, type MemberStoredStatus } from '@altis/shared';
import type { FieldWarning, Paged } from '@altis/shared/api/catalog/common';
import {
  MemberBody,
  MemberExtendBody,
  MemberPatchBody,
  type MemberEventView,
  type MemberEventsQuery,
  type MemberListItem,
  type MemberSearchBody,
  type MemberSearchResponse,
  type MemberTypeRef,
  type MemberView,
} from '@altis/shared/api/members';
import { sql, type Expression, type Selectable, type SqlBool, type Transaction, type Updateable } from 'kysely';
import type { TxCtx } from '../context.js';
import {
  libraryToday,
  lockLiveMember,
  memberNotFound,
  memberStale,
  memberStatusOf,
  memberStatusWhere,
  memberTypeNotFound,
  memberValidationFailed,
  openLoanCount,
  parseMemberBody,
  takenOnRace,
  textOrNull,
  writeMemberEvents,
  type Db,
} from './common.js';
import { memberNameKey, memberNoDisplay, memberNoProblem, nameKeyWords, normalizeMemberNo } from './keys.js';
import { lockLiveMemberType } from './types.js';
// ---- Komunitas K2 (members extended) ----
import { customValuesSchema, loadCustomDefs, readCustomValues, writeCustomValues } from '../catalog/data/custom-fields.js';

/**
 * Writes the member's custom field values `values` (checked against the live `members` definitions; a required one
 * is not enforced on a member, whose record often starts from an import).
 *
 * @throws DomainError VALIDATION_FAILED at `custom.<code>`
 */
async function saveMemberCustom(tx: TxCtx, id: string, values: Record<string, unknown>): Promise<void> {
  const defs = await loadCustomDefs(tx.trx, 'members');
  const parsed = customValuesSchema(defs, 'patch').safeParse(values);
  if (!parsed.success) {
    throw memberValidationFailed(parsed.error.issues.map((issue) => ({ path: ['custom', ...issue.path.map(String)].join('.'), code: issue.code === 'unrecognized_keys' ? 'unknown_field' : issue.code })));
  }
  await writeCustomValues(tx.trx, 'members', id, parsed.data, defs, { now: tx.now, actor: tx.actor.id });
}

// Members: create, edit (suspend and reactivate are an edit of `status`), extend, archive, read, look up by number,
// search, and the member's history.
//
// - The member number is normalised (keys.ts) and unique on `member_no_key`, which ignores spaces: a number another
//   member holds (archived ones included) is `{path: 'memberNo', code: 'taken'}`, checked with a SELECT and again when
//   the write meets the unique index.
// - Dates are calendar dates in the library's time zone. A new member's `joined_on` = `valid_from` = the typed date or
//   today; `expires_on` = the typed date, else `valid_from + membership_days` of the type (null when the type never
//   expires). A member is valid up to and including `expires_on`. Changing the type never changes the dates.
// - Every write locks the member first (lockLiveMember), compares `version` and bumps it. Archiving a member with open
//   loans is 409 MEMBER_IN_USE `{openLoans, balanceMinor}` (no fines in this edition yet: the balance is 0).
// - Each write records its history (`member_events`: `created` or `imported`, `updated` with the field names,
//   `suspended`, `reactivated`, `extended` with the old and new expiry, `archived`) and, in `interactive` mode, audits
//   `members.member.*` with the field names only.

type MemberRow = Selectable<DB['members']>;

/** How a member is saved: `interactive` audits; `bulk` (the CSV import) leaves the audit to its caller. */
export interface MemberSaveOptions {
  mode?: 'interactive' | 'bulk';
  /** `members.source` of a new member (default `manual`). */
  source?: string;
  /** The history row of a write: `created`/`updated` (default) or `imported`. */
  eventType?: 'imported';
  /** Today in the library's time zone, when the caller read it already. */
  today?: string;
}

/** The API names of the personal text fields and their columns. */
const TEXT_FIELDS = Object.freeze({
  identityNo: 'identity_no',
  institution: 'institution',
  className: 'class_name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  postalCode: 'postal_code',
  mailingAddress: 'mailing_address',
  notes: 'notes',
} as const);

type TextField = keyof typeof TEXT_FIELDS;
const TEXT_KEYS = Object.keys(TEXT_FIELDS) as TextField[];

/** A live branch `id`, else the field error `{path, code: 'not_found'}`. */
async function branchError(db: Db, id: string, path: string): Promise<FieldWarning | null> {
  const row = await db.selectFrom('branches').select('archived_at').where('id', '=', id).executeTakeFirst();
  return row === undefined || row.archived_at !== null ? { path, code: 'not_found' } : null;
}

/** Whether a member other than `exceptId` holds the member number key `key`. */
async function memberNoTaken(db: Db, key: string, exceptId?: string): Promise<boolean> {
  let q = db.selectFrom('members').select('id').where('member_no_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** The member number of a body checked: its shown form, its key, and the field error (`invalid`, `taken`) or null. */
async function checkMemberNo(db: Db, raw: string, exceptId?: string): Promise<{ display: string; key: string; error: FieldWarning | null }> {
  const display = memberNoDisplay(raw);
  const key = normalizeMemberNo(raw);
  if (memberNoProblem(display) !== null) return { display, key, error: { path: 'memberNo', code: 'invalid' } };
  return { display, key, error: (await memberNoTaken(db, key, exceptId)) ? { path: 'memberNo', code: 'taken' } : null };
}

// ---- create ----------------------------------------------------------------------------------------------------------

/**
 * Creates a member (see the top of this file) and answers its id and version 0. The member type is locked while live
 * as the transaction's first statement.
 *
 * @throws DomainError NOT_FOUND for a type that is not live; VALIDATION_FAILED with every field error (`memberNo`
 *   `invalid`/`taken`, `homeBranchId` `not_found`, `birthDate` `future`)
 */
export async function createMember(tx: TxCtx, input: MemberBody, o: MemberSaveOptions = {}): Promise<{ id: string; version: number }> {
  const b = parseMemberBody(MemberBody, input);
  const { trx } = tx;
  if (!(await lockLiveMemberType(trx, b.memberTypeId))) throw memberTypeNotFound();
  const type = await trx.selectFrom('member_types').select('membership_days').where('id', '=', b.memberTypeId).executeTakeFirstOrThrow();
  const today = o.today ?? (await libraryToday(trx, tx.now));

  const errors: FieldWarning[] = [];
  const no = await checkMemberNo(trx, b.memberNo);
  if (no.error !== null) errors.push(no.error);
  if (b.homeBranchId !== undefined && b.homeBranchId !== null) {
    const e = await branchError(trx, b.homeBranchId, 'homeBranchId');
    if (e !== null) errors.push(e);
  }
  if (b.birthDate !== undefined && b.birthDate !== null && b.birthDate > today) errors.push({ path: 'birthDate', code: 'future' });
  if (errors.length > 0) throw memberValidationFailed(errors);

  const joinedOn = b.joinedOn ?? today;
  const days = type.membership_days === null ? null : Number(type.membership_days);
  const expiresOn = b.expiresOn !== undefined ? b.expiresOn : days === null ? null : addDays(joinedOn, days);
  const id = newId(tx.now);
  const text = (k: TextField): string | null => textOrNull(b[k]);
  await takenOnRace('memberNo', () =>
    trx
      .insertInto('members')
      .values({
        id,
        member_no_display: no.display,
        member_no_key: no.key,
        member_type_id: b.memberTypeId,
        home_branch_id: b.homeBranchId ?? null,
        status: 'active',
        status_note: null,
        name: b.name,
        name_key: memberNameKey(b.name),
        gender: b.gender ?? null,
        birth_date: b.birthDate ?? null,
        identity_no: text('identityNo'),
        institution: text('institution'),
        class_name: text('className'),
        email: text('email'),
        phone: text('phone'),
        address: text('address'),
        postal_code: text('postalCode'),
        mailing_address: text('mailingAddress'),
        notes: text('notes'),
        photo_file_id: null,
        locale: b.locale,
        joined_on: joinedOn,
        valid_from: joinedOn,
        expires_on: expiresOn,
        password_hash: null,
        must_reset_password: 0,
        session_version: 0,
        last_login_at: null,
        anonymized_at: null,
        source: o.source ?? 'manual',
        archived_at: null,
        version: 0,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  if (b.custom !== undefined) await saveMemberCustom(tx, id, b.custom);
  const fields = Object.keys(b)
    .filter((k) => {
      const v = b[k as keyof typeof b];
      return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
    })
    .sort();
  await writeMemberEvents(tx, id, [{ type: o.eventType ?? 'created', meta: { fields } }]);
  if ((o.mode ?? 'interactive') === 'interactive') await tx.audit({ action: 'members.member.create', entity: 'members', entityId: id, meta: { fields } });
  return { id, version: 0 };
}

// ---- update ----------------------------------------------------------------------------------------------------------

/** The member `id` read after its lock, with its version checked. */
async function lockedMember(trx: Transaction<DB>, id: string, version: number): Promise<MemberRow> {
  if (!(await lockLiveMember(trx, id))) throw memberNotFound();
  const row = await trx.selectFrom('members').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw memberNotFound();
  if (Number(row.version) !== version) throw memberStale();
  return row;
}

/**
 * Changes the fields `patch` sends (see the top of this file) and answers the new version. `status` suspends (with a
 * `statusNote`) or reactivates (the note is cleared). The audit entry names the fields whose value changed.
 *
 * @throws DomainError NOT_FOUND (no live member, or a new type that is not live); CONFLICT_STALE; VALIDATION_FAILED
 *   (`memberNo` `invalid`/`taken`, `homeBranchId` `not_found`, `birthDate` `future`, `statusNote` `required`)
 */
export async function updateMember(tx: TxCtx, id: string, input: MemberPatchBody, o: MemberSaveOptions = {}): Promise<{ id: string; version: number }> {
  const p = parseMemberBody(MemberPatchBody, input);
  const { trx } = tx;
  const before = await lockedMember(trx, id, p.version);
  const today = o.today ?? (await libraryToday(trx, tx.now));

  const errors: FieldWarning[] = [];
  const set: Updateable<DB['members']> = {};
  const fields: string[] = [];
  const change = <K extends keyof Updateable<DB['members']>>(field: string, column: K, next: Updateable<DB['members']>[K] | undefined, old: unknown): void => {
    if (next === undefined || next === old) return;
    set[column] = next;
    fields.push(field);
  };

  if (p.memberNo !== undefined) {
    const no = await checkMemberNo(trx, p.memberNo, id);
    if (no.error !== null) errors.push(no.error);
    else if (no.key !== before.member_no_key || no.display !== before.member_no_display) {
      set.member_no_display = no.display;
      set.member_no_key = no.key;
      fields.push('memberNo');
    }
  }
  if (p.memberTypeId !== undefined && p.memberTypeId !== before.member_type_id) {
    if (!(await lockLiveMemberType(trx, p.memberTypeId))) throw memberTypeNotFound();
    change('memberTypeId', 'member_type_id', p.memberTypeId, before.member_type_id);
  }
  if (p.name !== undefined && p.name !== before.name) {
    set.name = p.name;
    set.name_key = memberNameKey(p.name);
    fields.push('name');
  }
  if (p.homeBranchId !== undefined && p.homeBranchId !== null && p.homeBranchId !== before.home_branch_id) {
    const e = await branchError(trx, p.homeBranchId, 'homeBranchId');
    if (e !== null) errors.push(e);
  }
  change('homeBranchId', 'home_branch_id', p.homeBranchId, before.home_branch_id);
  change('gender', 'gender', p.gender, before.gender);
  if (p.birthDate !== undefined && p.birthDate !== null && p.birthDate > today) errors.push({ path: 'birthDate', code: 'future' });
  change('birthDate', 'birth_date', p.birthDate, before.birth_date);
  for (const k of TEXT_KEYS) {
    const v = p[k];
    if (v !== undefined) change(k, TEXT_FIELDS[k], textOrNull(v), before[TEXT_FIELDS[k]]);
  }
  change('locale', 'locale', p.locale, before.locale);
  change('expiresOn', 'expires_on', p.expiresOn, before.expires_on);

  // The status: a suspension needs a note; a reactivation clears it.
  const fromStatus = before.status as MemberStoredStatus;
  const toStatus = p.status ?? fromStatus;
  const events: { type: MemberEventType; meta?: Record<string, unknown> }[] = [];
  if (toStatus === 'suspended') {
    const note = p.statusNote !== undefined ? textOrNull(p.statusNote) : before.status_note;
    if (note === null) errors.push({ path: 'statusNote', code: 'required' });
    change('statusNote', 'status_note', note, before.status_note);
  } else {
    change('statusNote', 'status_note', null, before.status_note);
  }
  if (toStatus !== fromStatus) {
    set.status = toStatus;
    fields.push('status');
    events.push({ type: toStatus === 'suspended' ? 'suspended' : 'reactivated', meta: { fields: ['status'] } });
  }
  if (errors.length > 0) throw memberValidationFailed(errors);
  if (p.custom !== undefined && Object.keys(p.custom).length > 0) {
    await saveMemberCustom(tx, id, p.custom);
    fields.push('custom');
  }

  const updated = await takenOnRace('memberNo', () =>
    trx
      .updateTable('members')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw memberStale();
  fields.sort();
  const rest = fields.filter((f) => f !== 'status' && f !== 'statusNote');
  if (rest.length > 0 || (events.length === 0 && fields.length > 0)) events.push({ type: o.eventType ?? 'updated', meta: { fields: events.length === 0 ? fields : rest } });
  await writeMemberEvents(tx, id, events);
  if ((o.mode ?? 'interactive') === 'interactive') await tx.audit({ action: 'members.member.update', entity: 'members', entityId: id, meta: { fields } });
  return { id, version: p.version + 1 };
}

// ---- extend, archive -------------------------------------------------------------------------------------------------

/**
 * Extends a membership: the new period starts on `from` (`today`; `expiry`, the current expiry while it has not
 * passed, else today; or a date), `expires_on = start + (days ?? membershipDays)`, `valid_from = start`; `joined_on`
 * stays. History `extended {from, to}` (the old and new expiry); audit `members.member.extend`.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED `{path: 'days', code: 'required'}` (a type that
 *   never expires and no `days`)
 */
export async function extendMember(tx: TxCtx, id: string, input: MemberExtendBody): Promise<{ id: string; version: number }> {
  const b = parseMemberBody(MemberExtendBody, input);
  const { trx } = tx;
  const before = await lockedMember(trx, id, b.version);
  const type = await trx.selectFrom('member_types').select('membership_days').where('id', '=', before.member_type_id).executeTakeFirst();
  const today = await libraryToday(trx, tx.now);
  const start = b.from === 'today' ? today : b.from === 'expiry' ? (before.expires_on !== null && before.expires_on >= today ? before.expires_on : today) : b.from;
  const days = b.days ?? (type?.membership_days === null || type?.membership_days === undefined ? null : Number(type.membership_days));
  if (days === null) throw memberValidationFailed([{ path: 'days', code: 'required' }]);
  const expiresOn = addDays(start, days);
  const updated = await trx
    .updateTable('members')
    .set((eb) => ({ valid_from: start, expires_on: expiresOn, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', b.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw memberStale();
  await writeMemberEvents(tx, id, [{ type: 'extended', meta: { from: before.expires_on, to: expiresOn } }]);
  await tx.audit({ action: 'members.member.extend', entity: 'members', entityId: id, meta: { fields: ['expiresOn', 'validFrom'] } });
  return { id, version: b.version + 1 };
}

/**
 * Archives a member without open loans (`archived_at = now`, version + 1), history `archived`, audit
 * `members.member.archive`. The member's data stays (deleting is anonymisation, later work).
 *
 * @throws DomainError NOT_FOUND (none, or archived already); CONFLICT_STALE; MEMBER_IN_USE `{openLoans, balanceMinor}`
 */
export async function archiveMember(tx: TxCtx, id: string, version: number): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  await lockedMember(trx, id, version);
  const openLoans = await openLoanCount(trx, id);
  if (openLoans > 0) {
    throw new DomainError('MEMBER_IN_USE', {
      detail: `Anggota ini masih meminjam ${openLoans} eksemplar; kembalikan dahulu / This member still has ${openLoans} open loan(s); return them first`,
      meta: { openLoans, balanceMinor: 0 },
    });
  }
  const updated = await trx
    .updateTable('members')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw memberStale();
  await writeMemberEvents(tx, id, [{ type: 'archived' }]);
  await tx.audit({ action: 'members.member.archive', entity: 'members', entityId: id, meta: {} });
  return { id, version: version + 1 };
}

// ---- read ------------------------------------------------------------------------------------------------------------

/** The member type of a member as its views show it. */
async function typeRefs(db: Db, ids: readonly string[]): Promise<Map<string, MemberTypeRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.selectFrom('member_types').select(['id', 'code_display', 'name_id', 'name_en', 'loan_limit']).where('id', 'in', unique).execute();
  return new Map(
    rows.map((r) => [r.id, { id: r.id, code: r.code_display, nameId: r.name_id, nameEn: r.name_en, loanLimit: r.loan_limit === null ? null : Number(r.loan_limit) }]),
  );
}

/** A member type that is gone (never in practice: a type in use is never deleted). */
function missingType(id: string): MemberTypeRef {
  return { id, code: '?', nameId: '?', nameEn: null, loanLimit: null };
}

function memberView(row: MemberRow, type: MemberTypeRef, today: string, openLoans: number): MemberView {
  return {
    id: row.id,
    memberNo: row.member_no_display,
    type,
    homeBranchId: row.home_branch_id,
    storedStatus: row.status === 'suspended' ? 'suspended' : 'active',
    status: memberStatusOf({ ...row, anonymized_at: row.anonymized_at === null ? null : Number(row.anonymized_at), archived_at: row.archived_at === null ? null : Number(row.archived_at) }, today),
    statusNote: row.status_note,
    name: row.name,
    gender: (row.gender as Gender | null) ?? null,
    birthDate: row.birth_date,
    identityNo: row.identity_no,
    institution: row.institution,
    className: row.class_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    postalCode: row.postal_code,
    mailingAddress: row.mailing_address,
    notes: row.notes,
    photoFileId: row.photo_file_id,
    locale: row.locale === 'en' ? 'en' : 'id',
    joinedOn: row.joined_on,
    validFrom: row.valid_from,
    expiresOn: row.expires_on,
    openLoans,
    source: row.source,
    archived: row.archived_at !== null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
  };
}

async function viewOf(db: Db, row: MemberRow, now: number): Promise<MemberView> {
  const type = (await typeRefs(db, [row.member_type_id])).get(row.member_type_id) ?? missingType(row.member_type_id);
  const view = memberView(row, type, await libraryToday(db, now), await openLoanCount(db, row.id));
  // ---- Komunitas K2 (members extended) ----
  view.custom = (await readCustomValues(db, 'members', [row.id])).get(row.id) ?? {};
  return view;
}

/**
 * The member `id` as MemberView (an archived member too).
 *
 * @throws DomainError NOT_FOUND
 */
export async function getMember(db: Db, id: string, now: number): Promise<MemberView> {
  const row = await db.selectFrom('members').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw memberNotFound();
  return viewOf(db, row, now);
}

/** The live (not archived, not anonymised) member holding the member number `raw` (normalised first), or null. */
export async function findLiveMemberByNo(db: Db, raw: string): Promise<MemberRow | null> {
  const key = normalizeMemberNo(raw);
  if (memberNoProblem(key) !== null) return null;
  const row = await db.selectFrom('members').selectAll().where('member_no_key', '=', key).where('archived_at', 'is', null).where('anonymized_at', 'is', null).executeTakeFirst();
  return row ?? null;
}

/**
 * The live member holding the member number `raw` as MemberView.
 *
 * @throws DomainError NOT_FOUND
 */
export async function lookupMember(db: Db, raw: string, now: number): Promise<MemberView> {
  const row = await findLiveMemberByNo(db, raw);
  if (row === null) throw memberNotFound();
  return viewOf(db, row, now);
}

/** `s` with the LIKE wildcards (and the escape character `!`) escaped for `LIKE … ESCAPE '!'`. */
function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

/**
 * The search condition of `q` on the members table (alias `m`): the member number from its start, every word of the
 * name, the identity number or the e-mail as typed.
 */
export function memberQueryWhere(q: string): Expression<SqlBool> | null {
  const text = q.trim();
  if (text === '') return null;
  const parts: Expression<SqlBool>[] = [];
  const no = normalizeMemberNo(text);
  if (memberNoProblem(no) === null) parts.push(sql<SqlBool>`m.member_no_key like ${`${escapeLike(no)}%`} escape '!'`);
  const words = nameKeyWords(text);
  if (words.length > 0) {
    const all = words.map((w) => sql<SqlBool>`m.name_key like ${`%${escapeLike(w)}%`} escape '!'`);
    parts.push(sql<SqlBool>`(${sql.join(all, sql` and `)})`);
  }
  parts.push(sql<SqlBool>`m.identity_no = ${text}`);
  parts.push(sql<SqlBool>`m.email = ${text}`);
  return sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

function badCursor(): DomainError {
  return memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/**
 * Members by `body` (see MemberSearchBody), ordered by name then id, keyset paged: the cursor `k.<id>` names the last
 * member of the page.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function searchMembers(db: Db, body: MemberSearchBody, now: number): Promise<MemberSearchResponse> {
  const today = await libraryToday(db, now);
  let query = db.selectFrom('members as m').selectAll('m');
  if (body.status === undefined) query = query.where('m.archived_at', 'is', null).where('m.anonymized_at', 'is', null);
  else query = query.where(memberStatusWhere(body.status, today));
  if (body.typeId !== undefined) query = query.where('m.member_type_id', '=', body.typeId);
  if (body.className !== undefined && body.className !== '') query = query.where('m.class_name', '=', body.className);
  if (body.homeBranchId !== undefined) query = query.where('m.home_branch_id', '=', body.homeBranchId);
  const qWhere = body.q === undefined ? null : memberQueryWhere(body.q);
  if (qWhere !== null) query = query.where(qWhere);
  if (body.cursor !== undefined) {
    const id = /^k\.([0-9A-Z]{26})$/.exec(body.cursor)?.[1];
    if (id === undefined || !isUlid(id)) throw badCursor();
    const last = await db.selectFrom('members').select(['name_key', 'id']).where('id', '=', id).executeTakeFirst();
    if (last === undefined) throw badCursor();
    query = query.where((eb) => eb.or([eb('m.name_key', '>', last.name_key), eb.and([eb('m.name_key', '=', last.name_key), eb('m.id', '>', last.id)])]));
  }
  const rows = await query.orderBy('m.name_key').orderBy('m.id').limit(body.limit + 1).execute();
  const page = rows.slice(0, body.limit);
  const types = await typeRefs(
    db,
    page.map((r) => r.member_type_id),
  );
  const items: MemberListItem[] = page.map((r) => ({
    id: r.id,
    memberNo: r.member_no_display,
    name: r.name,
    type: types.get(r.member_type_id) ?? missingType(r.member_type_id),
    className: r.class_name,
    status: memberStatusOf({ ...r, anonymized_at: r.anonymized_at === null ? null : Number(r.anonymized_at), archived_at: r.archived_at === null ? null : Number(r.archived_at) }, today),
    expiresOn: r.expires_on,
    photoFileId: r.photo_file_id,
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > body.limit && last !== undefined ? `k.${last.id}` : null };
}

/**
 * The history of the member `id`, newest first, keyset paged by the cursor `<at>.<id>` of the last entry.
 *
 * @throws DomainError NOT_FOUND; VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function listMemberEvents(db: Db, id: string, q: MemberEventsQuery): Promise<Paged<MemberEventView>> {
  const member = await db.selectFrom('members').select('id').where('id', '=', id).executeTakeFirst();
  if (member === undefined) throw memberNotFound();
  let query = db
    .selectFrom('member_events as e')
    .leftJoin('staff_users as u', (j) => j.onRef('u.id', '=', 'e.actor_id').on('e.actor_type', '=', 'staff'))
    .select(['e.id', 'e.at', 'e.type', 'e.actor_type', 'e.actor_id', 'e.meta', 'u.name as actor_name'])
    .where('e.member_id', '=', id);
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.([0-9A-Z]{26})$/.exec(q.cursor);
    if (m === null || !isUlid(m[2]!)) throw badCursor();
    const at = Number(m[1]);
    const after = m[2]!;
    query = query.where((eb) => eb.or([eb('e.at', '<', at), eb.and([eb('e.at', '=', at), eb('e.id', '<', after)])]));
  }
  const rows = await query.orderBy('e.at', 'desc').orderBy('e.id', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const items: MemberEventView[] = page.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(r.meta);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) meta = v as Record<string, unknown>;
    } catch {
      meta = {};
    }
    return { id: r.id, at: Number(r.at), type: r.type as MemberEventType, actorType: r.actor_type, actorId: r.actor_id, actorName: r.actor_name ?? null, meta };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > q.limit && last !== undefined ? `${Number(last.at)}.${last.id}` : null };
}
