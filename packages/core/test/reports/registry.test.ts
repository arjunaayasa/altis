import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PERSONAL_COLUMNS } from '@altis/db';
import { reportWorkDir, reportWorkPath } from '@altis/platform';
import { MESSAGES, newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORTS, reportById } from '../../src/reports/registry.js';
import { columnShapes, columnsOf, showsPersonalColumn } from '../../src/reports/personal.js';
import { TEST_REPORTS } from '../../src/reports/test-reports.js';
import type { DocumentCtx, DocumentReport, DocumentResume, DocumentStep, ReportCtx, ReportDefinition, TableReport } from '../../src/reports/types.js';

// The report registry: every definition of the report catalogue with its final metadata (kind, formats, orientation,
// personal, columns, parameters and whether it scans the stock), the rule that a report showing a personal column is
// personal, every label a shared message, and the test profile's three definitions of a known shape.

/** The report catalogue: id → kind, personal, orientation, columns (`key:type`, or by the shaping parameter's value). */
const CATALOGUE: Readonly<Record<string, { kind: 'table' | 'document'; personal: boolean; orientation: 'portrait' | 'landscape'; columns?: string }>> = {
  'collection.summary': { kind: 'table', personal: false, orientation: 'portrait', columns: 'section:text item:text titles:int items:int' },
  'collection.ddc_recap': { kind: 'table', personal: false, orientation: 'portrait', columns: 'class:text label:text group:text titles:int items:int' },
  'collection.acquisitions': { kind: 'table', personal: false, orientation: 'landscape' },
  'collection.title_list': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns: 'title:text edition:text publisher:text place:text year:text isbn_issn:text classification:text call_number:text items:int',
  },
  'collection.item_list': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns:
      'barcode:text inventory_no:text title:text call_number:text collection_type:text status:text location:text received_date:date price:money acq_source:text',
  },
  'collection.accession_register': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns:
      'inventory_no:text barcode:text received_date:date title:text authors:text edition:text isbn:text place:text publisher:text year:text collation:text price:money source:text call_number:text',
  },
  'collection.data_quality': {
    kind: 'table',
    personal: false,
    orientation: 'portrait',
    columns: 'problem:text barcode:text title:text call_number:text location:text detail:text',
  },
  'collection.attachment_downloads': { kind: 'table', personal: false, orientation: 'portrait', columns: 'title:text attachment:text mime:text downloads:int' },
  'accreditation.annex.ddc': { kind: 'table', personal: false, orientation: 'portrait', columns: 'class:text label:text titles:int items:int' },
  'accreditation.annex.collection_matrix': { kind: 'table', personal: false, orientation: 'portrait', columns: 'medium:text kind:text titles:int items:int' },
  'accreditation.annex.additions': { kind: 'table', personal: false, orientation: 'portrait', columns: 'label:text titles:int pct:percent' },
  'accreditation.annex.l14': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns: 'month:text student:int teacher:int edu_staff:int school_visits:int population:int pct:percent source:text',
  },
  'accreditation.annex.usage_monthly': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns:
      'month:text visits_student:int visits_teacher:int visits_edu_staff:int visits_public:int visits_other:int visits_guest:int loans:int in_library_uses:int source:text',
  },
  'accreditation.annex.staff': { kind: 'table', personal: true, orientation: 'landscape' },
  'accreditation.annex.budgets': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns: 'year:text library:money parent:money parent_nonpersonnel:money collection:money community:money pct:percent',
  },
  'accreditation.annex.activities': {
    kind: 'table',
    personal: false,
    orientation: 'portrait',
    columns: 'kind:text title:text held_on:date participants:int partner:text',
  },
  'accreditation.annex.partnerships': {
    kind: 'table',
    personal: false,
    orientation: 'portrait',
    columns: 'partner:text kind:text starts_on:date ends_on:date scope:text',
  },
  'accreditation.annex.documents': {
    kind: 'table',
    personal: false,
    orientation: 'landscape',
    columns: 'kind:text title:text reference:text issued_on:date issued_by:text aspects:text valid_until:date',
  },
  'accreditation.dossier': { kind: 'document', personal: true, orientation: 'portrait' },
  'accreditation.self_assessment': { kind: 'document', personal: true, orientation: 'portrait' },
  'accreditation.statement_1000': { kind: 'document', personal: false, orientation: 'portrait' },
  // ---- Komunitas K2 (members) ----
  'members.list': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns: 'member_no:text name:text member_type:text class:text gender:text member_status:text joined_on:date expires_on:date',
  },
  // ---- Komunitas (member, visit and circulation reports) ----
  'members.summary': { kind: 'table', personal: false, orientation: 'portrait', columns: 'section:text item:text registered:int active:int expired:int suspended:int' },
  'members.expiring': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns: 'member_no:text name:text member_type:text class:text expires_on:date days_left:int phone:text email:text',
  },
  'members.reprint_list': { kind: 'table', personal: true, orientation: 'portrait', columns: 'source_no:text member_no:text name:text' },
  'visits.monthly': { kind: 'table', personal: false, orientation: 'landscape', columns: 'group:text m01:int m02:int m03:int m04:int m05:int m06:int m07:int m08:int m09:int m10:int m11:int m12:int total:int' },
  'visits.daily': { kind: 'table', personal: false, orientation: 'portrait', columns: 'date:date weekday:text members:int guests:int total:int' },
  'visits.list': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns: 'visited_at:text member_no:text name:text member_type:text class:text institution:text location:text source:text purpose:text',
  },
  'circulation.summary': { kind: 'table', personal: false, orientation: 'portrait', columns: 'section:text item:text value:int' },
  'circulation.loans_by_class': { kind: 'table', personal: false, orientation: 'landscape', columns: 'month:text c000:int c100:int c200:int c300:int c400:int c500:int c600:int c700:int c800:int c900:int c2x:int cnon:int total:int' },
  'circulation.item_usage': { kind: 'table', personal: false, orientation: 'landscape', columns: 'barcode:text title:text m01:int m02:int m03:int m04:int m05:int m06:int m07:int m08:int m09:int m10:int m11:int m12:int total:int' },
  'circulation.top_titles': { kind: 'table', personal: false, orientation: 'portrait', columns: 'rank:int title:text call_number:text loans:int' },
  'circulation.in_library': { kind: 'table', personal: false, orientation: 'landscape', columns: 'month:text c000:int c100:int c200:int c300:int c400:int c500:int c600:int c700:int c800:int c900:int c2x:int cnon:int total:int' },
  'circulation.loan_history': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns:
      'member_no:text name:text member_type:text class:text barcode:text title:text loaned_on:date due_on:date returned_on:date renewals:int outcome:text days_late:int',
  },
  'circulation.open_loans': { kind: 'table', personal: true, orientation: 'landscape', columns: 'member_no:text name:text class:text phone:text email:text barcode:text title:text loaned_on:date due_on:date days_late:int' },
  'circulation.overdue': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns: 'member_no:text name:text class:text phone:text email:text barcode:text title:text price:money loaned_on:date due_on:date days_late:int fine:money',
  },
  'circulation.due_soon': { kind: 'table', personal: true, orientation: 'landscape', columns: 'member_no:text name:text class:text phone:text email:text barcode:text title:text loaned_on:date due_on:date days_left:int' },
  'circulation.holds': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns: 'title:text member_no:text name:text placed_on:date status:text queue_position:int pickup_until:date',
  },
  'circulation.charges': {
    kind: 'table',
    personal: true,
    orientation: 'landscape',
    columns: 'member_no:text name:text charged_on:date kind:text description:text amount:money paid:money waived:money balance:money',
  },
  'circulation.payments_daily': { kind: 'table', personal: true, orientation: 'landscape', columns: 'paid_on:date method:text staff:text payments:int amount:money' },
  'circulation.top_borrowers': { kind: 'table', personal: true, orientation: 'portrait', columns: 'rank:int member_no:text name:text member_type:text class:text loans:int' },
};

