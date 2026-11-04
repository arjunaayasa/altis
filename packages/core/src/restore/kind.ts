import type { OpKindHandler } from '../ops/machine.js';
import { createRestoreEngine, type RestoreKindDeps } from './runner.js';

// The `restore` op kind (spec §9.10, §9.4; decisions C16, C17, C18, C25, C44; preflight B4, S2, S4, S5, S6, S13, S23;
// rulings R1c-3, R1c-6, R1c-9; P7, P9, P14, P17, P21; plan Task 22). Maintenance `restore` (the gate closes everything
// but the ops routes, `/_health` and the step of `/_cron`), freeze (no live job lease, at least 3 s, at most 60 s)
// before the first step. Every state's work is checkpointed in `op.params` (fixed-size checkpoints), every step
// returns by its deadline, and any process may step the op (a process booting meanwhile waits in `ops_wait`, B4):
//
//   verifying            the source (source.ts): this installation's HMAC? (external if not: refused without
//                        `confirmed`, BACKUP_CONFIRM_REQUIRED); the schemaVersion known to the code (else
//                        BACKUP_SCHEMA_TOO_NEW); the secrets branch (secrets.ts); every part's SHA-256 (a server
//                        backup) or the extraction into tmp/<opId>/src/ (an archive), resumable per part or entry
//   prechecked           the read-only pre-pass (prepass.ts) → `ops/<opId>/report.json`; a conflict fails the op
//                        (RESTORE_CONFLICTS) with the database untouched. Then the target's `schema_meta.install_id`
//                        and schema version, read before anything is dropped
//   pre_restore          unless `skipPreRestore`: a DB-only backup of kind `pre_restore` of the live database (Task 11's
//                        exporter on the op's dedicated connection, `frozen`: we are in maintenance), its id the op's,
//                        after ensureHeadroom(DATA_DIR, 1.5 × the newest backup)
//   preserving           the target's install and history rows to `ops/<opId>/keep/` (keep.ts); then the point of no
//                        return is written to op.json (with the move to `loading`) before anything is dropped
//   loading              load.ts on the work handle (the dedicated pool-1 connection, P17/S4; Task 25's work file on
//                        SQLite): the drop, the archive-level migrations, the tables, the schedules
//   migrating            runMigrations to the code's latest schema (`targetSchema: 'latest'`, C44); skipped with
//                        `targetSchema: 'backup'` (1d), whose load stops at the backup's schema
//   finalizing           finalize.ts's steps 1–7 → `done`, then requestRestart('restore') (P14; every other process
//                        restarts through its fence's data-epoch look, S23). Step 7 (report, audit entry,
//                        notification) never sends the op back: a failure is tried again by the next step, and after
//                        OPS_STALL_MS of failures the op moves to `needs_attention` (maintenance stays; resumed, the
//                        step is tried again)
//   failed_restoring_pre a failure past the point of no return (a full disk included): the same load, migrations and
//                        steps 1, 5, 6, 7 from the `pre_restore` backup (branch a) → `failed` with
//                        `notification.restore_failed`; on SQLite Task 25's rename back instead. A failure here is
//                        thrown: the machine moves the op to `needs_attention`, maintenance stays (S13)
//
// A failure before the point of no return ends the op `failed`: tmp/<opId>/ removed, an unfinished `pre_restore`
// backup abandoned, `backup.restore` audited with outcome `failed` (the database is intact), `disk_low` after a full
// disk; the machine lowers the maintenance flag. A lost connection or a busy lock leaves the op for the next step.
//
// The steps themselves live in runner.ts (1d Task 12), which the update's automatic revert also runs inside its own op
// (createRestoreRunner); this file is the op kind around them, and owns `pre_restore` and `failed_restoring_pre`.

export type { RestoreKindDeps, RestoreParams, SqliteSwap, SqliteSwapWait } from './runner.js';

/**
 * The `restore` op kind (see the top of this file).
 *
 * @throws TypeError when `deps` are not usable
 */
export function restoreKind(deps: RestoreKindDeps): OpKindHandler {
  const engine = createRestoreEngine(deps, 'kind');
  return {
    kind: 'restore',
    initialState: 'verifying',
    maintenance: 'restore',
    freeze: true,
    step: (ctx, op) => engine.step(ctx, op),
    cancel: (ctx, op) => engine.cancel(ctx, op),
  };
}
