import type { DB } from '@altis/db';
import { localDate, newId, type AccredGroup } from '@altis/shared';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { bcryptCost, isBcryptHash, BCRYPT_MAX_COST, BCRYPT_MIN_COST } from '../../../crypto/bcrypt.js';
import { codeKey } from '../../../catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { setAttachmentMemberTypes } from '../../../members/area/account.js';
import { memberNameKey, memberNoDisplay, memberNoProblem, normalizeMemberNo } from '../../../members/keys.js';
import { guessGroup } from '../../../accreditation/slims-usage/guess.js';
import { detectType } from '../../../files/magic.js';
import { writeSettings } from '../../../settings/service.js';
import type { SettingKey } from '../../../settings/registry.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  cachedForRun,
  cutChars,
  keyOf,
  mappedRows,
  oneLine,
  quietText,
  readSourceFile,
  scanAll,
  sha256Of,
  stateOf,
  storeBlob,
  textOf,
  againOnRace,
  keyFits,
  type BatchIo,
  type Ledger,
} from './stage-b-kit.js';
import {
  archiveJson,
  dateCell,
  flagCell,
  intCell,
  localEpoch,
  mapped,
  runPeoplePhases,
  runTimeZone,
  settingFlag,
  settingScalar,
  slimsSettings,
  subjectKeyOf,
  timeCell,
  type PeoplePhase,
} from './people-kit.js';

// Members (spec K2: the SLiMS tables `mst_member_type`, `member`, `member_custom`, `biblio_mark`, `comment`, and the
// member and visit keys of `setting`). SLiMS 9 table/column names (interoperability facts, no SLiMS code). Phases:
//
// 1. `mst_member_type` → member types (entity `mst_member_type`): a code from the name (taken → `-<id>`), the group of
//    the wizard's map or guessed from the name, `member_periode` 0 → no expiry (`zero_period`), the reserve flags;
//    the SLiMS loan limit never becomes the type's total limit unless the run asks for it (`typeLimitAsTotal`): it is
//    the limit of the type's fallback rule (the circulation stage). The groups also go to the usage group map.
// 2. `member` → members (entity `member`, `source = slims:<member_id>`): the number normalised like a barcode (two
//    source numbers that collide once normalised are refused: a real run never gets here with one, a dry run reports
//    each as `member_no_collision`); the type through the map, else the run's default type (`member_type_default`),
//    else skipped `member_type_missing`; pending → suspended; a birth date that is zero, 1970-01-01 or shared by more
//    than a fifth of the members → none (`placeholder_birth_date`); dates of membership with their fallbacks; the fax
//    into the notes; a malformed e-mail dropped (`invalid_email`); the password per its kind: bcrypt of cost 4-12 kept
//    (verified, then rehashed, at the member's first sign-in), MD5, bcrypt above cost 12 and anything else → none and a
//    reset is required (`md5_password`, `bcrypt_cost_unsupported`, `password_unknown`), empty → no OPAC sign-in. The
//    gender only with `migrateGender`. A member mapped by an earlier run: skipped `already_migrated`, or with
//    `membersMode = update` re-synced field by field (see syncMember).
// 3. photos: `member.member_image` → `images/persons/<name>` of the files source (JPEG, at most 500 KB) as the
//    member's photo, unless the member has one; a missing file is reported (`missing_photo`).
// 4. `member_custom` → counted, not migrated (`custom_fields_not_migrated`).
// 5. `biblio_mark` → bookmarks (an orphan member or title skipped `orphan`).
// 6. `comment` → `migration_archive` with the member's subject key (OPAC comments are not built).
// 7. the member and visit keys of `setting` (written by a real run): `password_policy_min_length` →
//    `members.password.minLength` (clamped 6-64), `enable_visitor_limitation`/`time_visitor_limitation` →
//    `visits.dedupeMinutes`; a key SLiMS never wrote is reported with the value ALTIS keeps and why.
// 8. attachments of SLiMS member types (Phase 2 kept them `staff` with the SLiMS type ids): each id mapped → access
//    `members` with those types; an unknown id keeps the attachment `staff` (`attachment_type_unknown`).

const TT = 'mst_member_type';
const TM = 'member';
/** The member photo upload context's limit. */
const PHOTO_MAX_BYTES = 500 * 1024;
/** A birth date shared by more than this share of the members is a placeholder. */
const PLACEHOLDER_SHARE = 0.2;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

type MemberRow = Selectable<DB['members']>;

// ---- what the stage reads of the whole source -------------------------------------------------------------------

interface MemberFacts {
  /** Normalised member number → the source numbers that share it (only the shared ones). */
  collisions: Map<string, string[]>;
  /** The birth dates shared by more than a fifth of the members. */
  placeholderBirth: Set<string>;
  /** Members per SLiMS type id. */
  perType: Map<string, number>;
  /** Per SLiMS type id, an expiry shared by more than half of its members (a bulk save of the type in SLiMS). */
  typeExpiry: Map<string, { date: string; members: number }>;
}

