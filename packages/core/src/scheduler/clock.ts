import { normalizeDbError, withTx, type DB, type DbHandle } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { TxRunner } from '../context.js';
import { publish } from '../events/publish.js';
import { JOB_LEASE_MS } from '../jobs/types.js';
import { notify } from '../notifications/service.js';
import { SETTINGS } from '../settings/registry.js';
import { readSettings, writeSettings } from '../settings/service.js';
import { nextRun, parseCronExpr, periodMs, type CronExpr } from './cron-expr.js';
import type { ScheduleDef } from './registry.js';

// clock_anomaly (spec §10.4, decision C3; preflight S18): the server clock looks wrong.
//
// - Raised (detectClockAnomaly) when now is more than 5 minutes before what the installation has already seen
//   (`maxSeen`: the latest `schedules.last_run_at`, or the `at` of the newest audit entry written after the last
//   confirmation), or when an enabled schedule's next run lies more than two periods ahead and after the next run
//   from now (so it was computed by a clock that ran ahead). refreshClockAnomaly writes the instance setting
//   `system.clock_anomaly {detectedAt, maxSeen}` once, with one notification to the holders of
//   `system.diagnostics.read` and one `clock.anomaly` event on `system.status` (a compare-and-set on the setting's
//   row: of several processes only one raises it), and keeps it while it holds.
// - While it is active: ticks recompute `next_run_at` instead of running ahead of time (tick.ts), a lease or a named
//   lock far ahead counts as expired (the runner's claims, `claimLock` with `farFutureIsExpired`), and age-based purges
//   are skipped (their jobs read the setting).
// - It never clears itself. Two ways out: an admin's confirmation (confirmClock: reauth and audit, through the route's
//   runner) or a signed time within ±5 minutes (clearClockAnomaly, from 1d's feed, heartbeat or clock token). Both
//   clamp the timestamps a clock ahead left in the future to now, each beyond its longest legitimate horizon (C3:
//   `schedules.last_run_at > now`, `next_run_at > now + 2 × period` (recomputed), `jobs.run_at > now + 1 h`,
//   `jobs.locked_until > now + 2 × lease`, `locks.until > now + 10 min`, `backups.created_at > now`: a backup stamped
//   ahead would rank newest in the count-based retention and keep the real ones out), and record
//   `system.clock_confirmed {at, auditSeq}`, so the detector ignores the audit entries written before it; otherwise it
//   would raise the anomaly again at once.

/** How far the clock may be off before it counts (spec §10.4: "± 5 menit"). */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

/** `jobs.run_at` further ahead than this is clamped (C3: the longest retry delay, 1 h). */
const RUN_AT_HORIZON_MS = 3_600_000;
/** `locks.until` further ahead than this is clamped (C3). */
const LOCK_HORIZON_MS = 10 * 60_000;

/** What `system.clock_anomaly` holds while the anomaly is active. */
export type ClockAnomaly = { detectedAt: number; maxSeen: number };

/** Where 1d's signed time comes from. */
const TRUSTED_SOURCES: readonly string[] = ['feed', 'heartbeat', 'clock_token'];

const ANOMALY_KEY = 'system.clock_anomaly';

type Db = Kysely<DB> | Transaction<DB>;

