import { isDomainError, newId } from '@altis/shared';
import type { Kysely } from 'kysely';
import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0040: members and desk circulation (Komunitas). All class data, all global except the loans, which belong to the
// branch of the lent item.
//
// - member_types: the basic rules of a kind of member (school pupils, teachers, the public, ...): how long a membership
//   lasts (`membership_days`, null = it never expires), how many open loans a member may hold (`loan_limit`, null = no
//   limit, 0 = may not borrow), holds and online renewal, and the population group it counts in. Unique by `code_key`.
// - members: one library member. `member_no_key` is the member number normalised like an item barcode, unique; the
//   personal columns (name, contact, identity, class, notes, photo, password hash) are registered as personal data.
//   `status` is `active` or `suspended` (expired, archived and anonymised are read from the dates). `member_type_id`
//   has no foreign key (a type is not owned by its members; archiving a type in use is refused by the code).
// - member_events: what happened to a member (created, updated, extended, suspended, ...); they belong to the member
//   (CASCADE). `meta` names the changed fields (and the old and new expiry of an extension), never a personal value.
// - policies: the loan rules. Each dimension (member type, collection type, material type, branch) is null for "all";
//   `scope_key` is the tuple `<member type|*>/<collection type|*>/<material type|*>/<branch|*>` (archived: `~<id>`), so
//   two live rules never share a tuple. The rule's terms are copied into each loan when it is made.
// - loans: one loan of an item. `open_item_id` is the item's id while the loan is open and null once it is closed: the
//   unique index on it allows one open loan per item on every engine (NULLs are distinct). The `stat_*` columns keep
//   the statistics dimensions as they were when the item was lent.
//
// Every text column of a unique key is key191() (binary on MySQL/MariaDB, byte order on PostgreSQL); `open_item_id`
// is a ulid(), binary as well. The code enforces the narrower widths (`scope_key` 120).
//
// Seeds (inserted only when their `code_key` is absent, so a library's own edits are never overwritten): four member
// types (pupils, teachers, education staff, the public) and the general loan rule `DEFAULT` (every dimension "all",
// 7 days, one renewal, no fine), without which a new installation could not lend anything.
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0040_members_circulation';