/** What the stage needs to know of every `member` row (cached for the run). */
export function memberFacts(c: SlimsStageContext): Promise<MemberFacts> {
  return cachedForRun(c, 'members:facts', async () => {
    const byKey = new Map<string, string[]>();
    const births = new Map<string, number>();
    const perType = new Map<string, number>();
    const expiries = new Map<string, Map<string, number>>();
    let total = 0;
    await scanAll(c, TM, (row) => {
      const id = keyOf(row['member_id']);
      if (id === '') return;
      total += 1;
      const key = normalizeMemberNo(id);
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
      const birth = dateCell(row['birth_date'], { placeholder: true });
      if (birth !== null) births.set(birth, (births.get(birth) ?? 0) + 1);
      const type = keyOf(row['member_type_id']);
      if (type !== '') {
        perType.set(type, (perType.get(type) ?? 0) + 1);
        const exp = dateCell(row['expire_date']);
        if (exp !== null) {
          const m = expiries.get(type) ?? new Map<string, number>();
          m.set(exp, (m.get(exp) ?? 0) + 1);
          expiries.set(type, m);
        }
      }
    });
    const collisions = new Map([...byKey].filter(([, ids]) => ids.length > 1));
    const placeholderBirth = new Set([...births].filter(([, n]) => total > 4 && n > total * PLACEHOLDER_SHARE).map(([d]) => d));
    const typeExpiry = new Map<string, { date: string; members: number }>();
    for (const [type, m] of expiries) {
      const n = perType.get(type) ?? 0;
      for (const [date, k] of m) if (n > 4 && k > n / 2) typeExpiry.set(type, { date, members: k });
    }
    return { collisions, placeholderBirth, perType, typeExpiry };
  });
}

/** The SLiMS member types (id, name) of the source (cached for the run). */
export function sourceMemberTypes(c: SlimsStageContext): Promise<ReadonlyMap<string, SlimsRow>> {
  return cachedForRun(c, 'members:types', async () => {
    const out = new Map<string, SlimsRow>();
    await scanAll(c, TT, (row) => {
      const id = keyOf(row['member_type_id']);
      if (id !== '' && !out.has(id)) out.set(id, row);
    });
    return out;
  });
}

/** The accreditation group of the SLiMS type `id` named `name`: the wizard's choice, else a guess from the name. */
export function typeGroup(c: SlimsStageContext, id: string, name: string): AccredGroup {
  return Object.hasOwn(c.options.people.memberTypeGroups, id) ? c.options.people.memberTypeGroups[id]! : guessGroup(name);
}

// ---- 1. member types ------------------------------------------------------------------------------------------------

/** An ASCII code of at most 32 characters from a SLiMS name (`SLIMS-T<id>` when nothing is left). */
function typeCode(name: string, id: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9 -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const code = cutChars(ascii, 24).trim();
  return code === '' ? `SLIMS-T${cutChars(id, 20)}` : code;
}

