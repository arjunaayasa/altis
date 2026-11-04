import { withTx, type DbHandle } from '@altis/db';
import { txCtx } from '../context.js';
import type { notify as notifyFn } from '../notifications/service.js';
import type { OpFile } from '../ops/files.js';
import type { OpStepContext } from '../ops/machine.js';
import { actorOf } from '../restore/finalize.js';
import { RELEASE_LOG_FINAL, insertReleaseLog, readReleaseLog, setReleaseLogStatus } from './releases-log.js';

// The end of an update op (spec §9.6 step 7 "catat di `releases_log` dan audit, kirim notifikasi", §9.7; decisions
// C25, D1d-38; preflight B7): one transaction sets the op's `releases_log` row to its final status, writes the op's
// own audit entry `update.apply {outcome, target, from, backupId, error?}` and notifies the holders of
// `system.update.run`. The row is inserted first when it is absent (an op begun at `verified` that failed before its
// `verified` step ran, B7).
//
// Idempotent: a row that already has a final status means this end was recorded (a step that died after the commit,
// P7), and nothing more is written, so every op has exactly one `update.apply` and one notification whatever runs it
// again. The update kind calls it before the machine writes the ended op.json: an op whose row is final already is
// ended by its next step (kind.ts).

/** The outcomes of an update op. */
export type UpdateOutcome = 'done' | 'aborted' | 'rolled_back' | 'restored' | 'restore_failed';

/** Where the update notifications lead: Pembaruan, or the operations page while the installation stays in maintenance. */
const UPDATES_LINK = '/admin/updates';
const OPS_LINK = '/admin/_update';

/** The notification of each outcome: its type and its catalog key (`notification.<key>.title` and `.body`). */
const NOTIFICATIONS = Object.freeze({
  done: { type: 'update.done', titleKey: 'notification.update_done.title', link: UPDATES_LINK },
  aborted: { type: 'update.failed', titleKey: 'notification.update_failed.title', link: UPDATES_LINK },
  rolled_back: { type: 'update.rolled_back', titleKey: 'notification.update_rolled_back.title', link: UPDATES_LINK },
  restored: { type: 'update.restored', titleKey: 'notification.update_restored.title', link: UPDATES_LINK },
  restore_failed: { type: 'update.restore_failed', titleKey: 'notification.update_restore_failed.title', link: OPS_LINK },
} as const) satisfies Readonly<Record<UpdateOutcome, { type: string; titleKey: string; link: string }>>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Records the end of the update op `op` with `outcome` (see the top of this file): its `releases_log` row (inserted
 * when absent: target, from, the op's start), `update.apply` audited as the op's actor, and the outcome's notification
 * to `system.update.run`, in one transaction on `ctx.db()` (or the op's dedicated connection). Does nothing when the row
 * has a final status already. `op.error` (null for an operator's cancel) is recorded in the row's detail and, as its
 * code, in the audit entry.
 *
 * @throws the database's errors (`DB_UNAVAILABLE`, ...: nothing was written); TypeError for an op whose
 *   `params.target` or `params.from` is not a version the row can hold
 */
export async function finishUpdate(
  ctx: OpStepContext,
  op: OpFile,
  outcome: UpdateOutcome,
  deps: { notify: typeof notifyFn },
): Promise<void> {
  const h: DbHandle = ctx.db() ?? (await ctx.connectDedicated());
  const target = text(op.params['target']);
  const from = text(op.params['from']);
  if (target === null || from === null) throw new TypeError('finishUpdate: the op has no params.target or params.from');
  const now = ctx.now();
  const n = NOTIFICATIONS[outcome];
  await withTx(h, async (trx) => {
    const row = await readReleaseLog(trx, op.opId);
    if (row !== null && RELEASE_LOG_FINAL.has(row.status)) return;
    if (row === null) {
      await insertReleaseLog(trx, { id: op.opId, version: target, action: 'update', fromVersion: from, startedAt: op.startedAt, backupId: op.backupId });
    }
    const backupId = op.backupId ?? row?.backupId ?? null;
    const detail: Record<string, unknown> = { outcome };
    if (op.error !== null) detail['error'] = op.error;
    await setReleaseLogStatus(trx, op.opId, outcome, { finishedAt: now, backupId, detail });
    const meta: Record<string, unknown> = { outcome, target, from, backupId };
    if (op.error !== null) meta['error'] = op.error.code;
    await txCtx(trx, now, actorOf(op.actor)).audit({ action: 'update.apply', entity: 'releases_log', entityId: op.opId, meta });
    // The notification last: its event is the transaction's last statement (§10.6).
    await deps.notify(
      trx,
      {
        audience: { permission: 'system.update.run' },
        type: n.type,
        titleKey: n.titleKey,
        params: { version: target },
        link: n.link,
      },
      now,
    );
  });
}
