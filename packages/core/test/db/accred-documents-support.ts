import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type ReportRunsTable } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { AccredProfile } from '@altis/shared/api/accreditation';
import { StoredRunParams } from '@altis/shared/api/reports';
import type { Selectable } from 'kysely';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { startDocumentRun, type AccredDocumentId } from '../../src/accreditation/documents/index.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { ACCRED_METRICS, type AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { catalogueCode } from '../../src/accreditation/scoring/score.js';
import type { AccredInstrument } from '../../src/accreditation/types.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver, type StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobHandler, JobRegistry, SliceResult } from '../../src/jobs/types.js';
import { PdfDocument } from '../../src/print/pdf.js';
import { reportsExportJob } from '../../src/reports/export/job.js';
import { writeSettings } from '../../src/settings/service.js';
import { STOCK_TZ, stockAt } from '../support/stock-fixture.js';
import { checkPdf, type CheckedPage } from '../support/pdf-check.js';

// What the accreditation document tests share (accred-dossier, accred-dossier-zip, accred-self-assessment,
// accred-statement): a migrated database with a staff member, a school library and a DATA_DIR of its own; periods seeded
// straight into the tables with their results, answers, evidence files and profile (the results of the "SMA contoh"
// school, whose answers give an estimate of 70.45, predicate C); the export job driven slice by slice through the
// queue's claim path; and readers for the PDFs (text per page) and the ZIPs (a strict streaming reader that never
// looks at the central directory and refuses a stored entry whose sizes are only in a data descriptor).

export const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

/** When the seeded rows were written: an hour before the real clock. */
export const SEEDED_AT = Date.now() - 3_600_000;
export const LIBRARY = 'Perpustakaan SMA Contoh';
export const STAFF_NAME = 'Siti Pustakawan';
/** The override note the evidence file must never print. */
export const OVERRIDE_NOTE = 'CATATAN-OVERRIDE-UJI-7731';
export const SCHOOL_HEAD = 'Drs. Budi Santoso';
export const LIBRARY_HEAD = 'Sari Wulandari';

export interface DocsDb {
  h: TestDbHandle;
  root: string;
  dataDir: string;
  staffId: string;
  branchId: string;
  storage: StorageDriver;
  registry: JobRegistry;
  close(): Promise<void>;
}

