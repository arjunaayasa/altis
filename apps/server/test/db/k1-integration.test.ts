import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCRED_METRIC_PROVIDERS,
  claimById,
  createJobRegistry,
  enqueueEvaluate,
  evaluateJob,
  instrumentById,
  legacyTarget,
  loadAccredSettings,
  localStorageDriver,
  previewReport,
  reportById,
  runSlice,
  slimsJobs,
  startSlimsMigration,
  tableChecksumFromDb,
  txCtx,
  writeSettings,
  archiveItem,
  type Actor,
  type CatalogJobDeps,
  type JobHandler,
  type SlimsStartInput,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, verifyAuditChain, withTx, type TableName } from '@altis/db';
import { AUDIT_ACTIONS, newId, t, type MessageKey } from '@altis/shared';
import type { ResultsView, SnapshotView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORBIDDEN, pdfPages, streamEntries, type StreamedEntry } from '../../../../packages/core/test/db/accred-documents-support.js';
import { GOLDEN_BASE_URL, seedSmaContoh, type GoldenFixture } from '../../../../packages/core/test/support/accreditation-golden.js';
import { checkPdf } from '../../../../packages/core/test/support/pdf-check.js';
import { SLIMS_FIXTURE_SEED, slimsFixtureBytes } from '../../../../packages/core/test/support/slims-fixture/index.js';
import type { UsageExpectation } from '../../../../packages/core/test/support/slims-fixture/generate-usage.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { DASHBOARD_HOME_ROUTES } from '../../src/api/dashboard.js';
import { AKUN_ROUTES } from '../../src/opac/akun/routes.js';
import { VISIT_STATION_ROUTES } from '../../src/opac/visits/routes.js';
import { ALL_ROUTES, KOMUNITAS_ROUTES } from '../../src/routes.js';
import type { AgentReply } from '../agent.js';
import { K1_PENDING_ALLOWED, KOMUNITAS_AUDIT_SCRIPTS } from '../audit/komunitas.js';
import { KOMUNITAS_MATRIX } from '../matrix/komunitas.js';
import { MATRIX_FIXTURES, allPersonas } from '../matrix-fixtures.js';
import { recordingLogger } from '../support.js';
import { openK1Installation, type K1Browser, type K1Installation } from './k1-support.js';

// The reports and the accreditation workspace end to end, on the engine picked by ALTIS_TEST_DB:
//
// - the routes: every community route has its permission-matrix row, the three new permissions their personas, and
//   every community audit action an audit script (none left pending);
// - through the API as the admin SPA uses it, on the golden school dataset: the evaluation of the upper secondary
//   period by the real job (estimate 70.45, predicate C); every personal export refused without a fresh
//   re-authentication; the evidence file as a PDF, one ZIP and one ZIP per component, with the real annex lists and the
//   annual report of the period in them (left out, and named in the run's warnings, for a reader who may not export
//   it) and never a score, a predicate, a gap action, an answer, an answer-bearing note or an override note; the
//   self-assessment with the estimate; the freeze, after which edits of a register, a copy and a usage cell leave the
//   snapshot byte for byte as it was; the SLiMS usage import of the synthetic dump, after which the school visits of
//   the lower secondary period are the fixture's hand count, and a change of the member type groups moves them without
//   a new import;
// - the SLiMS catalogue re-sync: after a sync of the changed source the collection items follow the archived, lost and
//   new copies (a copy lost in SLiMS leaves the stock from the sync date), the entry dates feed the acquisition dates,
//   and a second sync of the same source rewrites nothing.

const ctx = testDbContext();
const API = '/api/v1';
const PERIODS = `${API}/accreditation/periods`;
const K1_PERMISSIONS = ['reports.statistics.read', 'accreditation.workspace.read', 'accreditation.workspace.manage'] as const;
/** An override note the evidence file must never print. */
const OVERRIDE_NOTE = 'Catatan-penggantian-uji-4417';

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const msg = (key: string): string => t('id', key as MessageKey);

/** The text of a ZIP entry: a PDF's pages, any other file's bytes. */
function entryText(e: StreamedEntry): string {
  return e.name.endsWith('.pdf') ? pdfPages(e.data).join('\n') : e.data.toString('latin1');
}

/**
 * The cells of one table column of a PDF, top to bottom on every page, joined without spaces (a cell wraps inside a
 * narrow column, mid-word too): the text runs below the column's header that start where the header starts.
 */
function columnText(pdf: Uint8Array, header: string): string {
  const out: string[] = [];
  for (const page of checkPdf(pdf).pages) {
    const head = page.texts.find((t) => t.text === header);
    if (head === undefined) continue;
    const cells = page.texts.filter((t) => Math.abs(t.x - head.x) < 0.5 && t.y < head.y).sort((a, b) => b.y - a.y);
    out.push(cells.map((t) => t.text).join(''));
  }
  return out.join('').replace(/\s+/g, '');
}