/** The module, permission and export permission of the member, visit and circulation reports. */
const PERMISSIONS: Readonly<Record<string, readonly [string, string, string]>> = {
  'members.list': ['members', 'members.records.read', 'members.export.run'],
  // ---- Komunitas (member, visit and circulation reports) ----
  'members.summary': ['members', 'reports.statistics.read', 'reports.statistics.read'],
  'members.expiring': ['members', 'members.records.read', 'members.export.run'],
  'members.reprint_list': ['members', 'members.records.read', 'members.export.run'],
  'visits.monthly': ['visits', 'reports.statistics.read', 'reports.statistics.read'],
  'visits.daily': ['visits', 'reports.statistics.read', 'reports.statistics.read'],
  'visits.list': ['visits', 'visits.records.read', 'visits.records.read'],
  ...Object.fromEntries(
    ['summary', 'loans_by_class', 'item_usage', 'top_titles', 'in_library'].map((n) => [`circulation.${n}`, ['circulation', 'reports.statistics.read', 'reports.statistics.read']]),
  ),
  ...Object.fromEntries(
    ['loan_history', 'open_loans', 'overdue', 'due_soon', 'holds', 'charges', 'payments_daily', 'top_borrowers'].map((n) => [
      `circulation.${n}`,
      ['circulation', 'circulation.records.read', 'circulation.records.read'],
    ]),
  ),
};