/** A migrated database with a school library, a branch, a staff member and the export job; its DATA_DIR. */
export async function openDocsDb(prefix: string, o: { libraryType?: 'sekolah' | 'umum' } = {}): Promise<DocsDb> {
  const h = await testDb();
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${prefix}-`)));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  const staffId = newId(SEEDED_AT);
  await h.db
    .insertInto('staff_users')
    .values({ id: staffId, username_key: 'siti', username_display: 'siti', name: STAFF_NAME, password_hash: 'x', status: 'active', created_at: SEEDED_AT, updated_at: SEEDED_AT })
    .execute();
  await withTx(h, (trx) =>
    writeSettings(trx, { 'library.name': LIBRARY, 'library.type': o.libraryType ?? 'sekolah', 'library.timezone': STOCK_TZ }, { keyring: KEYRING, now: SEEDED_AT, actorId: null }),
  );
  const at = stockAt('2017-01-02');
  const branchId = newId(at);
  await h.db
    .insertInto('branches')
    .values({ id: branchId, code_key: 'UTM', code_display: 'UTM', name: 'Perpustakaan Utama', address: null, timezone: STOCK_TZ, is_default: 0, created_at: at, created_by: null, updated_at: at, updated_by: null })
    .execute();
  const storage = localStorageDriver(dataDir);
  const deps = (): CatalogJobDeps & { appVersion: string } => ({ dataDir, baseUrl: 'https://perpus.sma-contoh.sch.id', keyring: KEYRING, storage, log: silent, appVersion: '0.1.0' });
  const registry = createJobRegistry([reportsExportJob(deps) as JobHandler<unknown>]);
  return {
    h,
    root,
    dataDir,
    staffId,
    branchId,
    storage,
    registry,
    async close() {
      await h.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

/** The profile of the "SMA contoh" school (the level changes with the instrument). */
export function schoolProfile(level: 'sd_mi' | 'smp_mts' | 'sma_smk_ma', more: Partial<AccredProfile> = {}): AccredProfile {
  return {
    schoolLevel: level,
    npp: '3201010D1000004',
    status: 'negeri',
    foundedYear: 1990,
    foundingDecree: { number: 'SK-01/1990', date: '1990-07-01', issuer: 'Kepala Sekolah' },
    schoolName: 'SMA Contoh',
    schoolHead: SCHOOL_HEAD,
    libraryHead: LIBRARY_HEAD,
    libraryHeadId: '198001012005012001',
    address: { street: 'Jl. Pendidikan 1', village: 'Sukamaju', district: 'Cibeunying', regency: 'Kota Bandung', province: 'Jawa Barat', postalCode: '40123' },
    phone: '022-123456',
    website: 'https://perpus.sma-contoh.sch.id',
    email: 'perpus@sma-contoh.sch.id',
    certificateName: 'Perpustakaan SMA Contoh',
    ...more,
  };
}

export interface PeriodSeed {
  instrumentId: string;
  name?: string;
  profile?: AccredProfile;
  population?: boolean;
}

/** An open school-year period 2025/2026 written at SEEDED_AT; its id. */
export async function seedPeriod(db: DocsDb, o: PeriodSeed): Promise<string> {
  const id = newId(SEEDED_AT);
  const population = o.population ?? true;
  await db.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: o.name ?? 'Tahun pelajaran 2025/2026',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: o.instrumentId,
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: JSON.stringify(o.profile ?? {}),
      students: population ? 108 : null,
      teachers: population ? 10 : null,
      edu_staff: population ? 5 : null,
      classes: 3,
      user_pcs: 4,
      staff_pcs: 1,
      ict_devices: 5,
      scanners: 2,
      floor_m2: 120,
      bandwidth_mbps: 30,
      hours_per_week: 35,
      all_registered_confirmed: 0,
      archived_at: null,
      version: 0,
      created_at: SEEDED_AT,
      created_by: null,
      updated_at: SEEDED_AT,
      updated_by: null,
    })
    .execute();
  return id;
}

/** The answers of the "SMA contoh" school under the SMA instrument (estimate 70.45, predicate C). */
export const SMA_LETTERS: Readonly<Record<string, 'a' | 'b' | 'c' | 'd'>> = Object.freeze({
  K1: 'c', K2: 'a', K3: 'b', K4: 'b', K5: 'c', K6: 'b', K7: 'a', K8: 'b',
  SP1: 'a', SP2: 'b', SP3: 'c', SP4: 'a', SP5: 'c', SP6: 'c', SP7: 'b',
  L1: 'b', L2: 'a', L3: 'b', L4: 'b', L5: 'c', L6: 'b', L7: 'c', L8: 'b', L9: 'b', L10: 'c', L11: 'a', L12: 'b', L13: 'b', L14: 'c',
  T1: 'b', T2: 'b', T3: 'b', T4: 'c', T5: 'b',
  F1: 'b', F2: 'b', F3: 'c', F4: 'b',
  G1: 'c', G2: 'c', G3: 'b', G4: 'b',
});

/** The values of the "SMA contoh" school per concept code. */
const SMA_VALUES: Readonly<Record<string, number>> = Object.freeze({
  K1: 1000, K2: 25, K3: 6, K4: 2, K5: 25, K6: 43, K7: 100, K8: 4,
  SP4: 4, SP5: 50, SP6: 30, SP7: 5,
  L1: 3, L2: 6, L3: 4, L4: 5, L5: 3, L6: 4, L7: 1, L8: 2, L9: 3, L10: 1, L11: 1, L12: 5, L13: 9, L14: 50,
  T1: 1, T2: 4, T3: 2, T4: 6, T5: 61,
  F1: 3, F2: 4, F4: 40,
  G1: 3, G2: 3, G3: 6, G4: 3,
});

type Note = { key: string; params?: Record<string, string | number> };

/**
 * The notes seeded on some items: every note that speaks about the answer (the evidence file must leave each out) and
 * a few data-quality notes it prints.
 */
const VALUE_NOTES: Readonly<Record<string, Note[]>> = Object.freeze<Record<string, Note[]>>({
  K2: [{ key: 'accred.note.fiction_rule', params: { rule: 'tipe koleksi FIKSI' } }],
  K3: [{ key: 'accred.note.mandatory_missing', params: { items: 'Aspek 7' } }],
  K4: [{ key: 'accred.note.register_empty', params: { register: 'Kegiatan' } }],
  K6: [
    { key: 'accred.note.items_without_received_date', params: { count: 40 } },
    { key: 'accred.note.undated_share_high', params: { pct: 11, max: 10 } },
  ],
  K7: [{ key: 'accred.note.k7_unprocessed', params: { pct: 90, threshold: 100 } }],
  L6: [{ key: 'accred.note.l6_manual' }],
  L11: [{ key: 'accred.note.l11_unverified' }],
});
const SCORING_NOTES: Readonly<Record<string, Note[]>> = Object.freeze<Record<string, Note[]>>({
  K2: [{ key: 'accred.note.truncated' }, { key: 'accred.note.k2_overlap' }],
  K6: [{ key: 'accred.note.k6_tier', params: { count: 700 } }],
});

export interface ResultsSeed {
  prerequisites?: { npp?: boolean; titles?: number; asOf?: string };
  letters?: Readonly<Record<string, 'a' | 'b' | 'c' | 'd'>>;
  values?: Readonly<Record<string, number>>;
}

/** The registration prerequisites the evaluation found. */
export function prerequisitesOf(o: ResultsSeed['prerequisites'] = {}) {
  const count = o.titles ?? 1000;
  const npp = o.npp ?? true;
  return { titles: { pass: count >= 1000, count, asOf: o.asOf ?? '2026-06-30' }, npp: { pass: npp }, foundingDecree: { pass: true }, met: count >= 1000 && npp };
}

/**
 * The results an evaluation of `periodId` under `instr` would leave: every computed indicator with its value and the
 * suggestion of the given letters, the standards, the prerequisites, `_meta` ready.
 */
export async function seedResults(db: DocsDb, periodId: string, instr: AccredInstrument, o: ResultsSeed = {}): Promise<void> {
  const letters = o.letters ?? SMA_LETTERS;
  const values = o.values ?? SMA_VALUES;
  const prerequisites = prerequisitesOf(o.prerequisites);
  const computedAt = SEEDED_AT + 1_000;
  const rows: [string, unknown][] = [
    ['_meta', { status: 'ready', startedAt: computedAt, jobId: newId(computedAt), computedAt, durationMs: 40, prerequisites }],
    ['SCH-PRASYARAT', { kind: 'prerequisites', prerequisites, titles: { value: prerequisites.titles.count, unit: 'count', basis: 'live', notes: [] } }],
  ];
  for (const c of instr.components) {
    for (const ind of c.indicators) {
      const manual = ind.band.kind === 'manual';
      const metric = ind.metric ?? null;
      const v = values[ind.code];
      const value =
        manual || metric === null || v === undefined
          ? null
          : {
              value: v,
              ...(ind.code === 'K2' ? { numerator: 250, denominator: 1000 } : {}),
              unit: ACCRED_METRICS[metric as AccredMetricId].unit,
              basis: 'live',
              notes: VALUE_NOTES[ind.code] ?? [],
              ...(ind.code === 'K1' ? { detail: { reportId: 'collection.title_list', params: { asOf: '2026-06-30' } } } : {}),
            };
      rows.push([
        catalogueCode(ind),
        { kind: 'indicator', metric, value, size: null, suggestion: manual ? null : (letters[ind.code] ?? null), notes: SCORING_NOTES[ind.code] ?? [] },
      ]);
    }
  }
  for (const check of instr.snp) {
    rows.push([check.code, { kind: 'snp', metric: check.metric, value: null, outcome: check.code === 'SNP-S-01' ? 'pass' : 'fail', rule: check.ruleKey, notes: [] }]);
  }
  for (const [code, payload] of rows) {
    await db.h.db.insertInto('accred_results').values({ period_id: periodId, indicator_code: code, payload: JSON.stringify(payload), computed_at: computedAt }).execute();
  }
}

/** The answers given by hand (SP1 a, SP2 b, SP3 c, F3 c) and the K1 answer that replaced its suggestion, with a note. */
export async function seedAnswers(db: DocsDb, periodId: string): Promise<void> {
  const rows: [string, string, 'manual' | 'override', string | null][] = [
    ['SCH-SP1', 'a', 'manual', null],
    ['SCH-SP2', 'b', 'manual', null],
    ['SCH-SP3', 'c', 'manual', null],
    ['SCH-F3', 'c', 'manual', null],
    ['SCH-K1', 'c', 'override', OVERRIDE_NOTE],
  ];
  for (const [code, answer, mode, note] of rows) {
    await db.h.db.insertInto('accred_answers').values({ period_id: periodId, indicator_code: code, answer, mode, note, updated_at: SEEDED_AT, updated_by: db.staffId }).execute();
  }
}

/** A real one-page PDF with `text`, as an uploaded evidence file. */
export function tinyPdf(text: string): Uint8Array {
  const doc = new PdfDocument({ title: text });
  doc.addPage(200, 100).text(10, 50, text, { font: 'Helvetica', size: 10 });
  return doc.toBytes();
}

/** An evidence file of `periodId` (stored, with its `files` row); its file id. */
export async function addEvidence(
  db: DocsDb,
  periodId: string,
  o: { indicatorCode: string | null; evidenceCode: string | null; caption: string; name: string; mime: string; bytes: Uint8Array; sortOrder?: number },
): Promise<string> {
  const fileId = newId(SEEDED_AT);
  const evidenceId = newId(SEEDED_AT);
  const sha256 = createHash('sha256').update(o.bytes).digest('hex');
  await db.storage.put(fileId, o.bytes, { size: o.bytes.byteLength, sha256 });
  await db.h.db
    .insertInto('files')
    .values({
      id: fileId,
      original_name: o.name,
      mime: o.mime,
      size: o.bytes.byteLength,
      sha256,
      context: 'accreditation.evidence',
      owner_type: 'accred_evidence',
      owner_id: evidenceId,
      access: 'staff',
      status: 'ok',
      created_at: SEEDED_AT,
      created_by: db.staffId,
    })
    .execute();
  await db.h.db
    .insertInto('accred_evidence')
    .values({
      id: evidenceId,
      period_id: periodId,
      indicator_code: o.indicatorCode,
      evidence_code: o.evidenceCode,
      entity: null,
      entity_id: null,
      file_id: fileId,
      caption: o.caption,
      sort_order: o.sortOrder ?? 0,
      created_at: SEEDED_AT,
      created_by: db.staffId,
    })
    .execute();
  return fileId;
}

/** Starts a run of document `reportId` for `periodId`, as its route does; its run and job ids. */
export function startDoc(db: DocsDb, reportId: AccredDocumentId, periodId: string, body: Record<string, unknown> = {}): Promise<{ id: string; jobId: string }> {
  return withTx(db.h, (trx) => startDocumentRun(trx, reportId, periodId, body as never, { createdBy: db.staffId, now: Date.now(), registry: db.registry, keyring: KEYRING }));
}

/**
 * Claims and runs job `jobId` slice by slice (`budgetMs` each) until it stops continuing; the outcomes. A slice that
 * `forget` names is lost after it ran: its checkpoint is put back to the one it started from, as when the process
 * stopped before the queue recorded it (its files stay as it left them).
 */
export async function drive(
  db: DocsDb,
  jobId: string,
  o: { budgetMs?: number; maxSlices?: number; forget?: (slice: number) => boolean } = {},
): Promise<SliceResult['outcome'][]> {
  const outcomes: SliceResult['outcome'][] = [];
  for (let i = 1; i <= (o.maxSlices ?? 2000); i += 1) {
    const before = await db.h.db.selectFrom('jobs').select('payload').where('id', '=', jobId).executeTakeFirstOrThrow();
    const job = await claimById(db.h, db.registry, jobId, { worker: 'test', now: Date.now() });
    if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
    const r = await runSlice(db.h, db.registry, job, { mode: 'worker', budgetMs: o.budgetMs ?? 20_000, keyring: KEYRING, log: silent, clock: () => Date.now(), env: {} });
    outcomes.push(r.outcome);
    if (r.outcome !== 'continued') return outcomes;
    if (o.forget?.(i) === true) await db.h.db.updateTable('jobs').set({ payload: before.payload }).where('id', '=', jobId).execute();
  }
  return outcomes;
}

/** Starts and runs document `reportId` to its end; the run's row and file. */
export async function runDoc(
  db: DocsDb,
  reportId: AccredDocumentId,
  periodId: string,
  body: Record<string, unknown> = {},
  o: { budgetMs?: number } = {},
): Promise<{ run: Selectable<ReportRunsTable>; bytes: Buffer; outcomes: SliceResult['outcome'][] }> {
  const { id, jobId } = await startDoc(db, reportId, periodId, body);
  const outcomes = await drive(db, jobId, o);
  const run = await db.h.db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  if (run.status !== 'succeeded') throw new Error(`run ${id} ended ${run.status} (${run.error_code ?? ''})`);
  const bytes = await fsp.readFile(reportExportPath(db.dataDir, id, run.format as 'pdf' | 'zip'));
  return { run, bytes, outcomes };
}

/** The stored parameters of a run. */
export function storedParams(run: Selectable<ReportRunsTable>): StoredRunParams {
  return StoredRunParams.parse(JSON.parse(run.params));
}

/** A page's text in reading order (top to bottom, left to right), one space between runs. */
export function pageText(page: CheckedPage): string {
  return [...page.texts]
    .sort((a, b) => Math.round(b.y * 10) - Math.round(a.y * 10) || a.x - b.x)
    .map((t) => t.text)
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The text of every page of a PDF (checked by the structural checker first). */
export function pdfPages(bytes: Uint8Array): string[] {
  return checkPdf(bytes).pages.map(pageText);
}

/** One entry of a ZIP as a strict streaming reader sees it. */
export interface StreamedEntry {
  name: string;
  flags: number;
  method: number;
  data: Buffer;
}

/**
 * A strict streaming reader, test-local: it walks the local headers front to back and never looks at the central
 * directory. It refuses a stored entry whose sizes are only in a data descriptor (it could not find where it ends),
 * and checks every entry's size and CRC-32 against its header.
 */
export function streamEntries(bytes: Buffer): StreamedEntry[] {
  const out: StreamedEntry[] = [];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const flags = bytes.readUInt16LE(at + 6);
    const method = bytes.readUInt16LE(at + 8);
    const crc = bytes.readUInt32LE(at + 14);
    let compressedSize = bytes.readUInt32LE(at + 18);
    let size = bytes.readUInt32LE(at + 22);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const name = utf8.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const extra = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + extraLength);
    if (extraLength >= 20 && extra.readUInt16LE(0) === 0x0001) {
      size = Number(extra.readBigUInt64LE(4));
      compressedSize = Number(extra.readBigUInt64LE(12));
    }
    if ((flags & 0x0008) !== 0) throw new Error(`entry ${name} has its sizes in a data descriptor only`);
    const dataAt = at + 30 + nameLength + extraLength;
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.byteLength !== size || crc32(data) !== crc) throw new Error(`entry ${name}: size or CRC-32 do not match`);
    out.push({ name, flags, method, data });
    at = dataAt + compressedSize;
  }
  if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('the entries are not followed by the central directory');
  return out;
}

/** The SMA instrument and its siblings. */
export const SMA = instrumentById('sch-sma-2025') as AccredInstrument;
export const SD = instrumentById('sch-sd-2025') as AccredInstrument;

/** Texts the evidence file never holds: the estimate, the predicates, the override note, the answer-bearing words. */
export const FORBIDDEN = Object.freeze([
  '70,45',
  '70.45',
  'Predikat',
  'Sangat Baik',
  'Cukup Baik',
  'Tidak Terakreditasi',
  OVERRIDE_NOTE,
  'menyarankan',
  'jawaban butir ini',
  'mendapat jawaban',
  'saran ini',
  'pilih jawaban',
  'SIMULASI INTERNAL',
]);
