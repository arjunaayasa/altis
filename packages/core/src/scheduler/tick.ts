import { normalizeDbError, withTx, type DB, type DbHandle } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { sql, type Transaction } from 'kysely';
import { errorFields, type CoreLogger } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { enqueue } from '../jobs/enqueue.js';
import type { JobRegistry } from '../jobs/types.js';
import { readSettings } from '../settings/service.js';
import { refreshClockAnomaly } from './clock.js';
import { nextRun, parseCronExpr, periodMs, type CronExpr } from './cron-expr.js';
import { SCHEDULES, type ScheduleDef, type ScheduleWindow } from './registry.js';

// Seeding and ticking the schedules (spec §10.4, §6.5 class `config`; decisions C2, C41; preflight S16).
//
// - seedSchedules writes the code's definitions: a missing row is inserted (`next_run_at = nextRun(expr, now)`,
//   `enabled` = its default); an existing row keeps what an admin may edit, `enabled` always and `expr` where the
//   definition says `exprEditable` (and the stored one still parses); a row whose expression the admin may not edit
//   follows the code's expression (a later release may change it) and gets its next run from it; a row no definition
//   names is deleted. Two processes seeding at once write one row per definition (the INSERT is in a savepoint and a
//   duplicate key means the other one was first).
// - tickSchedules is the compare-and-set of §10.4: each due row is moved on with `UPDATE schedules SET next_run_at,
//   last_run_at WHERE name AND next_run_at = :seen` and only the transaction that changed it enqueues the job, with
//   `unique_key` `sched:<name>:<scheduled_for>`, in the same transaction. The next run is computed from now, so missed
//   runs collapse into one catch-up run (C2: a server down for three days backs up once). The job's payload is
//   `def.payload(window)` (S16), default the window `{windowStart: last_run_at (or one period before the scheduled
//   time), windowEnd: the scheduled time}`.
// - While `clock_anomaly` is active every enabled row is looked at: one whose next run lies ahead of now gets it
//   recomputed from now (never enqueued ahead of time), one already due runs as usual.
// - A definition whose job type has no handler in this release is skipped (logged once per process): its task brings
//   the handler. A row that no definition names, or whose expression does not parse, is skipped too.

/** Lines already logged by this process (a set of keys, P6: safe to lose). */
const noted = new Set<string>();

function noteOnce(log: CoreLogger | undefined, key: string, level: 'info' | 'warn', msg: string, fields: Record<string, unknown>): void {
  if (log === undefined || noted.has(key)) return;
  noted.add(key);
  log[level](msg, fields);
}

function checkNow(now: number, caller: string): void {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError(`${caller}: now must be a safe non-negative integer (epoch ms)`);
  }
}

function tryParse(expr: string): CronExpr | null {
  try {
    return parseCronExpr(expr);
  } catch {
    return null;
  }
}

function isTransaction(trx: unknown): boolean {
  return typeof trx === 'object' && trx !== null && (trx as { isTransaction?: unknown }).isTransaction === true;
}

/** Inserts `row` unless another transaction inserted the same name first (inside SAVEPOINT altis_sched). */
async function insertMissing(trx: Transaction<DB>, row: { name: string; expr: string; enabled: number; next_run_at: number; last_run_at: null }): Promise<void> {
  await sql`savepoint altis_sched`.execute(trx);
  try {
    await trx.insertInto('schedules').values(row).execute();
  } catch (error) {
    const normalized = normalizeDbError(error);
    if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION') throw error;
    // Seeded by another process meanwhile: its row stands.
    await sql`rollback to savepoint altis_sched`.execute(trx);
  }
  await sql`release savepoint altis_sched`.execute(trx);
}

/**
 * Writes the definitions `defs` into `schedules` in `trx` at `now`, next runs in the local time of `tz` (see the top of
 * this file). Re-runnable as a whole (R37): it reads and writes only through `trx`.
 *
 * @throws TypeError when `trx` is not a transaction, `now` is malformed or two definitions share a name; DomainError
 *   `VALIDATION_FAILED` when a definition's expression does not parse; RangeError for an unknown zone
 */
export async function seedSchedules(trx: Transaction<DB>, now: number, tz: string, defs: readonly ScheduleDef[]): Promise<void> {
  if (!isTransaction(trx)) throw new TypeError('seedSchedules() runs inside the caller’s transaction: pass the trx of withTx()');
  checkNow(now, 'seedSchedules');
  const names = defs.map((d) => d.name);
  if (new Set(names).size !== names.length) throw new TypeError('seedSchedules: two definitions share a name');
  const parsed = defs.map((d) => ({ def: d, expr: parseCronExpr(d.expr) }));
  const stored = new Map((await trx.selectFrom('schedules').select(['name', 'expr']).execute()).map((r) => [r.name, r.expr]));
  for (const { def, expr } of parsed) {
    const current = stored.get(def.name);
    if (current === undefined) {
      await insertMissing(trx, {
        name: def.name,
        expr: def.expr,
        enabled: def.enabledByDefault ? 1 : 0,
        next_run_at: nextRun(expr, now, tz),
        last_run_at: null,
      });
      continue;
    }
    if (current === def.expr || (def.exprEditable === true && tryParse(current) !== null)) continue;
    await trx
      .updateTable('schedules')
      .set({ expr: def.expr, next_run_at: nextRun(expr, now, tz) })
      .where('name', '=', def.name)
      .where('expr', '=', current)
      .execute();
  }
  let stale = trx.deleteFrom('schedules');
  if (names.length > 0) stale = stale.where('name', 'not in', names);
  await stale.execute();
}