/** The test profile's definitions, appended after the catalogue. */
const TEST_IDS = ['test.rows', 'test.personal', 'test.document'];

const MESSAGE_KEYS = new Set(Object.keys(MESSAGES.id));

const shape = (def: ReportDefinition, params: Record<string, unknown> = {}): string =>
  columnsOf(def, params)
    .map((c) => `${c.key}:${c.type}`)
    .join(' ');

const table = (id: string): TableReport => {
  const def = reportById(id);
  if (def === null || def.kind !== 'table') throw new Error(`${id} is not a table report`);
  return def;
};

const testRowsReport = table('test.rows');
const testPersonalReport = table('test.personal');
const testDocumentReport = reportById('test.document') as DocumentReport;

describe('REPORTS', () => {
  it('holds the catalogue, in its order, then the test profile definitions; every id is unique and found by reportById', () => {
    expect(REPORTS.map((d) => d.id)).toEqual([...Object.keys(CATALOGUE), ...TEST_IDS]);
    expect(new Set(REPORTS.map((d) => d.id)).size).toBe(REPORTS.length);
    for (const def of REPORTS) expect(reportById(def.id)).toBe(def);
    expect(reportById('collection.nope')).toBeNull();
    expect(Object.isFrozen(REPORTS)).toBe(true);
    expect(REPORTS.slice(-TEST_REPORTS.length)).toEqual(TEST_REPORTS);
  });

  it('every definition has the kind, personal flag, orientation, columns, module and permissions of the catalogue', () => {
    for (const [id, want] of Object.entries(CATALOGUE)) {
      const def = reportById(id)!;
      expect([def.kind, def.personal, def.orientation], id).toEqual([want.kind, want.personal, want.orientation]);
      if (want.columns !== undefined) expect(shape(def), id).toBe(want.columns);
      expect(def.titleKey, id).toBe(`report.${id}.title`);
      if (id.startsWith('collection.')) {
        expect([def.module, def.permission, def.exportPermission ?? def.permission], id).toEqual(['collection', 'reports.statistics.read', 'reports.statistics.read']);
        expect(def.formats, id).toEqual(['csv', 'xlsx', 'pdf']);
      } else if (PERMISSIONS[id] !== undefined) {
        expect([def.module, def.permission, def.exportPermission ?? def.permission], id).toEqual(PERMISSIONS[id]);
        expect(def.formats, id).toEqual(['csv', 'xlsx', 'pdf']);
      } else {
        expect([def.module, def.permission], id).toEqual(['accreditation', 'accreditation.workspace.read']);
        expect(def.params[0], id).toMatchObject({ name: 'periodId', kind: 'period', required: true });
        if (def.kind === 'table') expect(def.formats, id).toEqual(['csv', 'xlsx', 'pdf']);
      }
    }
    expect(reportById('accreditation.dossier')!.formats).toEqual(['pdf', 'zip']);
    expect(reportById('accreditation.self_assessment')!.formats).toEqual(['pdf']);
    expect(reportById('accreditation.statement_1000')!.formats).toEqual(['pdf']);
  });

  it('the columns that depend on the parameters: the acquisitions matrix or one year in detail; the staff annex sections', () => {
    const acq = table('collection.acquisitions');
    expect(shape(acq)).toBe('year:text c000:int c100:int c200:int c300:int c400:int c500:int c600:int c700:int c800:int c900:int c2x:int cnon:int total:int');
    expect(shape(acq, { detailYear: 2025 })).toBe(
      'barcode:text title:text class:text collection_type:text acq_date:date acq_basis:text price:money acq_source:text supplier:text',
    );
    const staff = table('accreditation.annex.staff');
    expect(shape(staff)).toBe(
      'name:text position:text role:text is_librarian:text employment:text education:text library_training:text competency_cert:text association_member:text appointment_ref:text starts_on:date ends_on:date',
    );
    expect(shape(staff, { section: 'trainings' })).toBe('name:text training:text organizer:text held_on:date hours:int');
    expect(shape(staff, { section: 'ratio' })).toBe('label:text value:int');
    // ---- Komunitas (member, visit and circulation reports) ----
    expect(shape(table('members.reprint_list'), { kind: 'items' })).toBe('source_barcode:text barcode:text title:text');
    expect(shape(table('circulation.loans_by_class'), { mainClass: '800' })).toBe('class:text m01:int m02:int m03:int m04:int m05:int m06:int m07:int m08:int m09:int m10:int m11:int m12:int total:int');
    expect(shape(table('circulation.payments_daily'), { view: 'receipts' })).toBe(
      'paid_on:date receipt_no:text member_no:text name:text method:text staff:text amount:money voided:text',
    );
  });

  it('the copies of the reprint list also take the catalogue permission; no other definition asks for one more', () => {
    const reprint = table('members.reprint_list');
    expect(reprint.extraPermission?.({ kind: 'items' })).toBe('catalog.records.read');
    expect(reprint.extraPermission?.({ kind: 'members' })).toBeNull();
    expect(reprint.extraPermission?.({})).toBeNull();
    expect(REPORTS.filter((d) => d.extraPermission !== undefined).map((d) => d.id)).toEqual(['members.reprint_list']);
  });

  it('the stock scans: the acquisitions always, four lists with a date of their own, and three annexes', () => {
    const scanBased = (def: ReportDefinition, params: Record<string, unknown>): boolean => def.kind === 'table' && def.scanBased?.(params) === true;
    const always = ['collection.acquisitions', 'accreditation.annex.ddc', 'accreditation.annex.collection_matrix', 'accreditation.annex.additions'];
    const withAsOf = ['collection.summary', 'collection.ddc_recap', 'collection.title_list', 'collection.item_list'];
    for (const def of REPORTS) {
      expect(scanBased(def, {}), def.id).toBe(always.includes(def.id));
      expect(scanBased(def, { asOf: '2025-12-31' }), def.id).toBe(always.includes(def.id) || withAsOf.includes(def.id));
    }
  });

  it('every parameter schema takes the empty values of a first preview (the period aside) and refuses an unknown key', () => {
    for (const def of REPORTS) {
      const base = def.params.some((p) => p.name === 'periodId') ? { periodId: newId() } : def.id === 'test.rows' ? { rows: 0 } : {};
      expect(def.paramsSchema.safeParse(base).success, def.id).toBe(true);
      expect(def.paramsSchema.safeParse({ ...base, nope: 1 }).success, def.id).toBe(false);
      for (const p of def.params) expect(p.labelKey, `${def.id} ${p.name}`).toBe(`report.param.${p.name}`);
    }
  });
});

