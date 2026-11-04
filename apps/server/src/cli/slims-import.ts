import path from 'node:path';
import {
  SLICE_BUDGET_MS,
  claimById,
  closeJobSessions,
  createJobRegistry,
  getRun,
  liveSlimsMigration,
  readMaintenance,
  releaseEndedRunWork,
  runSlice,
  startSlimsMigration,
  txCtx,
  type Actor,
  type SlimsDbTarget,
} from '@altis/core';
import { connect, withTx } from '@altis/db';
import { copyOperatorFile, dataPath, isEnvSet, realPathOf, removeTree, type Env } from '@altis/platform';
import { DomainError, newId, normalizeKey } from '@altis/shared';
import { SlimsDbSource } from '@altis/shared/api/catalog/migration';
import type { AppState } from '../app.js';
import { loadConfig } from '../config.js';
import type { BootContext } from '../index.js';
import { bindJobHandlers, jobHandlers, jobWorkerName, testClockOffsetMs } from '../jobs/runtime.js';
import { createLogger } from '../logger.js';
import { createAppOps } from '../services.js';
import { CliError } from './common.js';
import { notInstalled } from './migrate.js';

// `node app.js slims:import (--db <host:port/db> --user <u> | --dump <file>) [--files-zip <zip> | --files-dir <folder>]
// [--branch <code>] [--price-mode major|minor|skip] [--dry-run] [--allow-non-empty] [--json]` (spec §11, §12.6; Phase 2
// Task 23, preflight M15): migrates a SLiMS catalogue through the same job a server runs.
//
// 1. Before anything is written: the database password from `ALTIS_SLIMS_DB_PASSWORD`, else a prompt without echo at
//    the terminal (never an argument: cli/index.ts refuses `--password`); with `--allow-non-empty` the library's name
//    typed at the terminal (the start compares it, D2-25); `--files-dir` resolved to its real path, which must be a
//    folder (the job reads entries under it only, Task 10's openFilesDir); `--branch` a branch's code, default the
//    default branch.
// 2. A migration that is already live (queued or running, from the server or another command) is joined: this command
//    copies nothing and drives that job. Otherwise `--dump` and `--files-zip` are copied into `tmp/<id>/upload.bin`
//    (copyOperatorFile: a regular file only, headroom 2× its size first), and the start runs as the server's route
//    does (startSlimsMigration: the target guard, the run, the job with its unique key `catalog.migrate_slims` and the
//    password sealed in its secret, `catalog.migration.start` by the CLI actor). The job's first slice moves the copies
//    into the run's work folder. A start that fails removes the copies again. A start that ended orphaned runs removes
//    their work folders after its COMMIT (releaseEndedRunWork; C16, C17).
// 3. The job is driven through the runner's claim path in this process (claimById, runSlice; M15): its claims hold
//    `jobs:heavy` as the server's do, so it never overlaps a server-side migration, import or reindex. While another
//    process holds the job (or it waits for a retry) the command waits and looks again; progress lines go to
//    `onProgress`. Refused under maintenance, as the server's runner pauses.
// 4. The run's status at its end: `succeeded` returns the run and its summary (cli/index.ts prints `--json` as
//    `{ok: true, command, runId, dryRun, status, joined, summary}`); `failed` or `cancelled` is CliError
//    `MIGRATION_FAILED` (exit 1), the report of the run in Katalog > Migrasi SLiMS.

