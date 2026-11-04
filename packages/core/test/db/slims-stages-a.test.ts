import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MigrationSummary, MigrationTableCounts } from '@altis/shared/api/catalog/migration';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { readCustomValues } from '../../src/catalog/data/custom-fields.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import { placeNameOf } from '../../src/migration/slims/maps/place.js';
import type { SlimsReportRow, SlimsStage, SlimsStageContext } from '../../src/migration/slims/stage.js';
import { mastersStage } from '../../src/migration/slims/stages/masters.js';
import { recordsStage } from '../../src/migration/slims/stages/records.js';
import { relationsStage } from '../../src/migration/slims/stages/relations.js';
import { __setSlimsStageBatch, cutChars, fitChars, Ledger } from '../../src/migration/slims/stages/stage-a-kit.js';
import { readSettings } from '../../src/settings/service.js';
import { wipeCatalog } from '../support/search-corpus.js';
import { buildSlimsFixture, type SlimsFixture } from '../support/slims-fixture/index.js';

// The SLiMS stages A (Phase 2 Task 37; spec §11.4, §11.5, §11.6; S13, S19, M13): masters, authorities, the thesaurus,
// records and relations, run through the real migration job on the synthetic fixture dump (Task 10) with the
// framework's own split, analyze and report around them (Task 23). The stages of Task 38 are left out
// (__setSlimsStages), so only the tables these three read are reconciled here.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const SECOND_SEED = 20261107;
const STAGES_A: readonly SlimsStage[] = [mastersStage, recordsStage, relationsStage];
/** The source tables stages A read. */
const READS = [...new Set(STAGES_A.flatMap((s) => s.reads))];

/** Every catalog table a migration may write, the settings and the legacy map. */
const WATCHED = [
  'languages',
  'material_types',
  'publishers',
  'agents',
  'subjects',
  'subject_relations',
  'records',
  'record_identifiers',
  'record_agents',
  'record_subjects',
  'record_relations',
  'locations',
  'collection_types',
  'suppliers',
  'custom_field_defs',
  'custom_values',
  'search_doc',
  'search_facet',
  'migration_map',
  'migration_archive',
  'settings',
] as const;

type Watched = (typeof WATCHED)[number];

describe('stages A: cuts and report rows', () => {
  it('a cut value keeps at most `max` code points (as the contracts and the columns count them), never half a surrogate pair', () => {
    const astral = '\u{20000}'.repeat(300); // 300 code points, 600 UTF-16 units
    for (const cut of [cutChars(astral, 191), cutChars(`a${astral}`, 191)]) {
      expect(Array.from(cut)).toHaveLength(191);
      expect(z.string().max(191).safeParse(cut).success).toBe(true);
      expect(z.string().max(190).safeParse(cut).success).toBe(false);
      expect(Array.from(cut).every((ch) => ch === 'a' || ch === '\u{20000}')).toBe(true);
    }
    expect(cutChars('abc ', 3)).toBe('abc');
    expect(cutChars('ab  c', 4)).toBe('ab');
    expect(Array.from(placeNameOf({ place_name: `  ${astral}  ` })!)).toHaveLength(191);
    const rows: SlimsReportRow[] = [];
    const l = new Ledger(new Map(), new Map());
    expect(Array.from(fitChars(l, 'biblio', '1', 'edition', astral, 191)!)).toHaveLength(191);
    l.apply({ report: (r: SlimsReportRow) => rows.push(r), counters: {} } as unknown as SlimsStageContext);
    expect(rows).toEqual([{ table: 'biblio', legacyKey: '1', code: 'text_truncated', detail: 'edition: 300 > 191' }]);
  });

  it('past 200 rows of one code in a table, the report rows are counted and summed up in one row at its end', () => {
    const rows: SlimsReportRow[] = [];
    const c = { report: (r: SlimsReportRow) => rows.push(r), counters: {} } as unknown as SlimsStageContext;
    const l = new Ledger(new Map(), new Map());
    for (let i = 0; i < 250; i += 1) l.report('biblio', String(i), 'date_invalid', 'x');
    l.report('biblio', '7', 'title_empty', 'x');
    l.overflow('biblio');
    l.apply(c);
    expect(rows.filter((r) => r.code === 'date_invalid' && r.legacyKey !== null)).toHaveLength(200);
    expect(rows.filter((r) => r.code === 'title_empty')).toHaveLength(1);
    expect(rows.at(-1)).toEqual({ table: 'biblio', legacyKey: null, code: 'date_invalid', detail: '+50 baris lagi tidak dicantumkan / more rows not listed' });
  });
});

