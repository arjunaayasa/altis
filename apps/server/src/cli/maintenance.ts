import { activeOp, clearMaintenance, readMaintenance, txCtx, withControlLock, writeMaintenance, type Actor, type AuditInput } from '@altis/core';
import { connect, withTx } from '@altis/db';
import type { Env } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { loadConfig } from '../config.js';
import type { BootContext } from '../index.js';

// `node app.js maintenance:on [--reason <text>]` and `maintenance:off [--force]` (spec §9.4, §13.6; 1c Task 24):
//
// - `on` raises the manual flag `DATA_DIR/ops/maintenance.json` `{reason: 'manual', since, opId: null,
//   exemptJobIds: []}`; every process's ops fence sees it within 2 s and the gate answers 503 (Task 15). A flag that is
//   up already (manual, or an op's) is left as it is: an op's flag must keep its reason and op.
// - `off` lowers the flag. While `ops/op.json` holds an op that has not ended (or cannot be read) it is refused with
//   OPS_IN_PROGRESS unless `--force`: a running op's next step raises its own flag again anyway (M21); a frozen
//   backup then freezes again from the start (final review G2), and a restore before its point of no return ends
//   `failed` with OPS_FREEZE_BROKEN, the database untouched (R1c-15). An op in `needs_attention` keeps a forced-off
//   flag off (final review OPS-ATTN-EXIT; R1c-12's Diagnostik block) until it is resumed, which does the same; a
//   restore past its point of no return does neither (its half-loaded tables are never served: its next step raises
//   the flag again). It still holds the ops lock: processes that boot meanwhile wait in `ops_wait`
//   and no op can begin. Its way out is `ops:resume` or `ops:cancel` (cli/ops.ts); `--force` serves the processes
//   that are up meanwhile.
//
// Both read and write the flag under `ops/step.lock`, the lock the OpsMachine writes op.json and the flag under, so a
// command never interleaves with an op beginning or ending. The audit entry (`maintenance.on {reason}`,
// `maintenance.off {force}`, actor `cli`) is written when the flag changed and the database answers: maintenance is
// also for an installation whose database is down, so its absence is no failure (`audited: false`).

/** Who the audit entries name: the CLI. */
const CLI_ACTOR: Actor = { type: 'cli', id: null, ip: null };
/** A step in progress holds `ops/step.lock` for up to 20 s and its last unit of work. */
const LOCK_WAIT_MS = 30_000;
/** Connecting for the audit entry gives up sooner than a server would: the flag is already written. */
const AUDIT_CONNECT_MS = 5000;

export interface MaintenanceOnResult {
  /** A flag was up already (it was kept). */
  alreadyOn: boolean;
  audited: boolean;
}

export interface MaintenanceOffResult {
  /** A flag was up (and is now removed). */
  wasOn: boolean;
  audited: boolean;
}

/**
 * `fn` under `ops/step.lock`, ahead of the steppers (withControlLock: a step under way stops after its handler step and
 * none begins meanwhile; final review).
 *
 * @throws DomainError `OPS_IN_PROGRESS` when the lock stayed held for 30 s
 */
function underStepLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  return withControlLock(dataDir, { now: () => Date.now(), waitMs: LOCK_WAIT_MS }, () => fn());
}

/**
 * Writes `entry` (actor `cli`) when the installed database answers.
 *
 * @returns false, with nothing written, when DATA_DIR is not installed or the database cannot be reached or written
 */
export async function auditIfAnswering(ctx: BootContext, env: Env, entry: AuditInput): Promise<boolean> {
  let config;
  try {
    config = await loadConfig(ctx.dataDir, env);
  } catch {
    return false;
  }
  if (config === null || config.installState !== 'complete') return false;
  let h;
  try {
    h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir, connectTimeoutMs: AUDIT_CONNECT_MS });
  } catch {
    return false;
  }
  try {
    await withTx(h, (trx) => txCtx(trx, Date.now(), CLI_ACTOR).audit(entry));
    return true;
  } catch {
    return false;
  } finally {
    await h.close();
  }
}

/**
 * `maintenance:on`: raises the manual flag (unless one is up) and audits `maintenance.on {reason}`.
 *
 * @param reason the operator's note (`--reason`), or null
 */
export async function maintenanceOn(ctx: BootContext, env: Env, reason: string | null): Promise<MaintenanceOnResult> {
  const raised = await underStepLock(ctx.dataDir, async () => {
    if ((await readMaintenance(ctx.dataDir)) !== null) return false;
    await writeMaintenance(ctx.dataDir, { reason: 'manual', since: Date.now(), opId: null, exemptJobIds: [] });
    return true;
  });
  if (!raised) return { alreadyOn: true, audited: false };
  const audited = await auditIfAnswering(ctx, env, { action: 'maintenance.on', entity: null, entityId: null, meta: { reason } });
  return { alreadyOn: false, audited };
}

/**
 * `maintenance:off`: lowers the flag, whoever raised it, and audits `maintenance.off {force}`.
 *
 * @throws DomainError `OPS_IN_PROGRESS` while an op has not ended (or op.json cannot be read), unless `force`
 */
export async function maintenanceOff(ctx: BootContext, env: Env, force: boolean): Promise<MaintenanceOffResult> {
  const removed = await underStepLock(ctx.dataDir, async () => {
    if (!force && (await activeOp(ctx.dataDir)) !== null) {
      throw new DomainError('OPS_IN_PROGRESS', {
        detail:
          'Operasi sedang berjalan dan memegang mode pemeliharaan; tunggu sampai selesai, atau bila macet: node app.js ops:resume ' +
          'atau ops:cancel (--force mematikan mode pemeliharaan: backup beku mengulang ekspornya, restore yang belum ' +
          'melewati titik tanpa kembali berakhir gagal dan harus dimulai lagi) / ' +
          'An operation is in progress and holds maintenance; wait until it ends, or when it is stuck: node app.js ops:resume ' +
          'or ops:cancel (--force turns maintenance off: a frozen backup redoes its export, a restore before its point of no ' +
          'return ends failed and must be started again)',
      });
    }
    const flag = await readMaintenance(ctx.dataDir);
    return flag !== null && (await clearMaintenance(ctx.dataDir, flag.opId));
  });
  if (!removed) return { wasOn: false, audited: false };
  const audited = await auditIfAnswering(ctx, env, { action: 'maintenance.off', entity: null, entityId: null, meta: { force } });
  return { wasOn: true, audited };
}

/** The human line of `maintenance:on` (the command first, so scripts can match it). */
export function describeOn(result: MaintenanceOnResult): string {
  const note = result.audited || result.alreadyOn ? '' : ' (audit tidak ditulis: database tidak menjawab / not audited: the database did not answer)';
  return result.alreadyOn
    ? 'maintenance:on: mode pemeliharaan sudah aktif; dibiarkan / maintenance mode is on already; left as it is'
    : `maintenance:on: mode pemeliharaan aktif; server berjalan menerapkannya dalam beberapa detik / maintenance mode is on; running servers apply it within seconds${note}`;
}

/** The human line of `maintenance:off`. */
export function describeOff(result: MaintenanceOffResult): string {
  const note = result.audited || !result.wasOn ? '' : ' (audit tidak ditulis: database tidak menjawab / not audited: the database did not answer)';
  return result.wasOn
    ? `maintenance:off: mode pemeliharaan dimatikan / maintenance mode is off${note}`
    : 'maintenance:off: mode pemeliharaan memang tidak aktif / maintenance mode was not on';
}
