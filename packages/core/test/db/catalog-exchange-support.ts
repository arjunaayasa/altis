import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withTx } from '@altis/db';
import { newId, normalizeKey, type Permission } from '@altis/shared';
import type { ExportBody, ImportBody } from '@altis/shared/api/catalog/exchange';
import { RUN_REPORT_MAX_ROWS, type RunRow } from '../../src/catalog/data/runs.js';
import { exportJob, startCatalogExport } from '../../src/catalog/exchange/export-job.js';
import { importJob, startCatalogImport } from '../../src/catalog/exchange/import-job.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobRegistry, SliceResult } from '../../src/jobs/types.js';
import { NOW, openRecordsDb, type RecordsDb } from './catalog-records-support.js';

// What the import and export tests of Phase 2 Task 31 share (catalog-import-{marc,csv,resume}.test.ts,
// catalog-export.test.ts): a migrated database (catalog-records-support.ts) with the import and export jobs, a staff
// user holding the import, export and items permissions (globally, or at the branches named), an import started the
// way the route starts one (its staged upload written straight into DATA_DIR) and run through the queue's claim path,
// and an export likewise; the stored report read back.

export const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

export interface ExchangeDb extends RecordsDb {
  deps: () => CatalogJobDeps;
  reg: JobRegistry;
  /** A staff user holding `catalog.import.run`, `catalog.export.run` and `catalog.items.manage` globally. */
  staff: Actor;
}

