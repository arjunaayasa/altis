import { migrateUpOne, type AltisMigration } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { errorFields } from '../../context.js';
import type { OpFile } from '../files.js';
import type { OpKindHandler, OpStepContext } from '../machine.js';

// The `migrate` op kind (spec §9.4, §13.6; preflight S21): the CLI's `migrate` under the ops lock. `running` applies
// one migration per handler step with migrateUpOne (its own locks and rules, spec §6.4), so a step stays short (P9)
// and the machine's budget decides how many run in one call; `done` once nothing is pending (or the database is
// ahead of this code). The install wizard's `install-migrate` (install-migrate.ts) runs the same step.

/** What the migration kinds need from the running code. */
export interface MigrationKindDeps {
  /** The running code's version (SemVer): migrateUpOne refuses a database that needs a newer one. */
  appVersion: string;
  /** Every migration of this code, by name (releaseMigrations()). */
  migrations: Record<string, AltisMigration>;
}

/** The shortest wait for the migration locks in one step; the rest of the step's budget when that is longer. */
const LOCK_WAIT_MIN_MS = 1000;

/** Another process holds a migration lock (migrate.lock, or the MySQL/MariaDB named lock): a later step retries. */
function lockBusy(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  const reason = error.meta?.['reason'];
  return (error.code === 'STATE_CORRUPT' && reason === 'lock_timeout') || (error.code === 'DB_UNAVAILABLE' && reason === 'busy');
}

/** The migration a failure names (MigrationFailureMeta.migration), if any. */
function failedMigration(error: unknown): string | null {
  const meta = (error as { meta?: Record<string, unknown> } | null)?.meta;
  const name = meta?.['migration'];
  return typeof name === 'string' ? name : null;
}

/**
 * One handler step of a migration kind: applies at most one pending migration on `ctx.db()` (or, in a process
 * without a live handle, the op's own connection), records it in `params.applied` and `message`, and moves to `done`
 * when nothing is pending any more. A busy migration lock leaves the op as it was (a later step tries again); a failed
 * migration ends it `failed`, naming the migration; a lost connection is thrown on (the machine leaves the op for the
 * next step).
 */
export async function migrationStep(deps: MigrationKindDeps, ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  const h = ctx.db() ?? (await ctx.connectDedicated());
  let outcome: { done: boolean; applied?: string };
  try {
    outcome = await migrateUpOne(h, {
      appVersion: deps.appVersion,
      dataDir: ctx.dataDir,
      migrations: deps.migrations,
      lockWaitMs: Math.max(LOCK_WAIT_MIN_MS, ctx.deadline - ctx.now()),
    });
  } catch (error) {
    if (lockBusy(error)) {
      ctx.log.info('ops: a migration lock is busy; a later step tries again', { opId: op.opId });
      return op;
    }
    if (isDomainError(error) && error.code === 'DB_UNAVAILABLE') throw error;
    const migration = failedMigration(error);
    ctx.log.error('ops: a migration failed', { opId: op.opId, migration, ...errorFields(error) });
    return {
      ...op,
      state: 'failed',
      error: {
        code: isDomainError(error) ? error.code : 'INTERNAL',
        ...(migration === null ? {} : { detail: `Migrasi ${migration} gagal / Migration ${migration} failed` }),
      },
    };
  }
  const before = op.params['applied'];
  const applied = Array.isArray(before) ? before.filter((n): n is string => typeof n === 'string') : [];
  if (outcome.applied !== undefined) applied.push(outcome.applied);
  const names = Object.keys(deps.migrations).sort();
  const position = outcome.applied === undefined ? -1 : names.indexOf(outcome.applied);
  const progress = outcome.done ? 100 : position < 0 ? op.progress : Math.floor((100 * (position + 1)) / names.length);
  return {
    ...op,
    state: outcome.done ? 'done' : 'running',
    params: { ...op.params, applied },
    progress,
    message: outcome.applied ?? op.message,
  };
}

/** The `migrate` kind: maintenance `migrate`, no freeze (migrations are additive, spec §6.4). */
export function migrateKind(deps: MigrationKindDeps): OpKindHandler {
  return {
    kind: 'migrate',
    initialState: 'running',
    maintenance: 'migrate',
    freeze: false,
    step: (ctx, op) => migrationStep(deps, ctx, op),
  };
}
