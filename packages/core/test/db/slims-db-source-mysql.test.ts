import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { openForeignMysql, PHASE1_MIGRATIONS, runMigrations, withTx, type ForeignMysql } from '@altis/db';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  emptyDatabase,
  ENGINE_SPECS,
  engineLabel,
  TEST_DB_PASSWORD,
  TEST_DB_ROOT_PASSWORD,
  TEST_DB_USER,
  testDb,
  testDbContext,
  testDbHost,
  type TestDbHandle,
} from '../../../../tools/test/test-db.js';
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
import { writeSettings } from '../../src/settings/service.js';
import { wipeCatalog } from '../support/search-corpus.js';
import { loadMysqlDump, mysqlSlimsFixture, renderDumpInOrder, type MysqlDumpSplit, type MysqlSlimsFixture } from '../support/slims-fixture-mysql.js';
import { FIXTURE_TABLES, SLIMS_FIXTURE_SEED } from '../support/slims-fixture/index.js';

// The SLiMS migration read straight from a MySQL server (the direct-connection source, db-source.ts over @altis/db's
// foreign client) against the same SLiMS read from its dump, on MySQL only (ALTIS_TEST_DB=mysql80 or mysql84: the test
// server is both the SLiMS source and the ALTIS target):
//
// - the synthetic fixture with its usage rows (member types, members, loans, visits) and five member photos is loaded
//   from its own dump into a fresh database `slims_src_<random>` (as root; the migration reads it as the test user,
//   granted SELECT only), every table with the fixture's row count and no warning from the server;
// - the real job migrates it twice into a fresh ALTIS database each time, from the dump (staged upload) and from the
//   database, with the same SLiMS folder (`--files-dir`: the fixture's files and `images/persons/`). Some stages
//   depend on the order rows come in (the first level-1 author of a record is its main entry, links are numbered as
//   they come, the first of two duplicate authorities is kept). The author and subject links (`biblio_author`,
//   `biblio_topic`) keep the fixture's own order, the order they were entered in and out of key order, on both paths:
//   the fixture's tables are MyISAM, which gives its rows in that order, and the database source reads those two
//   tables in the table's own order, as mysqldump does. Every other table the dump path migrates has its rows in the
//   server's primary-key order, the order the database source reads it in (the fixture lists a few out of key order);
// - both runs end with the same rows in every ALTIS table the migration writes (ids replaced by stable names), the same
//   legacy map, counts, report rows and summary, the same members, copies, titles and photos; the member photos are
//   stored (two), or reported (not a JPEG, missing, too large) alike.
//
// The differences the two paths are allowed, each asserted as it is before the comparison sets it aside:
//
// - A latin1 table: the server converts its text to the connection's utf8mb4, so the database path never sees the
//   Windows-1252 bytes the dump holds; the dump path decodes them itself and counts the repair (`fixes`, `samples`,
//   the charset sample, and a sample row of the report, so the report is longer). The text that lands in ALTIS is the
//   same.
// - A table a stage reads that has no primary key on the server: the database source pages it by offset and the report
//   says so (`no_pk`); the dump path reads its staged rows and has no such row.

const ctx = testDbContext();
const MYSQL = ctx.engine === 'mysql80' || ctx.engine === 'mysql84';
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
/** In the past: an audit entry may not be dated ahead of the real clock. Every run's clock stands here. */
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const LIBRARY = 'Perpustakaan Sumber Langsung';
const BRANCH_ID = newId(NOW);
const STAFF_ID = newId(NOW);

/**
 * The cells of the fixture no MySQL server could have dumped, made what the server stores (slims-fixture-mysql.ts):
 * a fixture change that adds one must be looked at.
 */
const ADJUSTMENTS = ['cut biblio.isbn_issn', 'trailing_spaces mst_content_type.code2'];

/** The SLiMS tables both paths read in the order their rows were entered (see the top of this file). */
const ENTERED_ORDER = ['biblio_author', 'biblio_topic'];

