import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type AccredPeriodsTable } from '@altis/db';
import { newId } from '@altis/shared';
import type { AccredProfile } from '@altis/shared/api/accreditation';
import type { Selectable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import type { AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { registersProvider } from '../../src/accreditation/providers/registers.js';
import { suggestAnswer } from '../../src/accreditation/scoring/suggest.js';
import { routineFacts } from '../../src/accreditation/scoring/rules.js';
import type { AccredIndicator, AccredInstrument, AccredMetricContext, AccredMetricValue } from '../../src/accreditation/types.js';
import { reportById } from '../../src/reports/registry.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';

// The `registers` metrics over the five registers of a school year 2025-07-01 … 2026-06-30, evaluated after it ended
// (so the snapshot date is 2026-06-30 and its three periods start 2023-07-01):
// - an activity counts once in its window by the day it was held, archived ones never; the learning and the outside
//   literacy items also count a row of another kind that carries their flag;
// - a register with no live row at all gives no value (and says it is empty); once one row exists, a count of 0 is a 0;
// - staff are counted when active at the period's end, and only their trainings count;
// - a partner counts once over every agreement that overlaps the three periods, whatever its kind;
// - the budget share is the exact mean of the three yearly shares, cut once; a missing year gives no value;
// - the report routine counts each report kind per yearly slice; the legality elements read the documents and the NPP.

const ctx = testDbContext();
/** After the period ended: the snapshot date is its last day. */
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0);
const TODAY = '2026-08-01';
const D = '2026-06-30';
const SMA = instrumentById('sch-sma-2025') as AccredInstrument;

const paramsOf = (instr: AccredInstrument) => (metric: AccredMetricId) =>
  instr.components.flatMap((c) => c.indicators).find((i) => i.metric === metric)?.metricParams ?? {};
const indicator = (code: string): AccredIndicator => SMA.components.flatMap((c) => c.indicators).find((i) => i.code === code)!;

describe.skipIf(!ctx.available)(`registers metric provider [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let settings: AccredSettings;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-registers-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    settings = await loadAccredSettings(h.db);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('staff_trainings').execute();
    for (const table of ['library_activities', 'library_staff', 'library_partnerships', 'library_budgets', 'library_documents', 'pages', 'accred_periods'] as const) {
      await h.db.deleteFrom(table).execute();
    }
  });

  const trail = { version: 0, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null };

  async function period(o: Partial<Selectable<AccredPeriodsTable>> = {}): Promise<Selectable<AccredPeriodsTable>> {
    const row = {
      id: newId(NOW),
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
      ...o,
    } satisfies Selectable<AccredPeriodsTable>;
    await h.db.insertInto('accred_periods').values(row).execute();
    return row;
  }

  function metricCtx(p: Selectable<AccredPeriodsTable>, profile: AccredProfile = {}): AccredMetricContext {
    return {
      db: h.db,
      periodId: p.id,
      period: p,
      profile,
      instrument: SMA,
      D,
      today: TODAY,
      settings,
      baseUrl: 'https://perpus.sma-contoh.sch.id',
      now: NOW,
      budgetLeftMs: () => 20_000,
      paramsOf: paramsOf(SMA),
    };
  }

  async function compute(p: Selectable<AccredPeriodsTable>, ids: AccredMetricId[], profile?: AccredProfile): Promise<Map<AccredMetricId, AccredMetricValue>> {
    const step = await registersProvider.compute(metricCtx(p, profile), ids, null);
    if (!step.done) throw new Error('the registers provider answers in one call');
    return new Map(step.values);
  }

  async function activity(kind: string, heldOn: string, o: { facility?: boolean; speaker?: boolean; archived?: boolean } = {}): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('library_activities')
      .values({
        id,
        branch_id: null,
        kind,
        title: `Kegiatan ${kind} ${heldOn}`,
        held_on: heldOn,
        ended_on: null,
        participants: 20,
        partner: null,
        uses_library_facility: o.facility === true ? 1 : 0,
        external_speaker: o.speaker === true ? 1 : 0,
        description: null,
        archived_at: o.archived === true ? NOW : null,
        ...trail,
      })
      .execute();
    return id;
  }

  async function document(kind: string, o: { issuedOn?: string | null; validUntil?: string | null; aspects?: string[]; archived?: boolean } = {}): Promise<void> {
    await h.db
      .insertInto('library_documents')
      .values({
        id: newId(NOW),
        branch_id: null,
        kind,
        title: `Dokumen ${kind}`,
        reference: null,
        issued_on: o.issuedOn === undefined ? '2024-01-10' : o.issuedOn,
        issued_by: null,
        aspect_codes: o.aspects === undefined ? null : JSON.stringify(o.aspects),
        valid_until: o.validUntil ?? null,
        file_id: null,
        archived_at: o.archived === true ? NOW : null,
        ...trail,
      })
      .execute();
  }

  interface StaffOptions {
    role?: string;
    librarian?: boolean;
    level?: string | null;
    libraryEducation?: boolean;
    training?: boolean;
    cert?: boolean;
    association?: boolean;
    startsOn?: string;
    endsOn?: string | null;
    archived?: boolean;
  }

  async function staff(name: string, o: StaffOptions = {}): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('library_staff')
      .values({
        id,
        branch_id: null,
        staff_user_id: null,
        name,
        position: null,
        role: o.role ?? 'technical',
        is_librarian: o.librarian === true ? 1 : 0,
        employment: null,
        education_level: o.level === undefined ? 'sma' : o.level,
        education_library: o.libraryEducation === true ? 1 : 0,
        library_training: o.training === true ? 1 : 0,
        competency_cert: o.cert === true ? 1 : 0,
        association_member: o.association === true ? 1 : 0,
        appointment_ref: null,
        starts_on: o.startsOn ?? '2020-01-01',
        ends_on: o.endsOn ?? null,
        archived_at: o.archived === true ? NOW : null,
        ...trail,
      })
      .execute();
    return id;
  }

  async function trainings(staffId: string, dates: readonly string[], o: { archived?: boolean } = {}): Promise<void> {
    for (const heldOn of dates) {
      await h.db
        .insertInto('staff_trainings')
        .values({
          id: newId(NOW),
          library_staff_id: staffId,
          title: `Pelatihan ${heldOn}`,
          organizer: null,
          held_on: heldOn,
          hours: 8,
          certificate_file_id: null,
          archived_at: o.archived === true ? NOW : null,
          ...trail,
        })
        .execute();
    }
  }

  async function partnership(partner: string, startsOn: string, endsOn: string | null, kind = 'mou', archived = false): Promise<void> {
    await h.db
      .insertInto('library_partnerships')
      .values({
        id: newId(NOW),
        branch_id: null,
        partner,
        kind,
        starts_on: startsOn,
        ends_on: endsOn,
        scope: null,
        document_file_id: null,
        archived_at: archived ? NOW : null,
        ...trail,
      })
      .execute();
  }

  async function budget(year: number, libraryMinor: number, parentNonpersonnelMinor: number | null, o: { archived?: boolean; community?: number } = {}): Promise<void> {
    const id = newId(NOW);
    await h.db
      .insertInto('library_budgets')
      .values({
        id,
        scope_key: o.archived === true ? `~${id}` : '',
        branch_id: null,
        year,
        library_minor: libraryMinor,
        parent_minor: 500_000_000,
        parent_nonpersonnel_minor: parentNonpersonnelMinor,
        collection_minor: 2_000_000,
        community_minor: o.community ?? null,
        currency: 'IDR',
        note: null,
        archived_at: o.archived === true ? NOW : null,
        ...trail,
      })
      .execute();
  }

  async function news(status: string, publishedAt: number | null, archived = false): Promise<void> {
    await h.db
      .insertInto('pages')
      .values({
        id: newId(NOW),
        kind: 'news',
        slug_key: `berita-${newId(NOW).toLowerCase()}`,
        status,
        published_at: publishedAt,
        cover_file_id: null,
        archived_at: archived ? NOW : null,
        ...trail,
      })
      .execute();
  }

  const ACTIVITY_METRICS: AccredMetricId[] = [
    'registers.activities.needs_survey',
    'registers.activities.preservation_3p',
    'registers.activities.learning',
    'registers.activities.reading_culture',
    'registers.activities.writing_guidance',
    'registers.activities.external_literacy',
    'registers.activities.promotion',
  ];
  const valueOf = (m: Map<AccredMetricId, AccredMetricValue>, id: AccredMetricId) => m.get(id)?.value;
  const keys = (v: AccredMetricValue | undefined) => (v?.notes ?? []).map((n) => n.key);

  describe('activities', () => {
    it('counts each kind in its window by the day it was held; the flags count a row of another kind once', async () => {
      const p = await period();
      await activity('needs_survey', '2025-08-10');
      await activity('needs_survey', '2026-03-01');
      await activity('needs_survey', '2025-06-30');
      await activity('needs_survey', '2026-02-02', { archived: true });
      await activity('learning_session', '2025-09-01', { facility: true });
      await activity('writing_guidance', '2025-10-01', { facility: true, speaker: true });
      for (const d of ['2023-07-01', '2024-02-01', '2025-01-15', '2026-06-30']) await activity('preservation', d);
      await activity('preservation', '2023-03-01');

      const m = await compute(p, ACTIVITY_METRICS);
      expect(valueOf(m, 'registers.activities.needs_survey')).toBe(2);
      expect(valueOf(m, 'registers.activities.learning')).toBe(2);
      expect(valueOf(m, 'registers.activities.writing_guidance')).toBe(1);
      expect(valueOf(m, 'registers.activities.external_literacy')).toBe(1);
      expect(valueOf(m, 'registers.activities.reading_culture')).toBe(0);
      expect(valueOf(m, 'registers.activities.preservation_3p')).toBe(4);
      expect(m.get('registers.activities.needs_survey')).toMatchObject({ unit: 'count', basis: 'register', notes: [] });
    });

    it('every list it points to is an activities annex its own parameters accept', async () => {
      const p = await period();
      await activity('promotion', '2025-08-10');
      const m = await compute(p, ACTIVITY_METRICS);
      for (const id of ACTIVITY_METRICS) {
        const detail = m.get(id)?.detail;
        expect(detail?.reportId, id).toBe('accreditation.annex.activities');
        expect(reportById(detail!.reportId)!.paramsSchema.safeParse(detail!.params).success, id).toBe(true);
        expect(detail!.params['periodId']).toBe(p.id);
      }
      expect(m.get('registers.activities.learning')?.detail?.params).toEqual({ periodId: p.id, learning: true });
      expect(m.get('registers.activities.external_literacy')?.detail?.params).toEqual({ periodId: p.id, externalLiteracy: true });
      expect(m.get('registers.activities.preservation_3p')?.detail?.params).toEqual({ periodId: p.id, kinds: ['preservation'], window: 'three_periods' });
    });

    it('an empty register gives no value and says so; one row of another kind makes the count 0', async () => {
      const p = await period();
      await activity('promotion', '2025-09-01', { archived: true });
      const empty = await compute(p, ['registers.activities.needs_survey', 'registers.activities.learning']);
      expect(empty.get('registers.activities.needs_survey')).toMatchObject({ value: null, notes: [{ key: 'accred.note.register_empty', params: { register: 'Kegiatan' } }] });
      expect(valueOf(empty, 'registers.activities.learning')).toBeNull();

      await activity('promotion', '2025-09-01');
      const one = await compute(p, ['registers.activities.needs_survey']);
      expect(one.get('registers.activities.needs_survey')).toMatchObject({ value: 0, notes: [] });
    });

    it('promotion carries the OPAC news published in the period', async () => {
      const p = await period();
      await activity('promotion', '2025-08-10');
      await news('published', Date.UTC(2025, 9, 5, 2, 0, 0));
      await news('published', Date.UTC(2026, 5, 29, 20, 0, 0));
      await news('published', Date.UTC(2025, 5, 29, 2, 0, 0));
      await news('draft', Date.UTC(2025, 9, 6, 2, 0, 0));
      await news('published', Date.UTC(2025, 9, 7, 2, 0, 0), true);
      const v = (await compute(p, ['registers.activities.promotion'])).get('registers.activities.promotion');
      // 2026-06-29 20:00 UTC is 2026-06-30 in Jakarta, still in the period.
      expect(v).toMatchObject({ value: 1, facts: { newsPublished: 2 }, notes: [{ key: 'accred.note.l13_news', params: { count: 2 } }] });
    });
  });

  describe('staff', () => {
    const STAFF_METRICS: AccredMetricId[] = [
      'registers.active_staff',
      'registers.staff_pcs_pct',
      'registers.population_per_staff',
      'registers.training_avg_3p',
      'registers.head_qualification',
      'registers.staff_roles',
      'registers.profile_staff',
    ];

    it('counts the staff active at the period end and only their trainings in the three periods', async () => {
      const p = await period();
      const head = await staff('Kepala', { role: 'head', librarian: true, level: 's1', training: true, association: true, startsOn: '2019-07-15' });
      const tech = await staff('Teknis', { role: 'technical', training: true, startsOn: '2022-01-03' });
      const former = await staff('Mantan', { role: 'librarian', librarian: true, level: 's1', libraryEducation: true, endsOn: '2025-01-31' });
      await staff('Diarsipkan', { role: 'ict', archived: true });
      await trainings(head, ['2023-07-01', '2023-11-20', '2024-03-01', '2024-09-09', '2025-02-02', '2025-10-10', '2026-06-30']);
      await trainings(head, ['2023-05-01']);
      await trainings(head, ['2026-01-01'], { archived: true });
      await trainings(tech, ['2023-08-01', '2024-08-01', '2025-08-01', '2025-12-01', '2026-04-01']);
      await trainings(former, ['2024-01-01', '2024-06-01']);

      const m = await compute(p, STAFF_METRICS);
      expect(valueOf(m, 'registers.active_staff')).toBe(2);
      expect(m.get('registers.training_avg_3p')).toMatchObject({ value: 6, numerator: 12, denominator: 2, unit: 'ratio', notes: [{ key: 'accred.note.truncated' }] });
      expect(m.get('registers.staff_pcs_pct')).toMatchObject({ value: 50, numerator: 1, denominator: 2, unit: 'percent' });
      expect(m.get('registers.population_per_staff')).toMatchObject({ value: 61, numerator: 123, denominator: 2, unit: 'ratio' });
      expect(m.get('registers.head_qualification')?.facts).toEqual({ heads: 1, educationLevel: 's1', educationLibrary: false, libraryTraining: true });
      expect(m.get('registers.staff_roles')?.facts).toEqual({ active: 2, librarians: 1, ict: 0, technical: 1, technicalCertified: 1 });
      expect(m.get('registers.profile_staff')).toMatchObject({
        value: 2,
        table: [
          ['total', 2],
          ['librarians', 1],
          ['education_library', 0],
          ['competency_cert', 0],
          ['association_member', 1],
        ],
      });

      // The rules read these facts as the instrument expects: a degree in another field with training, and a
      // librarian with technical staff.
      expect(suggestAnswer(indicator('T1'), m.get('registers.head_qualification')!, null).suggestion).toBe('b');
      expect(suggestAnswer(indicator('T3'), m.get('registers.staff_roles')!, null).suggestion).toBe('b');
      expect(suggestAnswer(indicator('T4'), m.get('registers.training_avg_3p')!, null).suggestion).toBe('c');
      expect(suggestAnswer(indicator('T5'), m.get('registers.population_per_staff')!, null).suggestion).toBe('b');
    });

    it('of several heads the one who started last is used, and their count is a fact', async () => {
      const p = await period();
      await staff('Kepala lama', { role: 'head', level: 'd3', startsOn: '2018-01-01' });
      await staff('Kepala baru', { role: 'head', level: 's2', libraryEducation: true, startsOn: '2024-07-01' });
      const v = (await compute(p, ['registers.head_qualification'])).get('registers.head_qualification');
      expect(v).toMatchObject({ value: 2, facts: { heads: 2, educationLevel: 's2', educationLibrary: true, libraryTraining: false } });
    });

    it('without staff: no values, with the reason; with staff but no head: no head', async () => {
      const p = await period({ staff_pcs: null });
      const empty = await compute(p, STAFF_METRICS);
      expect(empty.get('registers.active_staff')).toMatchObject({ value: null, notes: [{ key: 'accred.note.register_empty', params: { register: 'Tenaga' } }] });
      expect(keys(empty.get('registers.staff_pcs_pct'))).toEqual(['accred.note.input_missing', 'accred.note.staff_missing']);
      expect(empty.get('registers.staff_pcs_pct')?.notes[0]).toEqual({ key: 'accred.note.input_missing', params: { field: 'jumlah komputer untuk tenaga perpustakaan' } });
      expect(valueOf(empty, 'registers.staff_pcs_pct')).toBeNull();
      expect(empty.get('registers.training_avg_3p')).toMatchObject({ value: null, notes: [{ key: 'accred.note.staff_missing' }] });
      expect(empty.get('registers.population_per_staff')).toMatchObject({ value: null, notes: [{ key: 'accred.note.staff_missing' }] });
      expect(empty.get('registers.head_qualification')).toMatchObject({ value: null, notes: [{ key: 'accred.note.head_missing' }] });
      expect(empty.get('registers.staff_roles')).toMatchObject({ value: null, notes: [{ key: 'accred.note.staff_missing' }] });

      await staff('Mantan', { role: 'head', endsOn: '2025-01-31' });
      await staff('Teknis', { role: 'technical' });
      const noHead = await compute(p, ['registers.active_staff', 'registers.head_qualification']);
      expect(valueOf(noHead, 'registers.active_staff')).toBe(1);
      expect(noHead.get('registers.head_qualification')).toMatchObject({ value: null, notes: [{ key: 'accred.note.head_missing' }] });
    });

    it('the school population per staff member needs the population', async () => {
      const p = await period({ students: null });
      await staff('Teknis');
      const v = (await compute(p, ['registers.population_per_staff'])).get('registers.population_per_staff');
      expect(v).toMatchObject({ value: null, notes: [{ key: 'accred.note.population_missing' }] });
    });

    it('a school population of 0 counts as missing: no ratio, the same note, and no suggestion', async () => {
      const p = await period({ students: 0, teachers: 0, edu_staff: 0 });
      await staff('Teknis');
      const v = (await compute(p, ['registers.population_per_staff'])).get('registers.population_per_staff')!;
      expect(v).toMatchObject({ value: null, notes: [{ key: 'accred.note.population_missing' }] });
      expect(suggestAnswer(indicator('T5'), v, null).suggestion).toBeNull();
    });
  });

  describe('partnerships', () => {
    it('counts each partner once over the agreements that overlap the three periods, of any kind', async () => {
      const p = await period();
      await partnership('Dinas Perpustakaan Kota', '2023-01-01', '2024-12-31', 'mou');
      await partnership('Taman Bacaan Pelangi', '2025-02-01', null, 'pks');
      await partnership('  taman   bacaan PELANGI ', '2025-08-01', '2026-07-31', 'other');
      await partnership('Universitas Négeri', '2026-01-10', '2027-01-09', 'mou');
      await partnership('Penerbit Lama', '2021-07-01', '2023-06-30', 'mou');
      await partnership('Arsip', '2025-01-01', null, 'mou', true);
      const v = (await compute(p, ['registers.partners_3p'])).get('registers.partners_3p');
      expect(v).toMatchObject({ value: 3, unit: 'count', basis: 'register', detail: { reportId: 'accreditation.annex.partnerships', params: { periodId: p.id } } });
    });

    it('an empty register gives no value', async () => {
      const p = await period();
      const v = (await compute(p, ['registers.partners_3p'])).get('registers.partners_3p');
      expect(v).toMatchObject({ value: null, notes: [{ key: 'accred.note.register_empty', params: { register: 'Kerja Sama' } }] });
    });
  });

  describe('budgets', () => {
    it('the share is the exact mean of the three yearly shares, cut once, with the years in a table', async () => {
      const p = await period();
      await budget(2024, 6_500_000, 100_000_000);
      await budget(2025, 5_200_000, 100_000_000);
      await budget(2026, 6_900_000, 100_000_000);
      await budget(2025, 99_000_000, 100_000_000, { archived: true });
      const m = await compute(p, ['registers.budget_share_3y', 'registers.budget_share_year', 'registers.profile_budget']);
      expect(m.get('registers.budget_share_3y')).toMatchObject({
        value: 6,
        unit: 'percent',
        notes: [{ key: 'accred.note.truncated' }],
        table: [
          [2024, 6_500_000, 100_000_000, 6],
          [2025, 5_200_000, 100_000_000, 5],
          [2026, 6_900_000, 100_000_000, 6],
        ],
        detail: { reportId: 'accreditation.annex.budgets', params: { periodId: p.id } },
      });
      expect(suggestAnswer(indicator('G3'), m.get('registers.budget_share_3y')!, null).suggestion).toBe('b');
      expect(valueOf(m, 'registers.budget_share_year')).toBe(6);
      expect(m.get('registers.profile_budget')).toMatchObject({
        value: 6_900_000,
        table: [
          ['library_minor', 6_900_000],
          ['community_minor', ''],
          ['collection_minor', 2_000_000],
          ['parent_minor', 500_000_000],
          ['currency', 'IDR'],
        ],
      });
    });

    it('the mean is exact: 29 % three times is 29, where binary fractions would give 28.999…', async () => {
      const p = await period();
      for (const year of [2024, 2025, 2026]) await budget(year, 29_000_000, 100_000_000);
      expect(valueOf(await compute(p, ['registers.budget_share_3y']), 'registers.budget_share_3y')).toBe(29);
      await h.db.deleteFrom('library_budgets').execute();
      // Amounts whose products pass 2^53 keep their precision.
      for (const year of [2024, 2025, 2026]) await budget(year, 2_900_000_000_000_000, 9_000_000_000_000_000);
      expect(valueOf(await compute(p, ['registers.budget_share_3y', 'registers.budget_share_year']), 'registers.budget_share_3y')).toBe(32);
    });

    it('a missing year, or a year without the parent budget, gives no value and says the data is incomplete', async () => {
      const p = await period();
      await budget(2024, 6_500_000, 100_000_000);
      await budget(2026, 6_900_000, 100_000_000);
      const missing = await compute(p, ['registers.budget_share_3y', 'registers.budget_share_year']);
      expect(missing.get('registers.budget_share_3y')).toMatchObject({ value: null, notes: [{ key: 'accred.note.budget_incomplete' }] });
      expect(valueOf(missing, 'registers.budget_share_year')).toBe(6);

      await budget(2025, 5_200_000, null);
      expect(valueOf(await compute(p, ['registers.budget_share_3y']), 'registers.budget_share_3y')).toBeNull();
      await h.db.deleteFrom('library_budgets').execute();
      await budget(2024, 6_500_000, 100_000_000);
      await budget(2025, 5_200_000, 0);
      await budget(2026, 6_900_000, 100_000_000);
      expect(valueOf(await compute(p, ['registers.budget_share_3y']), 'registers.budget_share_3y')).toBeNull();
    });
  });

  describe('documents', () => {
    it('the report routine counts each report kind per yearly slice, undated ones apart', async () => {
      const p = await period();
      for (const d of ['2023-12-15', '2024-12-15', '2025-12-15']) await document('report_annual', { issuedOn: d });
      for (const d of ['2023-12-20', '2024-06-20', '2024-12-20', '2025-06-20', '2025-12-20', '2026-06-20']) await document('report_semester', { issuedOn: d });
      for (const d of ['2023-09-30', '2023-12-31', '2024-03-31', '2024-09-30', '2024-12-31', '2025-03-31', '2025-09-30', '2025-12-31', '2026-03-31']) {
        await document('report_quarterly', { issuedOn: d });
      }
      await document('report_monthly', { issuedOn: null });
      await document('report_annual', { issuedOn: '2023-06-30' });
      await document('report_annual', { issuedOn: '2026-01-05', archived: true });
      const v = (await compute(p, ['registers.report_routine_3p'])).get('registers.report_routine_3p');
      const slice = { annual: 1, semester: 2, quarterly: 3, monthly: 0 };
      expect(v).toMatchObject({ value: 18, unit: 'code', facts: routineFacts([slice, slice, slice], 1) });
      const r = suggestAnswer(indicator('G4'), v!, null);
      expect(r.suggestion).toBe('b');
      expect(r.notes).toContainEqual({ key: 'accred.note.g4_undated', params: { count: 1 } });
    });

    it('the legality elements: the current documents and the NPP of the profile', async () => {
      const p = await period();
      await document('founding_decree', { issuedOn: '2010-07-01' });
      await document('duties');
      await document('org_structure', { issuedOn: '2024-01-10', validUntil: '2028-12-31' });
      await document('org_structure', { issuedOn: '2020-01-10', validUntil: '2023-12-31' });
      await document('duties', { issuedOn: '2026-09-01' });

      const noNpp = (await compute(p, ['registers.legality_elements'], { npp: '  ' })).get('registers.legality_elements');
      expect(noNpp).toMatchObject({ value: 3, facts: { elements: ['founding_decree', 'duties', 'org_structure'] } });
      expect(suggestAnswer(indicator('F1'), noNpp!, null)).toMatchObject({ suggestion: 'd' });

      const withNpp = (await compute(p, ['registers.legality_elements'], { npp: '3201010D0000001' })).get('registers.legality_elements');
      expect(withNpp).toMatchObject({ value: 4, facts: { elements: ['founding_decree', 'npp', 'duties', 'org_structure'] } });
    });

    it('without any document the legality elements count the NPP alone, and nothing without it', async () => {
      const p = await period();
      const none = (await compute(p, ['registers.legality_elements', 'registers.collection_policy_aspects'])).get('registers.legality_elements');
      expect(none).toMatchObject({ value: null, notes: [{ key: 'accred.note.register_empty', params: { register: 'Dokumen' } }] });
      const npp = (await compute(p, ['registers.legality_elements'], { npp: '3201010D0000001' })).get('registers.legality_elements');
      expect(npp).toMatchObject({ value: 1, facts: { elements: ['npp'] }, notes: [] });
    });

    it('aspects are the union over the current documents of a kind; the head report counts those issued in the period', async () => {
      const p = await period();
      await document('collection_policy', { aspects: ['a1', 'a2', 'a3'] });
      await document('collection_policy', { issuedOn: '2025-01-05', aspects: ['a3', 'a4', 'a6', 'a5', 'zz'] });
      await document('collection_policy', { validUntil: '2025-12-31', aspects: ['a7'] });
      await document('collection_policy', { archived: true, aspects: ['a8'] });
      await document('library_program', { aspects: ['a1', 'a2', 'a3'] });
      await document('head_performance_report', { issuedOn: '2026-06-01', aspects: ['a1', 'a2', 'a3', 'a4'] });
      await document('head_performance_report', { issuedOn: '2025-06-01', aspects: ['a5', 'a6'] });
      for (const kind of ['rules', 'sop_membership', 'sop_loan']) await document(kind);
      for (const kind of ['pos_collection', 'pos_organisation', 'pos_service', 'pos_promotion']) await document(kind);
      const m = await compute(p, [
        'registers.collection_policy_aspects',
        'registers.library_program_aspects',
        'registers.head_performance_aspects',
        'registers.service_procedures',
        'registers.operating_procedures',
        'registers.founding_decree_registered',
      ]);
      expect(m.get('registers.collection_policy_aspects')).toMatchObject({ value: 6, facts: { elements: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] } });
      expect(m.get('registers.library_program_aspects')).toMatchObject({ value: 3, facts: { elements: ['a1', 'a2', 'a3'] } });
      expect(m.get('registers.head_performance_aspects')).toMatchObject({ value: 4, facts: { elements: ['a1', 'a2', 'a3', 'a4'] } });
      expect(m.get('registers.service_procedures')).toMatchObject({ value: 3, facts: { elements: ['rules', 'sop_membership', 'sop_loan'] } });
      expect(m.get('registers.operating_procedures')).toMatchObject({ value: 4, facts: { elements: ['pos_collection', 'pos_organisation', 'pos_service', 'pos_promotion'] } });
      expect(m.get('registers.founding_decree_registered')).toMatchObject({ value: 0, notes: [] });
      expect(m.get('registers.collection_policy_aspects')?.detail).toEqual({ reportId: 'accreditation.annex.documents', params: { periodId: p.id, kinds: ['collection_policy'] } });
      expect(suggestAnswer(indicator('K3'), m.get('registers.collection_policy_aspects')!, null).suggestion).toBe('b');
      expect(suggestAnswer(indicator('L1'), m.get('registers.service_procedures')!, null).suggestion).toBe('b');

      await document('founding_decree', { issuedOn: '2027-01-01' });
      expect(valueOf(await compute(p, ['registers.founding_decree_registered']), 'registers.founding_decree_registered')).toBe(1);
    });
  });

  describe('profile and standards', () => {
    it('the stock-take and weeding dates, and the profile counts of their spans', async () => {
      const p = await period();
      await activity('stocktake', '2022-08-01');
      await activity('stocktake', '2024-08-10');
      await activity('weeding', '2024-08-12');
      await activity('weeding', '2026-07-15');
      await activity('innovation', '2025-09-01');
      await activity('innovation', '2026-02-01');
      await activity('uniqueness', '2025-11-11');
      await activity('award', '2024-05-05');
      await activity('award', '2023-05-05');
      await partnership('Dinas Perpustakaan Kota', '2025-02-01', null, 'pks');
      await partnership('Penerbit Lama', '2023-01-01', '2024-12-31');
      const m = await compute(p, ['registers.stocktake_weeding_3y', 'registers.profile_counts']);
      expect(m.get('registers.stocktake_weeding_3y')).toMatchObject({ value: 2, facts: { lastStocktake: '2024-08-10', lastWeeding: '2024-08-12' } });
      expect(m.get('registers.profile_counts')).toMatchObject({
        value: 1,
        table: [
          ['partners', 1],
          ['innovation', 2],
          ['uniqueness', 1],
          ['award', 1],
        ],
      });
    });

    it('computes only what it is asked for, and every value in one call', async () => {
      const p = await period();
      const step = await registersProvider.compute(metricCtx(p), ['registers.founding_decree_registered'], null);
      expect(step.done).toBe(true);
      if (step.done) expect([...step.values.keys()]).toEqual(['registers.founding_decree_registered']);
      const all = await registersProvider.compute(metricCtx(p), registersProvider.metrics, null);
      expect(all.done && [...all.values.keys()].sort()).toEqual([...registersProvider.metrics].sort());
    });
  });
});