describe('the personal rule', () => {
  it('a definition whose columns, for any shape of its parameters, include a registered personal column is personal', () => {
    for (const def of REPORTS) {
      if (showsPersonalColumn(def)) expect(def.personal, def.id).toBe(true);
    }
    expect(REPORTS.filter((def) => def.kind === 'table' && showsPersonalColumn(def)).map((d) => d.id)).toEqual([
      'accreditation.annex.staff',
      'members.list',
      'members.expiring',
      'members.reprint_list',
      'visits.list',
      'circulation.loan_history',
      'circulation.open_loans',
      'circulation.overdue',
      'circulation.due_soon',
      'circulation.holds',
      'circulation.charges',
      'circulation.payments_daily',
      'circulation.top_borrowers',
      'test.personal',
    ]);
  });

  it('the staff annex is caught by every section that shows a name, and test.personal only because it is marked', () => {
    const staff = table('accreditation.annex.staff');
    const shaped = columnShapes(staff).filter((params) => columnsOf(staff, params).some((c) => c.source !== undefined));
    expect(shaped.map((p) => p['section'] ?? 'staff')).toEqual(expect.arrayContaining(['staff', 'trainings']));
    expect(PERSONAL_COLUMNS.library_staff?.map((c) => c.column)).toEqual(expect.arrayContaining(['name', 'appointment_ref']));
    expect(showsPersonalColumn(testPersonalReport)).toBe(true);
    expect(testPersonalReport.personal).toBe(true);
    const unmarked = { ...testPersonalReport, personal: false };
    expect(showsPersonalColumn(unmarked) && !unmarked.personal).toBe(true);
    const unsourced = { ...testPersonalReport, columns: [{ key: 'name', labelKey: 'report.column.name', type: 'text' as const }] };
    expect(showsPersonalColumn(unsourced)).toBe(false);
  });
});

