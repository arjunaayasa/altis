import fsp from 'node:fs/promises';
import { auditAppend, withTx } from '@altis/db';
import { isDomainError, newId, t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { reportById } from '../../src/reports/registry.js';
import { previewReport } from '../../src/reports/runs/preview.js';
import { libraryCollectionStatistics, libraryLoanStatistics, libraryMemberStatistics, libraryVisitStatistics } from '../../src/reports/statistics/library.js';
import type { ReportRow } from '../../src/reports/types.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { masterId, seedBranch, seedCopy, seedLoan, seedMember, seedUse, seedVisit } from '../support/circulation-seed.js';
import { checkPdf } from '../support/pdf-check.js';
import { STAFF_NAME, drive, exportPath, insertPeriod, openExportDb, runRow, startRun, type ExportDb } from './reports-export-support.js';

// The second round of reports on a small library seen on 15 March 2026 (Asia/Jakarta), worked out by hand: the visits
// by hour and weekday, the accreditation-period filter of the monthly matrices, the staff activity from the audit log,
// the library's figures of the dashboard, and the annual report as a PDF run.

const ctx = testDbContext();
const NOW = Date.parse('2026-03-15T05:00:00Z');
const TOTAL = t('id', 'report.row.total');
const guests = t('id', 'report.row.circ.guests' as MessageKey);

describe.skipIf(!ctx.available)(`the second round of reports [${engineLabel()}]`, () => {
  let db: ExportDb;
  let branchId: string;
  /** The school year 2025/2026. */
  let periodId: string;
  /** A span of 24 months. */
  let longPeriodId: string;
  let bayu: string;

  async function preview(id: string, params: Record<string, unknown> = {}): Promise<{ rows: ReportRow[]; totals: ReportRow | null }> {
    const def = reportById(id)!;
    const settings = await loadAccredSettings(db.h.db);
    const o = { locale: 'id' as const, tz: 'Asia/Jakarta', now: NOW, settings };
    const rows: ReportRow[] = [];
    let page = await previewReport(db.h.db, def, { params, limit: 200 }, o);
    const totals = page.totals;
    rows.push(...page.rows);
    while (page.nextCursor !== null) {
      page = await previewReport(db.h.db, def, { params, limit: 200, cursor: page.nextCursor }, o);
      rows.push(...page.rows);
    }
    return { rows, totals };
  }

  /** The field errors of a refused preview. */
  async function refused(id: string, params: Record<string, unknown>): Promise<unknown> {
    return preview(id, params).then(
      () => 'answered',
      (e: unknown) => (isDomainError(e) ? [e.code, (e.meta as { errors?: unknown }).errors] : e),
    );
  }

  /** A visit at the instant `at` (its day in Jakarta). */
  async function visitAt(at: string, o: { member?: boolean; headcount?: number; voided?: boolean } = {}): Promise<void> {
    const siswa = await masterId(db.h.db, 'member_types', 'SISWA');
    const day = new Date(Date.parse(at) + 7 * 3_600_000).toISOString().slice(0, 10);
    const id = await seedVisit(db.h.db, {
      branchId,
      visitedOn: day,
      ...(o.member === false ? { guestName: 'Tamu' } : { memberTypeId: siswa, accredGroup: 'student' }),
      headcount: o.headcount ?? 1,
      voided: o.voided ?? false,
    });
    await db.h.db.updateTable('visits').set({ visited_at: Date.parse(at) }).where('id', '=', id).execute();
  }

  async function audit(at: string, actorId: string, action: string, meta: Record<string, unknown> = {}, actorType = 'staff'): Promise<void> {
    await withTx(db.h, (trx) => auditAppend(trx, { at: Date.parse(at), actorType, actorId, action, entity: null, entityId: null, branchId: null, ip: null, meta }));
  }

  beforeAll(async () => {
    db = await openExportDb('k5-reports');
    const h = db.h.db;
    branchId = await seedBranch(h, 'UT');
    periodId = await insertPeriod(db, 'Tahun Pelajaran 2025/2026');
    longPeriodId = await insertPeriod(db, 'Dua tahun');
    await h.updateTable('accred_periods').set({ kind: 'custom', starts_on: '2025-01-01', ends_on: '2026-12-31' }).where('id', '=', longPeriodId).execute();
    // Visits: a class of 30 on Monday 2 March at 08:15 and a member at 09:30; a guest on Wednesday 4 March at 13:00 and a
    // voided visit then; a member on Tuesday 5 August 2025 at 10:00 (in the school year, outside the last 30 days); five
    // on 30 June 2025 (before the school year).
    await visitAt('2026-03-02T01:15:00Z', { headcount: 30 });
    await visitAt('2026-03-02T02:30:00Z');
    await visitAt('2026-03-04T06:00:00Z', { member: false });
    await visitAt('2026-03-04T06:30:00Z', { voided: true, headcount: 4 });
    await visitAt('2025-08-05T03:00:00Z');
    await visitAt('2025-06-30T03:00:00Z', { headcount: 5 });
    // Members: Ana (joined this year), Dodi (expired), Fajar (archived).
    const ana = await seedMember(h, { no: 'S-001', name: 'Ana', joinedOn: '2026-01-10' });
    await seedMember(h, { no: 'S-004', name: 'Dodi', expiresOn: '2026-03-01' });
    await seedMember(h, { no: 'S-005', name: 'Fajar', archived: true });
    // Copies and loans: one in August 2025 (returned), one on 3 March (open, overdue), one in June 2025 (returned).
    const bio = await seedCopy(h, { branchId, title: 'Biologi Dasar', barcode: 'B0001', classification: '570' });
    const tafsir = await seedCopy(h, { branchId, title: 'Tafsir Ringkas', barcode: 'B0002', classification: '2X1' });
    const atlas = await seedCopy(h, { branchId, title: 'Atlas Dunia', barcode: 'B0003', classification: '912' });
    await h.updateTable('items').set({ received_date: '2026-02-01' }).where('id', '=', atlas.itemId).execute();
    await seedLoan(h, { ...bio, memberId: ana, branchId, loanedOn: '2025-08-10', dueOn: '2025-08-17', returnedOn: '2025-08-15', statDdc: '570' });
    await seedLoan(h, { ...tafsir, memberId: ana, branchId, loanedOn: '2026-03-03', dueOn: '2026-03-10', statDdc: '2X' });
    await seedLoan(h, { ...atlas, memberId: ana, branchId, loanedOn: '2025-06-20', dueOn: '2025-06-27', returnedOn: '2025-06-25', statDdc: '910' });
    await seedUse(h, { ...bio, branchId, usedOn: '2025-09-01', statDdc: '000' });
    // The audit log: two staff members' work in the last 30 days, one loan of January, a dry run, a member's renewal.
    bayu = newId();
    await h.insertInto('staff_users').values({ id: bayu, username_key: 'bayu', username_display: 'bayu', name: 'Bayu Petugas', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW }).execute();
    for (const action of ['catalog.record.create', 'catalog.record.create', 'circulation.loan.create', 'circulation.loan.create', 'circulation.loan.create', 'circulation.loan.return']) {
      await audit('2026-03-10T03:00:00Z', db.staffId, action);
    }
    await audit('2026-03-10T03:00:00Z', db.staffId, 'catalog.item.batch_create', { count: 5, skipped: 0, patternId: null });
    await audit('2026-03-10T03:00:00Z', db.staffId, 'members.import.finish', { dryRun: false, inserted: 4, updated: 1 });
    await audit('2026-03-10T03:00:00Z', db.staffId, 'members.import.finish', { dryRun: true, inserted: 9 });
    await audit('2026-01-05T03:00:00Z', db.staffId, 'circulation.loan.create');
    for (const action of ['catalog.item.create', 'members.member.create', 'circulation.loan.renew', 'circulation.loan.renew']) await audit('2026-03-12T03:00:00Z', bayu, action);
    await audit('2026-03-12T03:00:00Z', ana, 'circulation.loan.renew', {}, 'member');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('visits.by_hour: head counts by the hour of the branch clock and the weekday, voided visits left out, the hours with visits and those between', async () => {
    const last30 = await preview('visits.by_hour');
    const hour = (h: string, cells: number[]): ReportRow => [`${h}:00–${h}:59`, ...cells];
    expect(last30.rows).toEqual([
      hour('08', [30, 0, 0, 0, 0, 0, 0, 30]),
      hour('09', [1, 0, 0, 0, 0, 0, 0, 1]),
      hour('10', [0, 0, 0, 0, 0, 0, 0, 0]),
      hour('11', [0, 0, 0, 0, 0, 0, 0, 0]),
      hour('12', [0, 0, 0, 0, 0, 0, 0, 0]),
      hour('13', [0, 0, 1, 0, 0, 0, 0, 1]),
    ]);
    expect(last30.totals).toEqual([TOTAL, 31, 0, 1, 0, 0, 0, 0, 32]);
    const year = await preview('visits.by_hour', { periodId });
    expect(year.rows.find((r) => r[0] === '10:00–10:59')).toEqual(hour('10', [0, 1, 0, 0, 0, 0, 0, 1]));
    expect(year.totals).toEqual([TOTAL, 31, 1, 1, 0, 0, 0, 0, 33]);
    expect(await preview('visits.by_hour', { range: { from: '2020-01-01', to: '2020-12-31' } })).toEqual({ rows: [], totals: [TOTAL, 0, 0, 0, 0, 0, 0, 0, 0] });
  });

  it('the period filter: the monthly visits, loans by class and in-library uses read the period instead of the year', async () => {
    const byYear = await preview('visits.monthly', { year: 2025 });
    expect(byYear.rows.map((r) => [r[0], r[6], r[8], r[13]])).toEqual([['Siswa', 5, 1, 6]]);
    const byPeriod = await preview('visits.monthly', { year: 2025, periodId });
    expect(byPeriod.rows.map((r) => [r[0], r[3], r[8], r[13]])).toEqual([
      ['Siswa', 31, 1, 32],
      [guests, 1, 0, 1],
    ]);
    const loans = await preview('circulation.loans_by_class', { periodId });
    expect(loans.rows.map((r) => r[0])).toEqual(['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(loans.rows.filter((r) => r[13] !== 0).map((r) => [r[0], r[6], r[11], r[13]])).toEqual([
      ['2025-08', 1, 0, 1],
      ['2026-03', 0, 1, 1],
    ]);
    expect(loans.totals?.at(-1)).toBe(2);
    const division = await preview('circulation.loans_by_class', { periodId, mainClass: '500' });
    expect(division.rows.find((r) => r[0] === '570–579')?.slice(8, 9)).toEqual([1]);
    const uses = await preview('circulation.in_library', { periodId });
    expect(uses.rows.filter((r) => r[13] !== 0).map((r) => [r[0], r[1]])).toEqual([['2025-09', 1]]);
    expect(await refused('visits.monthly', { periodId: longPeriodId })).toEqual(['VALIDATION_FAILED', [{ path: 'periodId', code: 'too_big' }]]);
    expect(await refused('circulation.loans_by_class', { periodId: newId() })).toEqual(['VALIDATION_FAILED', [{ path: 'periodId', code: 'not_found' }]]);
  });

  it('system.staff_activity: each staff member from the audit log by actor, a batch by its size, an import for real only, no member', async () => {
    const recent = await preview('system.staff_activity');
    expect(recent.rows).toEqual([
      [STAFF_NAME, 2, 5, 4, 3, 1, 0, 15],
      ['Bayu Petugas', 0, 1, 1, 0, 0, 2, 4],
    ]);
    expect(recent.totals).toEqual([TOTAL, 2, 6, 5, 3, 1, 2, 19]);
    const year = await preview('system.staff_activity', { periodId });
    expect(year.rows[0]).toEqual([STAFF_NAME, 2, 5, 4, 4, 1, 0, 16]);
    expect((await preview('system.staff_activity', { range: { from: '2026-03-11', to: '2026-03-15' } })).rows.map((r) => r[0])).toEqual(['Bayu Petugas']);
  });

  it('the library figures of the dashboard: the stock of today, the register, this month and year', async () => {
    expect(await libraryCollectionStatistics(db.h.db, NOW)).toEqual({ today: '2026-03-15', year: 2026, titles: 3, items: 3, receivedThisYear: 1 });
    expect(await libraryMemberStatistics(db.h.db, NOW)).toEqual({ today: '2026-03-15', year: 2026, registered: 2, valid: 1, joinedThisYear: 1 });
    const months = (m: Record<number, number>): number[] => Array.from({ length: 12 }, (_, k) => m[k + 1] ?? 0);
    expect(await libraryVisitStatistics(db.h.db, NOW)).toEqual({ today: '2026-03-15', year: 2026, thisMonth: 32, thisYear: 32, byMonth: months({ 3: 32 }) });
    expect(await libraryLoanStatistics(db.h.db, NOW)).toEqual({ today: '2026-03-15', year: 2026, thisMonth: 1, thisYear: 1, byMonth: months({ 3: 1 }), open: 1, overdue: 1 });
  });

  it('library.annual_report: a PDF run of the school year, in its language, naming no one but the requester in the footer', async () => {
    for (const locale of ['id', 'en'] as const) {
      const run = await startRun(db, 'library.annual_report', { format: 'pdf', params: { periodId }, locale });
      expect((await drive(db, run.jobId)).at(-1)).toBe('succeeded');
      const row = await runRow(db, run.id);
      expect([row.status, row.personal, row.locale]).toEqual(['succeeded', 0, locale]);
      const pages = checkPdf(await fsp.readFile(exportPath(db, run.id, 'pdf'))).pages;
      const text = pages.flatMap((p) => p.texts.map((x) => x.text)).join('\n');
      for (const key of ['collection', 'additions', 'members', 'usage', 'activities', 'staff', 'budget', 'approval']) {
        expect(text, `${locale} ${key}`).toContain(t(locale, `report.annual.section.${key}` as MessageKey));
      }
      expect(text).toContain('Tahun Pelajaran 2025/2026');
      // 33 people in the school year (the voided visit and the visits before it left out); 2 loans.
      expect(text).toContain('33');
      expect(text).not.toContain('Ana');
      expect(text).not.toContain('Bayu');
    }
    // A year by default, the document refused in a format it does not write.
    const year = await startRun(db, 'library.annual_report', { format: 'pdf', params: {} });
    expect((await drive(db, year.jobId)).at(-1)).toBe('succeeded');
    const csv = await startRun(db, 'library.annual_report', { format: 'csv', params: {} }).then(
      () => 'started',
      (e: unknown) => (isDomainError(e) ? e.code : e),
    );
    expect(csv).toBe('VALIDATION_FAILED');
  }, 120_000);

  it('the copies received this year on the dashboard follow the acquisition date of the reports, not the receiving date alone', async () => {
    const h = db.h.db;
    /** A copy whose first history row is `type` at `at`, its record made at `recordAt`. */
    async function copyOf(barcode: string, type: 'created' | 'migrated', at: string, recordAt = at): Promise<void> {
      const { recordId, itemId } = await seedCopy(h, { branchId, title: `Judul ${barcode}`, barcode });
      await h.updateTable('records').set({ created_at: Date.parse(recordAt) }).where('id', '=', recordId).execute();
      await h.updateTable('items').set({ created_at: Date.parse(at) }).where('id', '=', itemId).execute();
      await h
        .insertInto('item_events')
        .values({ id: newId(), item_id: itemId, at: Date.parse(at), type, from_status: null, to_status: 'available', from_location_id: null, to_location_id: null, actor_type: 'system', actor_id: null, meta: '{}' })
        .execute();
    }
    const before = (await libraryCollectionStatistics(h, NOW)).receivedThisYear;
    // Made here on 1 January 2026 at 00:30 in Jakarta (counted), and on 31 December 2025 at 23:30 there (not counted).
    await copyOf('C0001', 'created', '2025-12-31T17:30:00Z');
    await copyOf('C0002', 'created', '2025-12-31T16:30:00Z');
    // Migrated: dated by its record's creation in the source system (counted), unless that is a migration's own clock.
    await copyOf('C0003', 'migrated', '2026-03-01T03:00:00Z', '2026-02-10T03:00:00Z');
    await copyOf('C0004', 'migrated', '2026-03-01T03:00:00Z', '2026-03-01T03:00:00Z');
    await h
      .insertInto('catalog_runs')
      .values({ id: newId(), kind: 'migration', status: 'succeeded', format: null, options: '{}', summary: '{}', report_file_id: null, output_name: null, output_size: null, expires_at: null, job_id: null, created_at: Date.parse('2026-03-01T02:00:00Z'), created_by: null, finished_at: Date.parse('2026-03-01T04:00:00Z') })
      .execute();
    expect((await libraryCollectionStatistics(h, NOW)).receivedThisYear).toBe(before + 2);
  });
});
