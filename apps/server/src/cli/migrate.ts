import { SLICE_BUDGET_MS, type OpActor, type OpStatus, type OpsMachine } from '@altis/core';
import { EDITION_MIGRATIONS, connect, listCatalogTables, releaseMigrations, type DbHandle, type MigrationOutcome } from '@altis/db';
import type { Env } from '@altis/platform';
import { DomainError, ERROR_CODES, isDomainError, type ErrorCode } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig } from '../config.js';
import type { BootContext } from '../index.js';
import { createLogger } from '../logger.js';
import { createAppOps } from '../services.js';
import { CliError } from './common.js';

// `node app.js migrate` (spec §13.6, §9.4; 1c Task 24): brings the database of an installed DATA_DIR up to this
// release's migrations under the ops lock: `ops.begin('migrate', {type: 'cli'})` (maintenance `migrate`), then the op
// is stepped until it ends; its step applies one migration per handler step with the runner's own locks (migrate.lock
// and the database's; spec §6.4, preflight S21). Another op in progress → OPS_IN_PROGRESS (exit 1).
//
//   migrated     the pending migrations were applied                         exit 0
//   up-to-date   nothing was pending                                          exit 0
//   schema-ahead the database holds migrations of a newer release that this   exit 0 (with a note)
//                release may run with (a rollback): nothing is run
//   too-old      this release is older than the database's min_code_version   SCHEMA_TOO_NEW, exit 3
//
// The outcome is read from the database around the op (what schema_migrations gained, names this code does not know,
// schema_meta afterwards), so it holds whoever stepped the op meanwhile. Its `edition` (the other migration lane) is
// read the same way from schema_migrations_edition, and is `{mode: 'empty', applied: []}` without reading that table
// while this code ships no migration of that lane; `mode` is then `schema-ahead` too when only that lane is ahead.

/** Who the CLI's ops are begun, cancelled and audited by. */
export const CLI_OP_ACTOR: OpActor = { type: 'cli', id: null };

/** A step that found the op busy elsewhere (another process holds `ops/step.lock`) waits this long before the next. */
const BUSY_PAUSE_MS = 250;