async function typesBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const keys = rows.map((r) => keyOf(r['member_type_id']));
  const maps = await mappedRows(c, io.db, TT, keys);
  const facts = await memberFacts(c);
  const toMap: LegacyMapping[] = [];
  const planned = new Set<string>();
  const groups: { key: string; label: string; group: AccredGroup }[] = [];
  for (const row of rows) {
    const key = keyOf(row['member_type_id']);
    if (key === '') {
      l.skipped(TT, 'empty_key');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    const name = cutChars(oneLine(textOf(l, TT, 'member_type_name', row['member_type_name']) ?? ''), 191) || `SLiMS ${key}`;
    const group = typeGroup(c, key, name);
    groups.push({ key: `slims_type:${key}`, label: name, group });
    if (state === 'done') {
      l.skipped(TT, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TT);
      continue;
    }
    const period = intCell(row['member_periode']);
    if (period === null || period <= 0) l.report(TT, key, 'zero_period', 'member_periode=0: tanpa kedaluwarsa / no expiry');
    const limit = intCell(row['loan_limit']);
    l.report(TT, key, 'type_limit_to_rule', `loan_limit=${limit ?? 0}: batas aturan cadangan tipe / the type's fallback rule limit`);
    if ((facts.perType.get(key) ?? 0) === 0) l.report(TT, key, 'type_without_members', name);
    l.migrated(TT);
    if (io.trx === null) continue;
    let code = typeCode(name, key);
    const taken = async (k: string): Promise<boolean> =>
      planned.has(k) || (await io.db.selectFrom('member_types').select('id').where('code_key', '=', k).executeTakeFirst()) !== undefined;
    if (await taken(codeKey(code))) {
      code = cutChars(`${cutChars(code, 20)}-${key}`, 32);
      l.report(TT, key, 'code_taken', code);
    }
    planned.add(codeKey(code));
    const id = newId(c.now);
    await againOnRace(() =>
      io.trx!
        .insertInto('member_types')
        .values({
          id,
          code_display: code,
          code_key: codeKey(code),
          name_id: name,
          name_en: null,
          accred_group: group,
          membership_days: period === null || period <= 0 ? null : Math.min(period, 32_767),
          loan_limit: c.options.people.typeLimitAsTotal && limit !== null ? Math.max(0, Math.min(limit, 32_767)) : null,
          holds_allowed: flagCell(row['enable_reserve']) === false ? 0 : 1,
          holds_limit: Math.max(0, Math.min(intCell(row['reserve_limit']) ?? 2, 32_767)),
          online_renewal: 1,
          sort_order: 0,
          archived_at: null,
          version: 0,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        })
        .execute(),
    );
    toMap.push({ source: c.options.sourceName, entity: TT, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx === null) return;
  await mapLegacy(io.trx, toMap);
  await saveGroups(io.trx, c, groups);
}

/** The usage group map: a SLiMS type the map does not hold yet, or one the wizard named, takes its group. */
async function saveGroups(trx: Transaction<DB>, c: SlimsStageContext, groups: readonly { key: string; label: string; group: AccredGroup }[]): Promise<void> {
  if (groups.length === 0) return;
  const held = new Map(
    (await trx.selectFrom('usage_group_map').select(['group_key', 'accred_group']).where('group_key', 'in', groups.map((g) => g.key)).execute()).map((r) => [r.group_key, r]),
  );
  for (const g of groups) {
    const named = Object.hasOwn(c.options.people.memberTypeGroups, g.key.slice('slims_type:'.length));
    if (!held.has(g.key)) {
      await trx.insertInto('usage_group_map').values({ group_key: g.key, label: g.label, accred_group: g.group, updated_at: c.now, updated_by: null }).execute();
    } else if (named) {
      await trx.updateTable('usage_group_map').set({ label: g.label, accred_group: g.group, updated_at: c.now }).where('group_key', '=', g.key).execute();
    }
  }
  const unknown = c.options.people.unknownMemberGroup;
  if (unknown !== null) {
    const row = await trx.selectFrom('usage_group_map').select('group_key').where('group_key', '=', 'member_unknown').executeTakeFirst();
    if (row === undefined) {
      await trx.insertInto('usage_group_map').values({ group_key: 'member_unknown', label: 'SLiMS', accred_group: unknown, updated_at: c.now, updated_by: null }).execute();
    } else {
      await trx.updateTable('usage_group_map').set({ accred_group: unknown, updated_at: c.now }).where('group_key', '=', 'member_unknown').execute();
    }
  }
}

// ---- 2. members -------------------------------------------------------------------------------------------------------

/** How a SLiMS password hash comes over: kept, or none (and why). */
export function slimsPassword(raw: string): { hash: string | null; mustReset: boolean; code: 'empty' | 'kept' | 'md5_password' | 'bcrypt_cost_unsupported' | 'password_unknown' } {
  const v = raw.trim();
  if (v === '') return { hash: null, mustReset: false, code: 'empty' };
  if (isBcryptHash(v)) {
    const cost = bcryptCost(v);
    if (cost !== null && cost >= BCRYPT_MIN_COST && cost <= BCRYPT_MAX_COST) return { hash: v, mustReset: false, code: 'kept' };
    return { hash: null, mustReset: true, code: 'bcrypt_cost_unsupported' };
  }
  if (/^[0-9a-f]{32}$/i.test(v)) return { hash: null, mustReset: true, code: 'md5_password' };
  return { hash: null, mustReset: true, code: 'password_unknown' };
}

/** The values a SLiMS member row gives the member's fields (the fields a re-sync compares, by their API names). */
interface Wanted {
  memberNo: { display: string; key: string };
  name: string;
  memberTypeId: string;
  institution: string | null;
  address: string | null;
  postalCode: string | null;
  mailingAddress: string | null;
  phone: string | null;
  email: string | null;
  identityNo: string | null;
  notes: string | null;
  status: 'active' | 'suspended';
  statusNote: string | null;
  joinedOn: string;
  validFrom: string;
  expiresOn: string | null;
  birthDate: string | null;
  gender: 'female' | 'male' | null;
  password: { hash: string | null; mustReset: boolean; code: string };
  lastLoginAt: number | null;
}

async function wantedOf(c: SlimsStageContext, l: Ledger, key: string, row: SlimsRow, typeId: string, today: string, facts: MemberFacts): Promise<Wanted> {
  const text = (column: string, max: number): string | null => {
    const v = oneLine(textOf(l, TM, column, row[column]) ?? '');
    return v === '' ? null : cutChars(v, max);
  };
  const long = (column: string): string | null => {
    const v = (textOf(l, TM, column, row[column]) ?? '').trim();
    return v === '' ? null : cutChars(v, 20_000);
  };
  const display = memberNoDisplay(key);
  let email = text('member_email', 191);
  if (email !== null && !EMAIL.test(email)) {
    l.report(TM, key, 'invalid_email', 'e-mail tidak sah dikosongkan / an invalid e-mail left empty');
    email = null;
  }
  const fax = text('member_fax', 64);
  const notesBase = long('member_notes');
  const notes = fax === null ? notesBase : [notesBase, `Faks: ${fax}`].filter((x) => x !== null).join('\n');
  let birth = dateCell(row['birth_date'], { placeholder: true });
  const rawBirth = keyOf(row['birth_date']);
  if (birth !== null && facts.placeholderBirth.has(birth)) birth = null;
  if (birth === null && rawBirth !== '') l.report(TM, key, 'placeholder_birth_date', rawBirth.slice(0, 10));
  if (birth !== null && birth > today) birth = null;
  let joined = dateCell(row['member_since_date']) ?? dateCell(row['register_date']);
  if (joined === null) {
    joined = today;
    l.report(TM, key, 'joined_unknown', `member_since_date: ${today}`);
  }
  const validFrom = dateCell(row['register_date']) ?? joined;
  const expires = dateCell(row['expire_date']);
  if (expires === null) l.report(TM, key, 'expiry_missing', 'expire_date: tanpa kedaluwarsa / no expiry');
  const pending = flagCell(row['is_pending']) === true;
  const genderCell = keyOf(row['gender']);
  const gender = !c.options.people.migrateGender ? null : genderCell === '1' ? 'male' : genderCell === '0' ? 'female' : null;
  const password = slimsPassword(quietText(row['mpasswd']));
  if (password.code !== 'empty' && password.code !== 'kept') l.report(TM, key, password.code, 'wajib atur ulang sandi / a password reset is required');
  const lastLoginDate = dateCell(row['last_login']);
  const tz = await runTimeZone(c);
  return {
    memberNo: { display, key: normalizeMemberNo(key) },
    name: text('member_name', 191) ?? display,
    memberTypeId: typeId,
    institution: text('inst_name', 191),
    address: long('member_address'),
    postalCode: text('postal_code', 16),
    mailingAddress: long('member_mail_address'),
    phone: text('member_phone', 64),
    email,
    identityNo: text('pin', 64),
    notes,
    status: pending ? 'suspended' : 'active',
    statusNote: pending ? 'Dimigrasi: berstatus pending di SLiMS' : null,
    joinedOn: joined,
    validFrom,
    expiresOn: expires,
    birthDate: birth,
    gender,
    password,
    lastLoginAt: lastLoginDate === null ? null : localEpoch(tz, lastLoginDate, timeCell(row['last_login'])),
  };
}

/** The member columns of the API fields a re-sync compares. */
const SYNC_COLUMNS: readonly [keyof Wanted, keyof MemberRow][] = [
  ['name', 'name'],
  ['memberTypeId', 'member_type_id'],
  ['institution', 'institution'],
  ['address', 'address'],
  ['postalCode', 'postal_code'],
  ['mailingAddress', 'mailing_address'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['identityNo', 'identity_no'],
  ['notes', 'notes'],
  ['status', 'status'],
  ['joinedOn', 'joined_on'],
  ['validFrom', 'valid_from'],
  ['expiresOn', 'expires_on'],
  ['birthDate', 'birth_date'],
  ['gender', 'gender'],
];

/** The start of the latest real migration run before this one that succeeded (its edits came after), or null. */
function previousRunStart(c: SlimsStageContext): Promise<number | null> {
  return cachedForRun(c, 'members:previous', async () => {
    const row = await c.h.db
      .selectFrom('catalog_runs')
      .select('created_at')
      .where('kind', '=', 'migration')
      .where('dry_run', '=', 0)
      .where('status', '=', 'succeeded')
      .where('id', '<>', c.runId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : Number(row.created_at);
  });
}

/** The fields staff or the member edited in ALTIS since `since` (from the member's history), by their API names. */
async function editedSince(db: BatchIo['db'], memberIds: readonly string[], since: number | null): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (memberIds.length === 0) return out;
  let q = db
    .selectFrom('member_events')
    .select(['member_id', 'type', 'meta'])
    .where('member_id', 'in', [...memberIds])
    .where('type', 'in', ['updated', 'extended', 'suspended', 'reactivated', 'archived', 'password', 'photo'])
    .where('actor_type', 'in', ['staff', 'member']);
  if (since !== null) q = q.where('at', '>', since);
  for (const e of await q.execute()) {
    const set = out.get(e.member_id) ?? new Set<string>();
    if (e.type === 'extended') set.add('expiresOn');
    else if (e.type === 'suspended' || e.type === 'reactivated') set.add('status');
    else if (e.type === 'password') set.add('password');
    else if (e.type === 'photo') set.add('photo');
    else {
      try {
        const fields = (JSON.parse(e.meta) as { fields?: unknown }).fields;
        if (Array.isArray(fields)) for (const f of fields) if (typeof f === 'string') set.add(f === 'statusNote' ? 'status' : f);
      } catch {
        // a history row without fields names none
      }
    }
    out.set(e.member_id, set);
  }
  return out;
}

/**
 * The re-sync of a mapped member (`membersMode = update`): each field that comes from SLiMS takes the source's value,
 * except a field staff or the member edited in ALTIS since the previous run (kept, `sync_conflict` when the source
 * differs). ALTIS's own fields are never written: an scrypt password or one set in ALTIS since (a newer SLiMS hash may
 * replace an older SLiMS one), the reset flag, the session version, a later sign-in, the photo, the language. A change
 * moves the version on and writes the history row `synced` with the field names.
 */
async function syncMember(c: SlimsStageContext, io: BatchIo, l: Ledger, key: string, row: MemberRow, want: Wanted, edited: ReadonlySet<string>): Promise<void> {
  const set: Updateable<DB['members']> = {};
  const fields: string[] = [];
  const conflicts: string[] = [];
  const take = (field: string, column: keyof MemberRow, value: unknown): void => {
    if ((row[column] ?? null) === (value ?? null)) return;
    if (edited.has(field)) {
      conflicts.push(field);
      return;
    }
    (set as Record<string, unknown>)[column] = value;
    fields.push(field);
  };
  if (row.member_no_key !== want.memberNo.key || row.member_no_display !== want.memberNo.display) {
    if (edited.has('memberNo')) conflicts.push('memberNo');
    else {
      const taken = await io.db.selectFrom('members').select('id').where('member_no_key', '=', want.memberNo.key).where('id', '<>', row.id).executeTakeFirst();
      if (taken !== undefined) l.report(TM, key, 'member_no_taken', want.memberNo.display);
      else {
        set.member_no_display = want.memberNo.display;
        set.member_no_key = want.memberNo.key;
        fields.push('memberNo');
      }
    }
  }
  for (const [field, column] of SYNC_COLUMNS) {
    if (field === 'gender' && !c.options.people.migrateGender) continue;
    take(field, column, want[field]);
  }
  if (set.name !== undefined) set.name_key = memberNameKey(String(set.name));
  if (set.status !== undefined) set.status_note = want.statusNote;
  // The password: never over an scrypt hash or one set in ALTIS; a SLiMS hash may replace an older SLiMS one.
  const stored = row.password_hash;
  if (!edited.has('password') && (stored === null || isBcryptHash(stored)) && (stored ?? null) !== (want.password.hash ?? null)) {
    if (want.password.hash !== null || want.password.mustReset) {
      set.password_hash = want.password.hash;
      if (want.password.mustReset) set.must_reset_password = 1;
      fields.push('password');
    }
  }
  if (want.lastLoginAt !== null && (row.last_login_at === null || Number(row.last_login_at) < want.lastLoginAt)) set.last_login_at = want.lastLoginAt;
  if (conflicts.length > 0) l.report(TM, key, 'sync_conflict', conflicts.sort().join(','));
  l.migrated(TM);
  if (fields.length === 0) {
    if (io.trx !== null && set.last_login_at !== undefined) await io.trx.updateTable('members').set({ last_login_at: set.last_login_at }).where('id', '=', row.id).execute();
    return;
  }
  fields.sort();
  l.changed(TM);
  if (io.trx === null) {
    l.report(TM, key, 'sync_change', fields.join(','));
    return;
  }
  await io.trx
    .updateTable('members')
    .set((eb) => ({ ...set, version: eb('version', '+', 1), updated_at: c.now }))
    .where('id', '=', row.id)
    .execute();
  await io.trx
    .insertInto('member_events')
    .values({ id: newId(c.now), member_id: row.id, at: c.now, type: 'synced', actor_type: 'system', actor_id: null, meta: JSON.stringify({ fields }) })
    .execute();
}

/** The ALTIS type of SLiMS type `slimsType` (a dry run names a type the run would make `~<id>`), or null. */
async function typeOf(c: SlimsStageContext, io: BatchIo, types: ReadonlyMap<string, string>, slimsType: string): Promise<string | null> {
  const t = types.get(slimsType);
  if (t !== undefined) return t;
  if (io.trx === null && slimsType !== '' && (await sourceMemberTypes(c)).has(slimsType)) return `~${slimsType}`;
  return null;
}

async function membersBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, at: { c: string | null; n: number }): Promise<void> {
  const facts = await memberFacts(c);
  const tz = await runTimeZone(c);
  const today = localDate(tz, c.now);
  if (at.c === null && at.n === 0) {
    for (const [type, e] of facts.typeExpiry) l.report(TT, type, 'type_expiry_same_date', `${e.date}: ${e.members} anggota / members`);
  }
  const keys = rows.map((r) => keyOf(r['member_id']));
  const maps = await mappedRows(c, io.db, TM, keys);
  const types = await mapped(c, io.db, TT, rows.map((r) => keyOf(r['member_type_id'])));
  const mappedIds = [...maps.values()].map((m) => m.targetId);
  const stored = new Map<string, MemberRow>();
  for (let i = 0; i < mappedIds.length; i += 500) {
    for (const r of await io.db.selectFrom('members').selectAll().where('id', 'in', mappedIds.slice(i, i + 500)).execute()) stored.set(r.id, r);
  }
  const update = c.options.people.membersMode === 'update';
  const edited = update ? await editedSince(io.db, mappedIds, await previousRunStart(c)) : new Map<string, Set<string>>();
  const toMap: LegacyMapping[] = [];
  const planned = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row['member_id']);
    if (key === '') {
      l.skipped(TM, 'empty_key');
      continue;
    }
    const m = maps.get(key);
    const state = stateOf(c, m);
    if (state === 'replay') {
      l.migrated(TM);
      continue;
    }
    const normalized = normalizeMemberNo(key);
    if (facts.collisions.has(normalized)) {
      l.skipped(TM, 'member_no_collision');
      l.report(TM, key, 'member_no_collision', facts.collisions.get(normalized)!.join(' | '));
      continue;
    }
    if (memberNoProblem(memberNoDisplay(key)) !== null || Array.from(key).length > 191) {
      l.skipped(TM, 'invalid_member_no');
      l.report(TM, key, 'invalid_member_no', 'Nomor anggota tidak dapat dipakai / The member number cannot be used');
      continue;
    }
    const slimsType = keyOf(row['member_type_id']);
    let typeId = await typeOf(c, io, types, slimsType);
    if (typeId === null) {
      typeId = c.options.people.defaultMemberTypeId;
      if (typeId === null) {
        l.skipped(TM, 'member_type_missing');
        l.report(TM, key, 'member_type_missing', `member_type_id=${slimsType || '-'}`);
        continue;
      }
      l.report(TM, key, 'member_type_default', `member_type_id=${slimsType || '-'}`);
    }
    if (state === 'done') {
      const before = stored.get(m!.targetId);
      if (!update || before === undefined) {
        l.skipped(TM, 'already_migrated');
        continue;
      }
      if (before.archived_at !== null || before.anonymized_at !== null) {
        l.skipped(TM, 'archived_in_altis');
        continue;
      }
      const want = await wantedOf(c, l, key, row, typeId, today, facts);
      await syncMember(c, io, l, key, before, want, edited.get(before.id) ?? new Set());
      continue;
    }
    const want = await wantedOf(c, l, key, row, typeId, today, facts);
    const taken =
      planned.has(want.memberNo.key) ||
      (await io.db.selectFrom('members').select('id').where('member_no_key', '=', want.memberNo.key).executeTakeFirst()) !== undefined;
    if (taken) {
      l.skipped(TM, 'member_no_taken');
      l.report(TM, key, 'member_no_taken', 'Nomor sudah dipakai anggota ALTIS / The number is held by an ALTIS member');
      continue;
    }
    planned.add(want.memberNo.key);
    l.migrated(TM);
    if (io.trx === null) continue;
    const id = newId(c.now);
    await againOnRace(() =>
      io.trx!
        .insertInto('members')
        .values({
          id,
          member_no_display: want.memberNo.display,
          member_no_key: want.memberNo.key,
          member_type_id: want.memberTypeId,
          home_branch_id: null,
          status: want.status,
          status_note: want.statusNote,
          name: want.name,
          name_key: memberNameKey(want.name),
          gender: want.gender,
          birth_date: want.birthDate,
          identity_no: want.identityNo,
          institution: want.institution,
          class_name: null,
          email: want.email,
          phone: want.phone,
          address: want.address,
          postal_code: want.postalCode,
          mailing_address: want.mailingAddress,
          notes: want.notes,
          photo_file_id: null,
          joined_on: want.joinedOn,
          valid_from: want.validFrom,
          expires_on: want.expiresOn,
          password_hash: want.password.hash,
          must_reset_password: want.password.mustReset ? 1 : 0,
          last_login_at: want.lastLoginAt,
          anonymized_at: null,
          source: cutChars(`slims:${key}`, 191),
          archived_at: null,
          version: 0,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        })
        .execute(),
    );
    await io.trx
      .insertInto('member_events')
      .values({ id: newId(c.now), member_id: id, at: c.now, type: 'migrated', actor_type: 'system', actor_id: null, meta: JSON.stringify({ source: c.options.sourceName }) })
      .execute();
    toMap.push({ source: c.options.sourceName, entity: TM, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

// ---- 3. photos ------------------------------------------------------------------------------------------------------

interface StoredPhoto {
  fileId: string;
  size: number;
  sha256: string;
  name: string;
}

/** Reads and stores the photos of a batch's members that have none yet (outside the transaction). */
async function photosBefore(c: SlimsStageContext, rows: readonly SlimsRow[]): Promise<Map<string, StoredPhoto | { missing: string }>> {
  const out = new Map<string, StoredPhoto | { missing: string }>();
  const wanted = rows.filter((r) => oneLine(quietText(r['member_image'])) !== '');
  if (wanted.length === 0) return out;
  const targets = await mapped(c, c.h.db, TM, wanted.map((r) => keyOf(r['member_id'])));
  const holders = new Set<string>();
  const ids = [...targets.values()];
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of await c.h.db.selectFrom('members').select('id').where('id', 'in', ids.slice(i, i + 500)).where('photo_file_id', 'is not', null).execute()) holders.add(r.id);
  }
  for (const row of wanted) {
    const key = keyOf(row['member_id']);
    const target = targets.get(key);
    if (!c.dryRun && (target === undefined || holders.has(target))) continue;
    const image = oneLine(quietText(row['member_image']));
    const rel = `images/persons/${image}`;
    const file = await readSourceFile(c, rel, PHOTO_MAX_BYTES, { keep: !c.dryRun, declaredOnly: c.dryRun });
    if (file.kind !== 'ok') {
      out.set(key, { missing: file.kind === 'missing' ? `${cutChars(rel, 200)}` : `${cutChars(rel, 200)} > 500 KB` });
      continue;
    }
    if (c.dryRun) continue;
    if (detectType(file.head).kind !== 'jpeg') {
      out.set(key, { missing: `${cutChars(rel, 200)}: bukan JPEG / not a JPEG` });
      continue;
    }
    const bytes = file.bytes!;
    const fileId = newId(c.now);
    const meta = { size: bytes.byteLength, sha256: sha256Of(bytes) };
    await storeBlob(c, fileId, bytes, meta);
    out.set(key, { fileId, ...meta, name: cutChars(image.split('/').pop() ?? image, 191) });
  }
  return out;
}

async function photosBatch(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo, l: Ledger, pre: unknown): Promise<void> {
  const photos = pre as Map<string, StoredPhoto | { missing: string }>;
  if (photos.size === 0) return;
  const targets = await mapped(c, io.db, TM, [...photos.keys()]);
  for (const [key, p] of photos) {
    if ('missing' in p) {
      l.report(TM, key, 'missing_photo', p.missing);
      continue;
    }
    const memberId = targets.get(key);
    if (io.trx === null || memberId === undefined) continue;
    await io.trx
      .insertInto('files')
      .values({
        id: p.fileId,
        original_name: p.name,
        mime: 'image/jpeg',
        size: p.size,
        sha256: p.sha256,
        context: 'members.photo',
        owner_type: 'members',
        owner_id: memberId,
        access: 'staff',
        status: 'ok',
        created_at: c.now,
        created_by: null,
      })
      .execute();
    await io.trx.updateTable('members').set({ photo_file_id: p.fileId }).where('id', '=', memberId).where('photo_file_id', 'is', null).execute();
  }
}

// ---- 5. bookmarks, 6. comments ----------------------------------------------------------------------------------------

async function bookmarksBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'biblio_mark';
  const keyOfMark = (r: SlimsRow): string => keyOf(r['id']) || `${keyOf(r['member_id'])}|${keyOf(r['biblio_id'])}`;
  const maps = await mappedRows(c, io.db, T, rows.map(keyOfMark));
  const members = await mapped(c, io.db, TM, rows.map((r) => keyOf(r['member_id'])));
  const records = await mapped(c, io.db, 'biblio', rows.map((r) => keyOf(r['biblio_id'])));
  const known = io.trx === null ? await sourceMemberKeys(c) : new Set<string>();
  const seen = new Set<string>();
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const key = keyOfMark(row);
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(T, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(T);
      continue;
    }
    const memberId = members.get(keyOf(row['member_id']));
    const recordId = records.get(keyOf(row['biblio_id']));
    if (recordId === undefined || (memberId === undefined && !known.has(keyOf(row['member_id'])))) {
      l.skipped(T, 'orphan');
      continue;
    }
    if (memberId === undefined) {
      l.migrated(T);
      continue;
    }
    const pair = `${memberId}:${recordId}`;
    const held =
      seen.has(pair) ||
      (await io.db.selectFrom('member_bookmarks').select('member_id').where('member_id', '=', memberId).where('record_id', '=', recordId).executeTakeFirst()) !== undefined;
    seen.add(pair);
    if (held) {
      l.skipped(T, 'duplicate');
      continue;
    }
    l.migrated(T);
    if (io.trx === null) continue;
    await io.trx.insertInto('member_bookmarks').values({ member_id: memberId, record_id: recordId, created_at: c.now }).execute();
    if (keyFits(key)) toMap.push({ source: c.options.sourceName, entity: T, legacyKey: key, targetId: memberId, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

/** The member ids of the source (cached for the run). */
export function sourceMemberKeys(c: SlimsStageContext): Promise<ReadonlySet<string>> {
  return cachedForRun(c, 'members:keys', async () => {
    const out = new Set<string>();
    await scanAll(c, TM, (row) => {
      const k = keyOf(row['member_id']);
      if (k !== '') out.add(k);
    });
    return out;
  });
}

/** Rows of `table` kept whole in `migration_archive`, each with the subject key of the member it names. */
export async function archiveRows(c: SlimsStageContext, io: BatchIo, l: Ledger, table: string, rows: readonly { key: string; row: SlimsRow; slimsMember: string }[]): Promise<void> {
  if (rows.length === 0) return;
  const held = new Map<string, string>();
  const keys = rows.map((r) => r.key);
  for (let i = 0; i < keys.length; i += 500) {
    for (const r of await io.db
      .selectFrom('migration_archive')
      .select(['legacy_key', 'run_id'])
      .where('source', '=', c.options.sourceName)
      .where('table_name', '=', table)
      .where('legacy_key', 'in', keys.slice(i, i + 500))
      .execute()) {
      held.set(r.legacy_key, r.run_id);
    }
  }
  const members = await mapped(c, io.db, TM, rows.map((r) => r.slimsMember));
  for (const r of rows) {
    const run = held.get(r.key);
    if (run !== undefined && run !== c.runId) {
      l.skipped(table, 'already_migrated');
      continue;
    }
    l.archived(table);
    if (run !== undefined || io.trx === null) continue;
    held.set(r.key, c.runId);
    await io.trx
      .insertInto('migration_archive')
      .values({
        id: newId(c.now),
        run_id: c.runId,
        source: c.options.sourceName,
        table_name: table,
        legacy_key: r.key,
        row_json: archiveJson(r.row),
        created_at: c.now,
        subject_key: await subjectKeyOf(c, r.slimsMember, members.get(r.slimsMember) ?? null),
      })
      .execute();
  }
}

async function commentsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'comment';
  const out: { key: string; row: SlimsRow; slimsMember: string }[] = [];
  for (const row of rows) {
    const key = keyOf(row['comment_id']);
    if (key === '') {
      l.skipped(T, 'empty_key');
      continue;
    }
    out.push({ key, row, slimsMember: keyOf(row['member_id']) });
  }
  await archiveRows(c, io, l, T, out);
}

async function customBatch(c: SlimsStageContext, rows: readonly SlimsRow[], _io: BatchIo, l: Ledger, at: { c: string | null; n: number }): Promise<void> {
  if (at.c === null && at.n === 0) l.report('member_custom', null, 'custom_fields_not_migrated', 'Ruas tambahan anggota SLiMS belum dipindahkan / SLiMS member custom fields are not moved yet');
  l.skipped('member_custom', 'custom_fields_not_migrated', rows.length);
}

// ---- 7. settings, 8. attachment access ------------------------------------------------------------------------------

async function settingsOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const settings = await slimsSettings(c);
  const patch: Partial<Record<SettingKey, unknown>> = {};
  const limit = settings.get('enable_visitor_limitation');
  if (limit === undefined) {
    l.report('setting', 'enable_visitor_limitation', 'setting_missing', 'Tidak ada di SLiMS: memakai default ALTIS (penekan kunjungan berulang aktif, 60 menit); perilaku bawaan SLiMS: mati / Not in SLiMS: the ALTIS default is kept (repeat check-ins suppressed, 60 minutes); SLiMS by default: off');
  } else if (settingFlag(settingScalar(limit)) === false) {
    patch['visits.dedupeMinutes'] = 0;
  } else {
    const minutes = Number(settingScalar(settings.get('time_visitor_limitation') ?? '') ?? NaN);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 720) patch['visits.dedupeMinutes'] = minutes;
    else l.report('setting', 'time_visitor_limitation', 'setting_missing', 'Tidak ada atau tidak sah: memakai 60 menit / Missing or not valid: 60 minutes kept');
  }
  const min = settings.get('password_policy_min_length');
  if (min === undefined) l.report('setting', 'password_policy_min_length', 'setting_missing', 'Tidak ada di SLiMS: memakai default ALTIS (8) / Not in SLiMS: the ALTIS default (8) is kept');
  else {
    const n = Number(settingScalar(min) ?? NaN);
    if (Number.isFinite(n)) patch['members.password.minLength'] = Math.max(6, Math.min(64, Math.trunc(n)));
  }
  for (const [name] of settings) {
    if (name.startsWith('password_policy_') && name !== 'password_policy_min_length') {
      l.report('setting', name, 'setting_reported', 'ALTIS tanpa aturan komposisi sandi / ALTIS has no password composition rules');
    }
  }
  for (const name of ['membercard_print_settings', 'enable_counter_by_ip', 'allowed_counter_ip']) {
    if (settings.has(name)) l.report('setting', name, 'setting_reported', 'Dilaporkan saja / Reported only');
  }
  if (io.trx !== null && Object.keys(patch).length > 0) await writeSettings(io.trx, patch, { keyring: [], now: c.now, actorId: null });
}

async function attachmentAccessOnce(c: SlimsStageContext, _rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const rows = await io.db.selectFrom('attachments').select(['id', 'file_id', 'legacy_access_limit']).where('access', '=', 'staff').where('legacy_access_limit', 'is not', null).execute();
  if (rows.length === 0) return;
  const types = await mapped(
    c,
    io.db,
    TT,
    rows.flatMap((r) => idsOf(r.legacy_access_limit)),
  );
  for (const a of rows) {
    const ids = idsOf(a.legacy_access_limit);
    const unknown = ids.filter((id) => !types.has(id));
    if (ids.length === 0 || unknown.length > 0) {
      l.report('biblio_attachment', a.id, 'attachment_type_unknown', `member_type_id=${unknown.join(',') || '-'}`);
      continue;
    }
    if (io.trx === null) continue;
    await io.trx.updateTable('attachments').set({ access: 'members' }).where('id', '=', a.id).where('access', '=', 'staff').execute();
    if (a.file_id !== null) await io.trx.updateTable('files').set({ access: 'members' }).where('id', '=', a.file_id).execute();
    await setAttachmentMemberTypes(io.trx, a.id, [...new Set(ids.map((id) => types.get(id)!))]);
  }
}

/** The SLiMS member type ids an attachment kept (`legacy_access_limit`, a JSON list). */
function idsOf(json: string | null): string[] {
  if (json === null) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => /^[0-9]{1,11}$/.test(x)) : [];
  } catch {
    return [];
  }
}