/** ALTIS tables a migration does not write, or whose rows are bookkeeping of the run itself (ids, clocks, chains). */
const NOT_COMPARED = new Set([
  'locks',
  'sessions',
  'remember_tokens',
  'password_resets',
  'rate_limits',
  'audit_log',
  'audit_head',
  'jobs',
  'schedules',
  'events',
  'event_consumers',
  'notifications',
  'notification_reads',
  'idempotency_keys',
  'upload_sessions',
  'license_state',
  'releases_log',
  'backups',
  'schema_tables',
  'schema_meta',
  'schema_migrations',
  'schema_migrations_lock',
  'schema_migrations_edition',
  'schema_migrations_edition_lock',
  'catalog_runs',
  'report_runs',
  'search_term',
  'search_state',
]);

/** A whole ULID, and a ULID inside a text (a `/files/<id>` link of a page, a facet's value). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID_IN_TEXT = /[0-9A-HJKMNP-TV-Z]{26}/g;

type Row = Record<string, unknown>;

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** A cell the foreign client read, as text (it hands text over as bytes). */
const cellText = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/** A row as JSON (bytes as hex, big integers as numbers), to find the rows the target was prepared with. */
const rawJson = (row: Row): string =>
  JSON.stringify(row, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : typeof v === 'bigint' ? Number(v) : v));

