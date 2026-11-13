import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type AccredPeriodsTable } from '@altis/db';
import { newId, t, type Locale, type MessageKey } from '@altis/shared';
import type { ReportCell } from '@altis/shared/api/reports';
import type { Selectable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { columnsOf } from '../../src/reports/personal.js';
import { reportById } from '../../src/reports/registry.js';
import type { ReportCtx, TableReport } from '../../src/reports/types.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';

// The register annexes of an accreditation period (school year 2025-07-01 … 2026-06-30, read after it ended): the staff
// (the people active at its end, their trainings in the period or the three periods, the staff ratios), the three
// budget years with the library's share, the activities (by kind, window and the two flags), the partnerships valid
// in the period and the documents current at its end or issued in it. Rows come by date, then id, a page at a time:
// the cursor names the last row of a page.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0);
const TODAY = '2026-08-01';

const label = (key: string, locale: Locale = 'id'): string => t(locale, key as MessageKey);
const YA = label('report.row.registers.yes');
const TIDAK = label('report.row.registers.no');

describe.skipIf(!ctx.available)(`register annexes of accreditation [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let settings: AccredSettings;
  let periodId: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-annexes-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    settings = await loadAccredSettings(h.db);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  const trail = { version: 0, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null };

  beforeEach(async () => {
    await h.db.deleteFrom('staff_trainings').execute();
    for (const table of ['library_activities', 'library_staff', 'library_partnerships', 'library_budgets', 'library_documents', 'accred_periods'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    periodId = newId(NOW);
    const row: Selectable<AccredPeriodsTable> = {
      id: periodId,
      branch_id: null,
      name: 'Tahun ajaran 2025/2026',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'sch-sma-2025',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{}',
      students: 108,
      teachers: 10,
      edu_staff: 5,
      classes: 3,
      population_served: null,
      teachers_using: 4,
      all_registered_confirmed: 0,
      user_pcs: 4,
      staff_pcs: 1,
      ict_devices: 5,
      scanners: 2,
      floor_m2: 120,
      bandwidth_mbps: 30,
      hours_per_week: 35,
      services: null,
      external_website_url: null,
      archived_at: null,
      ...trail,
    };
    await h.db.insertInto('accred_periods').values(row).execute();
  });

  const annex = (name: string): TableReport => reportById(`accreditation.annex.${name}`) as TableReport;

  function reportCtx(def: TableReport, params: Record<string, unknown>, locale: Locale = 'id'): ReportCtx {
    return {
      db: h.db,
      locale,
      tz: 'Asia/Jakarta',
      now: NOW,
      today: TODAY,
      settings,
      params: def.paramsSchema.parse({ periodId, ...params }),
      budgetLeftMs: () => 10_000,
    };
  }

  /** Every row of `def`, a page of `limit` at a time, and the number of pages. */
  async function allRows(def: TableReport, params: Record<string, unknown> = {}, limit = 1000, locale: Locale = 'id') {
    const c = reportCtx(def, params, locale);
    const rows: ReportCell[][] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await def.rows(c, cursor, limit);
      rows.push(...page.rows.map((r) => [...r]));
      cursor = page.nextCursor;
      pages += 1;
      expect(page.rows.length).toBeLessThanOrEqual(limit);
    } while (cursor !== null && pages < 100);
    return { rows, pages };
  }

  async function staff(name: string, o: Record<string, unknown> = {}): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('library_staff')
      .values({
        id,
        branch_id: null,
        staff_user_id: null,
        name,
        position: null,
        role: 'technical',
        is_librarian: 0,
        employment: null,
        education_level: null,
        education_library: 0,
        library_training: 0,
        competency_cert: 0,
        association_member: 0,
        appointment_ref: null,
        starts_on: '2020-01-01',
        ends_on: null,
        archived_at: null,
        ...trail,
        ...o,
      })
      .execute();
    return id;
  }

  async function training(staffId: string, title: string, heldOn: string, hours: number | null = 8): Promise<void> {
    await h.db
      .insertInto('staff_trainings')
      .values({ id: newId(NOW), library_staff_id: staffId, title, organizer: 'Perpusnas', held_on: heldOn, hours, certificate_file_id: null, archived_at: null, ...trail })
      .execute();
  }

  async function activity(kind: string, title: string, heldOn: string, o: Record<string, unknown> = {}): Promise<void> {
    await h.db
      .insertInto('library_activities')
      .values({
        id: newId(NOW),
        branch_id: null,
        kind,
        title,
        held_on: heldOn,
        ended_on: null,
        participants: null,
        partner: null,
        uses_library_facility: 0,
        external_speaker: 0,
        description: null,
        archived_at: null,
        ...trail,
        ...o,
      })
      .execute();
  }

  describe('staff', () => {
    async function seedStaff(): Promise<{ head: string; tech: string; librarian: string; former: string }> {
      const tech = await staff('Budi Teknis', { library_training: 1, starts_on: '2022-01-03' });
      const head = await staff('Siti Kepala', {
        role: 'head',
        position: 'Kepala Perpustakaan',
        is_librarian: 1,
        employment: 'civil_servant',
        education_level: 's1',
        library_training: 1,
        association_member: 1,
        appointment_ref: '800/12/2019',
        starts_on: '2019-07-15',
      });
      const librarian = await staff('Rina Pustakawan', { role: 'librarian', is_librarian: 1, education_level: 'd3', education_library: 1, competency_cert: 1, starts_on: '2024-07-01', ends_on: '2027-06-30' });
      const former = await staff('Mantan Tenaga', { ends_on: '2025-01-31', starts_on: '2018-01-01' });
      await staff('Diarsipkan', { archived_at: NOW, starts_on: '2018-01-01' });
      return { head, tech, librarian, former };
    }

    it('the staff active at the period end, by the day they started', async () => {
      await seedStaff();
      const def = annex('staff');
      expect(columnsOf(def, def.paramsSchema.parse({ periodId })).map((c) => c.key)).toEqual([
        'name',
        'position',
        'role',
        'is_librarian',
        'employment',
        'education',
        'library_training',
        'competency_cert',
        'association_member',
        'appointment_ref',
        'starts_on',
        'ends_on',
      ]);
      const { rows } = await allRows(def);
      expect(rows).toEqual([
        [
          'Siti Kepala',
          'Kepala Perpustakaan',
          label('vocab.staff_role.head'),
          YA,
          label('vocab.employment.civil_servant'),
          label('vocab.education_level.s1'),
          YA,
          TIDAK,
          YA,
          '800/12/2019',
          '2019-07-15',
          null,
        ],
        ['Budi Teknis', null, label('vocab.staff_role.technical'), TIDAK, null, null, YA, TIDAK, TIDAK, null, '2022-01-03', null],
        [
          'Rina Pustakawan',
          null,
          label('vocab.staff_role.librarian'),
          YA,
          null,
          `${label('vocab.education_level.d3')}, ${label('report.row.registers.education_library')}`,
          TIDAK,
          YA,
          TIDAK,
          null,
          '2024-07-01',
          '2027-06-30',
        ],
      ]);
      const paged = await allRows(def, {}, 1);
      expect(paged.rows).toEqual(rows);
      expect(paged.pages).toBe(3);
    });

    it('the trainings of those staff in the period, or in the three periods', async () => {
      const { head, tech, former } = await seedStaff();
      await training(head, 'Pelatihan katalogisasi', '2023-11-20', 32);
      await training(head, 'Bimtek SLiMS', '2025-10-10', null);
      await training(tech, 'Perawatan koleksi', '2024-08-01');
      await training(tech, 'Literasi digital', '2026-04-01');
      await training(head, 'Seminar lama', '2023-05-01');
      await training(former, 'Pelatihan mantan', '2025-09-01');
      const def = annex('staff');
      expect(columnsOf(def, def.paramsSchema.parse({ periodId, section: 'trainings' })).map((c) => c.key)).toEqual(['name', 'training', 'organizer', 'held_on', 'hours']);
      const three = await allRows(def, { section: 'trainings', window: 'three_periods' }, 2);
      expect(three.rows).toEqual([
        ['Siti Kepala', 'Pelatihan katalogisasi', 'Perpusnas', '2023-11-20', 32],
        ['Budi Teknis', 'Perawatan koleksi', 'Perpusnas', '2024-08-01', 8],
        ['Siti Kepala', 'Bimtek SLiMS', 'Perpusnas', '2025-10-10', null],
        ['Budi Teknis', 'Literasi digital', 'Perpusnas', '2026-04-01', 8],
      ]);
      expect(three.pages).toBe(2);
      const one = await allRows(def, { section: 'trainings' });
      expect(one.rows.map((r) => r[3])).toEqual(['2025-10-10', '2026-04-01']);
    });

    it('the ratios: active staff, librarians, the school population per staff member, computers and trainings', async () => {
      const { head, tech } = await seedStaff();
      for (const d of ['2023-08-01', '2024-08-01', '2025-08-01']) await training(head, 'Pelatihan', d);
      await training(tech, 'Pelatihan', '2026-01-01');
      const def = annex('staff');
      const { rows, pages } = await allRows(def, { section: 'ratio' });
      expect(pages).toBe(1);
      expect(rows).toEqual([
        [label('report.row.registers.ratio.active_staff'), 3],
        [label('report.row.registers.ratio.librarians'), 2],
        [label('report.row.registers.ratio.population'), 123],
        [label('report.row.registers.ratio.population_per_staff'), 41],
        [label('report.row.registers.ratio.staff_pcs'), 1],
        [label('report.row.registers.ratio.staff_pcs_pct'), 33],
        [label('report.row.registers.ratio.trainings_3p'), 4],
        [label('report.row.registers.ratio.training_avg_3p'), 1],
      ]);
      const english = await allRows(def, { section: 'ratio' }, 1000, 'en');
      expect(english.rows[0]).toEqual([label('report.row.registers.ratio.active_staff', 'en'), 3]);
    });

    it('without staff the ratios that divide by them stay empty', async () => {
      const { rows } = await allRows(annex('staff'), { section: 'ratio' });
      expect(rows.map((r) => r[1])).toEqual([0, 0, 123, null, 1, null, 0, null]);
    });
  });

  describe('budgets', () => {
    async function budget(year: number, libraryMinor: number, parentNonpersonnelMinor: number | null, community: number | null = null): Promise<void> {
      await h.db
        .insertInto('library_budgets')
        .values({
          id: newId(NOW),
          scope_key: '',
          branch_id: null,
          year,
          library_minor: libraryMinor,
          parent_minor: 500_000_000,
          parent_nonpersonnel_minor: parentNonpersonnelMinor,
          collection_minor: 2_000_050,
          community_minor: community,
          currency: 'IDR',
          note: null,
          archived_at: null,
          ...trail,
        })
        .execute();
    }

    it('the three budget years in major units with the library share cut to a whole percent, then the mean', async () => {
      await budget(2024, 6_500_000, 100_000_000, 150_000);
      await budget(2025, 5_200_000, 100_000_000);
      await budget(2026, 6_900_000, 100_000_000);
      await budget(2023, 9_900_000, 100_000_000);
      const { rows } = await allRows(annex('budgets'));
      expect(rows).toEqual([
        ['2024', 65_000, 5_000_000, 1_000_000, 20_000.5, 1_500, 6],
        ['2025', 52_000, 5_000_000, 1_000_000, 20_000.5, null, 5],
        ['2026', 69_000, 5_000_000, 1_000_000, 20_000.5, null, 6],
        [label('report.row.registers.budget_mean'), null, null, null, null, null, 6],
      ]);
    });

    it('a missing year is a row without amounts, and the mean is then empty', async () => {
      await budget(2024, 6_500_000, 100_000_000);
      await budget(2026, 6_900_000, null);
      const { rows } = await allRows(annex('budgets'));
      expect(rows).toEqual([
        ['2024', 65_000, 5_000_000, 1_000_000, 20_000.5, null, 6],
        ['2025', null, null, null, null, null, null],
        ['2026', 69_000, 5_000_000, null, 20_000.5, null, null],
        [label('report.row.registers.budget_mean'), null, null, null, null, null, null],
      ]);
    });
  });

  describe('activities', () => {
    beforeEach(async () => {
      await activity('promotion', 'Pameran buku', '2025-09-15', { participants: 120, partner: 'Penerbit Kita' });
      await activity('promotion', 'Lomba resensi', '2026-02-10');
      await activity('promotion', 'Promosi lama', '2025-06-30');
      await activity('promotion', 'Promosi dua tahun lalu', '2024-03-03');
      await activity('promotion', 'Diarsipkan', '2025-10-10', { archived_at: NOW });
      await activity('learning_session', 'Kelas IPA di perpustakaan', '2025-08-20');
      await activity('writing_guidance', 'Menulis bersama penulis tamu', '2025-11-11', { uses_library_facility: 1, external_speaker: 1 });
      await activity('external_literacy', 'Pegiat literasi', '2026-01-20');
    });

    it('one kind in the period, by date', async () => {
      const { rows } = await allRows(annex('activities'), { kinds: ['promotion'] });
      const promotion = label('vocab.activity_kind.promotion');
      expect(rows).toEqual([
        [promotion, 'Pameran buku', '2025-09-15', 120, 'Penerbit Kita'],
        [promotion, 'Lomba resensi', '2026-02-10', null, null],
      ]);
      const three = await allRows(annex('activities'), { kinds: ['promotion'], window: 'three_periods' });
      expect(three.rows.map((r) => r[1])).toEqual(['Promosi dua tahun lalu', 'Promosi lama', 'Pameran buku', 'Lomba resensi']);
    });

    it('the flags list the rows of other kinds that carry them; kinds and flags add up; nothing chosen lists all', async () => {
      expect((await allRows(annex('activities'), { learning: true })).rows.map((r) => r[1])).toEqual(['Kelas IPA di perpustakaan', 'Menulis bersama penulis tamu']);
      expect((await allRows(annex('activities'), { externalLiteracy: true })).rows.map((r) => r[1])).toEqual(['Menulis bersama penulis tamu', 'Pegiat literasi']);
      expect((await allRows(annex('activities'), { kinds: ['promotion'], learning: true })).rows.map((r) => r[1])).toEqual([
        'Kelas IPA di perpustakaan',
        'Pameran buku',
        'Menulis bersama penulis tamu',
        'Lomba resensi',
      ]);
      const all = await allRows(annex('activities'));
      expect(all.rows.map((r) => r[2])).toEqual(['2025-08-20', '2025-09-15', '2025-11-11', '2026-01-20', '2026-02-10']);
      const paged = await allRows(annex('activities'), {}, 4);
      expect(paged.rows).toEqual(all.rows);
      expect(paged.pages).toBe(2);
    });

    it('a cursor that is not one of its own is refused; a period that does not exist is not found', async () => {
      const def = annex('activities');
      await expect(def.rows(reportCtx(def, {}), 'nonsense', 10)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', meta: { errors: [{ path: 'cursor', code: 'invalid' }] } });
      const missing = { ...reportCtx(def, {}), params: { periodId: newId(NOW), window: 'period' } };
      await expect(def.rows(missing, null, 10)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('partnerships', () => {
    async function partnership(partner: string, kind: string, startsOn: string, endsOn: string | null, o: Record<string, unknown> = {}): Promise<void> {
      await h.db
        .insertInto('library_partnerships')
        .values({ id: newId(NOW), branch_id: null, partner, kind, starts_on: startsOn, ends_on: endsOn, scope: null, document_file_id: null, archived_at: null, ...trail, ...o })
        .execute();
    }

    it('the agreements valid at some time in the period, by their start', async () => {
      await partnership('Taman Bacaan Pelangi', 'pks', '2025-02-01', null, { scope: 'Pertukaran koleksi' });
      await partnership('Universitas Negeri', 'mou', '2026-01-10', '2027-01-09');
      await partnership('Dinas Perpustakaan Kota', 'mou', '2023-01-01', '2024-12-31');
      await partnership('Mitra Akhir', 'other', '2024-07-01', '2025-07-01');
      await partnership('Mitra Nanti', 'mou', '2026-07-01', null);
      await partnership('Diarsipkan', 'mou', '2025-08-01', null, { archived_at: NOW });
      const { rows } = await allRows(annex('partnerships'), {}, 2);
      expect(rows).toEqual([
        ['Mitra Akhir', label('vocab.partnership_kind.other'), '2024-07-01', '2025-07-01', null],
        ['Taman Bacaan Pelangi', label('vocab.partnership_kind.pks'), '2025-02-01', null, 'Pertukaran koleksi'],
        ['Universitas Negeri', label('vocab.partnership_kind.mou'), '2026-01-10', '2027-01-09', null],
      ]);
    });
  });

  describe('documents', () => {
    async function document(kind: string, title: string, issuedOn: string | null, o: Record<string, unknown> = {}): Promise<void> {
      await h.db
        .insertInto('library_documents')
        .values({
          id: newId(NOW),
          branch_id: null,
          kind,
          title,
          reference: null,
          issued_on: issuedOn,
          issued_by: null,
          aspect_codes: null,
          valid_until: null,
          file_id: null,
          archived_at: null,
          ...trail,
          ...o,
        })
        .execute();
    }

    beforeEach(async () => {
      await document('collection_policy', 'Kebijakan pengembangan koleksi', '2024-01-10', {
        reference: 'SK/01/2024',
        issued_by: 'Kepala Sekolah',
        aspect_codes: JSON.stringify(['a2', 'a1']),
        valid_until: '2028-12-31',
      });
      await document('rules', 'Tata tertib tanpa tanggal', null);
      await document('report_annual', 'Laporan tahunan 2023', '2023-12-15');
      await document('report_annual', 'Laporan tahunan 2025', '2025-12-15');
      await document('org_structure', 'Struktur lama', '2020-01-01', { valid_until: '2025-08-31' });
      await document('duties', 'Uraian tugas berikutnya', '2026-08-01');
      await document('rules', 'Diarsipkan', '2024-01-01', { archived_at: NOW });
    });

    it('the documents current at the period end or issued in it, by issue date (undated first)', async () => {
      // The old structure expired before the period ended and the next duties are issued after it: neither is listed.
      const { rows, pages } = await allRows(annex('documents'), {}, 2);
      expect(rows).toEqual([
        [label('vocab.document_kind.rules'), 'Tata tertib tanpa tanggal', null, null, null, null, null],
        [label('vocab.document_kind.report_annual'), 'Laporan tahunan 2023', null, '2023-12-15', null, null, null],
        [
          label('vocab.document_kind.collection_policy'),
          'Kebijakan pengembangan koleksi',
          'SK/01/2024',
          '2024-01-10',
          'Kepala Sekolah',
          `${label('accred.aspect.collection_policy.a1')}, ${label('accred.aspect.collection_policy.a2')}`,
          '2028-12-31',
        ],
        [label('vocab.document_kind.report_annual'), 'Laporan tahunan 2025', null, '2025-12-15', null, null, null],
      ]);
      expect(pages).toBe(2);
    });

    it('a document issued in the period counts even when it expired before the period ended', async () => {
      await document('sop_loan', 'Prosedur peminjaman sementara', '2025-08-01', { valid_until: '2025-12-31' });
      const { rows } = await allRows(annex('documents'), { kinds: ['sop_loan', 'org_structure'] });
      expect(rows.map((r) => r[1])).toEqual(['Prosedur peminjaman sementara']);
    });

    it('filtered by kind', async () => {
      const { rows } = await allRows(annex('documents'), { kinds: ['report_annual', 'report_semester'] });
      expect(rows.map((r) => r[1])).toEqual(['Laporan tahunan 2023', 'Laporan tahunan 2025']);
    });
  });
});
