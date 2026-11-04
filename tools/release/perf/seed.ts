import { randomBytes } from 'node:crypto';
import { auditAppend, connect, withTx, type DbConfig } from '@altis/db';
import { newId } from '@altis/shared';
import type { SmokeSession } from '../smoke/run.js';

// The seed `perf-phase1` of the §12.7 budgets (A11; plan Task 35): 50 staff, 200 000 `audit_log` entries and 10 000
// `jobs`, on an installed database. The staff are made through the API, as an administrator makes them (`POST users`,
// one request each); the audit entries through @altis/db's `auditAppend`, the very primitive every action of the
// server writes its entry with (hash chain and all), in transactions of AUDIT_BATCH entries; the jobs are the history
// a busy installation keeps (succeeded `update.check` runs, a few dead), written as rows of `jobs`.
//
// perf/measure.ts runs it between the install and the measurement; it can also be imported on its own.

export const PERF_SEED = Object.freeze({ name: 'perf-phase1', staff: 50, audit: 200_000, jobs: 10_000 });

/** Audit entries appended per transaction. */
const AUDIT_BATCH = 1000;
/** Job rows inserted per statement. */
const JOB_BATCH = 500;
/** The audit actions the seed spreads its entries over (registered actions of Phase 1). */
const AUDIT_ACTIONS = ['auth.login', 'auth.logout', 'users.update', 'settings.update', 'roles.update', 'backup.create'] as const;

export interface PerfSeedOptions {
  /** The installation's database (install.json's `db`) and DATA_DIR (SQLite lives there). */
  db: DbConfig;
  dataDir: string;
  /** A signed-in super admin of the running installation (re-authenticated by the caller for `POST users`). */
  admin: SmokeSession;
  /** Progress lines. */
  say?: (line: string) => void;
}

export interface PerfSeedResult {
  staff: number;
  audit: number;
  jobs: number;
  ms: number;
}

/** The staff of the seed, through the API (the server must run). */
export async function seedPerfStaff(o: Pick<PerfSeedOptions, 'admin' | 'say'>, count: number = PERF_SEED.staff): Promise<number> {
  for (let i = 1; i <= count; i += 1) {
    await o.admin.call('POST', 'users', {
      username: `perf_${String(i).padStart(3, '0')}`,
      name: `Staf Kinerja ${i}`,
      email: `perf${i}@perf.test`,
      password: `${randomBytes(12).toString('hex')}-Perf`,
    });
    if (i % 10 === 0) o.say?.(`perf seed: ${i} staff`);
  }
  return count;
}

/** The audit entries and jobs of the seed, straight into the database (the server may run or not). */
export async function seedPerfHistory(o: Pick<PerfSeedOptions, 'db' | 'dataDir' | 'say'>, counts: { audit: number; jobs: number } = PERF_SEED): Promise<{ audit: number; jobs: number }> {
  const h = await connect(o.db, { runtime: 'standalone', purpose: 'cli', dataDir: o.dataDir });
  try {
    const staff = (await h.db.selectFrom('staff_users').select('id').execute()).map((r) => r.id);
    // Spread over the last 90 days, oldest first (the chain wants increasing times; none ahead of the clock).
    const start = Date.now() - 90 * 86_400_000;
    const step = Math.max(1, Math.floor((90 * 86_400_000) / Math.max(1, counts.audit)));
    let written = 0;
    while (written < counts.audit) {
      const n = Math.min(AUDIT_BATCH, counts.audit - written);
      const first = written;
      await withTx(h, async (trx) => {
        for (let k = 0; k < n; k += 1) {
          const i = first + k;
          await auditAppend(trx, {
            at: start + i * step,
            actorType: 'staff',
            actorId: staff.length === 0 ? null : staff[i % staff.length]!,
            action: AUDIT_ACTIONS[i % AUDIT_ACTIONS.length]!,
            entity: 'staff_user',
            entityId: staff.length === 0 ? null : staff[(i * 7) % staff.length]!,
            branchId: null,
            ip: `10.0.${(i >> 8) & 255}.${i & 255}`,
            meta: { seed: PERF_SEED.name, i },
          });
        }
      });
      written += n;
      if (written % 20_000 === 0) o.say?.(`perf seed: ${written} audit entries`);
    }
    let jobs = 0;
    while (jobs < counts.jobs) {
      const n = Math.min(JOB_BATCH, counts.jobs - jobs);
      const rows = Array.from({ length: n }, (_, k) => {
        const i = jobs + k;
        const at = start + i * Math.floor((90 * 86_400_000) / Math.max(1, counts.jobs));
        const dead = i % 50 === 49;
        return {
          id: newId(at),
          type: 'update.check',
          payload: JSON.stringify({ reason: 'schedule' }),
          secret_param: null,
          status: dead ? 'dead' : 'succeeded',
          run_at: at,
          attempts: dead ? 5 : 1,
          max_attempts: 5,
          unique_key: null,
          lock_token: null,
          locked_by: null,
          locked_until: null,
          progress: 100,
          progress_message: null,
          last_error: dead ? 'FEED_UNREACHABLE' : null,
          created_by: null,
          created_at: at,
          updated_at: at + 1000,
          finished_at: at + 1000,
        };
      });
      await withTx(h, (trx) => trx.insertInto('jobs').values(rows).execute());
      jobs += n;
    }
    o.say?.(`perf seed: ${jobs} jobs`);
    return { audit: written, jobs };
  } finally {
    await h.close();
  }
}

/** The whole seed `perf-phase1` (see the top of this file). */
export async function seedPerf(o: PerfSeedOptions): Promise<PerfSeedResult> {
  const t0 = Date.now();
  const staff = await seedPerfStaff(o);
  const history = await seedPerfHistory(o);
  return { staff, ...history, ms: Date.now() - t0 };
}
