/**
 * The ops API vocabulary shared by the server and the admin (spec §9.4, §13.5 "Ops"; plan Task 15): what `GET
 * ops/current`, `POST ops/drive|cancel|takeover` answer, and the body of `POST ops/drive`. No Node built-ins here: the
 * browser bundles this module. Import it as `@altis/shared/api/ops`.
 *
 * The routes are `opsAuth` (§9.4): a session holding the permission of the op's kind (`OP_KIND_PERMISSION`; without an
 * op, any of `system.update.run`, `system.backup.restore`, `system.backup.create`), or a valid `altis_ops` cookie (the
 * one the op's begin or takeover set, good until the op ended + 1 hour). With the cookie alone, a write sends
 * `X-CSRF-Token` = the op's CSRF token, which {@link OpView}`.csrfToken` carries; with a session, the session's token.
 * During a restore past its point of no return only the cookie works (the tables may be gone). `cancel` and
 * `takeover` need a session with a fresh re-authentication (§7.3) whatever cookie the browser holds.
 *
 * - `GET ops/current` → 200 {@link OpView}; 404 `OPS_NONE` without a current op (none, or one that ended more than an
 *   hour ago).
 * - `POST ops/drive` {@link OpsDriveBody} → 200 {@link OpView}: `resume: true` first moves an op in `needs_attention`
 *   back to the state it left; then, in `external` mode, the op is stepped for up to 20 s (P9); in `worker` mode the
 *   process's worker steps it and the answer is the status as it is (spec §10.2).
 * - `POST ops/cancel` → 200 {@link OpView} of the cancelled op; 409 `OPS_POINT_OF_NO_RETURN` past its point of no
 *   return; 404 `OPS_NONE` without an op that has not ended.
 * - `POST ops/takeover` → 200 {@link OpView}, and a new `altis_ops` cookie: the op's actor is the caller, the old
 *   cookie stops working.
 * - `GET ops/report` → the op's report (`ops/<opId>/report.json`, e.g. a restore's conflict report) as an
 *   `application/json` attachment; 404 `NOT_FOUND` when the op has none.
 */
import { z } from 'zod';
import type { OpKind } from '../ops.js';

/** Who began (or took over) an op; `id` is a staff user's id, null for the CLI, the installer and the system. */
export interface OpActorView {
  type: 'staff' | 'cli' | 'install' | 'system';
  id: string | null;
}

/**
 * The status of an op (the server's `OpStatus`). For an `op.json` that cannot be read (nor its `.bak`): state
 * `needs_attention`, error `STATE_CORRUPT`, `pointOfNoReturn: true`, the id and kind from the maintenance flag (null
 * when it names none), `startedAt`/`heartbeatAt`/`actor` null.
 */
export interface OpStatusView {
  opId: string | null;
  kind: OpKind | null;
  /** A state of the kind (`ops.state.<state>` names it), or `needs_attention`. */
  state: string;
  terminal: boolean;
  needsAttention: boolean;
  startedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  /** 0 to 100. */
  progress: number;
  message: string | null;
  /** A registered error code (`error.<CODE>`) and an authored detail. */
  error: { code: string; detail?: string } | null;
  pointOfNoReturn: boolean;
  backupId: string | null;
  actor: OpActorView | null;
}

/**
 * 1d Task 29: what the operations page shows of an `update` op besides its status, from its `op.json` params: the
 * release it installs, and whether its prechecks found the running release below the target's `minCodeVersionAfter`
 * (§9.6 "pemulihan DB diperlukan bila gagal").
 */
export interface OpUpdateView {
  target: string | null;
  dbRestoreNeeded: boolean;
}

/** What the ops routes answer: the op's status, how this server runs its work, and what a page needs to drive it. */
export type OpView = OpStatusView & {
  /** `worker`: the server's worker loop steps the op; `external`: a page (or `/_cron`) must call `POST ops/drive`. */
  mode: 'worker' | 'external';
  /** The `X-CSRF-Token` for the ops writes of a caller authenticated by the `altis_ops` cookie; null with a session. */
  csrfToken: string | null;
  /** The op can move by steps: it has not ended and does not wait for a person (`needs_attention`). */
  driveable: boolean;
  /** 1d Task 29: present for an `update` op only (app.js's minimal serving never sends it). */
  update?: OpUpdateView;
};

/** The body of `POST ops/drive`: `resume` moves an op in `needs_attention` back to its state first. */
export const OpsDriveBody = z.strictObject({ resume: z.boolean().optional() });

export type OpsDriveBody = z.infer<typeof OpsDriveBody>;

/** The error of a `schemaHold` update that failed past its point of no return (§9.8 row 3, 1d Task 27). */
const SCHEMA_HOLD_FAILED = 'UPDATE_SCHEMA_HOLD_FAILED';

/**
 * The CLI way out the operations page (`#cli`) and Diagnostik show for `op` (none: an empty list). The page's inline
 * script mirrors it (apps/server/src/ops/update-script.ts).
 *
 * - An op that needs attention (final review OPS-ATTN-EXIT): `ops:resume`, and before its point of no return
 *   `ops:cancel` as the other choice. An op.json nobody can read (no `startedAt`): `ops:cancel` sets it aside
 *   (maintenance stays), then `maintenance:off` once the data is checked, or the newest backup (`releases_log`, spec
 *   §9.4) restored.
 * - An update whose revert failed to restore its `pre_update` backup (`restore_failed`, the "terlalu lama" mode of
 *   §9.7: "`/admin/_update` menampilkan langkah CLI (`backup:restore <id>`, `release:rollback`)", 1d Task 29):
 *   `maintenance:off --force`, `backup:restore <backupId>`, then `release:rollback`. A `schemaHold` update that failed
 *   (error `UPDATE_SCHEMA_HOLD_FAILED`, §9.8 row 3) has no release to roll back to (`previous` is null): the first two
 *   only, run under the previous image or zip as `ops.page.schema_hold` says.
 * - A restore that failed after going back to `pre_restore` (`seenRestoringPre`, or `failed` past its point of no
 *   return, which always went through `failed_restoring_pre`): `maintenance:off --force`, then
 *   `backup:restore <backupId>`.
 */
export function opCliLines(op: OpStatusView | null, seenRestoringPre = false): string[] {
  if (op === null) return [];
  const restore = `node app.js backup:restore ${op.backupId ?? '<backupId>'}`;
  if (op.needsAttention) {
    if (op.startedAt === null) return ['node app.js ops:cancel', 'node app.js maintenance:off', restore];
    return op.pointOfNoReturn ? ['node app.js ops:resume'] : ['node app.js ops:resume', 'node app.js ops:cancel'];
  }
  if (op.kind === 'update' && op.state === 'restore_failed' && op.error?.code !== SCHEMA_HOLD_FAILED) {
    return ['node app.js maintenance:off --force', restore, 'node app.js release:rollback'];
  }
  const failedRestore = op.kind === 'restore' && op.state === 'failed' && (seenRestoringPre || op.pointOfNoReturn);
  if (op.state === 'restore_failed' || failedRestore) return ['node app.js maintenance:off --force', restore];
  return [];
}