describe('the community routes are covered: matrix rows, personas, audit scripts', () => {
  it('every community route, the records bulk edit included, has its matrix row and a matrix fixture', () => {
    const rows = Object.keys(KOMUNITAS_MATRIX.rows);
    // The community routes served outside KOMUNITAS_ROUTES: the guestbook station's pages and the OPAC member area
    // (after the OPAC's catalogue routes), Beranda's library figures (beside the system dashboard), and the settings
    // groups of members, visits and privacy (SETTINGS_ROUTES).
    const outside = [...VISIT_STATION_ROUTES, ...AKUN_ROUTES, ...DASHBOARD_HOME_ROUTES].map((d) => d.id);
    const ids = [...KOMUNITAS_ROUTES.map((d) => d.id), ...outside, 'settings.members.put', 'settings.visits.put', 'settings.privacy.put', 'catalog.records.bulk'];
    expect(ids.length).toBeGreaterThan(40);
    expect(ids.filter((id) => !rows.includes(id))).toEqual([]);
    expect(rows.filter((id) => !ids.includes(id))).toEqual([]);
    for (const id of [...ids, 'settings.accreditation.put']) expect([id, Object.hasOwn(MATRIX_FIXTURES, id)]).toEqual([id, true]);
    // Every declared route is one of ALL_ROUTES.
    const all = new Set(ALL_ROUTES.map((d) => d.id));
    expect(ids.filter((id) => !all.has(id))).toEqual([]);
  });

  it('the three permissions of reports and accreditation each have their persona in the matrix', () => {
    const personas = allPersonas();
    for (const p of K1_PERMISSIONS) expect(personas).toContain(`perm:${p}`);
  });

  it('every community audit action has its script, none pending; every audited community route names one of them', () => {
    expect(K1_PENDING_ALLOWED).toBe(false);
    // The reports and accreditation actions end where the members and circulation actions begin.
    const k1Actions = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf('reports.run.start'), AUDIT_ACTIONS.indexOf('members.member.create'));
    expect(k1Actions).toHaveLength(18);
    for (const [area, script] of Object.entries(KOMUNITAS_AUDIT_SCRIPTS)) expect([area, script.run === null]).toEqual([area, false]);
    const scripted = new Set(Object.values(KOMUNITAS_AUDIT_SCRIPTS).flatMap((s) => [...s.actions]));
    expect(k1Actions.filter((a) => !scripted.has(a))).toEqual([]);
    // The members, visits, circulation, stocktake and OPAC home page routes audit actions of their own
    // (audit/members-circulation.ts and the scripts after it).
    const own = ['members.', 'visits.', 'circulation.', 'stocktake.', 'opac.home.'];
    for (const d of KOMUNITAS_ROUTES.filter((r) => !own.some((p) => r.id.startsWith(p)))) {
      if (d.audit === null) continue;
      expect([d.id, (k1Actions as readonly string[]).includes(d.audit)]).toEqual([d.id, true]);
    }
  });
});