/** A staff user holding `global` everywhere and `byBranch` at each branch named; its actor. */
export async function seedImporter(db: RecordsDb, o: { global: Permission[]; byBranch?: Record<string, Permission[]> }): Promise<Actor> {
  const id = newId(NOW);
  const name = `importir_${id.slice(-8).toLowerCase()}`;
  await withTx(db.h, async (trx) => {
    await trx
      .insertInto('staff_users')
      .values({ id, username_key: normalizeKey(name), username_display: name, name, password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    const assign = async (permissions: Permission[], branchId: string | null): Promise<void> => {
      if (permissions.length === 0) return;
      const roleId = newId(NOW);
      await trx.insertInto('roles').values({ id: roleId, key: `t_${roleId}`, name: `Peran ${roleId}`, created_at: NOW, updated_at: NOW }).execute();
      await trx
        .insertInto('role_permissions')
        .values(permissions.map((permission) => ({ role_id: roleId, permission })))
        .execute();
      await trx
        .insertInto('user_roles')
        .values({ id: newId(NOW), user_id: id, role_id: roleId, branch_id: branchId, scope_key: branchId ?? '', created_at: NOW })
        .execute();
    };
    await assign(o.global, null);
    for (const [branchId, permissions] of Object.entries(o.byBranch ?? {})) await assign(permissions, branchId);
  });
  return { type: 'staff', id, ip: null };
}

/** A migrated database with the exchange jobs and an importer. */
export async function openExchangeDb(prefix: string): Promise<ExchangeDb> {
  const db = await openRecordsDb(prefix);
  const deps = (): CatalogJobDeps => ({
    dataDir: db.dataDir,
    baseUrl: 'https://perpus.example.sch.id',
    keyring: KEYRING,
    storage: localStorageDriver(db.dataDir),
    log: silent,
  });
  const staff = await seedImporter(db, { global: ['catalog.import.run', 'catalog.export.run', 'catalog.items.manage'] });
  return { ...db, deps, reg: createJobRegistry([importJob(deps), exportJob(deps)]), staff };
}

/** The import options of a test: nothing matched, nothing skipped, no items, a real run; `o` replaces any of them. */
export function importOptions(o: Partial<ImportBody> = {}): ImportBody {
  return { matchOn: 'none', onMatch: 'skip', onDuplicate: 'report', createItems: false, dryRun: false, ...o } as ImportBody;
}

/** Writes `bytes` as a completed staged upload's file; its (upload) id. */
export async function stageFile(db: RecordsDb, bytes: Uint8Array | string): Promise<string> {
  const id = newId(NOW);
  await fsp.mkdir(path.join(db.dataDir, 'tmp', id), { recursive: true });
  await fsp.writeFile(path.join(db.dataDir, 'tmp', id, 'upload.bin'), bytes);
  return id;
}

/** Claims and runs job `id` until it stops continuing, `budgetMs` per slice; the slices' outcomes. */
export async function drive(db: ExchangeDb, id: string, o: { budgetMs?: number; maxSlices?: number } = {}): Promise<SliceResult['outcome'][]> {
  const outcomes: SliceResult['outcome'][] = [];
  for (let i = 0; i < (o.maxSlices ?? 1000); i += 1) {
    const job = await claimById(db.h, db.reg, id, { worker: 'test', now: NOW });
    if (job === null) throw new Error(`job ${id} cannot be claimed`);
    const r = await runSlice(db.h, db.reg, job, { mode: 'worker', budgetMs: o.budgetMs ?? 20_000, keyring: KEYRING, log: silent, clock: () => NOW, env: {} });
    outcomes.push(r.outcome);
    if (r.outcome !== 'continued') return outcomes;
  }
  return outcomes;
}

/** A finished run: its row and its summary. */
export interface RunResult {
  runId: string;
  jobId: string;
  run: RunRow;
  summary: Record<string, unknown> & { read: number; created: number; updated: number; duplicates: number; itemsCreated: number; errors: number; skipped: Record<string, number>; warnings: string[] };
}

export async function runOf(db: RecordsDb, runId: string, jobId: string): Promise<RunResult> {
  const run = await db.h.db.selectFrom('catalog_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
  return { runId, jobId, run, summary: JSON.parse(run.summary) as RunResult['summary'] };
}

/** Starts an import of `bytes` with `options` as `actor` (default the db's importer) and runs it to its end. */
export async function importFile(
  db: ExchangeDb,
  bytes: Uint8Array | string,
  options: Partial<ImportBody> = {},
  o: { actor?: Actor; budgetMs?: number } = {},
): Promise<RunResult> {
  const stagingId = await stageFile(db, bytes);
  const body = importOptions({ uploadId: stagingId, ...options });
  const input = { body, stagingId };
  const started = await withTx(db.h, (trx) => startCatalogImport(txCtx(trx, NOW, o.actor ?? db.staff), db.reg, input, { keyring: KEYRING }));
  await drive(db, started.jobId, { budgetMs: o.budgetMs ?? 20_000 });
  return runOf(db, started.runId, started.jobId);
}

/** Starts an export of `body` and runs it to its end; its run and the file's bytes (null without a file). */
export async function exportFile(db: ExchangeDb, body: ExportBody, o: { budgetMs?: number } = {}): Promise<RunResult & { bytes: Buffer | null }> {
  const started = await withTx(db.h, (trx) => startCatalogExport(txCtx(trx, NOW, db.staff), db.reg, body, { keyring: KEYRING }));
  await drive(db, started.jobId, { budgetMs: o.budgetMs ?? 20_000 });
  const result = await runOf(db, started.runId, started.jobId);
  const name = result.run.output_name;
  const bytes = name === null ? null : await fsp.readFile(path.join(db.dataDir, 'exports', name));
  return { ...result, bytes };
}

/** The data rows of the stored report of `run` (CSV, `,`, every cell quoted; no line break in our cells). */
export async function reportRows(db: RecordsDb, run: RunRow): Promise<string[][]> {
  if (run.report_file_id === null) throw new Error('the run has no report');
  const stream = await localStorageDriver(db.dataDir).get(run.report_file_id);
  if (stream === null) throw new Error('the report file is gone');
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  const text = Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\r\n').filter((l) => l !== '');
  const cells = (line: string): string[] => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"').replace(/^'(?=[=+\-@])/, ''));
  return lines.slice(1, RUN_REPORT_MAX_ROWS + 2).map(cells);
}