describe('the labels', () => {
  it('every title, column, parameter and option label is a shared message', () => {
    const missing: string[] = [];
    const need = (key: string, where: string): void => {
      if (!MESSAGE_KEYS.has(key)) missing.push(`${where}: ${key}`);
    };
    for (const def of REPORTS) {
      need(def.titleKey, def.id);
      for (const p of def.params) {
        need(p.labelKey, def.id);
        for (const option of p.options ?? []) need(`${p.optionLabelPrefix ?? `report.option.${p.name}.`}${option}`, `${def.id} ${p.name}`);
      }
      for (const params of columnShapes(def)) for (const c of columnsOf(def, params)) need(c.labelKey, def.id);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('a column is labelled report.column.<key>', () => {
    for (const def of REPORTS) for (const params of columnShapes(def)) for (const c of columnsOf(def, params)) expect(c.labelKey).toBe(`report.column.${c.key}`);
  });
});

describe('the test profile definitions', () => {
  const ctx = (params: Record<string, unknown>): ReportCtx => ({
    db: undefined as never,
    locale: 'id',
    tz: 'Asia/Jakarta',
    now: Date.UTC(2026, 5, 30),
    today: '2026-06-30',
    settings: undefined as never,
    params,
    budgetLeftMs: () => 20_000,
  });

  it('test.rows answers its row formula page by page, the texts repeated in turn', async () => {
    const params = testRowsReport.paramsSchema.parse({ rows: 3, texts: ['=HYPERLINK("x")', 'تفسير الجلالين'] });
    const first = await testRowsReport.rows(ctx(params), null, 2);
    expect(first).toEqual({ rows: [[1, '=HYPERLINK("x")', 1500], [2, 'تفسير الجلالين', 3000]], nextCursor: '2' });
    const second = await testRowsReport.rows(ctx(params), first.nextCursor, 2);
    expect(second).toEqual({ rows: [[3, '=HYPERLINK("x")', 4500]], nextCursor: null });
    expect(await testRowsReport.rows(ctx({ rows: 2 }), null, 10)).toEqual({ rows: [[1, 'baris 1', 1500], [2, 'baris 2', 3000]], nextCursor: null });
    expect(shape(testRowsReport)).toBe('n:int text:text amount:money');
  });

  it('test.rows counts its rows, or answers no count with countless; it never scans', async () => {
    expect(await testRowsReport.count!(ctx({ rows: 3 }))).toBe(3);
    expect(await testRowsReport.count!(ctx({ rows: 3, countless: true }))).toBeNull();
    expect(testRowsReport.scanBased).toBeUndefined();
    expect(testRowsReport.paramsSchema.safeParse({ rows: 200_001 }).success).toBe(false);
    expect(testRowsReport.paramsSchema.safeParse({ rows: 1, texts: Array.from({ length: 21 }, () => 'x') }).success).toBe(false);
    expect(testRowsReport.paramsSchema.safeParse({ rows: 1, texts: ['x'.repeat(201)] }).success).toBe(false);
  });

  it('test.personal answers three names from a personal column', async () => {
    expect((await testPersonalReport.rows(ctx({}), null, 10)).rows).toEqual([['Nama 1'], ['Nama 2'], ['Nama 3']]);
  });

  describe('test.document', () => {
    let root: string;
    beforeAll(async () => {
      root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-test-document-')));
    });
    afterAll(async () => {
      await fsp.rm(root, { recursive: true, force: true });
    });

    it('renders in three slices: two answers to go on, then the end with three rows and a warning', async () => {
      const dataDir = path.join(root, 'data');
      const runId = newId();
      await fsp.mkdir(reportWorkDir(dataDir, runId), { recursive: true });
      const doc: DocumentCtx = {
        ...ctx({}),
        runId,
        format: 'pdf',
        dataDir,
        storage: undefined as never,
        libraryName: 'Perpustakaan Contoh',
        staffName: 'Petugas',
        appVersion: '0.1.0',
        heartbeat: async () => {},
        cancelled: async () => false,
      };
      const steps: DocumentStep[] = [];
      let resume: DocumentResume | null = null;
      for (let i = 0; i < 3; i += 1) {
        const step = await testDocumentReport.render(doc, resume);
        steps.push(step);
        resume = step.done ? null : step.resume;
      }
      expect(steps).toEqual([
        { done: false, resume: { phase: 'slice-2', cursor: null, state: null } },
        { done: false, resume: { phase: 'slice-3', cursor: null, state: null } },
        { done: true, rowCount: 3, nonLatinRows: 0, warnings: ['test_warning'] },
      ]);
      expect(await fsp.readFile(reportWorkPath(dataDir, runId, 'output.part'), 'utf8')).toBe('test-document:1\ntest-document:2\ntest-document:3\n');
      expect(testDocumentReport.formats).toEqual(['pdf', 'zip']);
    });
  });
});
