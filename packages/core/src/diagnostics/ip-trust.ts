import { withTx, countRows, type DB } from '@altis/db';
import type { IpTrust } from '@altis/shared';
import type { Transaction } from 'kysely';
import type { JobHandler } from '../jobs/types.js';
import { scheduleWindowSchema, type ScheduleWindow } from '../scheduler/registry.js';
import { readSettings, writeSettings } from '../settings/service.js';

// `system.ip_trust` from who signs in (spec P15 rule 1b, deferred by 1b to 1c; decision C22). When the configured
// proxy hops are wrong behind a shared proxy, every visitor gets the proxy's address: one IP then holds nearly every
// staff session. The hourly job looks at the sessions created in the last 24 hours:
//
// - one IP above {@link IP_TRUST_DOMINANCE} of at least {@link IP_TRUST_MIN_SESSIONS} sessions: `collapsed` (per-IP
//   buckets off, D13), unless it is `spoofable` (the browser test's finding, which only a clean browser test clears);
// - while `collapsed`: back to `ok` once at least {@link IP_TRUST_RECOVERY_MIN_SESSIONS} sessions show no IP above
//   {@link IP_TRUST_DOMINANCE}. A smaller window than the one that sets `collapsed`: a library with fewer than 20
//   sign-ins a day that collapsed once (its setup day, from one desk) would otherwise keep its per-IP limits off for
//   good (decision C22 "returns to ok when the dominance is gone");
// - otherwise (too few sessions to tell): the setting stays as it is.
//
// A one-desk library behind one IP fails open (C22): only the per-IP buckets switch off, `login:user` stays.

/** The window of sessions looked at: 24 hours. */
export const IP_TRUST_WINDOW_MS = 86_400_000;
/** Fewer sessions than this in the window say nothing. */
export const IP_TRUST_MIN_SESSIONS = 20;
/** One IP holding more than this share of the window's sessions is dominance. */
export const IP_TRUST_DOMINANCE = 0.9;
/** While `collapsed`, this many sessions in the window with no IP above {@link IP_TRUST_DOMINANCE} restore `ok`. */
export const IP_TRUST_RECOVERY_MIN_SESSIONS = 5;

/** A count as the drivers return it (number, numeric string or bigint) as a number. */
function countOf(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * The sessions created in `(now − 24 h, now]`: how many, and how many the most frequent address holds (sessions
 * without an address count in the total, never as an address).
 */
export async function sessionDominance(trx: Transaction<DB>, now: number): Promise<{ total: number; top: number }> {
  const since = now - IP_TRUST_WINDOW_MS;
  const inWindow = trx.selectFrom('sessions').where('created_at', '>', since).where('created_at', '<=', now);
  const total = await countRows(inWindow.select('id'));
  const top = await inWindow
    .select((eb) => ['ip', eb.fn.countAll().as('n')])
    .where('ip', 'is not', null)
    .groupBy('ip')
    .orderBy((eb) => eb.fn.countAll(), 'desc')
    .limit(1)
    .executeTakeFirst();
  return { total, top: top === undefined ? 0 : countOf(top.n) };
}

/**
 * Applies the dominance rule (see the top of this file) in `trx` at `now` and returns `system.ip_trust` as it is
 * afterwards. Writes only when the value changes.
 */
export async function refreshIpTrust(trx: Transaction<DB>, now: number): Promise<IpTrust> {
  const current = (await readSettings(trx, ['system.ip_trust'], []))['system.ip_trust'] as IpTrust;
  if (current === 'spoofable') return current;
  const { total, top } = await sessionDominance(trx, now);
  if (total < (current === 'collapsed' ? IP_TRUST_RECOVERY_MIN_SESSIONS : IP_TRUST_MIN_SESSIONS)) return current;
  const dominated = top / total > IP_TRUST_DOMINANCE;
  // Dominance sets `collapsed` only over the full window (fewer sessions while collapsed say only that it holds).
  const next: IpTrust = dominated ? (total >= IP_TRUST_MIN_SESSIONS ? 'collapsed' : current) : 'ok';
  if (next !== current) await writeSettings(trx, { 'system.ip_trust': next }, { keyring: [], now, actorId: null });
  return next;
}

/** The hourly job `diagnostics.ip_trust` (schedule `diagnostics.ip_trust`): one transaction, one slice. */
export function ipTrustJob(): JobHandler<ScheduleWindow> {
  return {
    type: 'diagnostics.ip_trust',
    permission: 'system.diagnostics.manage',
    retryable: 'api',
    payload: scheduleWindowSchema,
    async run(ctx) {
      const now = ctx.now();
      const before = (await readSettings(ctx.db, ['system.ip_trust'], []))['system.ip_trust'];
      const after = await withTx(ctx.handle, (trx) => refreshIpTrust(trx, now));
      if (after !== before) ctx.log.warn('diagnostics: ip_trust changed by session dominance', { from: before, to: after });
      return { done: true };
    },
  };
}