/** The parsed flags of `slims:import` (cli/index.ts): exactly one source, at most one files source. */
export interface SlimsImportOptions {
  /** `--db <host:port/db>`, with `user`; or `dump`. */
  db?: string;
  /** `--user <u>`, with `db`. */
  user?: string;
  /** `--dump <file>`: a mysqldump (`.sql` or `.sql.gz`). */
  dump?: string;
  /** `--files-zip <zip>`: the SLiMS files archive. */
  filesZip?: string;
  /** `--files-dir <folder>`: a SLiMS folder on this machine (bounded by its real path). */
  filesDir?: string;
  /** `--branch <code>`: the branch the locations and items go to (default: the main branch). */
  branch?: string;
  /** `--price-mode`: default `major`. */
  priceMode?: 'major' | 'minor' | 'skip';
  /** `--dry-run`: read and report, write nothing but the run and its report. */
  dryRun: boolean;
  /** `--allow-non-empty`: migrate into a catalogue that has live records (asks for the library's name). */
  allowNonEmpty: boolean;
  /** Asks the operator for the database password without echoing it; null without a terminal. */
  promptSecret: (question: string) => Promise<string | null>;
  /** Asks the operator a question (the library's name for `--allow-non-empty`); null without a terminal. */
  prompt: (question: string) => Promise<string | null>;
  /** A progress line for a human (never with `--json`). */
  onProgress?: (text: string) => void;
}

export interface SlimsImportResult {
  runId: string;
  dryRun: boolean;
  /** The run's status at its end (`succeeded`, `failed`, ...). */
  status: string;
  /** The command joined a migration that was already live. */
  joined: boolean;
  /** The run's summary (`MigrationSummary`). */
  summary: Record<string, unknown>;
}

/** The actor of the start this command makes. */
const CLI_ACTOR: Actor = { type: 'cli', id: null, ip: null };
/** The wait between two looks while another process runs the job (or it waits for a retry). */
const WAIT_MS = 1000;
/** The default port of `--db host/db`. */
const MYSQL_PORT = 3306;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function underMaintenance(): DomainError {
  return new DomainError('MAINTENANCE', {
    detail:
      'Mode pemeliharaan aktif (sebuah operasi sedang berjalan); coba lagi setelah selesai / ' +
      'Maintenance mode is on (an operation is running); try again once it ends',
  });
}