export function notInstalled(): DomainError {
  return new DomainError('NOT_INSTALLED', {
    detail: 'ALTIS belum terpasang; jalankan dulu / ALTIS is not installed; run first: node app.js install --config <file>',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The failure an op that ended in `status` (not `done`) is reported as: its recorded code and detail. */
export function opFailure(status: OpStatus): Error {
  const code = status.error?.code ?? 'INTERNAL';
  const detail = status.error?.detail ?? `Operasi berakhir ${status.state} / The operation ended ${status.state}`;
  return Object.hasOwn(ERROR_CODES, code) ? new DomainError(code as ErrorCode, { detail }) : new CliError(code, detail);
}

/**
 * Steps the op `opId` that this command began until it ends (≤ 20 s per step; while another process steps it, this
 * one waits and looks again). When the command cannot finish it (a step throws, or the op needs attention), the op is
 * cancelled before the error goes on, so that the next run of the command can begin again (only that op: one another
 * process began after it ended is never cancelled); an op whose step lock was taken over (`lock_lost`) is left to the
 * process that took it. With `o.cancel: false` (`ops:resume`, which did not begin the op) nothing is cancelled.
 *
 * @returns the status of the ended op (`done`, or the kind's failure state)
 */
export async function runOpToEnd(ops: OpsMachine, opId: string, o: { cancel?: boolean } = {}): Promise<OpStatus> {
  let last: string | null = null;
  try {
    for (;;) {
      const status = await ops.step(SLICE_BUDGET_MS);
      if (status === null || status.opId !== opId) {
        throw new DomainError('OPS_NONE', {
          detail: 'Operasi ini diambil alih atau dihapus oleh proses lain / This operation was taken over or removed by another process',
        });
      }
      if (status.terminal) return status;
      if (status.needsAttention) throw opFailure(status);
      const seen = `${status.state}:${String(status.heartbeatAt)}:${status.progress}`;
      if (seen === last) await sleep(BUSY_PAUSE_MS);
      last = seen;
    }
  } catch (error) {
    const lost = isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_lost';
    // Only its own op (final review T24): one somebody else began after this one ended is left alone.
    if (!lost && o.cancel !== false) await ops.cancel(CLI_OP_ACTOR, { opId }).catch(() => undefined);
    throw error;
  }
}

/** The names in schema_migrations (none before the migrator's tables exist). */
async function appliedNames(h: DbHandle): Promise<string[]> {
  if (!(await listCatalogTables(h)).includes('schema_migrations')) return [];
  return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name);
}

// ---- Komunitas K1 (edition lane) ----

/** The names in schema_migrations_edition (none before the migrator's tables exist). */
async function editionNames(h: DbHandle): Promise<string[]> {
  if (!(await listCatalogTables(h)).includes('schema_migrations_edition')) return [];
  return (await h.db.selectFrom('schema_migrations_edition').select('name').execute()).map((r) => r.name);
}

/** The other lane's part of the outcome, from its names before the op (null: this code ships no migration of it). */
async function editionOutcome(h: DbHandle, before: ReadonlySet<string> | null): Promise<MigrationOutcome['edition']> {
  if (before === null) return { mode: 'empty', applied: [] };
  const now = await editionNames(h);
  const applied = now.filter((name) => !before.has(name)).sort();
  const ahead = now.some((name) => !Object.hasOwn(EDITION_MIGRATIONS, name));
  return { mode: ahead ? 'schema-ahead' : applied.length > 0 ? 'migrated' : 'up-to-date', applied };
}

async function schemaMeta(h: DbHandle): Promise<{ schemaVersion: string; minCodeVersion: string }> {
  const row = await h.db.selectFrom('schema_meta').select(['schema_version', 'min_code_version']).where('id', '=', 1).executeTakeFirst();
  return { schemaVersion: row?.schema_version ?? '', minCodeVersion: row?.min_code_version ?? '0.0.0' };
}

function tooNew(schemaVersion: string, minCodeVersion: string, version: string): DomainError {
  return new DomainError('SCHEMA_TOO_NEW', {
    detail:
      `Skema database (${schemaVersion}) memerlukan ALTIS ${minCodeVersion} atau lebih baru; versi ini ${version} / ` +
      `The database schema (${schemaVersion}) needs ALTIS ${minCodeVersion} or newer; this is ${version}`,
    meta: { schemaVersion, minCodeVersion },
  });
}

/**
 * Runs the migrations of this release against the database of `ctx.dataDir`, under the ops lock.
 *
 * @returns the outcome (`too-old` is thrown instead)
 * @throws DomainError `NOT_INSTALLED` (no config.json, or an install that did not finish), `OPS_IN_PROGRESS` (another
 *   op has not ended), `SCHEMA_TOO_NEW` (exit 3), a failed migration's code (the op ends `failed`), or what
 *   loadConfig and connect throw
 */
export async function migrate(ctx: BootContext, env: Env): Promise<MigrationOutcome> {
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'migrate' });
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'ready', db: h, config };
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock: () => Date.now(), runtime: ctx.runtime });
  try {
    const before = new Set(await appliedNames(h));
    const editionBefore = Object.keys(EDITION_MIGRATIONS).length === 0 ? null : new Set(await editionNames(h));
    const { opId } = await ops.begin('migrate', CLI_OP_ACTOR, {});
    const status = await runOpToEnd(ops, opId);
    const meta = await schemaMeta(h);
    if (status.state !== 'done') {
      if (status.error?.code === 'SCHEMA_TOO_NEW') throw tooNew(meta.schemaVersion, meta.minCodeVersion, ctx.release.version);
      throw opFailure(status);
    }
    const now = await appliedNames(h);
    const applied = now.filter((name) => !before.has(name)).sort();
    const known = releaseMigrations();
    const ahead = now.some((name) => !Object.hasOwn(known, name));
    const edition = await editionOutcome(h, editionBefore);
    const mode = edition.mode === 'schema-ahead' || (applied.length === 0 && ahead) ? 'schema-ahead' : applied.length > 0 ? 'migrated' : 'up-to-date';
    return { mode, applied, ...meta, edition };
  } finally {
    await ops.close();
    await h.close();
  }
}

/**
 * The human line for an outcome (bilingual; the mode word first, so scripts can match it). The migrations of the other
 * lane this run applied follow it, when there are any (never while this code ships none).
 */
export function describeOutcome(outcome: MigrationOutcome): string {
  const line = coreLine(outcome);
  const n = outcome.edition.applied.length;
  return n === 0 ? line : `${line} (+${n} migrasi jalur lain / ${n} migration(s) of another lane)`;
}

function coreLine(outcome: MigrationOutcome): string {
  const v = outcome.schemaVersion;
  switch (outcome.mode) {
    case 'migrated':
      return `migrated: ${outcome.applied.length} migrasi diterapkan, skema ${v} / ${outcome.applied.length} migration(s) applied, schema ${v}`;
    case 'schema-ahead':
      return (
        `schema-ahead: skema ${v} lebih baru dari rilis ini, yang masih didukung; tidak ada yang dijalankan / ` +
        `schema ${v} is newer than this release, which is still supported; nothing was run`
      );
    default:
      return `up-to-date: skema ${v} sudah terbaru / schema ${v} is up to date`;
  }
}
