import type { AltisMigration, DbHandle } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import type { Context } from 'hono';
import type { AppState } from '../app.js';
import type { OpsFence } from './ops-fence.js';
import type { AppEnv } from './request-id.js';

// GET /_health (spec §11): `{status, version}`, nothing else, never behind authentication.
//
//   phase           status  body.status
//   ready            200    ok              after a live `select 1` answered within 2 s (single-flight, the answer
//                                           reused for 1 s: L48)
//   ready            503    db_unavailable  the live query failed or took longer (the phase is not changed)
//   not_installed    503    not_installed
//   starting         503    starting
//   db_unavailable   503    db_unavailable
//   too_old          503    schema_too_new
//   ops_wait         503    maintenance     1c Task 15: the process waits for an exclusive op before it boots (B4)
//   updating         503    maintenance     1d Task 25: the process boots an update's target (or steps its revert)
//                                           inside the update op
//   (a restore)      503    maintenance     1c Task 15: whatever the phase, while the ops fence sees a restore (its
//                                           tables may be gone); a frozen backup or any other op answers as usual
//
// 1d Task 25 (spec §9.3 "Sehat = listening + DB terjangkau + /_health internal 200 + migrasi skema selesai"; preflight
// S1, 1D-05): the update op's `verifying` step does not ask /_health, which answers 503 in every phase but `ready` while
// the target boots in phase `updating` (every update would revert with `health`). It asks updateHealth, which checks
// the conditions themselves, whatever the phase. /_health itself is unchanged.

export const HEALTH_PATH = '/_health';

/** How long the live database check of /_health may take. */
export const HEALTH_DB_TIMEOUT_MS = 2000;

/** How long the answer of a live database check is reused, from the moment it arrived (L48). */
export const HEALTH_REUSE_MS = 1000;

/** The live database check: true when the database answers within `timeoutMs`; never throws. */
export type PingDatabase = (h: Pick<DbHandle, 'db'>, timeoutMs: number) => Promise<boolean>;

export interface HealthOptions {
  /** The live check (default {@link pingDatabase}); a test seam. */
  ping?: PingDatabase;
  /** The process's ops fence as it is at each request (1c Task 15): a restore answers `maintenance`. */
  fence?: () => OpsFence | null;
}

export type HealthStatus = 'ok' | 'starting' | 'not_installed' | 'db_unavailable' | 'schema_too_new' | 'maintenance';

/**
 * True when the database answers `select 1` within `timeoutMs`. Never throws; a query still running when the time
 * is up is left to finish (or fail) on its own, its result ignored.
 */
export async function pingDatabase(h: Pick<DbHandle, 'db'>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  const answered = Promise.resolve()
    .then(() => h.db.selectNoFrom((eb) => eb.lit(1).as('ok')).execute())
    .then(
      () => true,
      () => false,
    );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1d Task 25 (preflight S1, 1D-05): the health of spec §9.3 for the update op's `verifying` step, whatever the app's
 * phase: the database answers `select 1` within {@link HEALTH_DB_TIMEOUT_MS}, and every migration of `migrations`
 * (this release's, `releaseMigrations()`) is applied, so nothing is pending (a database ahead of them counts as done).
 * False (the release is unhealthy: the update reverts) only for a database that answers and lacks a migration, or whose
 * `schema_migrations` cannot be read for another reason than the connection.
 *
 * @throws DomainError `DB_UNAVAILABLE` when the database does not answer `select 1` in time, or the connection fails
 *   while `schema_migrations` is read (review C09, §9.3 "Bukan alasan revert: … galat konektivitas DB"): a wait, which
 *   leaves the op as it was for a later step, never a revert
 */
export async function updateHealth(h: DbHandle, migrations: Readonly<Record<string, AltisMigration>>): Promise<boolean> {
  if (!(await pingDatabase(h, HEALTH_DB_TIMEOUT_MS))) {
    throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'health_check' } });
  }
  let applied: Set<string>;
  try {
    applied = new Set((await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name));
  } catch (error) {
    if (isDomainError(error) && error.code === 'DB_UNAVAILABLE') throw error;
    return false;
  }
  return Object.keys(migrations).every((name) => applied.has(name));
}

/** One live check of {@link sharedPing}. */
interface Check {
  h: object;
  answer: Promise<boolean>;
  answeredAt: number | undefined;
}

/**
 * `ping` made single-flight with a short reuse (L48): concurrent checks of one database handle share the one in
 * flight, and its answer is reused for {@link HEALTH_REUSE_MS} after it arrived, so a flood of /_health requests, or
 * a stalled database, costs one `select 1` at a time. Another handle (start() connects anew on a retry) is checked
 * on its own. A ping that throws counts as a failed check. The reuse is a per-process memory cache, safe to be
 * stale (P6): at most 1 s.
 */
function sharedPing(ping: PingDatabase): (h: Pick<DbHandle, 'db'>) => Promise<boolean> {
  /** The latest check: of which handle, its answer, and when that arrived (undefined while in flight). */
  let last: Check | undefined;
  return (h) => {
    if (last !== undefined && last.h === h) {
      if (last.answeredAt === undefined) return last.answer;
      const age = Date.now() - last.answeredAt;
      // A clock that stepped back (age < 0) never stretches the reuse.
      if (age >= 0 && age < HEALTH_REUSE_MS) return last.answer;
    }
    const answer = Promise.resolve()
      .then(() => ping(h, HEALTH_DB_TIMEOUT_MS))
      .then(
        (ok) => ok === true,
        () => false,
      );
    const check: Check = { h, answer, answeredAt: undefined };
    // Registered before any caller awaits `answer`, so it runs first once the answer is there.
    void answer.then(() => {
      check.answeredAt = Date.now();
    });
    last = check;
    return answer;
  };
}

async function healthStatus(
  state: AppState,
  check: (h: Pick<DbHandle, 'db'>) => Promise<boolean>,
  fence: OpsFence | null,
): Promise<HealthStatus> {
  // 1c Task 15: during a restore no live check (its tables may be gone, and the process restarts after it).
  if (state.phase === 'ops_wait' || state.phase === 'updating' || fence?.restoreInProgress() === true) return 'maintenance';
  switch (state.phase) {
    case 'ready':
      return state.db !== undefined && (await check(state.db)) ? 'ok' : 'db_unavailable';
    case 'too_old':
      return 'schema_too_new';
    default:
      return state.phase;
  }
}

/** What {@link healthHandler} returns: a Hono handler, and the body of the `health` route declaration. */
export type HealthHandler = (c: Context<AppEnv>) => Promise<Response>;

/**
 * The /_health handler over `state`. In phase `ready` it answers from a live database check that is single-flight
 * and reused for {@link HEALTH_REUSE_MS} (L48); each handler has its own, so an app builds one, once
 * (`services.health`), never one per request.
 */
export function healthHandler(state: AppState, version: string, o: HealthOptions = {}): HealthHandler {
  const check = sharedPing(o.ping ?? pingDatabase);
  return async (c) => {
    const status = await healthStatus(state, check, o.fence?.() ?? null);
    c.header('Cache-Control', 'no-store');
    return c.json({ status, version }, status === 'ok' ? 200 : 503);
  };
}