function checkTime(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${what} must be a safe non-negative integer (epoch ms)`);
  }
}

function tryParse(expr: string): CronExpr | null {
  try {
    return parseCronExpr(expr);
  } catch {
    return null;
  }
}

/**
 * Whether a stored next run `next` of `expr` was computed by a clock ahead (C3: beyond its longest legitimate horizon):
 * more than two periods after now, and later than the next run from now. A next run computed at any time up to now is
 * never later than that (the runs of an expression are a fixed set of instants), so the second test keeps a legitimate
 * gap longer than two periods out (the night the clocks go back, when local times already run are not run again).
 */
function farAhead(expr: CronExpr, next: number, now: number, tz: string): boolean {
  return next > now + 2 * periodMs(expr, now, tz) && next > nextRun(expr, now, tz);
}

/** The stored text of the setting as an active anomaly, or null (absent, null, or not a valid value). */
function anomalyOf(text: string | null | undefined): ClockAnomaly | null {
  if (text === null || text === undefined) return null;
  try {
    const parsed = SETTINGS[ANOMALY_KEY].schema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data as ClockAnomaly | null) : null;
  } catch {
    return null;
  }
}

/** The active anomaly, or null. */
export async function readClockAnomaly(db: Db): Promise<ClockAnomaly | null> {
  return ((await readSettings(db, [ANOMALY_KEY], []))[ANOMALY_KEY] as ClockAnomaly | null | undefined) ?? null;
}

/**
 * Whether the clock looks wrong at `o.now` (see the top of this file); the anomaly to raise, or null. `maxSeen` is the
 * latest time the installation has seen: the latest schedule run or audit entry, or, when only a far next run gives
 * the clock away, that run less one period.
 *
 * @throws TypeError for a malformed `now`; RangeError for an unknown zone
 */
export async function detectClockAnomaly(
  db: Db,
  o: { now: number; tz: string; defs: readonly ScheduleDef[] },
): Promise<ClockAnomaly | null> {
  checkTime(o.now, 'detectClockAnomaly: now');
  const { now } = o;
  const confirmed = (await readSettings(db, ['system.clock_confirmed'], []))['system.clock_confirmed'] as { auditSeq: number } | null;
  const rows = await db.selectFrom('schedules').select(['name', 'expr', 'enabled', 'next_run_at', 'last_run_at']).execute();
  const newest = await db
    .selectFrom('audit_log')
    .select('at')
    .where('seq', '>', confirmed?.auditSeq ?? 0)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  let seen: number | null = newest === undefined ? null : Number(newest.at);
  for (const row of rows) {
    if (row.last_run_at !== null) seen = Math.max(seen ?? 0, Number(row.last_run_at));
  }
  if (seen !== null && now < seen - CLOCK_TOLERANCE_MS) return { detectedAt: now, maxSeen: seen };

  const defined = new Set(o.defs.map((d) => d.name));
  let far: number | null = null;
  for (const row of rows) {
    if (Number(row.enabled) !== 1 || !defined.has(row.name)) continue;
    const expr = tryParse(row.expr);
    if (expr === null) continue;
    const next = Number(row.next_run_at);
    if (farAhead(expr, next, now, o.tz)) far = Math.max(far ?? 0, next - periodMs(expr, now, o.tz));
  }
  if (far === null) return null;
  return { detectedAt: now, maxSeen: Math.max(seen ?? 0, far) };
}

/**
 * Writes `value` into `system.clock_anomaly` unless it is already raised: a compare-and-set on the row as read (or an
 * INSERT in a savepoint when there is none), so of several transactions doing this at once only one changes it.
 *
 * @returns whether this transaction raised it
 */
async function raiseOnce(trx: Transaction<DB>, value: ClockAnomaly): Promise<boolean> {
  const def = SETTINGS[ANOMALY_KEY];
  const row = {
    value: JSON.stringify(def.schema.parse(value)),
    is_secret: 0,
    scope: def.scope,
    updated_at: value.detectedAt,
    updated_by: null,
  };
  const held = await trx.selectFrom('settings').select('value').where('key', '=', ANOMALY_KEY).executeTakeFirst();
  if (held === undefined) {
    await sql`savepoint altis_clock`.execute(trx);
    let inserted = true;
    try {
      await trx
        .insertInto('settings')
        .values({ key: ANOMALY_KEY, ...row })
        .execute();
    } catch (error) {
      const normalized = normalizeDbError(error);
      if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION') throw error;
      // Raised by another process meanwhile.
      await sql`rollback to savepoint altis_clock`.execute(trx);
      inserted = false;
    }
    await sql`release savepoint altis_clock`.execute(trx);
    return inserted;
  }
  if (anomalyOf(held.value) !== null) return false;
  const was = held.value;
  const changed = await trx
    .updateTable('settings')
    .set(row)
    .where('key', '=', ANOMALY_KEY)
    .where((eb) => (was === null ? eb('value', 'is', null) : eb('value', '=', was)))
    .executeTakeFirst();
  return Number(changed.numUpdatedRows) > 0;
}

/**
 * Raises `clock_anomaly` when detectClockAnomaly finds it and it is not active yet (one notification, one
 * `clock.anomaly` event, written with the setting in one transaction); keeps it while it is active. It never clears
 * it (spec §10.4: only {@link confirmClock} and {@link clearClockAnomaly} do). Call it outside any withTx callback.
 *
 * @returns whether the anomaly is active now
 */
export async function refreshClockAnomaly(
  h: DbHandle,
  o: { now: number; tz: string; defs: readonly ScheduleDef[] },
): Promise<{ active: boolean }> {
  checkTime(o.now, 'refreshClockAnomaly: now');
  if ((await readClockAnomaly(h.db)) !== null) return { active: true };
  const found = await detectClockAnomaly(h.db, o);
  if (found === null) return { active: false };
  await withTx(h, async (trx) => {
    if (!(await raiseOnce(trx, found))) return;
    await notify(
      trx,
      {
        audience: { permission: 'system.diagnostics.read' },
        type: 'clock.anomaly',
        titleKey: 'notification.clock_anomaly.title',
        link: '/admin/diagnostics',
      },
      found.detectedAt,
    );
    // The last statement of the transaction (§10.6).
    await publish(trx, { channel: 'system.status', type: 'clock.anomaly', payload: { ...found } });
  });
  return { active: true };
}

/** C3: every timestamp a clock ahead left beyond its longest legitimate horizon, set to `now`. */
async function clampFuture(trx: Transaction<DB>, now: number): Promise<void> {
  const tz = (await readSettings(trx, ['library.timezone'], []))['library.timezone'] as string;
  await trx.updateTable('schedules').set({ last_run_at: now }).where('last_run_at', '>', now).execute();
  const ahead = await trx.selectFrom('schedules').select(['name', 'expr', 'next_run_at']).where('next_run_at', '>', now).execute();
  for (const row of ahead) {
    const expr = tryParse(row.expr);
    if (expr === null || !farAhead(expr, Number(row.next_run_at), now, tz)) continue;
    await trx.updateTable('schedules').set({ next_run_at: nextRun(expr, now, tz) }).where('name', '=', row.name).execute();
  }
  await trx.updateTable('jobs').set({ run_at: now }).where('run_at', '>', now + RUN_AT_HORIZON_MS).execute();
  await trx.updateTable('jobs').set({ locked_until: now }).where('locked_until', '>', now + 2 * JOB_LEASE_MS).execute();
  await trx.updateTable('locks').set({ until: now }).where('until', '>', now + LOCK_HORIZON_MS).execute();
  await trx.updateTable('backups').set({ created_at: now }).where('created_at', '>', now).execute();
}

/** `system.clock_confirmed = {at: now, auditSeq: <audit head>}` and `system.clock_anomaly = null`. */
async function markConfirmed(trx: Transaction<DB>, now: number, actorId: string | null): Promise<void> {
  const head = await trx.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirst();
  await writeSettings(
    trx,
    { 'system.clock_confirmed': { at: now, auditSeq: Number(head?.last_seq ?? 0) }, [ANOMALY_KEY]: null },
    { keyring: [], now, actorId },
  );
}

/**
 * An admin confirms that the clock is right now (spec §10.4, decision C3; route `diagnostics.clock_confirm`, which
 * passes `rc.withTx` so the audit counts for it). One transaction of `run` (re-runnable, R37): the future timestamps
 * clamped (see the top of this file), the audit entry `diagnostics.clock_confirm` `{maxSeen}` (null without an active
 * anomaly) by the runner's actor, then `system.clock_confirmed` at the audit head (this entry included) and
 * `system.clock_anomaly = null`.
 *
 * @throws TypeError for a malformed `now`
 */
export async function confirmClock(run: TxRunner, o: { now: number }): Promise<void> {
  checkTime(o.now, 'confirmClock: now');
  const { now } = o;
  await run(async (tx) => {
    const active = await readClockAnomaly(tx.trx);
    await clampFuture(tx.trx, now);
    await tx.audit({ action: 'diagnostics.clock_confirm', entity: null, entityId: null, meta: { maxSeen: active?.maxSeen ?? null } });
    await markConfirmed(tx.trx, now, tx.actor.type === 'staff' ? tx.actor.id : null);
  });
}

/**
 * A signed time (1d: the feed's freshness document, a heartbeat, a clock token) says the clock is right: when the
 * anomaly is active and `|now − trustedTime| ≤ 5 min`, it is cleared, with the clamps and the confirmation record of
 * {@link confirmClock} (without an audit entry: nobody acted). Call it outside any withTx callback.
 *
 * @returns whether it cleared an active anomaly
 * @throws TypeError for a malformed `now` or `trustedTime`, or an unknown `source`
 */
export async function clearClockAnomaly(
  h: DbHandle,
  o: { now: number; trustedTime: number; source: 'feed' | 'heartbeat' | 'clock_token' },
): Promise<boolean> {
  checkTime(o.now, 'clearClockAnomaly: now');
  checkTime(o.trustedTime, 'clearClockAnomaly: trustedTime');
  if (!TRUSTED_SOURCES.includes(o.source)) throw new TypeError('clearClockAnomaly: source must be feed, heartbeat or clock_token');
  if (Math.abs(o.now - o.trustedTime) > CLOCK_TOLERANCE_MS) return false;
  return withTx(h, async (trx) => {
    if ((await readClockAnomaly(trx)) === null) return false;
    await clampFuture(trx, o.now);
    await markConfirmed(trx, o.now, null);
    return true;
  });
}
