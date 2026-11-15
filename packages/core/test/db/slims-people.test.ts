import { randomBytes } from 'node:crypto';
import { withTx } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { lendItem, returnItem } from '../../src/circulation/desk.js';
import { anonymizeMember } from '../../src/members/ext/privacy.js';
import { readCustomValues } from '../../src/catalog/data/custom-fields.js';
import { updateMember } from '../../src/members/members.js';
import { markSlimsCutoverStep, slimsCutover } from '../../src/migration/slims/cutover.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import '../../src/migration/slims/privacy.js';
import { circulationStage } from '../../src/migration/slims/stages/circulation.js';
import { membersStage, slimsPassword } from '../../src/migration/slims/stages/members.js';
import { memberSubjectKeyIn } from '../../src/migration/slims/stages/people-kit.js';
import { __setSlimsStageBBatch } from '../../src/migration/slims/stages/stage-b-kit.js';
import { staffStage } from '../../src/migration/slims/stages/staff.js';
import { visitsStage } from '../../src/migration/slims/stages/visits.js';
import { readSettings } from '../../src/settings/service.js';
import { fakeSlimsFactory, type FakeSlimsTable } from '../fixtures/slims-fake.js';
import { ACTOR, NOW, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The SLiMS migration's member, staff, visit and circulation stages on the engine picked by ALTIS_TEST_DB, through the
// real framework (an in-memory source of synthetic SLiMS rows, written for this test; the catalogue is seeded in ALTIS
// with its legacy map, as the catalogue stages would leave it). SLiMS 9 table/column names (interoperability facts, no
// SLiMS code). Checked: members with their passwords, statuses and dates; staff as disabled accounts; visits with
// repeats, guests and members who are gone; rules, the calendar, loans (a renewal's return date does not close a
// loan, two open loans of one copy), fines, holds and reads; "Cocokkan dengan SLiMS"; a run stopped after every batch
// and one whose counts were lost after a commit end as one never stopped; a re-sync that keeps a field edited in
// ALTIS; `replace` refused once ALTIS lends; member numbers that collide once normalised refuse the real run; the
// cut-over checklist; anonymising a member removes the archived rows about them.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const DB_SOURCE = { host: 'slims.internal', port: 3306, user: 'baca', database: 'slims', tls: false };
/** A bcrypt hash of cost 4 (its form is what the migration reads). */
const BCRYPT4 = `$2y$04$${'a'.repeat(22)}${'b'.repeat(31)}`;
const BCRYPT13 = `$2y$13$${'c'.repeat(22)}${'d'.repeat(31)}`;

const t = (columns: string[], rows: Record<string, string | number | null>[], primaryKey: string[] = [columns[0]!]): FakeSlimsTable => ({ columns, primaryKey, rows });

/** The synthetic SLiMS source. */
function slimsTables(o: { phone?: string; name?: string; collide?: boolean; job?: string } = {}): Record<string, FakeSlimsTable> {
  const member = (id: string, type: number | null, extra: Record<string, string | number | null> = {}): Record<string, string | number | null> => ({
    member_id: id,
    member_name: `Anggota ${id}`,
    gender: 1,
    birth_date: '2010-05-01',
    member_type_id: type,
    member_address: 'Jl. Contoh 1',
    member_mail_address: null,
    member_email: `${id.toLowerCase()}@example.test`,
    postal_code: '40111',
    inst_name: 'SMA Contoh',
    member_image: null,
    pin: null,
    member_phone: '0800',
    member_fax: null,
    member_since_date: '2024-07-15',
    register_date: '2024-07-15',
    expire_date: '2027-06-30',
    member_notes: null,
    is_pending: 0,
    mpasswd: '',
    last_login: null,
    ...extra,
  });
  const memberCols = Object.keys(member('X', 1));
  return {
    mst_member_type: t(
      ['member_type_id', 'member_type_name', 'loan_limit', 'loan_periode', 'enable_reserve', 'reserve_limit', 'member_periode', 'reborrow_limit', 'fine_each_day', 'grace_periode'],
      [
        { member_type_id: 1, member_type_name: 'Siswa', loan_limit: 2, loan_periode: 7, enable_reserve: 1, reserve_limit: 2, member_periode: 365, reborrow_limit: 1, fine_each_day: 500, grace_periode: 2 },
        { member_type_id: 2, member_type_name: 'Guru', loan_limit: 0, loan_periode: 14, enable_reserve: 1, reserve_limit: 3, member_periode: 0, reborrow_limit: 2, fine_each_day: 0, grace_periode: 0 },
        { member_type_id: 3, member_type_name: 'Umum', loan_limit: 1, loan_periode: 7, enable_reserve: 0, reserve_limit: 0, member_periode: 30, reborrow_limit: 0, fine_each_day: 1000, grace_periode: 0 },
      ],
    ),
    member: t(memberCols, [
      member('M001', 1, { mpasswd: BCRYPT4, member_fax: '021-1234', pin: '0012345678', member_image: 'm001.jpg', member_phone: o.phone ?? '0800', member_name: o.name ?? 'Anggota M001' }),
      member('M002', 1, { mpasswd: 'e10adc3949ba59abbe56e057f20f883e', is_pending: 1, member_email: 'bukan-email', expire_date: '2025-01-31' }),
      member('M003', 2, { mpasswd: BCRYPT13, birth_date: '0000-00-00', member_since_date: null, register_date: '2023-01-10', expire_date: '2027-01-01' }),
      member('M005', 9),
      member('M006', 1, { expire_date: null }),
      ...(o.collide === true ? [member('m 007', 1), member('M007', 1)] : []),
    ]),
    // Member custom fields: a text and a date field; M002's date is no date, M005's member is not migrated, M999 is gone.
    mst_custom_field: t(['field_id', 'primary_table', 'dbfield', 'label', 'type', 'data', 'is_public', 'indexed'], [
      { field_id: 8, primary_table: 'member', dbfield: 'cf_m1', label: 'Pekerjaan', type: 'text', data: null, is_public: 1, indexed: 1 },
      { field_id: 9, primary_table: 'member', dbfield: 'cf_m2', label: 'Tanggal Lulus', type: 'date', data: null, is_public: 0, indexed: 0 },
    ]),
    member_custom: t(['member_id', 'cf_m1', 'cf_m2'], [
      { member_id: 'M001', cf_m1: o.job ?? 'Guru Honorer', cf_m2: '2026-06-30' },
      { member_id: 'M002', cf_m1: 'Pelajar', cf_m2: 'bukan tanggal' },
      { member_id: 'M005', cf_m1: 'Karyawan', cf_m2: null },
      { member_id: 'M999', cf_m1: 'Lulusan', cf_m2: null },
    ]),
    biblio_mark: t(['id', 'member_id', 'biblio_id'], [
      { id: 'k1', member_id: 'M001', biblio_id: 1 },
      { id: 'k2', member_id: 'M999', biblio_id: 1 },
    ]),
    comment: t(['comment_id', 'biblio_id', 'member_id', 'comment'], [
      { comment_id: 1, biblio_id: 1, member_id: 'M001', comment: 'Bagus' },
      { comment_id: 2, biblio_id: 2, member_id: 'M002', comment: 'Seru' },
    ]),
    setting: t(['setting_id', 'setting_name', 'setting_value'], [
      { setting_id: 1, setting_name: 'ignore_holidays_fine_calc', setting_value: 'b:1;' },
      { setting_id: 2, setting_name: 'password_policy_min_length', setting_value: 's:1:"6";' },
    ]),
    user: t(['user_id', 'username', 'realname', 'passwd'], [
      { user_id: 1, username: 'admin', realname: 'Administrator', passwd: BCRYPT4 },
      { user_id: 2, username: 'pustakawan', realname: 'Petugas Satu', passwd: BCRYPT4 },
    ]),
    user_group: t(['group_id', 'group_name'], [{ group_id: 1, group_name: 'Petugas Sirkulasi' }]),
    group_access: t(['group_id', 'module_id', 'r', 'w'], [{ group_id: 1, module_id: 5, r: 1, w: 1 }], ['group_id', 'module_id']),
    mst_module: t(['module_id', 'module_name', 'module_path'], [{ module_id: 5, module_name: 'circulation', module_path: 'circulation' }]),
    system_log: t(['log_id', 'log_msg'], [{ log_id: 1, log_msg: 'a' }, { log_id: 2, log_msg: 'b' }]),
    mst_visitor_room: t(['room_id', 'room_name', 'unique_code'], [{ room_id: 1, room_name: 'Ruang Baca', unique_code: 'RB' }]),
    visitor_count: t(['visitor_id', 'member_id', 'member_name', 'institution', 'room_code', 'checkin_date'], [
      { visitor_id: 1, member_id: 'M001', member_name: 'Anggota M001', institution: null, room_code: 'RB', checkin_date: '2026-03-02 08:00:00' },
      { visitor_id: 2, member_id: 'M001', member_name: 'Anggota M001', institution: null, room_code: 'RB', checkin_date: '2026-03-02 08:30:00' },
      { visitor_id: 3, member_id: '', member_name: 'Tamu A', institution: 'SMP 2', room_code: 'RB', checkin_date: '2026-03-02 09:00:00' },
      { visitor_id: 4, member_id: 'M999', member_name: 'Lulus', institution: null, room_code: 'RB', checkin_date: '2026-04-01 10:00:00' },
      { visitor_id: 5, member_id: 'M003', member_name: 'Anggota M003', institution: null, room_code: 'XX', checkin_date: '2026-04-01 10:00:00' },
      { visitor_id: 6, member_id: 'M001', member_name: 'Anggota M001', institution: null, room_code: 'RB', checkin_date: '0000-00-00 00:00:00' },
      { visitor_id: 7, member_id: 'M003', member_name: 'Anggota M003', institution: null, room_code: 'RB', checkin_date: '2026-04-02 11:00:00' },
      { visitor_id: 8, member_id: 'M003', member_name: 'Anggota M003', institution: null, room_code: 'RB', checkin_date: '2026-04-02 11:00:00' },
    ]),
    mst_loan_rules: t(['loan_rules_id', 'member_type_id', 'coll_type_id', 'gmd_id', 'loan_limit', 'loan_periode', 'reborrow_limit', 'fine_each_day', 'grace_periode'], [
      { loan_rules_id: 1, member_type_id: 2, coll_type_id: 0, gmd_id: 0, loan_limit: 5, loan_periode: 21, reborrow_limit: 1, fine_each_day: 0, grace_periode: 0 },
      { loan_rules_id: 2, member_type_id: 1, coll_type_id: 1, gmd_id: 0, loan_limit: 3, loan_periode: 10, reborrow_limit: 1, fine_each_day: 500, grace_periode: 0 },
      { loan_rules_id: 3, member_type_id: 1, coll_type_id: 1, gmd_id: 0, loan_limit: 9, loan_periode: 30, reborrow_limit: 0, fine_each_day: 0, grace_periode: 0 },
      { loan_rules_id: 4, member_type_id: 1, coll_type_id: 7, gmd_id: 0, loan_limit: 1, loan_periode: 3, reborrow_limit: 0, fine_each_day: 0, grace_periode: 0 },
    ]),
    holiday: t(['holiday_id', 'holiday_dayname', 'holiday_date', 'description'], [
      { holiday_id: 1, holiday_dayname: 'Sun', holiday_date: null, description: null },
      { holiday_id: 2, holiday_dayname: 'Mon', holiday_date: '2026-08-17', description: 'HUT RI' },
      { holiday_id: 3, holiday_dayname: 'Tue', holiday_date: '2026-08-18', description: 'HUT RI' },
      ...[1, 2, 3, 4, 5, 6].map((d) => ({ holiday_id: 10 + d, holiday_dayname: 'Mon', holiday_date: `2009-06-0${d}`, description: 'Contoh' })),
    ]),
    item: t(['item_id', 'biblio_id', 'item_code'], [1, 2, 3, 4, 5].map((n) => ({ item_id: 100 + n, biblio_id: n, item_code: `B00${n}` }))),
    loan: t(['loan_id', 'item_code', 'member_id', 'loan_date', 'due_date', 'renewed', 'loan_rules_id', 'is_lent', 'is_return', 'return_date', 'uid'], [
      // Renewed once: SLiMS filled return_date, the loan is still out.
      { loan_id: 1, item_code: 'B001', member_id: 'M001', loan_date: '2026-08-20', due_date: '2026-08-27', renewed: 1, loan_rules_id: 2, is_lent: 1, is_return: 0, return_date: '2026-08-25', uid: 2 },
      { loan_id: 2, item_code: 'B002', member_id: 'M003', loan_date: '2026-08-25', due_date: '2026-09-08', renewed: 0, loan_rules_id: 1, is_lent: 1, is_return: 0, return_date: null, uid: 77 },
      { loan_id: 3, item_code: 'B003', member_id: 'M001', loan_date: '2026-07-01', due_date: '2026-07-08', renewed: 0, loan_rules_id: 2, is_lent: 1, is_return: 1, return_date: '2026-07-10', uid: 2 },
      { loan_id: 4, item_code: 'B004', member_id: 'M001', loan_date: '2026-08-08', due_date: '2026-08-15', renewed: 0, loan_rules_id: 2, is_lent: 1, is_return: 0, return_date: null, uid: 2 },
      { loan_id: 5, item_code: 'B005', member_id: 'M001', loan_date: '2026-08-01', due_date: '2026-08-08', renewed: 0, loan_rules_id: 2, is_lent: 1, is_return: 0, return_date: null, uid: 2 },
      { loan_id: 6, item_code: 'B005', member_id: 'M003', loan_date: '2026-08-10', due_date: '2026-08-17', renewed: 0, loan_rules_id: 1, is_lent: 1, is_return: 0, return_date: null, uid: 2 },
      { loan_id: 7, item_code: 'B002', member_id: 'M999', loan_date: '2026-01-05', due_date: '2026-01-12', renewed: 0, loan_rules_id: 0, is_lent: 1, is_return: 1, return_date: '2026-01-10', uid: 2 },
    ]),
    loan_history: t(['loan_id', 'item_code', 'biblio_id', 'member_id', 'classification', 'loan_date', 'due_date'], [
      { loan_id: 3, item_code: 'B003', biblio_id: 3, member_id: 'M001', classification: '599', loan_date: '2026-07-01', due_date: '2026-07-08' },
      { loan_id: 50, item_code: 'B009', biblio_id: 9, member_id: 'M001', classification: '599.9', loan_date: '2025-01-01', due_date: '2025-01-08' },
    ]),
    fines: t(['fines_id', 'fines_date', 'member_id', 'debet', 'credit', 'description'], [
      { fines_id: 1, fines_date: '2026-08-30', member_id: 'M001', debet: '1500', credit: '500', description: 'Terlambat B001' },
      { fines_id: 2, fines_date: '0000-00-00', member_id: 'M003', debet: '2000', credit: '2000', description: 'Denda lama' },
      { fines_id: 3, fines_date: '2026-08-30', member_id: 'M999', debet: '1000', credit: '0', description: 'Denda' },
      { fines_id: 4, fines_date: '2026-08-01', member_id: 'M001', debet: '150000', credit: '0', description: 'Denda besar' },
      { fines_id: 5, fines_date: '2026-08-02', member_id: 'M003', debet: '1000', credit: '3000', description: 'Denda' },
    ]),
    reserve: t(['reserve_id', 'member_id', 'biblio_id', 'item_code', 'reserve_date'], [
      { reserve_id: 1, member_id: 'M003', biblio_id: 1, item_code: 'B001', reserve_date: '2026-08-28 10:00:00' },
      { reserve_id: 2, member_id: 'M003', biblio_id: 1, item_code: 'B001', reserve_date: '2026-08-29 10:00:00' },
      { reserve_id: 3, member_id: 'M001', biblio_id: 3, item_code: 'B003', reserve_date: '2026-08-28 10:00:00' },
      { reserve_id: 4, member_id: 'M999', biblio_id: 2, item_code: 'B002', reserve_date: '2026-08-28 10:00:00' },
      { reserve_id: 5, member_id: 'M001', biblio_id: 4, item_code: 'B004', reserve_date: '2026-08-28 10:00:00' },
    ]),
    read_counter: t(['id', 'item_code', 'created_at'], [
      { id: 1, item_code: 'B001', created_at: '2026-08-01 09:00:00' },
      { id: 2, item_code: 'B004', created_at: '2026-08-01 09:00:00' },
    ]),
  };
}

describe.skipIf(!ctx.available)(`SLiMS members, staff, visits and circulation [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let library: string;
  /** SLiMS item id → ALTIS item id, B004 left out until a test maps it. */
  const items = new Map<number, string>();
  const deps = (): CatalogJobDeps => ({ dataDir: db.dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(db.dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));
  const STAGES = [membersStage, staffStage, visitsStage, circulationStage];

  async function mapRow(entity: string, legacyKey: string, targetId: string): Promise<void> {
    await db.h.db.insertInto('migration_map').values({ source: 'slims', entity, legacy_key: legacyKey, target_id: targetId, run_id: '01J00000000000000000000000' }).execute();
  }

  beforeAll(async () => {
    db = await openItemsDb('slims-people');
    library = String((await readSettings(db.h.db, ['library.name'], []))['library.name']);
    for (const n of [1, 2, 3, 4, 5]) {
      const recordId = await seedRecord(db, { title: `Judul ${n}` });
      await mapRow('biblio', String(n), recordId);
      if (n === 4) continue; // copy B004 is not in ALTIS yet
      const itemId = await seedItem(db, recordId, { barcode: `B00${n}` });
      items.set(100 + n, itemId);
      await mapRow('item', String(100 + n), itemId);
    }
    await mapRow('mst_coll_type', '1', await db.collectionTypeId('UMUM'));
    // The member field definitions, as the masters stage makes them from the `member` rows of `mst_custom_field`.
    for (const [code, label, type] of [['cf_m1', 'Pekerjaan', 'text'], ['cf_m2', 'Tanggal Lulus', 'date']] as const) {
      const id = newId(NOW);
      await db.h.db
        .insertInto('custom_field_defs')
        .values({ id, entity: 'members', code_key: code.toUpperCase(), code_display: code, label, label_en: null, type, options: null, is_required: 0, sort_order: 0, is_public: 0, is_searchable: 0, archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
        .execute();
      await mapRow('mst_custom_field', code, id);
    }
  });

  afterAll(async () => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    __setSlimsStageBBatch(null);
    await db?.close();
  });

  beforeEach(() => {
    __setSlimsStages(STAGES);
  });

  afterEach(() => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    __setSlimsStageBBatch(null);
  });

  const input = (o: Partial<SlimsStartInput> = {}): SlimsStartInput => ({
    dryRun: false,
    sourceKind: 'db',
    db: DB_SOURCE,
    password: 'x',
    dumpStagingId: null,
    files: null,
    filesStagingId: null,
    filesDir: null,
    branchId: db.branchId,
    priceMode: 'major',
    sourceName: 'slims',
    allowNonEmpty: true,
    confirmLibraryName: library,
    fromRunId: null,
    ...o,
  });
  const start = (o: Partial<SlimsStartInput> = {}) => withTx(db.h, (trx) => startSlimsMigration(txCtx(trx, NOW, ACTOR), registry, input(o), { keyring }));

  /** Runs job `id` to its end; with `lose`, every other continued slice's saved counts are put back (a death after its commit). */
  async function runToEnd(id: string, o: { budgetMs?: number; lose?: boolean } = {}): Promise<string> {
    for (let slices = 1; slices <= 400; slices += 1) {
      const run = await db.h.db.selectFrom('catalog_runs').select(['id', 'summary']).where('job_id', '=', id).executeTakeFirst();
      const job = await db.h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow();
      const claimed = await claimById(db.h, registry, id, { worker: 'test', now: NOW });
      if (claimed === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(db.h, registry, claimed, { mode: 'worker', budgetMs: o.budgetMs ?? 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
      if (o.lose === true && slices % 2 === 0 && run !== undefined) {
        await db.h.db.updateTable('catalog_runs').set({ summary: run.summary }).where('id', '=', run.id).execute();
        await db.h.db.updateTable('jobs').set({ payload: job.payload }).where('id', '=', id).execute();
      }
    }
    throw new Error('no end after 400 slices');
  }

  const summaryOf = async (runId: string): Promise<MigrationSummary> =>
    JSON.parse((await db.h.db.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirstOrThrow()).summary) as MigrationSummary;
  const memberByNo = (no: string) => db.h.db.selectFrom('members').selectAll().where('member_no_key', '=', no).executeTakeFirst();
  const count = async (table: 'members' | 'loans' | 'visits' | 'holds' | 'charges' | 'payments' | 'policies' | 'calendars' | 'item_uses' | 'staff_users' | 'member_bookmarks'): Promise<number> =>
    Number((await db.h.db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

  /** What the run leaves behind, without random ids. */
  async function snapshot(): Promise<unknown> {
    const loans = await db.h.db.selectFrom('loans').select(['item_id', 'open_item_id', 'member_id', 'loaned_on', 'due_on', 'renewals', 'returned_on', 'outcome', 'loaned_by']).orderBy('loaned_on').orderBy('due_on').execute();
    const visits = await db.h.db.selectFrom('visits').select(['visited_at', 'member_id', 'accred_group', 'is_repeat', 'guest_name']).orderBy('visited_at').orderBy('is_repeat').execute();
    return {
      counts: Object.fromEntries(
        await Promise.all((['members', 'loans', 'visits', 'holds', 'charges', 'payments', 'policies', 'calendars', 'item_uses', 'staff_users', 'member_bookmarks'] as const).map(async (x) => [x, await count(x)])),
      ),
      loans: loans.map((l) => ({ ...l, item_id: l.item_id !== null, open_item_id: l.open_item_id !== null, member_id: l.member_id !== null, loaned_by: l.loaned_by !== null })),
      visits: visits.map((v) => ({ ...v, member_id: v.member_id !== null })),
    };
  }

  async function wipe(): Promise<void> {
    await db.h.db.deleteFrom('custom_values').execute();
    for (const table of ['payment_allocations', 'payments', 'charges', 'holds', 'item_uses', 'loans', 'visits', 'member_bookmarks', 'member_events', 'members', 'policies', 'calendars', 'jobs', 'catalog_runs'] as const) {
      await db.h.db.deleteFrom(table).execute();
    }
    await db.h.db.deleteFrom('member_types').where('code_key', 'not in', ['SISWA', 'GURU', 'UMUM']).execute();
    await db.h.db.deleteFrom('locations').where('kind', '=', 'room').execute();
    await db.h.db.deleteFrom('staff_users').where('status', '=', 'disabled').execute();
    await db.h.db.deleteFrom('migration_map').where('run_id', '<>', '01J00000000000000000000000').execute();
    await db.h.db.deleteFrom('migration_archive').execute();
    await db.h.db.deleteFrom('usage_group_map').execute();
  }

  it('a SLiMS password: bcrypt of cost 4-12 kept, MD5 and bcrypt above 12 need a reset, empty means no sign-in', () => {
    expect(slimsPassword(BCRYPT4)).toEqual({ hash: BCRYPT4, mustReset: false, code: 'kept' });
    expect(slimsPassword(BCRYPT13)).toEqual({ hash: null, mustReset: true, code: 'bcrypt_cost_unsupported' });
    expect(slimsPassword('e10adc3949ba59abbe56e057f20f883e')).toEqual({ hash: null, mustReset: true, code: 'md5_password' });
    expect(slimsPassword('')).toEqual({ hash: null, mustReset: false, code: 'empty' });
  });

  it('the real run: members, staff, visits, rules, the calendar, loans, fines, holds and reads; the reconciliation balances', async () => {
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const { runId, jobId } = await start();
    expect(await runToEnd(jobId)).toBe('succeeded');
    const s = await summaryOf(runId);
    expect(s.reconciliation?.ok, JSON.stringify(s.reconciliation)).toBe(true);
    expect(s.memberNoCollisions).toBe(0);
    expect(s.memberTypes?.map((x) => [x.id, x.group, x.members])).toEqual([['1', 'student', 3], ['2', 'teacher', 1], ['3', 'public', 0]]);
    expect(s.tables['member']).toMatchObject({ source: 5, migrated: 4, skipped: { member_type_missing: 1 } });

    // Members: the password kinds, a pending member suspended, a bad e-mail and a placeholder birth date left out.
    const m1 = (await memberByNo('M001'))!;
    expect([m1.password_hash, m1.must_reset_password, m1.status, m1.identity_no, m1.notes, m1.source]).toEqual([BCRYPT4, 0, 'active', '0012345678', 'Faks: 021-1234', 'slims:M001']);
    expect(m1.gender).toBeNull(); // not migrated by default
    // Custom values, through the member field definitions: the date that is none left out; the rows of a member not
    // migrated or gone skipped as orphans; the summary holds no value.
    const m2Id = (await memberByNo('M002'))!.id;
    const custom = await readCustomValues(db.h.db, 'members', [m1.id, m2Id]);
    expect([custom.get(m1.id), custom.get(m2Id)]).toEqual([{ cf_m1: 'Guru Honorer', cf_m2: '2026-06-30' }, { cf_m1: 'Pelajar' }]);
    expect(s.tables['member_custom']).toMatchObject({ source: 4, migrated: 2, skipped: { orphan: 2 } });
    expect(JSON.stringify(s)).not.toContain('Guru Honorer');
    expect(JSON.stringify(s)).not.toContain('bukan tanggal');
    const m2 = (await memberByNo('M002'))!;
    expect([m2.password_hash, m2.must_reset_password, m2.status, m2.email, m2.expires_on]).toEqual([null, 1, 'suspended', null, '2025-01-31']);
    const m3 = (await memberByNo('M003'))!;
    expect([m3.password_hash, m3.must_reset_password, m3.birth_date, m3.joined_on, m3.valid_from]).toEqual([null, 1, null, '2023-01-10', '2023-01-10']);
    expect(await memberByNo('M005')).toBeUndefined();
    const guruId = (await db.h.db.selectFrom('migration_map').select('target_id').where('entity', '=', 'mst_member_type').where('legacy_key', '=', '2').executeTakeFirstOrThrow()).target_id;
    const guru = await db.h.db.selectFrom('member_types').selectAll().where('id', '=', guruId).executeTakeFirstOrThrow();
    expect(guru.code_display).toBe('GURU-2'); // the seeded type holds GURU
    expect([guru.membership_days, guru.loan_limit, guru.accred_group]).toEqual([null, null, 'teacher']);
    expect((await db.h.db.selectFrom('member_events').select('type').where('member_id', '=', m1.id).execute()).map((e) => e.type)).toEqual(['migrated']);

    // Staff: disabled, no usable password, no role.
    const staff = await db.h.db.selectFrom('staff_users').select(['username_key', 'status', 'must_change_password', 'id']).where('status', '=', 'disabled').orderBy('username_key').execute();
    expect(staff.map((u) => [u.username_key, u.status, u.must_change_password])).toEqual([['ADMIN', 'disabled', 1], ['PUSTAKAWAN', 'disabled', 1]]);
    expect(await db.h.db.selectFrom('user_roles').select('id').where('user_id', 'in', staff.map((u) => u.id)).execute()).toEqual([]);

    // Visits: a repeat within the hour, a guest, a member who is gone, identical rows both kept (the second a repeat).
    const visits = await db.h.db.selectFrom('visits').select(['member_id', 'accred_group', 'is_repeat', 'guest_name', 'guest_institution', 'location_id', 'visited_on']).orderBy('visited_at').orderBy('is_repeat').execute();
    expect(visits).toHaveLength(7);
    expect(visits.map((v) => v.is_repeat)).toEqual([0, 1, 0, 0, 0, 0, 1]);
    expect(visits[2]).toMatchObject({ member_id: null, accred_group: 'guest', guest_name: 'Tamu A', guest_institution: 'SMP 2' });
    expect(visits.filter((v) => v.accred_group === 'unknown')).toHaveLength(1);
    expect(s.tables['visitor_count']).toMatchObject({ source: 8, migrated: 7, skipped: { invalid_date: 1 } });

    // Rules: one fallback rule per type, the duplicate and the gone collection type skipped, the "every" rule archived,
    // the grace raised to the type's.
    const rules = await db.h.db.selectFrom('policies').selectAll().where('code_key', 'like', 'SLIMS-%').execute();
    expect(rules.filter((p) => p.archived_at === null)).toHaveLength(4);
    expect(rules.filter((p) => p.archived_at !== null).map((p) => p.loan_days)).toEqual([21]);
    const r2 = rules.find((p) => p.code_display === 'SLIMS-R2')!;
    expect([r2.loan_limit, r2.loan_days, r2.grace_days, r2.fine_per_day_minor]).toEqual([3, 10, 2, 50_000]);
    const guruRule = rules.find((p) => p.member_type_id === guru.id && p.archived_at === null)!;
    expect([guruRule.loan_limit, guruRule.loan_days, guruRule.scope_key]).toEqual([0, 14, `${guru.id}/*/*/*`]);
    expect(s.tables['mst_loan_rules']).toMatchObject({ source: 4, migrated: 1, archived: 1, skipped: { duplicate_rule: 1, coll_type_missing: 1 } });
    // The calendar: a weekly day, one two-day range, SLiMS's sample days skipped.
    const cal = await db.h.db.selectFrom('calendars').select(['kind', 'weekday', 'date_from', 'date_to']).orderBy('kind').execute();
    expect(cal).toEqual([
      { kind: 'dates', weekday: null, date_from: '2026-08-17', date_to: '2026-08-18' },
      { kind: 'weekly', weekday: 7, date_from: null, date_to: null },
    ]);
    expect(s.tables['holiday']).toMatchObject({ source: 9, migrated: 2, merged: 1, skipped: { slims_seed_holiday: 6 } });
    expect((await readSettings(db.h.db, ['circulation.fines.skipClosedDays', 'circulation.holds.onlyWhenNoneAvailable', 'members.password.minLength'], []))).toEqual({
      'circulation.fines.skipClosedDays': true,
      'circulation.holds.onlyWhenNoneAvailable': false,
      'members.password.minLength': 6,
    });

    // Loans: the renewed loan stays open; the later of two open loans of B005 stays open; the loan of a copy ALTIS lacks
    // is skipped; the guru's loan under the archived "every" rule takes the type's fallback rule; an unknown uid lends as no one.
    const loans = await db.h.db.selectFrom('loans').selectAll().execute();
    const open = loans.filter((l) => l.open_item_id !== null);
    expect(open.map((l) => l.item_id).sort()).toEqual([items.get(101), items.get(102), items.get(105)].sort());
    const l1 = open.find((l) => l.item_id === items.get(101))!;
    expect([l1.renewals, l1.returned_on, l1.policy_id, l1.loaned_by]).toEqual([1, null, r2.id, staff.find((u) => u.username_key === 'PUSTAKAWAN')!.id]);
    const l2 = open.find((l) => l.item_id === items.get(102))!;
    expect([l2.policy_id, l2.loaned_by, l2.loan_days]).toEqual([guruRule.id, null, 14]);
    expect(loans.filter((l) => l.outcome === 'closed_migration')).toHaveLength(1);
    expect(loans.filter((l) => l.member_id === null)).toHaveLength(1);
    expect(loans.filter((l) => l.item_id === null).map((l) => l.stat_ddc)).toEqual(['590']);
    expect(s.tables['loan']).toMatchObject({ source: 7, migrated: 6, skipped: { open_loan_unresolved: 1 } });
    expect(s.tables['loan_history']).toMatchObject({ source: 2, migrated: 1, skipped: { in_loan_table: 1 } });
    // Fines: overdue with its loan, a settled one without its day, a credit cut, the gone member's skipped.
    const charges = await db.h.db.selectFrom('charges').selectAll().orderBy('amount_minor').execute();
    expect(charges.map((c) => [c.kind, c.amount_minor, c.paid_minor, c.status, c.date_unknown])).toEqual([
      ['migrated', 100_000, 100_000, 'settled', 0],
      ['overdue', 150_000, 50_000, 'open', 0],
      ['migrated', 200_000, 200_000, 'settled', 1],
      ['migrated', 15_000_000, 0, 'open', 0],
    ]);
    expect(charges[1]!.loan_id).toBe(l1.id);
    const payments = await db.h.db.selectFrom('payments').select(['method', 'receipt_no', 'date_unknown', 'amount_minor']).orderBy('amount_minor').execute();
    expect(payments).toEqual([
      { method: 'other', receipt_no: null, date_unknown: 1, amount_minor: 50_000 },
      { method: 'other', receipt_no: null, date_unknown: 1, amount_minor: 100_000 },
      { method: 'other', receipt_no: null, date_unknown: 1, amount_minor: 200_000 },
    ]);
    // Holds: only the first for a copy on loan; the rest archived with their reasons, each with the member's subject key.
    const holds = await db.h.db.selectFrom('holds').selectAll().execute();
    expect(holds.map((h) => [h.member_id, h.status, h.source, h.item_id])).toEqual([[m3.id, 'waiting', 'migrated', null]]);
    expect(s.tables['reserve']).toMatchObject({ source: 5, migrated: 1, archived: 4 });
    expect(await count('item_uses')).toBe(1);
    expect(await count('member_bookmarks')).toBe(1);

    // "Cocokkan dengan SLiMS": every number matches but the open loan of the copy ALTIS lacks.
    const bad = (s.matches ?? []).filter((m) => !m.ok);
    expect(bad.map((m) => [m.key, m.source, m.altis])).toEqual([['open_loans_item_missing', 1, 0]]);
    expect(s.matches?.find((m) => m.key === 'unpaid_fines_minor')).toMatchObject({ source: 15_200_000, altis: 15_100_000, explained: 100_000, ok: true });
    expect(s.matches?.filter((m) => m.key === 'visits_month').map((m) => [m.scope, m.source, m.altis])).toEqual([['2026-03', 3, 3], ['2026-04', 4, 4]]);
    expect(s.warnings).toContain('matches_diff');
    // The summary names no one: member numbers and counts only.
    for (const name of ['Anggota M001', 'Tamu A', 'SMP 2', 'Jl. Contoh', 'Petugas Satu']) expect(JSON.stringify(s), name).not.toContain(name);

    // The cut-over checklist holds "Mulai melayani" back.
    const view = await slimsCutover(db.h.db);
    expect(view).toMatchObject({ runId, reconciled: false, ready: false, rooms: 1, roomsWithStation: 0, reprintOpenedAt: null, stocktakeAvailable: true, circulationLive: false });
    const refused = await withTx(db.h, (trx) => markSlimsCutoverStep(txCtx(trx, NOW, ACTOR), 'serve')).catch((e: unknown) => e);
    expect(isDomainError(refused) && refused.code === 'MIGRATION_PRECHECK_FAILED' && refused.meta?.['reason'] === 'cutover_incomplete').toBe(true);
    const marked = await withTx(db.h, (trx) => markSlimsCutoverStep(txCtx(trx, NOW, ACTOR), 'reprint_opened'));
    expect(marked.reprintOpenedAt).toBe(NOW);
  });

  it('a re-run: append skips every mapped row; update re-syncs a field SLiMS changed and keeps one edited in ALTIS; replace imports circulation again', async () => {
    const before = await snapshot();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const again = await start();
    expect(await runToEnd(again.jobId)).toBe('succeeded');
    expect(await snapshot()).toEqual(before);
    expect((await summaryOf(again.runId)).tables['member']).toMatchObject({ skipped: { already_migrated: 4, member_type_missing: 1 } });

    // Staff edits the phone in ALTIS; SLiMS changes the phone and the name.
    const m1 = (await memberByNo('M001'))!;
    await db.run((tx) => updateMember(tx, m1.id, { version: Number(m1.version), phone: '0811' }), NOW + 1000);
    // The copy B004 now exists in ALTIS (a catalogue re-sync would bring it).
    const b4 = await seedItem(db, (await db.h.db.selectFrom('migration_map').select('target_id').where('entity', '=', 'biblio').where('legacy_key', '=', '4').executeTakeFirstOrThrow()).target_id, { barcode: 'B004' });
    await mapRow('item', '104', b4);
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables({ phone: '0899', name: 'Nama Baru', job: 'Kepala Sekolah' }) }));
    const sync = await start({ people: { membersMode: 'update', circulationMode: 'replace' } });
    expect(await runToEnd(sync.jobId)).toBe('succeeded');
    const after = (await memberByNo('M001'))!;
    expect([after.name, after.phone, after.password_hash]).toEqual(['Nama Baru', '0811', BCRYPT4]);
    const synced = await db.h.db.selectFrom('member_events').select('meta').where('member_id', '=', m1.id).where('type', '=', 'synced').execute();
    expect(synced.map((e) => JSON.parse(e.meta))).toEqual(expect.arrayContaining([{ fields: ['name'] }, { fields: ['custom'] }]));
    expect(synced).toHaveLength(2);
    expect((await readCustomValues(db.h.db, 'members', [m1.id])).get(m1.id)).toEqual({ cf_m1: 'Kepala Sekolah', cf_m2: '2026-06-30' });
    const s = await summaryOf(sync.runId);
    expect(s.reconciliation?.ok).toBe(true);
    expect((s.matches ?? []).filter((m) => !m.ok)).toEqual([]);
    expect((await db.h.db.selectFrom('loans').select('id').where('open_item_id', 'is not', null).execute()).length).toBe(4);
    expect(await count('charges')).toBe(4);
    // B004 is out on loan now, so the hold on it comes over too.
    expect(await count('holds')).toBe(2);

    // The first act in ALTIS is an on-time return of a migrated loan: no row of ALTIS's own yet, but a replace would
    // put the loan back open from the frozen source, so it is refused from then on.
    const migrated = await db.h.db
      .selectFrom('loans as l')
      .innerJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.id', 'i.barcode_display'])
      .where('l.source', '=', 'migrated')
      .where('l.open_item_id', 'is not', null)
      .orderBy('l.id')
      .executeTakeFirstOrThrow();
    await db.h.db.updateTable('loans').set({ due_on: '2099-12-31' }).where('id', '=', migrated.id).execute();
    await db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode: migrated.barcode_display }));
    for (const table of ['loans', 'holds', 'charges', 'payments', 'item_uses'] as const) {
      expect(await db.h.db.selectFrom(table as 'loans').select('id').where('source', '<>', 'migrated').execute(), table).toEqual([]);
    }
    const afterReturn = await start({ people: { circulationMode: 'replace' } }).catch((e: unknown) => e);
    expect(isDomainError(afterReturn) && afterReturn.code === 'MIGRATION_CIRCULATION_LIVE').toBe(true);
    expect((await slimsCutover(db.h.db)).circulationLive).toBe(true);

    // ALTIS lends on its own: a replace is refused from then on.
    const m6 = (await memberByNo('M006'))!;
    await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: m6.id, barcode: 'B003' }));
    const refused = await start({ people: { circulationMode: 'replace' } }).catch((e: unknown) => e);
    expect(isDomainError(refused) && refused.code === 'MIGRATION_CIRCULATION_LIVE').toBe(true);
    expect((await slimsCutover(db.h.db)).circulationLive).toBe(true);
  });

  it('stopped after every batch, and with its counts lost after every other commit, a run ends as one that never stopped', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const whole = await start();
    expect(await runToEnd(whole.jobId)).toBe('succeeded');
    const wholeSummary = await summaryOf(whole.runId);
    const wholeRows = await snapshot();

    await wipe();
    __setSlimsStageBBatch(2);
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const stepped = await start();
    expect(await runToEnd(stepped.jobId, { budgetMs: 2_000, lose: true })).toBe('succeeded');
    const steppedSummary = await summaryOf(stepped.runId);
    expect(steppedSummary.tables).toEqual(wholeSummary.tables);
    expect(steppedSummary.matches).toEqual(wholeSummary.matches);
    expect(await snapshot()).toEqual(wholeRows);
  });

  it('member numbers that collide once normalised: the dry run lists them (and the circulation lists to check), a real run taking it over is refused 422', async () => {
    await wipe();
    const tables = slimsTables({ collide: true });
    // An open loan exactly as many open days late as its grace (2): SLiMS fines it, ALTIS ("within 2 days is free") not.
    tables['loan']!.rows.push({ loan_id: 30, item_code: 'B003', member_id: 'M001', loan_date: '2026-08-21', due_date: '2026-08-31', renewed: 0, loan_rules_id: 2, is_lent: 1, is_return: 0, return_date: null, uid: 2 });
    __setSlimsSourceFactory(fakeSlimsFactory({ tables }));
    const dry = await start({ dryRun: true });
    expect(await runToEnd(dry.jobId)).toBe('succeeded');
    const s = await summaryOf(dry.runId);
    expect(s.memberNoCollisions).toBe(2);
    expect(s.tables['member']?.skipped).toMatchObject({ member_no_collision: 2 });
    // The lists to check before the real run: M003's loans under the archived "every" rule of Guru take the type's
    // fallback rule (14 days, not 21; limit 0, which his two open loans pass); Siswa has rules of its own; nothing
    // names a member by name.
    expect(s.dryLists).toEqual([
      { key: 'loan_terms_differ', count: 3, samples: ['M003 · B002', 'M003 · B005', 'M001 · B003'] },
      { key: 'type_limit_changes', count: 1, samples: ['1 Siswa'] },
      { key: 'members_over_limit', count: 1, samples: ['M003'] },
      { key: 'all_rule_unused', count: 1, samples: ['1'] },
      { key: 'open_loan_item_missing', count: 0, samples: [] },
    ]);
    expect(await count('members')).toBe(0);
    const refused = await start({ fromRunId: dry.runId }).catch((e: unknown) => e);
    expect(isDomainError(refused) && refused.code === 'MIGRATION_PRECHECK_FAILED' && refused.meta?.['reason'] === 'member_no_collision' && refused.meta?.['count'] === 2).toBe(true);
    // Without the dry run, the real run fails before it writes a member.
    const direct = await start();
    expect(await runToEnd(direct.jobId)).toBe('succeeded');
    const row = await db.h.db.selectFrom('catalog_runs').select('status').where('id', '=', direct.runId).executeTakeFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(await count('members')).toBe(0);
  });

  it('anonymising a migrated member removes the archived rows about them', async () => {
    await wipe();
    __setSlimsSourceFactory(fakeSlimsFactory({ tables: slimsTables() }));
    const run = await start();
    expect(await runToEnd(run.jobId)).toBe('succeeded');
    const m1 = (await memberByNo('M001'))!;
    const m2 = (await memberByNo('M002'))!;
    const about = async (memberId: string): Promise<string[]> =>
      (await db.h.db.selectFrom('migration_archive').select('table_name').where('subject_key', '=', await memberSubjectKeyIn(db.h.db, memberId)).execute()).map((r) => r.table_name).sort();
    // (B004 is in ALTIS since the re-run test: of M001's holds only the one on a copy not on loan is archived.)
    expect(await about(m1.id)).toEqual(['comment', 'reserve']);
    expect(await about(m2.id)).toEqual(['comment']);
    await db.run((tx) => anonymizeMember(tx, m2.id, { version: Number(m2.version), confirmMemberNo: 'M002' }));
    expect(await about(m2.id)).toEqual([]);
    expect(await about(m1.id)).toEqual(['comment', 'reserve']);
    expect(await db.h.db.selectFrom('migration_map').select('legacy_key').where('target_id', '=', m2.id).execute()).toEqual([]);
  });

  it('a copy whose latest open loan belongs to a member who is gone is explained in "Cocokkan dengan SLiMS", not left as a difference', async () => {
    await wipe();
    const tables = slimsTables();
    const loan = (id: number, member: string, on: string) => ({ loan_id: id, item_code: 'B003', member_id: member, loan_date: on, due_date: on, renewed: 0, loan_rules_id: 2, is_lent: 1, is_return: 0, return_date: null, uid: 2 });
    // B003: an older open loan of a member who comes over, and the latest one of a member SLiMS no longer has.
    tables['loan']!.rows.push(loan(20, 'M001', '2026-08-03'), loan(21, 'M999', '2026-08-12'));
    __setSlimsSourceFactory(fakeSlimsFactory({ tables }));
    const run = await start();
    expect(await runToEnd(run.jobId)).toBe('succeeded');
    const s = await summaryOf(run.runId);
    // The latest loan is skipped (its member is gone), the older one is closed as the copy's second open loan: B003 is
    // not on loan in ALTIS, and both rows say why.
    const b3 = await db.h.db.selectFrom('loans').select(['open_item_id', 'outcome']).where('item_id', '=', items.get(103)!).where('loaned_on', '=', '2026-08-03').executeTakeFirstOrThrow();
    expect(b3).toEqual({ open_item_id: null, outcome: 'closed_migration' });
    const byKey = (key: string) => s.matches?.find((m) => m.key === key);
    expect(byKey('open_loans')?.ok).toBe(true);
    expect(byKey('items_on_loan'), JSON.stringify(byKey('items_on_loan'))).toMatchObject({ ok: true });
    expect((s.matches ?? []).filter((m) => !m.ok)).toEqual([]);
  });
});
