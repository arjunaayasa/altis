import { cronFlight, safeEqual, writeCronSeen, type OpStatus } from '@altis/core';
import { DomainError } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { route, type RouteDecl } from '../http/route.js';

// POST /_cron (spec §10.3, decision C39; route catalog `cron.run`): the HTTP path of the cron line, for hosts whose
// panel can only call a URL (aaPanel's Shell Script task with curl; cPanel's cron with curl or wget):
//
//   curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer <cronToken>" https://perpus.example.sch.id/_cron
//
// (ruling R1c-14: curl retries a 503, which a process that cannot finish its boot in time still answers.)
//
// - Only POST with `Authorization: Bearer <token>`, compared in constant time with config.json's `secrets.cronToken`
//   (§7.4: `auth: 'bearer'` reads no cookie and skips CSRF/Origin); no GET and no `?token=` form. A wrong or missing
//   token → 401 CRON_TOKEN_INVALID. The token is never logged (the request log holds the path only).
// - Before the install completes (a config.json whose installState is not `complete`): `tmp/cron-seen.json` is written
//   and the answer is 200 `{installed: false}`, so the wizard's scheduler test (Task 27) sees the line work; the phase
//   gate lets `/_cron` through while not installed (app.ts). A process that has no config in hand reads config.json
//   for the token: one started before another process's config step has none until its boot attempt loads it, and
//   the call that first finds the file must not be refused.
// - Single-flight (C39): a call less than 30 s after the last one, or while one runs, → 202 `{skipped: 'busy'}`
//   without work. The lease is a file under DATA_DIR/tmp, so it works before the install and during a restore.
// - Ruling R1c-14: the call that wakes a cold Passenger/LiteSpeed process is held by app.js until the release serves
//   (packages/bootloader front.ts), then reaches a process still booting. The phase gate (app.ts) lets it wait, at most
//   CRON_BOOT_WAIT_MS, for `ready` with its job runtime, `ops_wait`, or any phase that is not a boot's, instead of
//   answering 503 while `starting`; the time it waited comes out of its 20 s budget.
// - A call that reaches a retired handler (an update or a restart replaced it; its job runtime drains and its
//   database closes) → 202 `{skipped: 'busy'}` too, before the lease is taken: the handler serving next does the work.
// - Otherwise one pass of ≤ 20 s (P9): the op first, then the scheduler and at most one slice of each job (B5), and
//   the run record `system.run.cron_http` (not during a restore, S2) → 200 `{op, scheduled, slices}`.
// `tx: 'self'`: the work talks to files, the runner and the ops machine, none of which may sit in a re-runnable
// transaction (R37, D3).

/** The path of the cron call. */
export const CRON_PATH = '/_cron';

/** One call's budget (spec §10.3, P9: "POST /_cron (≤ 20 detik)"). */
export const CRON_BUDGET_MS = 20_000;

/**
 * Ruling R1c-14: how long a call that reaches a process still booting waits for the boot (phase gate, app.ts). It is
 * part of the call's {@link CRON_BUDGET_MS}: the pass gets what the wait left, at least 5 s.
 */
export const CRON_BOOT_WAIT_MS = 15_000;

/** How often a waiting call looks at the phase again. */
const CRON_BOOT_POLL_MS = 100;

/** R1c-14: whether a cron call that reaches `state` waits for its boot: the phases a boot passes through. */
export function cronWaitsForBoot(state: AppState): boolean {
  return state.retired !== true && (state.phase === 'starting' || state.phase === 'db_unavailable');
}

/**
 * R1c-14: waits, at most `waitMs`, until the boot of `state` is no longer on its way: a phase other than `starting`
 * and `db_unavailable`, except `ready` before start() made the job runtime (`hasJobs()`), which follows it at once;
 * or the handler retired. Polls the phase every 100 ms on a timer of the request's own, never past the bound.
 */