export const membersCirculation: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'member_types', 'data', NAME, (t) => {
      t.id();
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name_id', 191);
      t.varchar('name_en', 191).nullable();
      t.varchar('accred_group', 16);
      t.smallint('membership_days').nullable();
      t.smallint('loan_limit').nullable();
      t.bool('holds_allowed').default(1);
      t.smallint('holds_limit').default(2);
      t.bool('online_renewal').default(1);
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'member_types', 'uq_member_types_code_key', ['code_key'], { unique: true });

    await ensureTable(db, dialect, 'members', 'data', NAME, (t) => {
      t.id();
      t.varchar('member_no_display', 64);
      t.key191('member_no_key');
      t.ulid('member_type_id');
      t.ulid('home_branch_id').nullable();
      t.varchar('status', 16);
      t.varchar('status_note', 191).nullable();
      t.varchar('name', 191);
      t.key191('name_key');
      t.varchar('gender', 8).nullable();
      t.date('birth_date').nullable();
      t.varchar('identity_no', 64).nullable();
      t.varchar('institution', 191).nullable();
      t.varchar('class_name', 64).nullable();
      t.varchar('email', 191).nullable();
      t.varchar('phone', 64).nullable();
      t.text('address').nullable();
      t.varchar('postal_code', 16).nullable();
      t.text('mailing_address').nullable();
      t.text('notes').nullable();
      t.ulid('photo_file_id').nullable();
      t.char('locale', 2).default('id');
      t.date('joined_on');
      t.date('valid_from');
      t.date('expires_on').nullable();
      t.varchar('password_hash', 191).nullable();
      t.bool('must_reset_password').default(0);
      t.int('session_version').default(0);
      t.timestamp('last_login_at').nullable();
      t.timestamp('anonymized_at').nullable();
      t.varchar('source', 191).nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'members', 'uq_members_member_no_key', ['member_no_key'], { unique: true });
    await ensureIndex(db, dialect, 'members', 'ix_members_name_key', ['name_key']);
    await ensureIndex(db, dialect, 'members', 'ix_members_member_type_id', ['member_type_id']);
    await ensureIndex(db, dialect, 'members', 'ix_members_class_name', ['class_name']);
    await ensureIndex(db, dialect, 'members', 'ix_members_expires_on', ['expires_on']);
    await ensureIndex(db, dialect, 'members', 'ix_members_identity_no', ['identity_no']);

    await ensureTable(db, dialect, 'member_events', 'data', NAME, (t) => {
      t.id();
      t.ulid('member_id');
      t.timestamp('at');
      t.varchar('type', 16);
      t.varchar('actor_type', 32);
      t.ulid('actor_id').nullable();
      t.json('meta');
      t.foreignKey('member_id', 'members', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'member_events', 'ix_member_events_member_id_at', ['member_id', 'at']);

    await ensureTable(db, dialect, 'policies', 'data', NAME, (t) => {
      t.id();
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name', 191);
      t.ulid('member_type_id').nullable();
      t.ulid('collection_type_id').nullable();
      t.ulid('material_type_id').nullable();
      t.ulid('branch_id').nullable();
      t.key191('scope_key');
      t.bool('loanable').default(1);
      t.smallint('loan_days');
      t.smallint('loan_limit').nullable();
      t.smallint('renew_limit').default(0);
      t.bigint('fine_per_day_minor').default(0);
      t.bigint('fine_cap_minor').nullable();
      t.smallint('grace_days').default(0);
      t.char('currency', 3);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'policies', 'uq_policies_code_key', ['code_key'], { unique: true });
    await ensureIndex(db, dialect, 'policies', 'uq_policies_scope_key', ['scope_key'], { unique: true });

    await ensureTable(db, dialect, 'loans', 'data', NAME, (t) => {
      t.id();
      t.ulid('item_id').nullable();
      t.ulid('open_item_id').nullable();
      t.ulid('record_id').nullable();
      t.ulid('member_id').nullable();
      t.ulid('branch_id');
      t.ulid('policy_id').nullable();
      t.date('loaned_on');
      t.timestamp('loaned_at');
      t.date('due_on');
      t.smallint('renewals').default(0);
      t.date('last_renewed_on').nullable();
      t.date('returned_on').nullable();
      t.timestamp('returned_at').nullable();
      t.ulid('return_branch_id').nullable();
      t.varchar('outcome', 24).nullable();
      t.smallint('loan_days');
      t.smallint('renew_limit');
      t.smallint('grace_days');
      t.bigint('fine_per_day_minor');
      t.bigint('fine_cap_minor').nullable();
      t.char('currency', 3);
      t.varchar('overrides', 64).nullable();
      t.varchar('override_note', 191).nullable();
      t.ulid('loaned_by').nullable();
      t.ulid('returned_by').nullable();
      t.varchar('source', 16);
      t.varchar('stat_ddc', 8).nullable();
      t.ulid('stat_material_type_id').nullable();
      t.ulid('stat_collection_type_id').nullable();
      t.ulid('stat_location_id').nullable();
      t.ulid('stat_member_type_id').nullable();
      t.varchar('stat_accred_group', 16).nullable();
      t.varchar('stat_class_name', 64).nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'loans', 'uq_loans_open_item_id', ['open_item_id'], { unique: true });
    await ensureIndex(db, dialect, 'loans', 'ix_loans_member_id_returned_at', ['member_id', 'returned_at']);
    await ensureIndex(db, dialect, 'loans', 'ix_loans_returned_at_due_on', ['returned_at', 'due_on']);
    await ensureIndex(db, dialect, 'loans', 'ix_loans_item_id_loaned_at', ['item_id', 'loaned_at']);
    await ensureIndex(db, dialect, 'loans', 'ix_loans_record_id_returned_at', ['record_id', 'returned_at']);
    await ensureIndex(db, dialect, 'loans', 'ix_loans_loaned_on', ['loaned_on']);
    await ensureIndex(db, dialect, 'loans', 'ix_loans_returned_on', ['returned_on']);

    await seed(db as Kysely<SeedTables>);
  },
};

// ---- seeds ---------------------------------------------------------------------------------------------------------

/** The seeded tables, as this migration knows them (a migration runs against the schema of its moment). */
type SeedTables = {
  member_types: {
    id: string;
    code_display: string;
    code_key: string;
    name_id: string;
    name_en: string | null;
    accred_group: string;
    membership_days: number | null;
    loan_limit: number | null;
    holds_allowed: number;
    holds_limit: number;
    online_renewal: number;
    sort_order: number;
    archived_at: number | null;
    version: number;
    created_at: number;
    created_by: string | null;
    updated_at: number;
    updated_by: string | null;
  };
  policies: {
    id: string;
    code_display: string;
    code_key: string;
    name: string;
    member_type_id: string | null;
    collection_type_id: string | null;
    material_type_id: string | null;
    branch_id: string | null;
    scope_key: string;
    loanable: number;
    loan_days: number;
    loan_limit: number | null;
    renew_limit: number;
    fine_per_day_minor: number;
    fine_cap_minor: number | null;
    grace_days: number;
    currency: string;
    archived_at: number | null;
    version: number;
    created_at: number;
    created_by: string | null;
    updated_at: number;
    updated_by: string | null;
  };
  settings: { key: string; value: string | null };
};

type SeedTable = 'member_types' | 'policies';

/** code, name (id), name (en), population group, membership days, open-loan limit. */
const MEMBER_TYPES: readonly (readonly [string, string, string, string, number, number])[] = [
  ['SISWA', 'Siswa', 'Pupil', 'student', 365, 3],
  ['GURU', 'Guru', 'Teacher', 'teacher', 365, 10],
  ['TENDIK', 'Tenaga kependidikan', 'Education staff', 'edu_staff', 365, 5],
  ['UMUM', 'Umum', 'General public', 'public', 365, 2],
];

/** The general rule's dimension tuple: every dimension "all". */
const ALL_SCOPE = '*/*/*/*';

/**
 * Inserts `row` unless a row with its `code_key` is there. A duplicate insert (another connection seeded it in
 * between, UNIQUE_VIOLATION) counts as seeded once the row can be read back; inside a transaction (PostgreSQL runs the
 * migrations in one) the error stands, since PostgreSQL has aborted the transaction anyway.
 */
async function seedRow<T extends SeedTable>(db: Kysely<SeedTables>, table: T, row: SeedTables[T]): Promise<void> {
  const shared = db as unknown as Kysely<Record<SeedTable, { id: string; code_key: string }>>;
  const present = async () =>
    (await shared.selectFrom(table as SeedTable).select('id').where('code_key', '=', row.code_key).executeTakeFirst()) !== undefined;
  if (await present()) return;
  try {
    await shared.insertInto(table as SeedTable).values(row as { id: string; code_key: string }).execute();
  } catch (error) {
    if (db.isTransaction || !isDomainError(error) || error.code !== 'UNIQUE_VIOLATION' || !(await present())) throw error;
  }
}

/** The library's currency (`catalog.currency`, stored as a JSON string), else IDR. */
async function libraryCurrency(db: Kysely<SeedTables>): Promise<string> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', 'catalog.currency').executeTakeFirst();
  const m = row?.value === null || row?.value === undefined ? null : /^"([A-Z]{3})"$/.exec(row.value);
  return m?.[1] ?? 'IDR';
}

async function seed(db: Kysely<SeedTables>): Promise<void> {
  const now = Date.now();
  const trail = { archived_at: null, version: 0, created_at: now, created_by: null, updated_at: now, updated_by: null };
  for (const [i, [code, nameId, nameEn, group, days, limit]] of MEMBER_TYPES.entries()) {
    await seedRow(db, 'member_types', {
      id: newId(now),
      code_display: code,
      code_key: code,
      name_id: nameId,
      name_en: nameEn,
      accred_group: group,
      membership_days: days,
      loan_limit: limit,
      holds_allowed: 1,
      holds_limit: 2,
      online_renewal: 1,
      sort_order: (i + 1) * 10,
      ...trail,
    });
  }
  // A library that already has a live rule for every dimension keeps it: the scope is unique.
  const general = await db.selectFrom('policies').select('id').where('scope_key', '=', ALL_SCOPE).executeTakeFirst();
  if (general !== undefined) return;
  await seedRow(db, 'policies', {
    id: newId(now),
    code_display: 'DEFAULT',
    code_key: 'DEFAULT',
    name: 'Aturan umum',
    member_type_id: null,
    collection_type_id: null,
    material_type_id: null,
    branch_id: null,
    scope_key: ALL_SCOPE,
    loanable: 1,
    loan_days: 7,
    loan_limit: null,
    renew_limit: 1,
    fine_per_day_minor: 0,
    fine_cap_minor: null,
    grace_days: 0,
    currency: await libraryCurrency(db),
    ...trail,
  });
}