/** `--db <host[:port]/db>` and `--user` as the source's database. @throws CliError `USAGE` */
function dbTarget(spec: string, user: string): SlimsDbTarget {
  const match = /^(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?\/(.+)$/.exec(spec);
  const parsed =
    match === null
      ? null
      : SlimsDbSource.safeParse({
          kind: 'db',
          host: match[1]!.replace(/^\[|\]$/g, ''),
          port: match[2] === undefined ? MYSQL_PORT : Number(match[2]),
          user,
          password: '',
          database: match[3],
          tls: false,
        });
  if (parsed === null || !parsed.success) {
    throw new CliError('USAGE', '--db harus berbentuk host:port/basisdata / --db must look like host:port/database');
  }
  const { host, port, database, tls } = parsed.data;
  return { host, port, user: parsed.data.user, database, tls };
}

/** The steps of the job as a progress line, once per change. */
function progressReporter(onProgress: ((text: string) => void) | undefined): (p: { progress: number; message: string | null }) => void {
  let last = '';
  return (p) => {
    const line = `slims:import: ${p.message ?? '-'} ${p.progress}%`;
    if (onProgress === undefined || line === last) return;
    last = line;
    onProgress(line);
  };
}

/**
 * Migrates a SLiMS catalogue (see the top of this file). Everything it opens is closed before it returns.
 *
 * @throws CliError `USAGE` (a malformed `--db`), `PASSWORD_REQUIRED`, `CONFIRM_REQUIRED`, `FILES_DIR_INVALID`,
 *   `BRANCH_NOT_FOUND`, `MIGRATION_FAILED`; DomainError `NOT_INSTALLED`, `MAINTENANCE`, `MIGRATION_TARGET_NOT_EMPTY`,
 *   `DISK_QUOTA` (a copy), what loadConfig and connect throw
 */
export async function slimsImport(ctx: BootContext, env: Env, o: SlimsImportOptions): Promise<SlimsImportResult> {
  const offset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + offset;
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();

  // 1. What the operator gives, before anything is written.
  let db: SlimsDbTarget | null = null;
  let password: string | null = null;
  if (o.db !== undefined) {
    db = dbTarget(o.db, o.user ?? '');
    password = isEnvSet(env, 'ALTIS_SLIMS_DB_PASSWORD')
      ? env['ALTIS_SLIMS_DB_PASSWORD']!
      : await o.promptSecret('Kata sandi basis data SLiMS / SLiMS database password: ');
    if (password === null) {
      throw new CliError(
        'PASSWORD_REQUIRED',
        'Kata sandi basis data SLiMS diperlukan: isi ALTIS_SLIMS_DB_PASSWORD atau jalankan di terminal / ' +
          'The SLiMS database password is needed: set ALTIS_SLIMS_DB_PASSWORD or run this at a terminal',
      );
    }
  }
  let confirmLibraryName: string | null = null;
  if (o.allowNonEmpty) {
    confirmLibraryName = await o.prompt('Ketik nama perpustakaan ini untuk mengizinkan katalog tidak kosong / Type this library\'s name to allow a non-empty catalogue: ');
    if (confirmLibraryName === null) {
      throw new CliError(
        'CONFIRM_REQUIRED',
        '--allow-non-empty memerlukan nama perpustakaan yang diketik di terminal / --allow-non-empty needs the library\'s name typed at a terminal',
      );
    }
  }
  let filesDir: string | null = null;
  if (o.filesDir !== undefined) {
    // `<path>/.` resolves only for a folder (a file gives ENOTDIR): the real path of a folder, links followed.
    filesDir = await realPathOf(`${o.filesDir}${path.sep}.`);
    if (filesDir === null) throw new CliError('FILES_DIR_INVALID', '--files-dir harus sebuah folder / --files-dir must be a folder');
  }

  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'slims:import' });
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'ready', db: h, config };
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock, runtime: ctx.runtime });
  const reg = createJobRegistry(
    bindJobHandlers(jobHandlers(), {
      dataDir: ctx.dataDir,
      runtime: ctx.runtime,
      installId: config.install.id,
      appVersion: ctx.release.version,
      ops,
      config: () => state.config,
      log,
    }),
  );
  const copies: string[] = [];
  let kept = false;
  try {
    if ((await readMaintenance(ctx.dataDir)) !== null) throw underMaintenance();
    const branch =
      o.branch === undefined
        ? await h.db.selectFrom('branches').select('id').where('is_default', '=', 1).where('archived_at', 'is', null).executeTakeFirst()
        : await h.db.selectFrom('branches').select('id').where('code_key', '=', normalizeKey(o.branch)).where('archived_at', 'is', null).executeTakeFirst();
    if (branch === undefined) throw new CliError('BRANCH_NOT_FOUND', '--branch tidak menamai cabang aktif / --branch names no active branch');

    // 2. Join a live migration, or copy the files in and start one.
    let started: { runId: string; jobId: string; joined: boolean; endedRunIds?: readonly string[] } | null = null;
    const live = await liveSlimsMigration(h.db);
    if (live !== null) started = { ...live, joined: true };
    let dumpStagingId: string | null = null;
    let filesStagingId: string | null = null;
    if (started === null) {
      if (o.dump !== undefined) {
        dumpStagingId = newId(clock());
        copies.push(dumpStagingId);
        await copyOperatorFile(o.dump, dataPath(ctx.dataDir, 'tmp', dumpStagingId, 'upload.bin'));
      }
      if (o.filesZip !== undefined) {
        filesStagingId = newId(clock());
        copies.push(filesStagingId);
        await copyOperatorFile(o.filesZip, dataPath(ctx.dataDir, 'tmp', filesStagingId, 'upload.bin'));
      }
      started = await withTx(h, async (trx) => {
        const holder = await liveSlimsMigration(trx);
        if (holder !== null) return { ...holder, joined: true };
        const r = await startSlimsMigration(
          txCtx(trx, clock(), CLI_ACTOR),
          reg,
          {
            dryRun: o.dryRun,
            sourceKind: db === null ? 'dump' : 'db',
            db,
            password,
            dumpStagingId,
            files: filesStagingId !== null ? 'zip' : filesDir !== null ? 'dir' : null,
            filesStagingId,
            filesDir,
            branchId: branch.id,
            priceMode: o.priceMode ?? 'major',
            sourceName: 'slims',
            allowNonEmpty: o.allowNonEmpty,
            confirmLibraryName,
            fromRunId: null,
          },
          { keyring: config.keyring },
        );
        return { runId: r.runId, jobId: r.jobId, joined: false, endedRunIds: r.endedRunIds };
      });
      // The run's job moves the copies into its folder; a joined migration leaves them for removal below.
      kept = !started.joined;
      // The orphaned runs this start ended free their work folders (C16, C17).
      if (started.endedRunIds !== undefined) await releaseEndedRunWork(ctx.dataDir, started.endedRunIds, log);
    }
    if (started.joined) o.onProgress?.(`slims:import: migrasi yang sedang berjalan diikuti / joined the migration already running (${started.runId})`);

    // 3. The job through the runner's claim path, here.
    const report = progressReporter(o.onProgress);
    const worker = jobWorkerName('cli');
    for (;;) {
      const flag = await readMaintenance(ctx.dataDir);
      if (flag !== null && !flag.exemptJobIds.includes(started.jobId)) throw underMaintenance();
      const job = await claimById(h, reg, started.jobId, { worker, now: clock(), exempt: flag === null ? null : flag.exemptJobIds });
      if (job === null) {
        const row = await h.db.selectFrom('jobs').select(['status', 'progress', 'progress_message']).where('id', '=', started.jobId).executeTakeFirst();
        if (row === undefined || (row.status !== 'queued' && row.status !== 'running')) break;
        report({ progress: Number(row.progress), message: row.progress_message });
        await pause(WAIT_MS); // another process runs it, or it waits for its retry
        continue;
      }
      const result = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: SLICE_BUDGET_MS, keyring: config.keyring, log, clock, env });
      const row = await h.db.selectFrom('jobs').select(['progress', 'progress_message']).where('id', '=', started.jobId).executeTakeFirst();
      if (row !== undefined) report({ progress: Number(row.progress), message: row.progress_message });
      if (result.outcome === 'succeeded' || result.outcome === 'dead' || result.outcome === 'cancelled') break;
    }

    // 4. The run as it ended.
    const run = await getRun(h.db, started.runId);
    if (run === null) throw new CliError('MIGRATION_FAILED', `Run migrasi ${started.runId} hilang / The migration run ${started.runId} is gone`);
    if (run.status !== 'succeeded') {
      throw new CliError(
        'MIGRATION_FAILED',
        `Migrasi SLiMS ${run.id} berakhir ${run.status}; lihat laporannya di Katalog > Migrasi SLiMS / ` +
          `The SLiMS migration ${run.id} ended ${run.status}; see its report in Katalog > Migrasi SLiMS`,
      );
    }
    let summary: Record<string, unknown> = {};
    try {
      summary = JSON.parse(run.summary) as Record<string, unknown>;
    } catch {
      summary = {};
    }
    return { runId: run.id, dryRun: Number(run.dry_run) === 1, status: run.status, joined: started.joined, summary };
  } finally {
    if (!kept) for (const id of copies) await removeTree(dataPath(ctx.dataDir, 'tmp', id)).catch(() => undefined);
    await closeJobSessions(log);
    await ops.close();
    await h.close();
  }
}

/** The result for a human, in both languages. */
export function describeSlimsImport(result: SlimsImportResult): string {
  const reconciliation = (result.summary['reconciliation'] as { ok?: unknown } | null | undefined)?.ok;
  const check = reconciliation === true ? 'rekonsiliasi cocok / reconciliation ok' : 'rekonsiliasi berselisih / reconciliation differs';
  const kind = result.dryRun ? 'uji kering / dry run' : 'migrasi / migration';
  return `Migrasi SLiMS ${result.runId}: ${result.status} (${kind}; ${check}) / SLiMS migration ${result.runId}: ${result.status}`;
}