/** Two numeric primary keys compared column by column. */
function compareKeys(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** The rows only `a`, and only `b`, hold (as multisets), at most `limit` of each. */
function differences(a: readonly string[], b: readonly string[], limit = 5): { onlyDump: string[]; onlyDb: string[] } | null {
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  const onlyDb: string[] = [];
  for (const x of b) {
    const n = count.get(x) ?? 0;
    if (n > 0) count.set(x, n - 1);
    else onlyDb.push(x);
  }
  const onlyDump = [...count].flatMap(([x, n]) => Array.from({ length: n }, () => x));
  if (onlyDump.length === 0 && onlyDb.length === 0) return null;
  return { onlyDump: onlyDump.slice(0, limit), onlyDb: onlyDb.slice(0, limit) };
}

describe.skipIf(!ctx.available || !MYSQL)(`SLiMS migration from a MySQL database, against its dump [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let slimsDir: string;
  let dataDir: string;
  let fixture: MysqlSlimsFixture;
  let admin: ForeignMysql | null = null;
  let loaded: MysqlDumpSplit & { warnings: string[] };
  /** The dump the dump path migrates (gzip): the fixture's rows in the server's primary-key order. */
  let orderedDumpGz: Buffer;
  /** The tables whose rows that order moved. */
  let reordered: string[];
  /** The tables a stage reads that have no primary key on the server (sorted). */
  let keyless: string[];
  const sourceDb = `slims_src_${randomBytes(4).toString('hex')}`;
  const port = ENGINE_SPECS[ctx.engine].port ?? 0;
  const staff: Actor = { type: 'staff', id: STAFF_ID, ip: null };
  /** What the job logged as warnings and errors (shown when a run does not succeed). */
  const logged: string[] = [];
  const log: CoreLogger = {
    info() {},
    warn(message, fields) {
      logged.push(`warn ${message} ${JSON.stringify(fields ?? {})}`);
    },
    error(message, fields) {
      logged.push(`error ${message} ${JSON.stringify(fields ?? {})}`);
    },
  };
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-dbsrc-')));
    fixture = mysqlSlimsFixture(SLIMS_FIXTURE_SEED);
    // The SLiMS folder the CLI's --files-dir names: the fixture's files and the member photos.
    slimsDir = path.join(root, 'slims');
    for (const f of fixture.files) {
      await fsp.mkdir(path.dirname(path.join(slimsDir, f.rel)), { recursive: true });
      await fsp.writeFile(path.join(slimsDir, f.rel), f.data);
    }
    // The SLiMS database: created and filled as root, read by the migration as the test user (SELECT only).
    const server = { host: testDbHost(), port, user: 'root', password: TEST_DB_ROOT_PASSWORD, tls: false };
    admin = await openForeignMysql({ ...server, database: 'mysql' }, { connectTimeoutMs: 10_000 });
    await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [sourceDb]);
    const loader = await openForeignMysql({ ...server, database: sourceDb }, { connectTimeoutMs: 10_000 });
    try {
      loaded = await loadMysqlDump(loader, fixture.dump);
    } finally {
      await loader.close();
    }
    await admin.query(`GRANT SELECT ON ??.* TO ?@'%'`, [sourceDb, TEST_DB_USER]);
    // The rows of each table with a key in the order the database source reads them (the links in their own order).
    const order = new Map<string, string[]>();
    for (const t of FIXTURE_TABLES) {
      if (t.primaryKey.length === 0 || (fixture.data.rows.get(t.name)?.length ?? 0) === 0 || ENTERED_ORDER.includes(t.name)) continue;
      const list = t.primaryKey.map(() => '??').join(', ');
      const keys = await admin.query(`SELECT ${list} FROM ??.?? ORDER BY ${list}`, [...t.primaryKey, sourceDb, t.name, ...t.primaryKey]);
      order.set(t.name, keys.map((r) => t.primaryKey.map((c) => cellText(r[c])).join('\u0000')));
    }
    // The tables a stage reads that the server holds without a primary key.
    const keyed = new Set(
      (await admin.query("SELECT DISTINCT TABLE_NAME AS t FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY'", [sourceDb])).map((r) => cellText(r['t'])),
    );
    keyless = FIXTURE_TABLES.map((t) => t.name)
      .filter((t) => !keyed.has(t) && fixture.expected.roles.read.includes(t))
      .sort();
    const ordered = renderDumpInOrder(fixture.data, order);
    orderedDumpGz = gzipSync(ordered.dump);
    reordered = ordered.reordered;
    // The real sources and stages: no test seam replaces any of them.
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  }, 300_000);

  afterAll(async () => {
    if (h !== undefined) await h.close();
    if (admin !== null) {
      await admin.query(`REVOKE SELECT ON ??.* FROM ?@'%'`, [sourceDb, TEST_DB_USER]).catch(() => undefined);
      await admin.query('DROP DATABASE IF EXISTS ??', [sourceDb]);
      await admin.close();
    }
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  }, 120_000);

  // ---- the target ------------------------------------------------------------------------------------------------

  /** The tables compared, and the rows of each as the target was prepared (before any migration). */
  interface Prepared {
    tables: string[];
    seedRows: Map<string, Set<string>>;
    /** id → the row as prepared. */
    seedById: Map<string, Row>;
  }

  async function readTables(tables: readonly string[]): Promise<Record<string, Row[]>> {
    const out: Record<string, Row[]> = {};
    for (const t of tables) out[t] = (await h.db.selectFrom(t as 'records').selectAll().execute()) as unknown as Row[];
    return out;
  }

  /**
   * A fresh ALTIS database (`label` names its data folder): migrated, the catalogue emptied as the end-to-end test does,
   * one branch and one staff user of fixed ids, the attachment size limit of the fixture's oversized file.
   */
  async function prepareTarget(label: string): Promise<Prepared> {
    await emptyDatabase(h);
    const base = path.join(root, label);
    dataDir = path.join(base, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(base, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await wipeCatalog(h);
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers'] as const) await h.db.deleteFrom(table).execute();
    await h.db
      .insertInto('branches')
      .values({ id: BRANCH_ID, code_key: 'LANGSUNG', code_display: 'LANGSUNG', name: LIBRARY, timezone: 'Asia/Jakarta', is_default: 0, created_at: NOW, updated_at: NOW })
      .execute();
    await h.db
      .insertInto('staff_users')
      .values({ id: STAFF_ID, username_key: 'MIGRATOR-DBSRC', username_display: 'migrator-dbsrc', name: 'migrator', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': LIBRARY }, { now: NOW, actorId: null, keyring: [] }));
    const tables = (await h.db.introspection.getTables())
      .filter((t) => !t.isView)
      .map((t) => t.name)
      .filter((t) => !NOT_COMPARED.has(t))
      .sort();
    const rows = await readTables(tables);
    const seedRows = new Map<string, Set<string>>();
    const seedById = new Map<string, Row>();
    for (const t of tables) {
      seedRows.set(t, new Set(rows[t]!.map(rawJson)));
      for (const r of rows[t]!) if (typeof r['id'] === 'string') seedById.set(r['id'], r);
    }
    return { tables, seedRows, seedById };
  }

  /** `bytes` as a staged upload (`tmp/<id>/upload.bin`), its id. */
  async function staged(bytes: Buffer): Promise<string> {
    const id = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    return id;
  }

  /** Runs job `id` slice by slice until it ends (20 s per slice). */
  async function runToEnd(id: string): Promise<string> {
    for (let slices = 1; slices <= 3000; slices += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring, log, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 3000 slices');
  }

  // ---- what a run left -------------------------------------------------------------------------------------------

  interface Outcome {
    summary: MigrationSummary;
    /** The stages' report rows (after the framework's own rows), sorted. */
    rows: string[][];
    /** Per compared table, its rows without random ids (the rows the target was prepared with left out), sorted. */
    snapshot: Record<string, string[]>;
    /** Rows per compared table, and per entity of the legacy map. */
    counts: { tables: Record<string, number>; entities: Record<string, number> };
    fingerprint: { members: string[]; items: string[]; records: string[]; loans: number; visits: number; photos: string[] };
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

  /**
   * The ALTIS tables as a run left them, without their random ids: every id is named by the first legacy key that maps
   * to it (`biblio:7`, `member:SIS-0001`), by its code (`member_types:SISWA`), or else by its table and a hash of its
   * row with the ids it refers to named the same way (four rounds: every id starts as `<table>#?`, so two databases
   * name alike whatever their ids). The rows the target was prepared with are left out, and the creation and update
   * times of a prepared row the run changed stand as `<seed>`.
   */
  async function snapshot(prepared: Prepared): Promise<Pick<Outcome, 'snapshot' | 'counts'>> {
    const rows = await readTables(prepared.tables);
    rows['files'] = rows['files']!.filter((f) => f['context'] !== 'catalog.report');
    const fixed = new Map<string, string>();
    const maps = [...rows['migration_map']!].sort((a, b) => {
      const x = `${String(a['entity'])}\u0000${String(a['legacy_key'])}`;
      const y = `${String(b['entity'])}\u0000${String(b['legacy_key'])}`;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const m of maps) if (!fixed.has(String(m['target_id']))) fixed.set(String(m['target_id']), `${String(m['entity'])}:${String(m['legacy_key'])}`);
    for (const t of prepared.tables) {
      for (const r of rows[t]!) {
        if (typeof r['id'] === 'string' && typeof r['code_key'] === 'string' && !fixed.has(r['id'])) fixed.set(r['id'], `${t}:${r['code_key']}`);
      }
    }
    for (const r of await h.db.selectFrom('catalog_runs').select('id').execute()) fixed.set(r.id, 'run');
    fixed.set(BRANCH_ID, 'branch');
    fixed.set(STAFF_ID, 'staff');

    const canon = (t: string, row: Row, names: ReadonlyMap<string, string>): string => {
      const seed = typeof row['id'] === 'string' ? prepared.seedById.get(row['id']) : undefined;
      const value = (k: string, v: unknown): unknown => {
        if ((k === 'created_at' || k === 'updated_at') && seed !== undefined && seed[k] === v) return '<seed>';
        if (typeof v === 'string') {
          const named = names.get(v) ?? v.replace(ULID_IN_TEXT, (u) => names.get(u) ?? u);
          // A document's texts as sets of words (the end-to-end test's rule).
          return t === 'search_doc' && k.startsWith('t_') ? named.split(' ').sort().join(' ') : named;
        }
        if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
        if (typeof v === 'bigint') return Number(v);
        return v;
      };
      return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'id' && k !== 'doc_no').map(([k, v]) => [k, value(k, v)])));
    };
    let names = new Map(fixed);
    for (const t of prepared.tables) for (const r of rows[t]!) if (typeof r['id'] === 'string' && ULID.test(r['id']) && !fixed.has(r['id'])) names.set(r['id'], `${t}#?`);
    for (let round = 0; round < 4; round += 1) {
      const next = new Map(fixed);
      for (const t of prepared.tables) {
        for (const r of rows[t]!) {
          if (typeof r['id'] === 'string' && !fixed.has(r['id'])) next.set(r['id'], `${t}#${sha256(canon(t, r, names)).slice(0, 16)}`);
        }
      }
      names = next;
    }

    const out: Record<string, string[]> = {};
    const tables: Record<string, number> = {};
    for (const t of prepared.tables) {
      const seeds = prepared.seedRows.get(t)!;
      tables[t] = rows[t]!.length;
      out[t] = rows[t]!.filter((r) => !seeds.has(rawJson(r))).map((r) => canon(t, r, names)).sort();
    }
    out['migration_map'] = maps.map((m) => `${String(m['source'])}|${String(m['entity'])}|${String(m['legacy_key'])}|${names.get(String(m['target_id'])) ?? '?'}`);
    const entities: Record<string, number> = {};
    for (const m of maps) entities[String(m['entity'])] = (entities[String(m['entity'])] ?? 0) + 1;
    return { snapshot: out, counts: { tables, entities } };
  }

  /** The members, copies, titles, loans, visits and member photos a run left (the photo's stored bytes hashed again). */
  async function fingerprint(): Promise<Outcome['fingerprint']> {
    const photos: string[] = [];
    const stored = await h.db
      .selectFrom('files as f')
      .innerJoin('members as m', 'm.photo_file_id', 'f.id')
      .select(['f.id', 'f.sha256', 'f.size', 'f.mime', 'f.context', 'f.owner_id', 'm.id as member_id', 'm.member_no_display'])
      .execute();
    for (const p of stored) {
      const chunks: Buffer[] = [];
      for await (const c of (await localStorageDriver(dataDir).get(p.id))!) chunks.push(Buffer.from(c));
      const bytes = Buffer.concat(chunks);
      expect([p.member_no_display, p.context, p.mime, p.owner_id === p.member_id, sha256(bytes), bytes.length]).toEqual([
        p.member_no_display,
        'members.photo',
        'image/jpeg',
        true,
        p.sha256,
        Number(p.size),
      ]);
      photos.push(`${p.member_no_display}|${p.sha256}|${String(p.size)}`);
    }
    const count = async (t: 'loans' | 'visits'): Promise<number> =>
      Number((await h.db.selectFrom(t).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    return {
      members: (await h.db.selectFrom('members').select(['member_no_key', 'name']).execute()).map((m) => `${m.member_no_key}|${m.name}`).sort(),
      items: (await h.db.selectFrom('items').select('barcode_key').execute()).map((i) => i.barcode_key).sort(),
      records: (await h.db.selectFrom('records').select('title').execute()).map((r) => r.title).sort(),
      loans: await count('loans'),
      visits: await count('visits'),
      photos: photos.sort(),
    };
  }

  /** Migrates the fixture into a fresh target from `source`, and what the run left. */
  async function migrate(source: 'dump' | 'db'): Promise<Outcome> {
    const prepared = await prepareTarget(source);
    logged.length = 0;
    const input: SlimsStartInput = {
      dryRun: false,
      sourceKind: source,
      db: source === 'db' ? { host: testDbHost(), port, user: TEST_DB_USER, database: sourceDb, tls: false } : null,
      password: source === 'db' ? TEST_DB_PASSWORD : null,
      dumpStagingId: source === 'dump' ? await staged(orderedDumpGz) : null,
      files: 'dir',
      filesStagingId: null,
      filesDir: slimsDir,
      branchId: BRANCH_ID,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      confirmLibraryName: null,
      fromRunId: null,
    };
    const { runId, jobId } = await withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, staff), registry, input, { keyring }));
    const outcome = await runToEnd(jobId);
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary', 'report_file_id']).where('id', '=', runId).executeTakeFirstOrThrow();
    if (outcome !== 'succeeded' || run.status !== 'succeeded') {
      const job = await h.db.selectFrom('jobs').select(['status', 'last_error']).where('id', '=', jobId).executeTakeFirst();
      const warnings = (JSON.parse(run.summary) as Partial<MigrationSummary>).warnings ?? [];
      throw new Error(
        `the ${source} run ended ${outcome} (run ${run.status}, job ${job?.status ?? '?'}: ${job?.last_error ?? '-'}); warnings ${JSON.stringify(warnings)}; logged ${JSON.stringify(logged.slice(0, 10))}`,
      );
    }
    const rows = await reportRows(run.report_file_id);
    const end = rows.findIndex((r) => r[2] === 'phase3_tables');
    expect(end, 'the report has the framework rows').toBeGreaterThan(0);
    return {
      summary: JSON.parse(run.summary) as MigrationSummary,
      rows: rows.slice(end + 1).sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1)),
      ...(await snapshot(prepared)),
      fingerprint: await fingerprint(),
    };
  }

  // ---- the expected differences ------------------------------------------------------------------------------------

  /** The summary without the latin1 repairs only the dump path counts (see the top of this file). */
  function withoutLatin1Repairs(s: MigrationSummary): MigrationSummary {
    const fixes = Object.fromEntries(
      Object.entries(s.fixes)
        .map(([column, kinds]) => [column, Object.fromEntries(Object.entries(kinds).filter(([kind]) => kind !== 'cp1252'))] as const)
        .filter(([, kinds]) => Object.keys(kinds).length > 0),
    );
    const charset = s.charset.map((c) => (c.cp1252 === 0 ? c : { ...c, utf8: c.utf8 + c.cp1252, cp1252: 0, samples: c.mojibake === 0 ? [] : c.samples }));
    return { ...s, fixes, samples: s.samples.filter((x) => x.fix !== 'cp1252'), charset };
  }

  /**
   * What two runs must have the same of: the random check sample apart (each of its 20 pairs must match; the titles it
   * drew, `checkSource`, differ per run), and the report's size, which the dump path's Windows-1252 sample row changes.
   */
  function comparable(s: MigrationSummary): Record<string, unknown> {
    // The stored summary carries the pipeline's own fields beside the API's: the drawn titles and where to resume.
    type Stored = MigrationSummary & { checkSource: Record<string, string>; resume: Record<string, unknown> & { reportBytes: number } };
    const { checks, checkSource, resume, ...rest } = withoutLatin1Repairs(s) as Stored;
    expect(Object.keys(checkSource), 'the check sample names a record per pair').toHaveLength(checks.length);
    const { reportBytes, ...place } = resume;
    expect(reportBytes, 'the report was written').toBeGreaterThan(0);
    return { ...rest, resume: place, checks: { pairs: checks.length, matching: checks.filter((c) => c.matches).length } };
  }

  // -----------------------------------------------------------------------------------------------------------------

  it('the fixture dump loads into a MySQL database as the fixture holds it', async () => {
    expect(fixture.adjustments, 'cells of the fixture a MySQL server would store differently').toEqual(ADJUSTMENTS);
    expect(loaded.warnings, 'server warnings while the dump was loaded').toEqual([]);
    expect(loaded.skipped.map((s) => /TRIGGER/.test(s)), 'only the trigger block is skipped').toEqual([true]);
    expect(loaded.names).toEqual(['utf8mb4', 'latin1', 'utf8mb4']);
    const counts: Record<string, number> = {};
    const want: Record<string, number> = {};
    for (const [table, { source }] of Object.entries(fixture.expected.tables)) {
      counts[table] = Number((await admin!.query('SELECT COUNT(*) AS n FROM ??.??', [sourceDb, table]))[0]?.['n']);
      want[table] = source;
    }
    expect(counts, 'rows per SLiMS table in MySQL').toEqual(want);
    // The tables the fixture lists out of key order (the dump path migrates them in key order, see the top).
    expect(reordered.every((t) => fixture.expected.tables[t] !== undefined)).toBe(true);
    // The links: MyISAM tables, as the fixture creates them, whose rows the fixture lists out of key order.
    for (const t of ENTERED_ORDER) {
      const [info] = await admin!.query('SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [sourceDb, t]);
      expect([t, cellText(info?.['engine'])]).toEqual([t, 'MyISAM']);
      const key = FIXTURE_TABLES.find((x) => x.name === t)!.primaryKey;
      const rows = fixture.data.rows.get(t)!;
      const outOfOrder = rows.filter((r, i) => i > 0 && compareKeys(key.map((c) => r[c]), key.map((c) => rows[i - 1]![c])) < 0).length;
      expect(outOfOrder, `${t}: rows the fixture lists out of key order`).toBeGreaterThan(0);
    }
    // The latin1 table's Windows-1252 text arrived as the same characters.
    for (const t of fixture.expected.traps.cp1252) {
      const key = FIXTURE_TABLES.find((x) => x.name === t.table)!.primaryKey;
      expect(key, `${t.table}'s primary key`).toHaveLength(1);
      const [row] = await admin!.query('SELECT ?? AS v FROM ??.?? WHERE ?? = ?', [t.column, sourceDb, t.table, key[0], t.key]);
      const v = row?.['v'];
      expect([t.table, t.key, Buffer.isBuffer(v) ? v.toString('utf8') : v]).toEqual([t.table, t.key, t.clean]);
    }
  }, 120_000);

  let viaDump: Outcome;
  let viaDb: Outcome;

  it('migrates the dump (staged upload) with the SLiMS folder', async () => {
    viaDump = await migrate('dump');
    expect(viaDump.summary.reconciliation?.ok, 'dump path: reconciliation').toBe(true);
    expect(viaDump.summary.tables['biblio']).toMatchObject({ source: 300, migrated: 300 });
    expect(viaDump.fingerprint.members.length, 'dump path: members migrated').toBeGreaterThan(0);
  }, 600_000);

  it('migrates the database (as the test user, SELECT only) with the same SLiMS folder', async () => {
    viaDb = await migrate('db');
    expect(viaDb.summary.reconciliation?.ok, 'database path: reconciliation').toBe(true);
    expect(viaDb.summary.tables['biblio']).toMatchObject({ source: 300, migrated: 300 });
  }, 600_000);

  it('both paths leave the same catalogue, members, circulation, legacy map, counts and report', () => {
    expect(viaDump, 'the dump run').toBeDefined();
    expect(viaDb, 'the database run').toBeDefined();
    const derived = fixture.expected.roles.derived;

    // The expected differences, as they are.
    const latin1 = new Set(fixture.expected.traps.cp1252.map((t) => `${t.table}.${t.column}`));
    const cp1252Fixes = (s: MigrationSummary): string[] => Object.entries(s.fixes).filter(([, kinds]) => (kinds['cp1252'] ?? 0) > 0).map(([column]) => column).sort();
    // The dump path repairs Windows-1252 bytes only in the latin1 table's columns (the database path never sees any).
    expect(cp1252Fixes(viaDump.summary).filter((c) => !latin1.has(c)), 'dump path: Windows-1252 repairs outside the latin1 table').toEqual([]);
    expect(viaDump.summary.charset.filter((c) => c.cp1252 > 0 && !latin1.has(c.column))).toEqual([]);
    expect(cp1252Fixes(viaDb.summary), 'database path: no Windows-1252 repair (the server converts latin1)').toEqual([]);
    expect(viaDb.summary.samples.filter((x) => x.fix === 'cp1252')).toEqual([]);
    expect(viaDb.summary.charset.filter((c) => c.cp1252 > 0)).toEqual([]);
    // The derived tables are listed with the rows they hold on both paths.
    expect(derived.length).toBeGreaterThan(0);
    for (const t of derived) {
      expect([t, viaDump.summary.tables[t]?.source, viaDb.summary.tables[t]?.source]).toEqual([t, fixture.expected.tables[t]!.source, fixture.expected.tables[t]!.source]);
    }
    // `no_pk`: on the database path only, for each table a stage reads that has no primary key on the server.
    const noPk = (o: Outcome): string[] => o.rows.filter((r) => r[2] === 'no_pk').map((r) => r[0]!);
    expect(noPk(viaDump), 'dump path: no_pk rows').toEqual([]);
    expect(noPk(viaDb), 'database path: no_pk rows').toEqual(keyless);

    // Every comparison is reported, not only the first that fails: counts (the clearest), the fingerprint, the
    // report, the summary, every row.
    expect.soft(viaDb.counts, 'rows per ALTIS table and per legacy-map entity').toEqual(viaDump.counts);
    expect.soft(viaDb.fingerprint, 'members, copies, titles, loans, visits, photos').toEqual(viaDump.fingerprint);
    // The report lists the dump path's Windows-1252 repairs as samples; the database path has none (above).
    const cp1252Sample = (r: readonly unknown[]): boolean => r[2] === 'sample' && typeof r[3] === 'string' && / \[cp1252\]: /.test(r[3]);
    expect(viaDump.rows.filter(cp1252Sample).map((r) => r[0]), 'dump path: Windows-1252 samples, of the latin1 table only').toEqual(
      [...new Set(fixture.expected.traps.cp1252.map((t) => t.table))].sort(),
    );
    const reportRows = (o: Outcome): string[] => o.rows.filter((r) => !cp1252Sample(r) && r[2] !== 'no_pk').map((r) => JSON.stringify(r));
    expect.soft(differences(reportRows(viaDump), reportRows(viaDb), 20), 'report rows').toBeNull();
    expect.soft(comparable(viaDb.summary), 'summary').toEqual(comparable(viaDump.summary));
    const tables = [...new Set([...Object.keys(viaDump.snapshot), ...Object.keys(viaDb.snapshot)])].sort();
    const diff: Record<string, unknown> = {};
    for (const t of tables) {
      const d = differences(viaDump.snapshot[t] ?? [], viaDb.snapshot[t] ?? []);
      if (d !== null) diff[t] = d;
    }
    expect.soft(diff, 'rows only one path left, per ALTIS table').toEqual({});
  });

  it('member photos from images/persons/: stored, or reported, alike on both paths', async () => {
    for (const [label, o] of [
      ['dump', viaDump],
      ['database', viaDb],
    ] as const) {
      expect(o, `the ${label} run`).toBeDefined();
      const stored = fixture.photos.filter((p) => p.outcome === 'stored');
      expect(o.fingerprint.photos, `${label} path: stored photos`).toEqual(
        stored.map((p) => `${p.memberId}|${sha256(p.bytes!)}|${p.bytes!.length}`).sort(),
      );
      const reported = o.rows.filter((r) => r[2] === 'missing_photo');
      const rel = (p: { image: string }): string => `images/persons/${p.image}`;
      const detail: Record<string, (p: { image: string }) => string> = {
        not_jpeg: (p) => `${rel(p)}: bukan JPEG / not a JPEG`,
        missing: rel,
        too_large: (p) => `${rel(p)} > 500 KB`,
      };
      expect(reported, `${label} path: photos reported`).toEqual(
        fixture.photos
          .filter((p) => p.outcome !== 'stored')
          .map((p) => ['member', p.memberId, 'missing_photo', detail[p.outcome]!(p)])
          .sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1)),
      );
    }
  });
});