export interface TickOptions {
  /** Epoch ms of the tick. */
  now: number;
  /** `library.timezone`. */
  tz: string;
  defs: readonly ScheduleDef[];
  /** Seals a job's secret at enqueue (scheduled jobs carry none; enqueue takes it). */
  keyring: readonly KeyringEntry[];
  /** `clock_anomaly` is active: rows ahead of now are recomputed, never enqueued ahead of time. */
  anomaly: boolean;
  /** Where skipped rows and failed enqueues are noted (each once per process). */
  log?: CoreLogger;
}

/**
 * One tick of the schedules at `o.now` (see the top of this file): one transaction per due row, so call it outside any
 * withTx callback.
 *
 * @returns the number of jobs this call enqueued
 * @throws TypeError for a malformed `now`; what reading `schedules` throws (a row's own failure is logged and skipped)
 */
export async function tickSchedules(h: DbHandle, reg: JobRegistry, o: TickOptions): Promise<number> {
  checkNow(o.now, 'tickSchedules');
  const { now, tz, log } = o;
  const defs = new Map(o.defs.map((d) => [d.name, d]));
  let q = h.db.selectFrom('schedules').selectAll().where('enabled', '=', 1);
  if (!o.anomaly) q = q.where('next_run_at', '<=', now);
  const rows = await q.orderBy('name').execute();
  let enqueued = 0;
  for (const row of rows) {
    const def = defs.get(row.name);
    if (def === undefined) continue;
    if (reg.get(def.jobType) === undefined) {
      noteOnce(log, `type:${def.jobType}`, 'info', 'scheduler: no handler for a scheduled job type in this release; skipped', {
        schedule: def.name,
        jobType: def.jobType,
      });
      continue;
    }
    const expr = tryParse(row.expr);
    if (expr === null) {
      noteOnce(log, `expr:${row.name}:${row.expr}`, 'warn', 'scheduler: a stored schedule expression does not parse; skipped', { schedule: row.name });
      continue;
    }
    const seen = Number(row.next_run_at);
    try {
      const next = nextRun(expr, now, tz);
      if (seen > now) {
        // Only while the anomaly is active: recomputed from now, never enqueued ahead of time.
        if (next !== seen) {
          await h.db.updateTable('schedules').set({ next_run_at: next }).where('name', '=', row.name).where('next_run_at', '=', seen).execute();
        }
        continue;
      }
      const lastRun = row.last_run_at === null ? null : Number(row.last_run_at);
      const windowStart = lastRun ?? seen - periodMs(expr, seen, tz);
      // A last run ahead of the scheduled time (a clock that moved back) would give an inverted window.
      const window: ScheduleWindow = { windowStart: Math.max(0, Math.min(windowStart, seen)), windowEnd: seen };
      const payload = def.payload === undefined ? window : def.payload(window);
      const created = await withTx(h, async (trx) => {
        const moved = await trx
          .updateTable('schedules')
          .set({ next_run_at: next, last_run_at: now })
          .where('name', '=', row.name)
          .where('next_run_at', '=', seen)
          .executeTakeFirst();
        if (Number(moved.numUpdatedRows) !== 1) return false;
        const job = await enqueue(trx, reg, { type: def.jobType, payload, uniqueKey: `sched:${row.name}:${seen}` }, { now, keyring: o.keyring });
        return !job.existing;
      });
      if (created) enqueued += 1;
    } catch (error) {
      const fields = errorFields(error);
      noteOnce(log, `fail:${row.name}:${String(fields['code'] ?? fields['name'])}`, 'warn', 'scheduler: a scheduled run could not be enqueued', {
        schedule: row.name,
        ...fields,
      });
    }
  }
  return enqueued;
}

export interface SchedulerOptions {
  /** This process's live handle; undefined while there is none (the tick does nothing then). */
  db(): DbHandle | undefined;
  reg: JobRegistry;
  /** Default {@link SCHEDULES}. */
  defs?: readonly ScheduleDef[];
  keyring(): readonly KeyringEntry[];
  log: CoreLogger;
}

export interface Scheduler {
  /**
   * Seeds the schedules (seedSchedules in `library.timezone`) once per scheduler: concurrent calls share one seeding;
   * nothing is remembered while there is no handle or after a failure, so the next call seeds.
   */
  seed(now: number): Promise<void>;
  /**
   * The runner's tick (spec §10.4): seeds once, refreshes `clock_anomaly` (refreshClockAnomaly), then ticks the
   * schedules under it.
   *
   * @returns the number of jobs enqueued
   */
  tick(now: number): Promise<number>;
}

/** The scheduler of one process (the job runtime's, or the one `jobs:run` makes). */
export function createScheduler(o: SchedulerOptions): Scheduler {
  const defs = o.defs ?? SCHEDULES;
  let seeded: Promise<void> | null = null;

  async function timezone(h: DbHandle): Promise<string> {
    return (await readSettings(h.db, ['library.timezone'], []))['library.timezone'] as string;
  }

  function seed(now: number): Promise<void> {
    const h = o.db();
    if (h === undefined) return Promise.resolve();
    seeded ??= (async () => {
      const tz = await timezone(h);
      await withTx(h, (trx) => seedSchedules(trx, now, tz, defs));
    })().catch((error: unknown) => {
      seeded = null;
      throw error;
    });
    return seeded;
  }

  return {
    seed,
    async tick(now) {
      const h = o.db();
      if (h === undefined) return 0;
      await seed(now);
      const tz = await timezone(h);
      const { active } = await refreshClockAnomaly(h, { now, tz, defs });
      return tickSchedules(h, o.reg, { now, tz, defs, keyring: o.keyring(), anomaly: active, log: o.log });
    },
  };
}