describe.skipIf(!ctx.available)(`the golden school through the API [${engineLabel()}]`, () => {
  let k: K1Installation;
  let fx: GoldenFixture;
  let admin: K1Browser;
  /** A reader of the workspace (and the statistics) with a fresh re-authentication, and the same user's stale session. */
  let fresh: K1Browser;
  let stale: K1Browser;
  let readerId: string;
  const runs: { dossierPdf: string; dossierBytes: Buffer; snapshotId: string } = { dossierPdf: '', dossierBytes: Buffer.alloc(0), snapshotId: '' };

  const auditCount = async (action: string): Promise<number> =>
    Number((await k.h.db.selectFrom('audit_log').select((eb) => eb.fn.countAll<number>().as('n')).where('action', '=', action).executeTakeFirstOrThrow()).n);

  /** Moves the app's clock on, so that what happens next lies strictly after what happened before. */
  const tick = (ms = 1_000): void => {
    k.clock.now += ms;
  };

  /** Starts the evaluation of `periodId` through the API and drives its job to the end; the results then. */
  async function evaluate(periodId: string): Promise<ResultsView> {
    tick();
    const started = await fresh.send('post', `${PERIODS}/${periodId}/evaluate`, {});
    expect(started.status, started.text).toBe(202);
    expect(await k.drive((started.json as { jobId: string }).jobId)).toBe('succeeded');
    tick();
    const res = await fresh.send('get', `${PERIODS}/${periodId}/results`);
    expect(res.status, res.text).toBe(200);
    return res.json as ResultsView;
  }

  /** Starts a run through `url` (its answer `{id, jobId}`), drives it and downloads its file as `who`. */
  async function runAndDownload(who: K1Browser, url: string, body: unknown): Promise<{ id: string; bytes: Buffer; ms: number }> {
    const started = await who.send('post', url, body);
    expect(started.status, started.text).toBe(200);
    const run = started.json as { id: string; jobId: string };
    const t0 = performance.now();
    expect(await k.drive(run.jobId)).toBe('succeeded');
    const ms = performance.now() - t0;
    const file = await who.bytes(`${API}/reports/runs/${run.id}/download`);
    expect(file.status, file.body.toString('utf8').slice(0, 300)).toBe(200);
    return { id: run.id, bytes: file.body, ms };
  }

  beforeAll(async () => {
    k = await openK1Installation({ prefix: 'k1-integration', baseUrl: GOLDEN_BASE_URL, log: recordingLogger() });
    fx = await seedSmaContoh(k.h);
    admin = await k.browser(await k.staff('kepala_perpustakaan', 'super_admin'));
    readerId = await k.staff('penilai_akreditasi', ['accreditation.workspace.read', 'reports.statistics.read']);
    fresh = await k.browser(readerId);
    stale = await k.browser(readerId, { reauthAt: null });
  }, 180_000);

  afterAll(async () => {
    await k?.close();
  });

  it('evaluates the upper secondary period through the API: fresh results, estimate 70.45, predicate C, the override kept', async () => {
    // An answer replacing a suggestion with the same letter, with a note (the evidence file must never print it).
    tick();
    const answered = await admin.send('put', `${PERIODS}/${fx.periods.sma}/answers/SCH-K5`, { answer: 'c', mode: 'override', note: OVERRIDE_NOTE });
    expect(answered.status, answered.text).toBe(200);
    const view = await evaluate(fx.periods.sma);
    expect([view.status, view.stale]).toEqual(['ready', false]);
    expect(view.prerequisites?.met).toBe(true);
    expect(view.score).toMatchObject({ na: '70.45', grade: 'C', answered: view.score?.total });
    const k5 = view.indicators.find((i) => i.code === 'SCH-K5')!;
    expect([k5.suggestion, k5.final, k5.answer?.mode, k5.answer?.note]).toEqual(['c', 'c', 'override', OVERRIDE_NOTE]);
  });

  it('refuses every personal export without a fresh re-authentication (401), with no audit entry; the statement needs none', async () => {
    const starts = await auditCount('reports.run.start');
    const refused: [string, AgentReply][] = [
      ['staff annex', await stale.send('post', `${API}/reports/runs/personal`, { reportId: 'accreditation.annex.staff', format: 'csv', params: { periodId: fx.periods.sma } })],
      ['evidence file', await stale.send('post', `${PERIODS}/${fx.periods.sma}/dossier`, { format: 'pdf' })],
      ['evidence ZIP', await stale.send('post', `${PERIODS}/${fx.periods.sma}/dossier`, { format: 'zip_components' })],
      ['self-assessment', await stale.send('post', `${PERIODS}/${fx.periods.sma}/self-assessment`, {})],
    ];
    for (const [what, res] of refused) expect([what, res.status, code(res)]).toEqual([what, 401, 'AUTH_REAUTH_REQUIRED']);
    expect(await auditCount('reports.run.start')).toBe(starts);

    // The same user, re-authenticated: the staff annex runs; its download needs the fresh session too.
    const staffRun = await fresh.send('post', `${API}/reports/runs/personal`, { reportId: 'accreditation.annex.staff', format: 'csv', params: { periodId: fx.periods.sma } });
    expect(staffRun.status, staffRun.text).toBe(200);
    const run = staffRun.json as { id: string; jobId: string };
    expect(await auditCount('reports.run.start')).toBe(starts + 1);
    expect(await k.drive(run.jobId)).toBe('succeeded');
    const downloads = await auditCount('reports.run.download');
    const staleDownload = await stale.bytes(`${API}/reports/runs/${run.id}/download`);
    expect(staleDownload.status).toBe(401);
    expect(await auditCount('reports.run.download')).toBe(downloads);
    const csv = await fresh.bytes(`${API}/reports/runs/${run.id}/download`);
    expect(csv.status).toBe(200);
    expect(csv.body.toString('utf8')).toContain('Kepala Perpustakaan Contoh');
    expect(await auditCount('reports.run.download')).toBe(downloads + 1);

    // The statement of 1 000 titles names no one: it starts without a fresh re-authentication.
    const statement = await stale.send('post', `${PERIODS}/${fx.periods.sma}/statement-1000`, {});
    expect(statement.status, statement.text).toBe(200);
  });

  it('writes the evidence file, both ZIPs and the simulation from the real results and annexes, never a score or an answer in the file or a ZIP', async () => {
    const instrument = instrumentById('sch-sma-2025')!;
    const actions = instrument.components.flatMap((c) => c.indicators.map((i) => msg(i.actionKey)));
    // Every option label of the four items answered by hand (an answer printed as its option).
    const options = instrument.components
      .flatMap((c) => c.indicators)
      .filter((i) => ['SP1', 'SP2', 'SP3', 'F3'].includes(i.code))
      .flatMap((i) => (i.optionKeys ?? []).map(msg));
    expect(options).toHaveLength(16);
    const forbidden = [...FORBIDDEN, OVERRIDE_NOTE, ...actions, ...options, 'Saran ALTIS'];
    const expectClean = (what: string, text: string): void => {
      for (const bad of forbidden) expect(text, `${what}: ${bad}`).not.toContain(bad);
    };

    // The evidence file as a PDF: the golden period's sections with its official item numbers.
    const pdf = await runAndDownload(fresh, `${PERIODS}/${fx.periods.sma}/dossier`, { format: 'pdf' });
    runs.dossierPdf = pdf.id;
    runs.dossierBytes = pdf.bytes;
    process.stdout.write(`k1-integration: the evidence file PDF of the golden period took ${Math.round(pdf.ms)} ms on ${ctx.engine}\n`);
    expect(pdf.ms).toBeLessThan(60_000);
    const pages = pdfPages(pdf.bytes);
    expect(pages.length).toBeGreaterThan(5);
    const all = pages.join('\n');
    expectClean('evidence file', all);
    expect(all).toContain('SMA Contoh');

    // One ZIP: the evidence file first, then the lists generated from the real annexes and registers.
    const zip = await runAndDownload(fresh, `${PERIODS}/${fx.periods.sma}/dossier`, { format: 'zip' });
    const entries = streamEntries(zip.bytes);
    expect(entries[0]!.name).toBe('00-berkas-bukti.pdf');
    for (const e of entries) {
      expectClean(e.name, e.name);
      expectClean(e.name, entryText(e));
    }
    /** The text of the one entry whose name holds `slug`. */
    const textOf = (slug: string): string => {
      const found = entries.filter((e) => e.name.includes(slug));
      expect(found.map((e) => e.name), slug).toHaveLength(1);
      return entryText(found[0]!);
    };
    // The staff list (registers): the active staff by name (a name wraps inside its narrow column), not the former one.
    const staffList = entries.find((e) => e.name.includes('/T3-01-daftar-tenaga'))!;
    expect(columnText(staffList.data, 'Nama')).toEqual(expect.stringContaining('KepalaPerpustakaanContoh'));
    expect(columnText(staffList.data, 'Nama')).toEqual(expect.stringContaining('TenagaTeknisContoh'));
    expect(columnText(staffList.data, 'Nama')).not.toContain('Terdahulu');
    // The ratio and the budgets (registers and period).
    expect(textOf('/T5-01-jumlah-tenaga')).toContain('Warga sekolah per tenaga aktif (dipotong ke bilangan bulat) 61');
    expect(textOf('/G3-01-rekap-anggaran')).toContain('Rerata tiga tahun anggaran 6 %');
    // The DDC recap of printed books (collection): 2X on its own row and not under 200, the totals.
    const ddc = textOf('/K1-02-rekap-buku-tercetak-menurut-klasifikasi');
    expect(ddc).toContain('200 Agama 0 0');
    expect(ddc).toContain('2X Islam (perluasan DDC Indonesia) 66 66');
    expect(ddc).toContain('Jumlah 980 1.200');
    // The additions of three years (collection): the start stock and the share.
    const additions = textOf('/K6-01-koleksi-awal-penambahan');
    expect(additions).toContain('Stok awal per 2023-12-31 700');
    expect(additions).toContain('Jumlah penambahan tiga tahun 301 43 %');
    // The monthly school visits (usage): a school month, a holiday month, the population, the source.
    const l14 = textOf('/L14-01-rekap-bulanan');
    expect(l14).toContain('2025-08 56 5 2 63 123 51 % Impor SLiMS');
    expect(l14).toContain('2025-12 0 0 0 0 123 0 % Impor SLiMS');
    expect(l14).toContain('2026-06 55 5 2 62 123 50 % Impor SLiMS');
    // ---- Komunitas K5 (reports) ----
    // The annual library report the routine reports item drafts: first in its item, named as a generated list, the
    // same PDF of the period a run of the report makes, and no warning in the run.
    const g4 = entries.filter((e) => e.name.startsWith('G-pengelolaan/G4-')).map((e) => e.name);
    expect(g4[0]).toBe('G-pengelolaan/G4-01-laporan-tahunan-perpustakaan.pdf');
    expect(g4.at(-1)).toMatch(/^G-pengelolaan\/G4-\d{2}-daftar-laporan/);
    const annual = pdfPages(entries.find((e) => e.name === g4[0])!.data);
    expect(annual.join('\n')).toContain('Laporan Tahunan Perpustakaan');
    expect(annual.join('\n')).toContain('Tahun pelajaran 2025/2026 (SMA)');
    const own = await runAndDownload(fresh, `${API}/reports/runs`, { reportId: 'library.annual_report', format: 'pdf', params: { periodId: fx.periods.sma } });
    expect(annual).toEqual(pdfPages(own.bytes));
    const zipRun = await fresh.send('get', `${API}/reports/runs/${zip.id}`);
    expect((zipRun.json as { warnings: string[] }).warnings.filter((w) => w.startsWith('report_withheld:'))).toEqual([]);

    // One ZIP per component: seven ZIPs, none holding a score or an answer either.
    const perComponent = await runAndDownload(fresh, `${PERIODS}/${fx.periods.sma}/dossier`, { format: 'zip_components' });
    const outer = streamEntries(perComponent.bytes);
    expect(outer.map((e) => e.name)).toEqual(['K-koleksi.zip', 'SP-sarana.zip', 'L-pelayanan.zip', 'T-tenaga.zip', 'F-penyelenggaraan.zip', 'G-pengelolaan.zip', 'profil.zip']);
    for (const inner of outer) {
      for (const e of streamEntries(inner.data)) {
        expectClean(`${inner.name}/${e.name}`, e.name);
        expectClean(`${inner.name}/${e.name}`, entryText(e));
      }
    }
    const gInner = streamEntries(outer.find((e) => e.name === 'G-pengelolaan.zip')!.data);
    expect(gInner.filter((e) => e.name.startsWith('G4-')).map((e) => e.name)[0]).toBe('G4-01-laporan-tahunan-perpustakaan.pdf');

    // The simulation prints the estimate and the predicate; no ZIP holds it.
    const simulation = await runAndDownload(fresh, `${PERIODS}/${fx.periods.sma}/self-assessment`, {});
    const simulated = pdfPages(simulation.bytes).join('\n');
    expect(simulated).toContain('Perkiraan nilai akhir: 70,45');
    expect(simulated).toContain('Predikat: C (Cukup Baik)');
    for (const e of entries) expect(e.data.equals(simulation.bytes), e.name).toBe(false);
  }, 300_000);

  // ---- Komunitas K5 (reports) ----
  it('leaves the annual report out of the ZIP of a reader who may not export it, and the run says so', async () => {
    const workspaceOnly = await k.browser(await k.staff('penilai_tanpa_statistik', ['accreditation.workspace.read']));
    const zip = await runAndDownload(workspaceOnly, `${PERIODS}/${fx.periods.sma}/dossier`, { format: 'zip' });
    const names = streamEntries(zip.bytes).map((e) => e.name);
    expect(names.filter((n) => n.includes('laporan-tahunan'))).toEqual([]);
    // The item's numbering goes on without it.
    expect(names.filter((n) => n.startsWith('G-pengelolaan/G4-'))[0]).toMatch(/^G-pengelolaan\/G4-01-/);
    const run = (await workspaceOnly.send('get', `${API}/reports/runs/${zip.id}`)).json as { warnings: string[]; params: Record<string, unknown> };
    expect(run.warnings).toContain('report_withheld:G4.report_documents');
    expect(run.params['withheld']).toEqual(['library.annual_report']);
    // The report itself stays refused to that reader.
    const refused = await workspaceOnly.send('post', `${API}/reports/runs`, { reportId: 'library.annual_report', format: 'pdf', params: { periodId: fx.periods.sma } });
    expect(refused.status).toBe(403);
  }, 300_000);

  it('freezes the period; edits of a register row, a copy and a usage cell afterwards leave the snapshot byte for byte', async () => {
    tick();
    const frozen = await admin.send('post', `${PERIODS}/${fx.periods.sma}/freeze`, { note: 'Diserahkan ke asesor' });
    expect(frozen.status, frozen.text).toBe(201);
    runs.snapshotId = (frozen.json as { id: string }).id;
    const snapshotRow = () =>
      k.h.db.selectFrom('accred_snapshots').select(['result_values', 'na', 'na_low', 'na_high', 'grade', 'prerequisites_met', 'dossier_file_id']).where('id', '=', runs.snapshotId).executeTakeFirstOrThrow();
    const before = await snapshotRow();
    expect([before.na, before.grade, before.prerequisites_met]).toEqual(['70.45', 'C', 1]);
    expect(Buffer.byteLength(before.result_values, 'utf8')).toBeLessThanOrEqual(60_000);
    const view = (await admin.send('get', `${API}/accreditation/snapshots/${runs.snapshotId}`)).json as SnapshotView;
    expect(view.values.i['SCH-K1']).toMatchObject({ v: 1000, a: 'c' });

    // A register row edited, a copy archived, a usage cell changed (through the lower secondary period, still open).
    tick();
    const activity = await k.h.db.selectFrom('library_activities').select(['id', 'version']).where('kind', '=', 'needs_survey').orderBy('id').executeTakeFirstOrThrow();
    const patched = await admin.send('patch', `${API}/accreditation/activities/${activity.id}`, { version: Number(activity.version), title: 'Survei kebutuhan (diperbaiki)', participants: 99 });
    expect(patched.status, patched.text).toBe(200);
    const item = await k.h.db.selectFrom('items').select(['id', 'version', 'branch_id']).where('archived_at', 'is', null).where('status', '=', 'available').orderBy('id').executeTakeFirstOrThrow();
    const archived = await admin.send('delete', `${API}/branches/${item.branch_id}/items/${item.id}`, { version: Number(item.version) });
    expect(archived.status, archived.text).toBe(200);
    const usage = await admin.send('put', `${PERIODS}/${fx.periods.smp}/usage`, { cells: [{ metric: 'loans', month: '2025-09', groupKey: '', value: 4321 }] });
    expect(usage.status, usage.text).toBe(200);

    const after = await snapshotRow();
    expect(after).toEqual(before);
    expect((await admin.send('get', `${API}/accreditation/snapshots/${runs.snapshotId}`)).json).toEqual(view);

    // The frozen copy of the evidence file: the PDF of the run made after the results, downloaded only after a fresh
    // re-authentication.
    expect(before.dossier_file_id).not.toBeNull();
    expect((await stale.bytes(`${API}/accreditation/snapshots/${runs.snapshotId}/dossier`)).status).toBe(401);
    const copy = await fresh.bytes(`${API}/accreditation/snapshots/${runs.snapshotId}/dossier`);
    expect(copy.status).toBe(200);
    expect(copy.body.equals(runs.dossierBytes)).toBe(true);
  });

  it('imports the SLiMS usage dump: the school visits are the hand count, and a group change moves them without a new import', async () => {
    const PERIOD = { startsOn: '2025-07-01', endsOn: '2026-06-30' };
    const fixture = slimsFixtureBytes(undefined, { usage: { period: PERIOD } });
    const expected = fixture.hooks.usage as UsageExpectation;
    const types = expected.memberTypes.map((m) => String(m.id));
    expect(types).toHaveLength(4);
    const groups = { [types[0]!]: 'student', [types[1]!]: 'teacher', [types[2]!]: 'edu_staff', [types[3]!]: 'public' } as const;

    tick();
    const manager = await k.browser(admin.userId);
    const dump = await manager.upload('accreditation.slims_dump', fixture.dump, 'slims-backup.sql');
    const started = await manager.send('post', `${PERIODS}/${fx.periods.smp}/slims-usage`, {
      source: { kind: 'dump', uploadId: dump.uploadId },
      memberTypeGroups: groups,
      unknownMemberGroup: 'student',
    });
    expect(started.status, started.text).toBe(201);
    const { runId, jobId } = started.json as { runId: string; jobId: string };
    expect(await k.drive(jobId)).toBe('succeeded');
    expect((await k.h.db.selectFrom('catalog_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow()).status).toBe('succeeded');

    /** The fixture's hand count of the school visits without repeats in the period's months, by the stored groups. */
    const handCount = async (): Promise<number> => {
      const map = new Map((await k.h.db.selectFrom('usage_group_map').select(['group_key', 'accred_group']).execute()).map((r) => [r.group_key, r.accred_group]));
      const school = (key: string): boolean => ['student', 'teacher', 'edu_staff'].includes(map.get(key) ?? '');
      const keys = [...types.map((id) => `slims_type:${id}`), 'member_unknown'].filter(school);
      let n = 0;
      for (const month of expected.months.filter((m) => m >= '2025-07' && m <= '2026-06')) for (const key of keys) n += expected.cell(month, 'visits_deduped', key);
      return n;
    };
    const l14 = (v: ResultsView) => v.indicators.find((i) => i.code === 'SCH-L14')!;

    const first = l14(await evaluate(fx.periods.smp));
    const want = await handCount();
    expect(want).toBeGreaterThan(0);
    expect(first.numerator).toBe(want);

    // The teachers become "public": the school visits drop by theirs, read again from the same imported rows.
    const runsBefore = await k.h.db.selectFrom('catalog_runs').select('id').execute();
    tick();
    const moved = await manager.send('put', `${API}/accreditation/usage-groups`, { groups: [{ groupKey: `slims_type:${types[1]!}`, accredGroup: 'public' }] });
    expect(moved.status, moved.text).toBe(200);
    const second = l14(await evaluate(fx.periods.smp));
    const teachers = expected.months.filter((m) => m >= '2025-07' && m <= '2026-06').reduce((n, m) => n + expected.cell(m, 'visits_deduped', `slims_type:${types[1]!}`), 0);
    expect(teachers).toBeGreaterThan(0);
    expect(second.numerator).toBe(want - teachers);
    expect(second.numerator).toBe(await handCount());
    expect(await k.h.db.selectFrom('catalog_runs').select('id').execute()).toEqual(runsBefore);
  }, 300_000);

  it('the audit chain verifies after the whole flow', async () => {
    const rows = await k.h.db.selectFrom('audit_log').select('seq').execute();
    expect(await verifyAuditChain(k.h)).toEqual({ ok: true, head: rows.length });
  });
});

describe.skipIf(!ctx.available)(`the SLiMS catalogue re-sync end to end [${engineLabel()}]`, () => {
  const keyring = [{ kid: 'k1', key: Buffer.alloc(32, 7).toString('base64url'), active: true }];
  const silent = { info() {}, warn() {}, error() {} };
  const LIBRARY = 'Perpustakaan SMA Selaras';
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  let staffId = '';
  const plain = slimsFixtureBytes(SLIMS_FIXTURE_SEED);
  const mutated = slimsFixtureBytes(SLIMS_FIXTURE_SEED, { mutateCatalog: true });
  const deps = (): CatalogJobDeps & { appVersion: string } => ({ dataDir, baseUrl: GOLDEN_BASE_URL, keyring, storage: localStorageDriver(dataDir), log: silent, appVersion: '0.1.0' });
  const registry = createJobRegistry([...(slimsJobs(deps) as JobHandler<unknown>[]), evaluateJob(deps, { providers: ACCRED_METRIC_PROVIDERS }) as JobHandler<unknown>]);
  /** The periods: this school year (snapshot date today, after the sync) and the last one (ended before the sync). */
  const periods = { current: '', last: '' };

  async function runToEnd(jobId: string, now: number): Promise<string> {
    for (let i = 0; i < 3_000; i += 1) {
      const job = await claimById(h, registry, jobId, { worker: 'test', now });
      if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error(`job ${jobId} did not end`);
  }

  async function staged(bytes: Buffer, now: number): Promise<string> {
    const id = newId(now);
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    return id;
  }

  /** A migration run of `dump` on the clock `now` (an append run first, a re-sync later), to its end. */
  async function migrate(dump: Buffer, now: number, sync: boolean): Promise<void> {
    const later = (await h.db.selectFrom('records').select('id').limit(1).executeTakeFirst()) !== undefined;
    const input: SlimsStartInput = {
      dryRun: false,
      sourceKind: 'dump',
      db: null,
      password: null,
      dumpStagingId: await staged(dump, now),
      files: 'zip',
      filesStagingId: await staged(sync ? mutated.filesZip : plain.filesZip, now),
      filesDir: null,
      branchId,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: later,
      confirmLibraryName: later ? LIBRARY : null,
      fromRunId: null,
      ...(sync ? { catalogMode: 'sync' as const } : {}),
    };
    const { runId, jobId } = await withTx(h, (trx) => startSlimsMigration(txCtx(trx, now, staff), registry, input, { keyring }));
    expect(await runToEnd(jobId, now)).toBe('succeeded');
    expect((await h.db.selectFrom('catalog_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow()).status).toBe('succeeded');
  }

  /** Evaluates `periodId` with the real providers on the real clock; the stored value of SCH-K1 (titles in stock at D). */
  async function titlesInStock(periodId: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { jobId } = await withTx(h, (trx) => enqueueEvaluate(trx, periodId, { now: Date.now(), createdBy: staffId, registry, keyring }));
    expect(await runToEnd(jobId, Date.now())).toBe('succeeded');
    const row = await h.db.selectFrom('accred_results').select('payload').where('period_id', '=', periodId).where('indicator_code', '=', 'SCH-K1').executeTakeFirstOrThrow();
    return (JSON.parse(row.payload) as { value: { value: number } }).value.value;
  }

  async function seedPeriod(startsOn: string, endsOn: string): Promise<string> {
    const at = Date.now() - 4 * 3_600_000;
    const id = newId(at);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: `Tahun pelajaran ${startsOn.slice(0, 4)}`,
        kind: 'school_year',
        starts_on: startsOn,
        ends_on: endsOn,
        instrument_id: 'sch-sma-2025',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: JSON.stringify({ schoolLevel: 'sma_smk_ma', npp: '3201010D1000004' }),
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: at,
        created_by: null,
        updated_at: at,
        updated_by: null,
      })
      .execute();
    return id;
  }

  const itemOf = async (slimsId: number) => (await legacyTarget(h.db, 'slims', 'item', String(slimsId)))!;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-k1-resync-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    const at = Date.now() - 5 * 3_600_000;
    branchId = newId(at);
    await h.db.insertInto('branches').values({ id: branchId, code_key: 'SELARAS', code_display: 'SELARAS', name: LIBRARY, timezone: 'Asia/Jakarta', is_default: 1, created_at: at, updated_at: at }).execute();
    staffId = newId(at);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'PENYELARAS', username_display: 'penyelaras', name: 'penyelaras', password_hash: 'x', status: 'active', created_at: at, updated_at: at })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': LIBRARY, 'library.type': 'sekolah' }, { now: at, actorId: null, keyring: [] }));
    // The school year running now (its end lies ahead: snapshot date today) and the one before it (ended).
    const today = new Date();
    const start = today.getUTCFullYear() - (today.getUTCMonth() < 6 ? 1 : 0);
    periods.current = await seedPeriod(`${start}-07-01`, `${start + 1}-06-30`);
    periods.last = await seedPeriod(`${start - 1}-07-01`, `${start}-06-30`);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('after a sync of the changed source the stock follows the archived, lost and new copies, from the sync date', async () => {
    const firstRun = Date.now() - 3 * 3_600_000;
    await migrate(plain.dump, firstRun, false);
    // In ALTIS a librarian withdraws the other copy of title 76, so the copy SLiMS will declare lost is its last one.
    const other = (await h.db.selectFrom('items').select(['id', 'version', 'record_id']).where('id', '=', await itemOf(373)).executeTakeFirstOrThrow());
    expect(other.record_id).toBe((await h.db.selectFrom('items').select('record_id').where('id', '=', await itemOf(76)).executeTakeFirstOrThrow()).record_id);
    await withTx(h, (trx) => archiveItem(txCtx(trx, firstRun + 60_000, staff), branchId, other.id, Number(other.version)));

    const before = { current: await titlesInStock(periods.current), last: await titlesInStock(periods.last) };
    expect(before.current).toBeGreaterThan(250);

    const syncAt = Date.now() - 3_600_000;
    await migrate(mutated.dump, syncAt, true);
    const m = mutated.hooks.mutation!;
    // What the sync wrote: the weeded copies withdrawn, the lost one lost, the deleted title archived with its copies, the
    // title whose source row is gone kept for its live copy, the new copy added.
    const status = async (slimsId: number) => (await h.db.selectFrom('items').select(['status', 'archived_at']).where('id', '=', await itemOf(slimsId)).executeTakeFirstOrThrow());
    for (const id of m.weeded) expect((await status(id)).status).toBe('withdrawn');
    expect((await status(m.lost)).status).toBe('lost');
    for (const id of m.deletedRecord.items) expect((await status(id)).archived_at).not.toBeNull();
    const deletedTitle = await legacyTarget(h.db, 'slims', 'biblio', String(m.deletedRecord.biblioId));
    expect((await h.db.selectFrom('records').select('archived_at').where('id', '=', deletedTitle!).executeTakeFirstOrThrow()).archived_at).not.toBeNull();
    const keptTitle = await legacyTarget(h.db, 'slims', 'biblio', String(m.keptRecord.biblioId));
    expect((await h.db.selectFrom('records').select('archived_at').where('id', '=', keptTitle!).executeTakeFirstOrThrow()).archived_at).toBeNull();
    expect((await status(m.added.itemId)).status).toBe('available');

    const after = { current: await titlesInStock(periods.current), last: await titlesInStock(periods.last) };
    // This year (snapshot date after the sync): the deleted title and the title whose last live copy is now lost leave
    // the stock; the weeded copies' titles keep another live copy, the new copy's title was in stock already.
    expect(after.current).toBe(before.current - 2);
    // Last year (snapshot date before the sync): the loss and the archive both count from the sync date, so the stock of
    // that date is what it was: a title the source deleted later was still in stock then.
    expect(after.last).toBe(before.last);
  }, 600_000);

  it('the entry date of a copy whose receiving date SLiMS emptied dates its acquisition', async () => {
    const m = mutated.hooks.mutation!;
    const item = await h.db.selectFrom('items').select(['barcode_display', 'received_date', 'input_on']).where('id', '=', await itemOf(m.receivedEmptied)).executeTakeFirstOrThrow();
    expect(item.received_date).toBeNull();
    expect(item.input_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const def = reportById('collection.acquisitions')!;
    const settings = await loadAccredSettings(h.db);
    const year = Number(item.input_on!.slice(0, 4));
    let cursor: string | null = null;
    let found: (string | number | null)[] | undefined;
    for (let page = 0; page < 20 && found === undefined; page += 1) {
      const res = await previewReport(h.db, def, { params: { yearFrom: year, yearTo: year, detailYear: year }, limit: 200, ...(cursor === null ? {} : { cursor }) }, { locale: 'id', tz: 'Asia/Jakarta', now: Date.now(), settings });
      const barcode = res.columns.findIndex((c) => c.key === 'barcode');
      found = res.rows.find((r) => r[barcode] === item.barcode_display);
      if (found !== undefined) {
        const acqDate = res.columns.findIndex((c) => c.key === 'acq_date');
        const basis = res.columns.findIndex((c) => c.key === 'acq_basis');
        expect(found[acqDate]).toBe(item.input_on);
        expect(found[basis]).toBe(msg('report.acq_basis.input_on'));
      }
      cursor = res.nextCursor;
      if (cursor === null) break;
    }
    expect(found).toBeDefined();
  });

  it('a second sync of the same source rewrites nothing', async () => {
    const tables: TableName[] = ['records', 'items', 'item_events', 'migration_map', 'locations'];
    const sums = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await tableChecksumFromDb(h.db, h.dialect, t)] as const)));
    const before = await sums();
    await migrate(mutated.dump, Date.now() - 1_800_000, true);
    expect(await sums()).toEqual(before);
  }, 600_000);
});