export async function waitForBoot(state: AppState, hasJobs: () => boolean, waitMs = CRON_BOOT_WAIT_MS): Promise<void> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const booting = cronWaitsForBoot(state) || (state.phase === 'ready' && state.retired !== true && !hasJobs());
    const left = deadline - performance.now();
    if (!booting || left <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(CRON_BOOT_POLL_MS, left)));
  }
}

/** What a cron call reports of the op it stepped. */
export interface CronOpSummary {
  opId: string | null;
  kind: string | null;
  state: string;
  terminal: boolean;
  needsAttention: boolean;
  progress: number;
}

/** 200: what the pass did (`op` null without an op); 202: `{skipped: 'busy'}`; before the install `{installed: false}`. */
export type CronRunResponse =
  | { op: CronOpSummary | null; scheduled: number; slices: number }
  | { skipped: 'busy' }
  | { installed: false };

/** `Authorization: Bearer <token>` → the token (the scheme in any case); null for anything else. */
function bearerToken(header: string | undefined): string | null {
  const match = header === undefined ? null : /^Bearer +([\x21-\x7e]+) *$/i.exec(header);
  return match === null ? null : match[1]!;
}

function summary(op: OpStatus | null): CronOpSummary | null {
  if (op === null) return null;
  return { opId: op.opId, kind: op.kind, state: op.state, terminal: op.terminal, needsAttention: op.needsAttention, progress: op.progress };
}

const NO_STORE = { 'Cache-Control': 'no-store' };

/** config.json as written, for a process that has none in hand (see the top of this file); undefined when unusable. */
async function fileConfig(dataDir: () => string): Promise<Config | undefined> {
  try {
    return (await loadConfig(dataDir(), {})) ?? undefined;
  } catch {
    return undefined; // no DATA_DIR, a damaged file: no token to match
  }
}

const cronRun = route({
  id: 'cron.run',
  method: 'POST',
  path: CRON_PATH,
  public: true,
  auth: 'bearer',
  mode: 'system',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  async handler(rc) {
    const config = rc.c.get('config') ?? (await fileConfig(() => rc.services.dataDir));
    const token = bearerToken(rc.c.req.header('authorization'));
    // Without a config there is no token to match: the same answer as a wrong one.
    if (config === undefined || token === null || !safeEqual(token, config.secrets.cronToken)) {
      throw new DomainError('CRON_TOKEN_INVALID');
    }
    const dataDir = rc.services.dataDir;
    // R1c-14: a call that waited for the boot (phase gate) works on the clock of now, with what the wait left of its
    // budget (`rc.now` is when it reached this process).
    const now = rc.services.clock();
    const budgetMs = CRON_BUDGET_MS - Math.min(Math.max(now - rc.now, 0), CRON_BOOT_WAIT_MS);
    if (config.installState !== 'complete') {
      await writeCronSeen(dataDir, 'cron_http', now);
      return { body: { installed: false } satisfies CronRunResponse, headers: NO_STORE };
    }
    const busy = { status: 202, body: { skipped: 'busy' } satisfies CronRunResponse, headers: NO_STORE };
    if (rc.services.retired || !(await cronFlight(dataDir, now))) return busy;
    const jobs = rc.services.jobs;
    // No runtime (a process that is not ready, Task 15's ops_wait): the op alone is stepped, unless the handler was
    // retired meanwhile (its ops machine is being closed). A stopped runtime's cron() runs nothing by itself.
    if (jobs === null && rc.services.retired) return busy;
    const report = jobs === null ? { op: await rc.services.ops.step(budgetMs), scheduled: 0, slices: 0 } : await jobs.cron('cron_http', budgetMs);
    const body: CronRunResponse = { op: summary(report.op), scheduled: report.scheduled, slices: report.slices };
    return { body, headers: NO_STORE };
  },
});

/** The cron route (route catalog `cron.run`). */
export const CRON_ROUTES: RouteDecl[] = [cronRun];