describe.skipIf(!ctx.available)(`SLiMS stages A on the fixture [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  let fixture: SlimsFixture;
  let second: SlimsFixture;
  let libraryName: string;
  let seedIds: Record<'material_types' | 'languages' | 'collection_types', string[]>;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-stages-a-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await wipeCatalog(h);
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers'] as const) await h.db.deleteFrom(table).execute();
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'MIGRASI-A', code_display: 'MIGRASI-A', name: 'Perpustakaan Migrasi', timezone: 'Asia/Jakarta', is_default: 0, created_at: NOW, updated_at: NOW })
      .execute();
    const staffId = newId(NOW);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'MIGRATOR-A', username_display: 'migrator-a', name: 'migrator', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
    libraryName = String((await readSettings(h.db, ['library.name'], []))['library.name']);
    fixture = await buildSlimsFixture(path.join(root, 'fixture'));
    second = await buildSlimsFixture(path.join(root, 'fixture-2'), { seed: SECOND_SEED });
    seedIds = {
      material_types: (await h.db.selectFrom('material_types').select('id').execute()).map((r) => r.id),
      languages: (await h.db.selectFrom('languages').select('id').execute()).map((r) => r.id),
      collection_types: (await h.db.selectFrom('collection_types').select('id').execute()).map((r) => r.id),
    };
    __setSlimsSourceFactory(null);
  }, 120_000);

  afterEach(() => {
    __setSlimsStages(null);
    __setSlimsStageBatch(null);
  });

  afterAll(async () => {
    __setSlimsStages(null);
    __setSlimsStageBatch(null);
    if (h !== undefined) {
      await wipeCatalog(h);
      await h.close();
    }
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** Starts a migration of `dump` (as an uploaded dump) with the stages `stages`. */
  async function start(dump: string, o: Partial<SlimsStartInput> = {}, stages: readonly SlimsStage[] = STAGES_A): Promise<{ runId: string; jobId: string }> {
    __setSlimsStages(stages);
    // A run that adopts a dry run's work folder (S3) takes no upload.
    let staging: string | null = null;
    if ((o.fromRunId ?? null) === null) {
      staging = newId(NOW);
      await fsp.mkdir(path.join(dataDir, 'tmp', staging), { recursive: true });
      await fsp.copyFile(dump, path.join(dataDir, 'tmp', staging, 'upload.bin'));
    }
    const input: SlimsStartInput = {
      dryRun: false,
      sourceKind: 'dump',
      db: null,
      password: null,
      dumpStagingId: staging,
      files: null,
      filesStagingId: null,
      filesDir: null,
      branchId,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      confirmLibraryName: null,
      fromRunId: null,
      ...o,
    };
    return withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, staff), registry, input, { keyring }));
  }

  /** Claims and runs job `id`'s slices (each with `budgetMs`) until it ends; a slice the queue retries is retried at once. */
  async function runToEnd(id: string, budgetMs = 20_000): Promise<{ outcome: string; slices: number; retries: number }> {
    let retries = 0;
    for (let slices = 1; slices <= 3000; slices += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome === 'retry') {
        retries += 1;
        await h.db.updateTable('jobs').set({ run_at: NOW }).where('id', '=', id).execute();
        continue;
      }
      if (r.outcome !== 'continued') return { outcome: r.outcome, slices, retries };
    }
    throw new Error('no end after 3000 slices');
  }

  async function migrate(dump: string, o: Partial<SlimsStartInput> = {}, stages?: readonly SlimsStage[], budgetMs?: number) {
    const { runId, jobId } = await start(dump, o, stages);
    const end = await runToEnd(jobId, budgetMs);
    const run = await h.db.selectFrom('catalog_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    return { runId, end, status: run.status, summary: JSON.parse(run.summary) as MigrationSummary, report: await reportRows(run.report_file_id) };
  }

  /** The report file `fileId` as rows of cells (BOM and CRLF stripped, the `"` quoting undone). */
  async function reportRows(fileId: string | null): Promise<string[][]> {
    if (fileId === null) throw new Error('the run has no report');
    const chunks: Buffer[] = [];
    for await (const c of (await localStorageDriver(dataDir).get(fileId))!) chunks.push(Buffer.from(c));
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\r') continue;
      else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    return rows;
  }

  const counts = async (): Promise<Record<Watched, number>> => {
    const out = {} as Record<Watched, number>;
    for (const t of WATCHED) out[t] = Number((await h.db.selectFrom(t as 'records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return out;
  };

  /** The target of the legacy row (`source`, `entity`, `key`). */
  async function target(entity: string, key: string | number, source = 'slims'): Promise<string> {
    const row = await h.db
      .selectFrom('migration_map')
      .select('target_id')
      .where('source', '=', source)
      .where('entity', '=', entity)
      .where('legacy_key', '=', String(key))
      .executeTakeFirst();
    if (row === undefined) throw new Error(`no map row ${source}/${entity}/${key}`);
    return row.target_id;
  }
  const record = async (biblioId: number, source = 'slims') =>
    h.db.selectFrom('records').selectAll().where('id', '=', await target('biblio', biblioId, source)).executeTakeFirstOrThrow();

  /** Every table stages A read reconciles (diff 0), and its source count is the fixture's. */
  function expectReconciled(summary: MigrationSummary, f: SlimsFixture): void {
    expect(summary.reconciliation?.ok).toBe(true);
    for (const table of READS) {
      const row = summary.reconciliation!.tables.find((t) => t.table === table);
      expect(row, table).toBeDefined();
      expect([table, row!.diff, row!.source]).toEqual([table, 0, f.expected.tables[table]!.source]);
    }
  }

  const tableCounts = (summary: MigrationSummary, table: string): MigrationTableCounts => summary.tables[table]!;

  // ---- a dry run first, on the empty catalogue -------------------------------------------------------------------

  it('a dry run counts and reports every row, reconciles, and writes nothing (catalog tables, settings, legacy map)', async () => {
    const before = await counts();
    const dry = await migrate(fixture.dumpPath, { dryRun: true });
    expect([dry.end.outcome, dry.status]).toEqual(['succeeded', 'succeeded']);
    expect(await counts()).toEqual(before);
    expectReconciled(dry.summary, fixture);
    expect(tableCounts(dry.summary, 'biblio')).toMatchObject({ source: 300, migrated: 300 });
    expect(tableCounts(dry.summary, 'mst_language')).toMatchObject({ migrated: 1, merged: 5, skipped: { empty_key: 1 } });
    // Duplicates inside a batch are merged in the counts as a real run would.
    expect(tableCounts(dry.summary, 'mst_author')).toMatchObject({ migrated: 39, merged: 1 });
    expect(tableCounts(dry.summary, 'mst_publisher')).toMatchObject({ migrated: 9, merged: 1 });
    // The dry run reports what the real run will: the custom value that is no number, the split titles.
    expect(dry.report.some((r) => r[0] === 'biblio_custom' && r[1] === '4' && r[2] === 'custom_value_invalid')).toBe(true);
    expect(dry.summary.fixes['biblio.title']).toMatchObject({ mojibake: 3, backslash: 2 });
  }, 120_000);

  // ---- the real run ----------------------------------------------------------------------------------------------

  let real: Awaited<ReturnType<typeof migrate>>;

  it('after stages A every table they read reconciles (diff 0), with the counts the fixture implies', async () => {
    real = await migrate(fixture.dumpPath);
    expect([real.end.outcome, real.status]).toEqual(['succeeded', 'succeeded']);
    expectReconciled(real.summary, fixture);
    const s = real.summary;
    expect(tableCounts(s, 'biblio')).toEqual({ source: 300, migrated: 300, merged: 0, skipped: {}, archived: 0 });
    expect(tableCounts(s, 'mst_gmd')).toMatchObject({ migrated: 10, merged: 0 });
    expect(tableCounts(s, 'mst_language')).toMatchObject({ migrated: 1, merged: 5, skipped: { empty_key: 1 } });
    expect(tableCounts(s, 'mst_publisher')).toMatchObject({ migrated: 9, merged: 1 });
    expect(tableCounts(s, 'mst_author')).toMatchObject({ migrated: 39, merged: 1 });
    expect(tableCounts(s, 'mst_topic')).toMatchObject({ migrated: 14, merged: 1 });
    expect(tableCounts(s, 'mst_voc_ctrl')).toMatchObject({ migrated: 8 });
    // The RDA, place and relation-term tables become no rows of their own: merged into the records' fields (M13).
    for (const t of ['mst_content_type', 'mst_media_type', 'mst_carrier_type', 'mst_place', 'mst_relation_term']) {
      expect(tableCounts(s, t), t).toMatchObject({ migrated: 0, merged: fixture.expected.tables[t]!.source });
    }
    expect(tableCounts(s, 'mst_location')).toMatchObject({ migrated: 3 });
    expect(tableCounts(s, 'mst_coll_type')).toMatchObject({ migrated: 3 });
    expect(tableCounts(s, 'mst_supplier')).toMatchObject({ migrated: 3 });
    expect(tableCounts(s, 'mst_custom_field')).toMatchObject({ migrated: 7, skipped: { phase3: 1 } });
    expect(tableCounts(s, 'mst_servers')).toMatchObject({ migrated: 1, skipped: { server_type: 2 } });
    expect(tableCounts(s, 'setting')).toMatchObject({ migrated: 1, skipped: { print_settings: 1, not_mapped: 2 } });
    expect(tableCounts(s, 'biblio_author').skipped).toEqual({ orphan: 1 });
    expect(tableCounts(s, 'biblio_topic').skipped).toEqual({ orphan: 1 });
    expect(tableCounts(s, 'biblio_custom')).toMatchObject({ migrated: 40 });
    expect(tableCounts(s, 'biblio_relation')).toEqual({ source: 9, migrated: 4, merged: 0, skipped: { zero: 2, self: 1, duplicate: 1, orphan: 1 }, archived: 0 });
    // Every biblio has its record, every record its source.
    const mapped = await h.db.selectFrom('migration_map').select(['legacy_key', 'target_id', 'run_id']).where('entity', '=', 'biblio').execute();
    expect(mapped).toHaveLength(300);
    for (const m of mapped) expect(m.run_id).toBe(real.runId);
    expect((await record(77)).source).toBe('slims:77');
    // Indexed per batch: every record has its search document.
    expect(Number((await h.db.selectFrom('search_doc').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(300);
  }, 120_000);

  it('the mojibake, backslash, cp1252 and NUL traps are repaired, with their counts in `fixes`', async () => {
    const t = fixture.expected.traps;
    for (const trap of [...t.mojibake, ...t.backslash, ...t.nul]) {
      if (trap.table !== 'biblio') continue;
      const r = await record(Number(trap.key));
      const column = trap.column === 'title' ? 'title' : trap.column === 'sor' ? 'responsibility' : 'notes';
      expect([trap.key, r[column]]).toEqual([trap.key, trap.clean]);
    }
    expect((await h.db.selectFrom('agents').select('name_display').where('id', '=', await target('mst_author', 31)).executeTakeFirstOrThrow()).name_display).toBe('José Rizal');
    expect((await h.db.selectFrom('agents').select('name_display').where('id', '=', await target('mst_author', 32)).executeTakeFirstOrThrow()).name_display).toBe("O'Brien, Flann");
    expect((await h.db.selectFrom('publishers').select('name_display').where('id', '=', await target('mst_publisher', 7)).executeTakeFirstOrThrow()).name_display).toBe(
      'Penerbit Café Jaya',
    );
    const f = real.summary.fixes;
    expect(f['biblio.title']).toEqual({ mojibake: 3, backslash: 2 });
    expect(f['biblio.sor']).toEqual({ backslash: 1 });
    expect(f['biblio.notes']).toEqual({ nul: 1 });
    expect(f['mst_author.author_name']).toEqual({ mojibake: 1, backslash: 1 });
    expect(f['mst_publisher.publisher_name']).toEqual({ cp1252: 1 });
    expect(real.summary.samples.some((x) => x.column === 'biblio.title' && x.after === 'Café Bandung')).toBe(true);
  });

  it('a duplicate author → one agent and two map rows; the same for publishers and topics', async () => {
    const [a1, a2] = [await target('mst_author', 1), await target('mst_author', 2)];
    expect(a1).toBe(a2);
    const hirata = await h.db.selectFrom('agents').select(['id', 'type', 'dates']).where('name_key', 'like', 'HIRATA, ANDREA%').execute();
    expect(hirata).toEqual([{ id: a1, type: 'person', dates: '1967-' }]);
    expect(await target('mst_publisher', 1)).toBe(await target('mst_publisher', 2));
    expect(await target('mst_topic', 9)).toBe(await target('mst_topic', 10));
    expect(real.report.some((r) => r[0] === 'mst_author' && r[1] === '2' && r[2] === 'authority_merged')).toBe(true);
    // Records 1 and 2 (authors 1 and 2) share their main author.
    const main = async (biblioId: number) =>
      (await h.db.selectFrom('record_agents').select('agent_id').where('record_id', '=', await target('biblio', biblioId)).where('is_main', '=', 1).executeTakeFirstOrThrow())
        .agent_id;
    expect(await main(1)).toBe(a1);
    expect(await main(2)).toBe(a1);
  });

  it('author types p/o/c, topic types (o and c → topic + a report row), the thesaurus and its scope note', async () => {
    const agent = async (id: number) => h.db.selectFrom('agents').selectAll().where('id', '=', await target('mst_author', id)).executeTakeFirstOrThrow();
    expect((await agent(33)).type).toBe('organization');
    expect((await agent(34)).type).toBe('meeting');
    expect((await agent(5)).authority_source).toBe('LCNAF');
    const subject = async (id: number) => h.db.selectFrom('subjects').selectAll().where('id', '=', await target('mst_topic', id)).executeTakeFirstOrThrow();
    expect([(await subject(7)).type, (await subject(7)).term_display, (await subject(7)).classification]).toEqual(['topic', 'Komputer', '004']);
    expect((await subject(8)).type).toBe('topic');
    expect((await subject(2)).type).toBe('geographic');
    expect((await subject(4)).type).toBe('temporal');
    expect((await subject(6)).type).toBe('occupation');
    for (const id of ['7', '8']) expect(real.report.some((r) => r[0] === 'mst_topic' && r[1] === id && r[2] === 'topic_type_invalid')).toBe(true);
    // Thesaurus: U → use with its reciprocal uf; the unknown code XX → rt + report; the scope row → the scope note.
    const rel = async (a: number, b: number) =>
      (await h.db.selectFrom('subject_relations').select('rel').where('subject_id', '=', await target('mst_topic', a)).where('related_id', '=', await target('mst_topic', b)).execute())
        .map((r) => r.rel)
        .sort();
    expect(await rel(1, 2)).toEqual(['bt', 'use']);
    expect(await rel(2, 1)).toEqual(['nt', 'uf']);
    expect(await rel(4, 5)).toEqual(['rt']);
    expect(await rel(5, 4)).toEqual(['rt']);
    expect(real.report.some((r) => r[0] === 'mst_voc_ctrl' && r[1] === '7' && r[2] === 'relation_term_unknown')).toBe(true);
    expect((await subject(5)).scope_note).toBe('Karya fiksi berbentuk prosa panjang.');
  });

  it("title 'Laskar Pelangi: sebuah novel' → title and subtitle; split only when both sides are not empty", async () => {
    for (const trap of fixture.expected.traps.titles) {
      const r = await record(trap.biblioId);
      expect([trap.biblioId, r.title, r.subtitle]).toEqual([trap.biblioId, trap.title, trap.subtitle]);
    }
    const laskar = await record(1);
    expect(laskar.title_key).toBe('laskar pelangi sebuah novel');
  });

  it("publish_year 'c1998?' → publication_year '1998' with the text kept; no year → null", async () => {
    for (const trap of fixture.expected.traps.years) {
      const r = await record(trap.biblioId);
      expect([trap.biblioId, r.publication_year, r.publication_date_text]).toEqual([trap.biblioId, trap.year, trap.text]);
    }
    expect(real.summary.fixes['biblio.publish_year']?.['year']).toBeGreaterThanOrEqual(4);
  });

  it('a mixed ISBN/ISSN cell → 2 identifiers; an ISBN-10 keys to its ISBN-13; shared ISBNs are reported as possible duplicates', async () => {
    const ids = async (biblioId: number) =>
      (
        await h.db
          .selectFrom('record_identifiers')
          .select(['type', 'value_key', 'is_valid', 'sort_order'])
          .where('record_id', '=', await target('biblio', biblioId))
          .orderBy('sort_order')
          .execute()
      ).map((r) => [r.type, r.value_key, Number(r.is_valid)]);
    expect(await ids(3)).toEqual([
      ['isbn', '9780306406157', 1],
      ['issn', '03178471', 1],
    ]);
    expect(await ids(33)).toEqual([
      ['isbn', '9780306406157', 1],
      ['isbn', '9781566199094', 1],
    ]);
    for (const trap of fixture.expected.traps.identifiers) expect(await ids(trap.biblioId)).toHaveLength(trap.count);
    // §3.3: reported, never merged.
    const dup = real.report.find((r) => r[2] === 'possible_duplicate' && r[3]!.includes('9780306406157'));
    expect(dup).toBeDefined();
    expect(dup![3]).toMatch(/slims=3,33$/);
    expect((await record(3)).merged_into).toBeNull();
    expect((await record(33)).archived_at).toBeNull();
  });

  it('M13: carrier code nc and a place id → the carrier and the place name; an unknown carrier → null + rda_unmatched', async () => {
    for (const trap of fixture.expected.traps.rda) expect([trap.biblioId, (await record(trap.biblioId)).carrier_type]).toEqual([trap.biblioId, trap.carrier]);
    for (const trap of fixture.expected.traps.places) expect([trap.biblioId, (await record(trap.biblioId)).publication_place]).toEqual([trap.biblioId, trap.place]);
    const laskar = await record(1);
    expect([laskar.content_type, laskar.media_type, laskar.carrier_type, laskar.publication_place]).toEqual(['txt', 'n', 'nc', 'Belitung']);
    // The carrier row that matches no RDA code or term, and the record whose carrier id has no row at all.
    expect(real.report.some((r) => r[0] === 'mst_carrier_type' && r[1] === '4' && r[2] === 'rda_unmatched')).toBe(true);
    expect(real.report.some((r) => r[0] === 'biblio' && r[1] === '26' && r[2] === 'rda_unmatched')).toBe(true);
  });

  it('S19: a cf_* number column holding the text 12 is stored as the number 12; refused values are reported, the record migrates', async () => {
    const values = async (biblioId: number) => (await readCustomValues(h.db, 'records', [await target('biblio', biblioId)])).get(await target('biblio', biblioId))!;
    expect(await values(1)).toMatchObject({ cf_4c5d6: 12, cf_0a1b2: '2019-05-01', cf_1a2b3: 'APBN 2016' });
    expect(await values(2)).toMatchObject({ cf_4c5d6: 7 });
    expect(await values(4)).toMatchObject({ cf_7e8f9: ['1', '3'] });
    expect(await values(4)).not.toHaveProperty('cf_4c5d6');
    expect(real.report.some((r) => r[0] === 'biblio_custom' && r[1] === '4' && r[2] === 'custom_value_invalid' && r[3]!.includes('cf_4c5d6'))).toBe(true);
    // A zero date → null and reported; the option list that was a broken payload keeps what it could.
    expect(await values(3)).not.toHaveProperty('cf_0a1b2');
    expect(real.report.some((r) => r[0] === 'biblio_custom' && r[1] === '3' && r[2] === 'date_invalid')).toBe(true);
    const bad = await h.db.selectFrom('custom_field_defs').select(['type', 'options']).where('code_key', '=', 'CF_BAD01').executeTakeFirstOrThrow();
    expect([bad.type, JSON.parse(bad.options!)]).toEqual(['select', [{ value: '1', label_id: 'Ting', label_en: null }]]);
    expect(real.report.some((r) => r[0] === 'mst_custom_field' && r[1] === 'cf_bad01' && r[2] === 'php_broken')).toBe(true);
    const checklist = await h.db.selectFrom('custom_field_defs').select(['entity', 'type', 'is_public']).where('code_key', '=', 'CF_7E8F9').executeTakeFirstOrThrow();
    expect(checklist).toEqual({ entity: 'records', type: 'multiselect', is_public: 1 });
    expect(await h.db.selectFrom('custom_field_defs').select('entity').where('code_key', '=', 'CF_9C8D7').executeTakeFirstOrThrow()).toEqual({ entity: 'items' });
  });

  it('the records: material types from GMD, languages, hidden and promoted records, dates, publishers, roles of authors', async () => {
    const mt = async (biblioId: number) =>
      h.db.selectFrom('material_types').selectAll().where('id', '=', (await record(biblioId)).material_type_id).executeTakeFirstOrThrow();
    // Biblio 3 has the GMD 'Map' (code MP): its material type has the map profile.
    expect(await mt(3)).toMatchObject({ code_display: 'MP', name_id: 'Map', marc_type: 'e', schema_type: 'Map', content_type: 'cri' });
    expect(await mt(29)).toMatchObject({ code_key: 'BUKU' });
    expect(real.report.some((r) => r[0] === 'biblio' && r[1] === '30' && r[2] === 'material_type_default')).toBe(true);
    const lang = async (biblioId: number) => {
      const id = (await record(biblioId)).language_id;
      return id === null ? null : (await h.db.selectFrom('languages').select('code_display').where('id', '=', id).executeTakeFirstOrThrow()).code_display;
    };
    expect([await lang(1), await lang(11), await lang(27), await lang(28)]).toEqual(['ind', 'eng', 'xx', null]);
    expect(real.report.some((r) => r[0] === 'mst_language' && r[1] === 'xx' && r[2] === 'language_unknown')).toBe(true);
    for (const id of fixture.expected.traps.hidden) expect(Number((await record(id)).opac_visible)).toBe(0);
    expect(Number((await record(14)).opac_visible)).toBe(1);
    expect(Number((await record(14)).promoted)).toBe(1);
    // SLiMS dates are the library's local time (Asia/Jakarta, UTC+7); zero dates → the migration time + a report row.
    const r1 = await record(1);
    expect([r1.created_at, r1.updated_at, r1.changed_at]).toEqual([Date.UTC(2019, 1, 11, 1, 0, 0), Date.UTC(2020, 1, 21, 2, 30, 0), NOW]);
    expect([(await record(9)).created_at, (await record(9)).updated_at]).toEqual([NOW, NOW]);
    expect(real.report.filter((r) => r[0] === 'biblio' && r[1] === '9' && r[2] === 'date_invalid')).toHaveLength(2);
    expect((await record(31)).publisher_id).toBeNull();
    expect(real.report.some((r) => r[0] === 'biblio' && r[1] === '31' && r[2] === 'publisher_missing')).toBe(true);
    expect((await h.db.selectFrom('publishers').select('name_display').where('id', '=', (await record(1)).publisher_id!).executeTakeFirstOrThrow()).name_display).toBe(
      'Bentang Pustaka',
    );
    // Biblio 5 has one author on each of the ten levels.
    const roles = await h.db
      .selectFrom('record_agents')
      .select(['role', 'is_main'])
      .where('record_id', '=', await target('biblio', 5))
      .orderBy('sort_order')
      .execute();
    expect(roles.map((r) => [r.role, Number(r.is_main)])).toEqual([
      ['aut', 1],
      ['aut', 0],
      ['edt', 0],
      ['trl', 0],
      ['drt', 0],
      ['pro', 0],
      ['cmp', 0],
      ['ill', 0],
      ['cre', 0],
      ['ctb', 0],
    ]);
    // Topic level 1 → primary; the links of a missing author and topic are skipped and reported.
    const primary = await h.db.selectFrom('record_subjects').select(['subject_id', 'is_primary']).where('record_id', '=', await target('biblio', 4)).execute();
    expect(primary.map((p) => [p.subject_id, Number(p.is_primary)]).sort()).toEqual(
      [
        [await target('mst_topic', 6), 1],
        [await target('mst_topic', 13), 0],
      ].sort(),
    );
    expect(real.report.some((r) => r[0] === 'biblio_author' && r[1] === '6|9999' && r[2] === 'author_missing')).toBe(true);
    expect(real.report.some((r) => r[0] === 'biblio_topic' && r[1] === '7|8888' && r[2] === 'topic_missing')).toBe(true);
    expect(real.report.some((r) => r[0] === 'biblio' && r[2] === 'column_not_mapped' && r[3]!.startsWith('uid'))).toBe(true);
  });

  it('masters: rooms of the target branch, collection types, suppliers SUP<id>, SRU servers disabled, barcode patterns', async () => {
    const rooms = await h.db.selectFrom('locations').select(['code_display', 'code_key', 'kind', 'name', 'parent_id']).where('branch_id', '=', branchId).orderBy('code_key').execute();
    expect(rooms).toEqual([
      { code_display: 'lt2', code_key: 'LT2', kind: 'room', name: 'Lantai 2', parent_id: null },
      { code_display: 'REF', code_key: 'REF', kind: 'room', name: 'Ruang Referensi', parent_id: null },
      { code_display: 'SL', code_key: 'SL', kind: 'room', name: 'My Library', parent_id: null },
    ]);
    expect(await target('mst_location', 'lt2')).toBe((await h.db.selectFrom('locations').select('id').where('code_key', '=', 'LT2').executeTakeFirstOrThrow()).id);
    const coll = await h.db.selectFrom('collection_types').select(['code_display', 'name_id']).where('id', '=', await target('mst_coll_type', 2)).executeTakeFirstOrThrow();
    expect(coll).toEqual({ code_display: 'TEXTBOOK', name_id: 'Textbook' });
    const sup = await h.db.selectFrom('suppliers').select(['code_display', 'name', 'phone', 'address']).where('id', '=', await target('mst_supplier', 1)).executeTakeFirstOrThrow();
    expect(sup).toEqual({ code_display: 'SUP1', name: 'CV Buku Kita', phone: '0211234567', address: 'Jl. Merdeka 1' });
    const settings = await readSettings(h.db, ['catalog.sru.servers', 'catalog.barcode.patterns'], []);
    const servers = settings['catalog.sru.servers'] as { id: string; url: string; enabled: boolean }[];
    expect(servers.filter((s) => s.url === 'http://opac.perpusnas.go.id/sru.aspx')).toEqual([expect.objectContaining({ enabled: false })]);
    expect(servers).toHaveLength(3);
    const patterns = settings['catalog.barcode.patterns'] as { prefix: string; digits: number; suffix: string }[];
    expect(patterns.map((p) => [p.prefix, p.digits, p.suffix])).toEqual([
      ['B', 7, ''],
      ['B', 5, ''],
      ['R', 4, 'S'],
    ]);
    expect(real.report.some((r) => r[0] === 'mst_servers' && r[1] === '2' && r[2] === 'server_not_migrated')).toBe(true);
    expect(real.report.some((r) => r[0] === 'setting' && r[2] === 'print_settings_not_migrated')).toBe(true);
  });

  it('relations: rel_biblio_id 0, self relations, dangling ones and the reciprocal duplicate are dropped', async () => {
    const pairs: [number, number][] = [];
    for (const [a, b] of fixture.expected.traps.relations.kept) {
      const rows = await h.db
        .selectFrom('record_relations')
        .select(['related_id', 'type'])
        .where('record_id', '=', await target('biblio', a))
        .execute();
      expect(rows).toEqual([{ related_id: await target('biblio', b), type: 'related' }]);
      pairs.push([a, b]);
    }
    expect(pairs).toHaveLength(4);
    expect(Number((await h.db.selectFrom('record_relations').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(4);
    expect(real.report.some((r) => r[0] === 'biblio_relation' && r[1] === '7|9001' && r[2] === 'record_missing')).toBe(true);
  });

  it('a re-run on the same source skips every mapped row as already_migrated and changes nothing', async () => {
    const before = await counts();
    const sum = await checksum();
    const again = await migrate(fixture.dumpPath, { allowNonEmpty: true, confirmLibraryName: libraryName });
    expect(again.status).toBe('succeeded');
    expectReconciled(again.summary, fixture);
    expect(tableCounts(again.summary, 'biblio')).toEqual({ source: 300, migrated: 0, merged: 0, skipped: { already_migrated: 300 }, archived: 0 });
    expect(tableCounts(again.summary, 'mst_author').skipped).toEqual({ already_migrated: 40 });
    expect(tableCounts(again.summary, 'biblio_author').skipped['already_migrated']).toBe(fixture.expected.tables['biblio_author']!.source - 1);
    const after = await counts();
    expect({ ...after, settings: 0 }).toEqual({ ...before, settings: 0 });
    expect(await checksum()).toBe(sum);
  }, 120_000);

  it("S13: a second library's dump under sourceName 'kampus' migrates all its records; its map rows carry kampus", async () => {
    const before = Number((await h.db.selectFrom('records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const kampus = await migrate(second.dumpPath, { sourceName: 'kampus', allowNonEmpty: true, confirmLibraryName: libraryName });
    expect(kampus.status).toBe('succeeded');
    expectReconciled(kampus.summary, second);
    expect(tableCounts(kampus.summary, 'biblio')).toEqual({ source: 300, migrated: 300, merged: 0, skipped: {}, archived: 0 });
    for (const table of READS) expect(tableCounts(kampus.summary, table)?.skipped['already_migrated'], table).toBeUndefined();
    const rows = await h.db.selectFrom('migration_map').select(['source', 'entity']).where('run_id', '=', kampus.runId).execute();
    expect(rows.length).toBeGreaterThan(300);
    for (const r of rows) expect(r.source).toBe('kampus');
    expect(Number((await h.db.selectFrom('records').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(before + 300);
    // The shared authorities of both libraries are merged, not created twice.
    expect(await target('mst_author', 1, 'kampus')).toBe(await target('mst_author', 1));
    expect((await record(1, 'kampus')).id).not.toBe((await record(1)).id);
  }, 120_000);

  // ---- resume ----------------------------------------------------------------------------------------------------

  /** Removes everything a migration wrote, back to the seeded masters. */
  async function wipe(): Promise<void> {
    await wipeCatalog(h);
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers', 'jobs', 'locks'] as const) await h.db.deleteFrom(table).execute();
    for (const table of ['material_types', 'languages', 'collection_types'] as const) await h.db.deleteFrom(table).where('id', 'not in', seedIds[table]).execute();
    await h.db.deleteFrom('settings').where('key', 'in', ['catalog.sru.servers', 'catalog.barcode.patterns']).execute();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.mkdir(dataDir, { recursive: true });
  }

  /** A label for every row id the migration made, so two runs compare without their random ids. */
  async function labels(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const r of await h.db.selectFrom('material_types').select(['id', 'code_key']).execute()) out.set(r.id, `mt:${r.code_key}`);
    for (const r of await h.db.selectFrom('languages').select(['id', 'code_key']).execute()) out.set(r.id, `lg:${r.code_key}`);
    for (const r of await h.db.selectFrom('collection_types').select(['id', 'code_key']).execute()) out.set(r.id, `ct:${r.code_key}`);
    for (const r of await h.db.selectFrom('publishers').select(['id', 'name_key']).execute()) out.set(r.id, `pb:${r.name_key}`);
    for (const r of await h.db.selectFrom('agents').select(['id', 'type', 'name_key']).execute()) out.set(r.id, `ag:${r.type}:${r.name_key}`);
    for (const r of await h.db.selectFrom('subjects').select(['id', 'type', 'term_key']).execute()) out.set(r.id, `sb:${r.type}:${r.term_key}`);
    for (const r of await h.db.selectFrom('locations').select(['id', 'code_key']).execute()) out.set(r.id, `lc:${r.code_key}`);
    for (const r of await h.db.selectFrom('suppliers').select(['id', 'code_key']).execute()) out.set(r.id, `sp:${r.code_key}`);
    for (const r of await h.db.selectFrom('custom_field_defs').select(['id', 'entity', 'code_key']).execute()) out.set(r.id, `cf:${r.entity}:${r.code_key}`);
    for (const r of await h.db.selectFrom('records').select(['id', 'source']).execute()) out.set(r.id, `rc:${r.source}`);
    for (const r of await h.db.selectFrom('catalog_runs').select('id').execute()) out.set(r.id, 'run');
    return out;
  }

  /** The legacy map without its random ids and run ids, sorted. */
  async function canonicalMap(): Promise<string[]> {
    const l = await labels();
    const rows = await h.db.selectFrom('migration_map').select(['source', 'entity', 'legacy_key', 'target_id']).execute();
    return rows.map((r) => `${r.source}|${r.entity}|${r.legacy_key}|${l.get(r.target_id) ?? '?'}`).sort();
  }

  /** SHA-256 of the sorted canonical rows of the records and everything they link to (ids replaced by labels). */
  async function checksum(): Promise<string> {
    const l = await labels();
    const id = (v: string | null) => (v === null ? null : (l.get(v) ?? `?${v}`));
    const lines: string[] = [];
    const push = (table: string, row: Record<string, unknown>) => lines.push(`${table}\t${JSON.stringify(row)}`);
    for (const r of await h.db.selectFrom('records').selectAll().execute()) {
      const { id: rid, material_type_id, publisher_id, language_id, version, ...rest } = r;
      push('records', { rid: id(rid), mt: id(material_type_id), pb: id(publisher_id), lg: id(language_id), version: Number(version), ...rest });
    }
    for (const r of await h.db.selectFrom('record_identifiers').selectAll().execute()) {
      const { id: _id, record_id, ...rest } = r;
      void _id;
      push('record_identifiers', { r: id(record_id), ...rest, is_valid: Number(rest.is_valid), sort_order: Number(rest.sort_order) });
    }
    for (const r of await h.db.selectFrom('record_agents').selectAll().execute()) {
      push('record_agents', { r: id(r.record_id), a: id(r.agent_id), role: r.role, main: Number(r.is_main), order: Number(r.sort_order) });
    }
    for (const r of await h.db.selectFrom('record_subjects').selectAll().execute()) {
      push('record_subjects', { r: id(r.record_id), s: id(r.subject_id), primary: Number(r.is_primary), order: Number(r.sort_order) });
    }
    for (const r of await h.db.selectFrom('record_relations').selectAll().execute()) push('record_relations', { r: id(r.record_id), to: id(r.related_id), type: r.type });
    for (const r of await h.db.selectFrom('custom_values').selectAll().execute()) push('custom_values', { f: id(r.field_id), e: id(r.entity_id), v: r.value });
    for (const r of await h.db.selectFrom('agents').selectAll().execute()) push('agents', { a: id(r.id), dates: r.dates, src: r.authority_source, name: r.name_display });
    for (const r of await h.db.selectFrom('subjects').selectAll().execute()) push('subjects', { s: id(r.id), cls: r.classification, scope: r.scope_note, term: r.term_display });
    for (const r of await h.db.selectFrom('subject_relations').selectAll().execute()) push('subject_relations', { s: id(r.subject_id), to: id(r.related_id), rel: r.rel });
    lines.sort();
    return createHash('sha256').update(lines.join('\n')).digest('hex');
  }

  it('records stopped mid-stage (small batches, one per slice) and killed after a committed batch, then resumed → the same legacy map and records checksum', async () => {
    await wipe();
    const whole = await migrate(fixture.dumpPath);
    expect(whole.status).toBe('succeeded');
    const wholeMap = await canonicalMap();
    const wholeSum = await checksum();
    expect(wholeMap.filter((m) => m.startsWith('slims|biblio|'))).toHaveLength(300);

    await wipe();
    __setSlimsStageBatch(23);
    // A dry run splits the dump in one slice; the real run adopts its work folder (S3) and starts after the split.
    const dry = await migrate(fixture.dumpPath, { dryRun: true });
    expect(dry.status).toBe('succeeded');
    // The records stage "dies" twice right after a batch committed and before its checkpoint was saved.
    let calls = 0;
    const crashing: SlimsStage = {
      name: recordsStage.name,
      reads: recordsStage.reads,
      async run(c, cursor) {
        const r = await recordsStage.run(c, cursor);
        calls += 1;
        if (calls === 3 || calls === 20) throw new Error('simulated crash after a committed batch');
        return r;
      },
    };
    const stepped = await migrate(fixture.dumpPath, { fromRunId: dry.runId }, [mastersStage, crashing, relationsStage], 2_000);
    expect([stepped.status, stepped.summary.warnings]).toEqual(['succeeded', []]);
    expect(stepped.end.retries).toBe(2);
    expect(stepped.end.slices).toBeGreaterThan(40);
    expect(await canonicalMap()).toEqual(wholeMap);
    expect(await checksum()).toBe(wholeSum);
    expectReconciled(stepped.summary, fixture);
    // The rows of the batches redone after the crashes are replays (this run mapped them): counted as their first
    // attempt counted them, never as already migrated (as stages B count theirs, Task 39), so the counts and the repairs
    // are the uninterrupted run's.
    expect(tableCounts(stepped.summary, 'biblio')).toEqual({ source: 300, migrated: 300, merged: 0, skipped: {}, archived: 0 });
    expect(stepped.summary.tables).toEqual(whole.summary.tables);
    expect(stepped.summary.fixes).toEqual(whole.summary.fixes);
  }, 300_000);
});