const PHASES: readonly PeoplePhase[] = Object.freeze([
  { table: TT, run: (c, rows, io, l) => typesBatch(c, rows, io, l) },
  { table: TM, run: (c, rows, io, l, at) => membersBatch(c, rows, io, l, at) },
  { table: TM, before: photosBefore, undo: undoPhotos, run: (c, rows, io, l, _at, pre) => photosBatch(c, rows, io, l, pre) },
  { table: 'member_custom', run: (c, rows, io, l, at) => customBatch(c, rows, io, l, at) },
  { table: 'biblio_mark', run: (c, rows, io, l) => bookmarksBatch(c, rows, io, l) },
  { table: 'comment', run: (c, rows, io, l) => commentsBatch(c, rows, io, l) },
  { table: null, run: (c, rows, io, l) => settingsOnce(c, rows, io, l) },
  { table: null, run: (c, rows, io, l) => attachmentAccessOnce(c, rows, io, l) },
] satisfies PeoplePhase[]);

/** The photos a failed batch stored are removed (best effort). */
async function undoPhotos(c: SlimsStageContext, pre: unknown): Promise<void> {
  for (const p of (pre as Map<string, StoredPhoto | { missing: string }>).values()) if (!('missing' in p)) await c.storage.delete(p.fileId).catch(() => undefined);
}

/** The members stage (see the top of this file). */
export const membersStage: SlimsStage = Object.freeze({
  name: 'members' as const,
  reads: Object.freeze([TT, TM, 'member_custom', 'biblio_mark', 'comment']) as readonly string[],
  run: (c: SlimsStageContext, cursor: string | null) => runPeoplePhases(c, 'members', PHASES, cursor, (x) => previousRunStart(x)),
});
