import { NEEDS_ATTENTION, OP_STATES, isTerminal, type OpKind } from '@altis/shared';
import type { OpFile } from './files.js';

// 1d Task 11 (decision D1d-14, preflight B8, S4, 1D-02): which states of an op hold its maintenance flag, and what a
// starting server does about the op it finds (`opBootPlan`).
//
// An `update` holds neither the flag nor the freeze before `verified` (§9.6: download and verification run while the
// site serves); a `rollback` (pointers only, §9.7) never holds one; every other kind holds it from `begin` to its end.
// The machine judges a running op by its kind's handler (`maintenance`, `maintenanceFrom`); `start()` judges the op it
// finds before any handler exists, by the static table below, which agrees with the handlers (a test checks it). An
// op in `needs_attention`, which is not in `OP_STATES`, is judged by the state it left (`effectiveState`).

/**
 * The state from which an op of each kind holds its maintenance flag: `'all'` for every state, null for none. The
 * terminal states hold none, except those that keep maintenance ({@link KEEPS_MAINTENANCE}).
 */
export const KIND_MAINTENANCE_FROM: Readonly<Record<OpKind, string | 'all' | null>> = Object.freeze({
  update: 'verified',
  rollback: null,
  restore: 'all',
  backup: 'all',
  migrate: 'all',
  reset: 'all',
  'install-migrate': 'all',
});

/** Terminal states after which the maintenance flag stays up: the installation is not usable as it is (§9.7). */
export const KEEPS_MAINTENANCE: ReadonlySet<string> = new Set(['restore_failed']);

/** The state `op` is judged by: the one it left for `needs_attention` (its `stateBefore`), else its state. */
export function effectiveState(op: OpFile): string {
  return op.state === NEEDS_ATTENTION ? (op.stateBefore ?? op.state) : op.state;
}

/**
 * Whether an op of `kind` whose flag is raised from `from` (`'all'`, null for never, else a state of the kind) holds it
 * in `state`. In the kind's `OP_STATES` order, a state at or after `from` holds it; a terminal state only when it keeps
 * maintenance. A state that cannot be placed (`needs_attention` itself, or one the kind does not have) counts as
 * holding it: nothing is served as normal while an op nobody can place may be writing.
 */
export function holdsFrom(kind: OpKind, from: string | 'all' | null, state: string): boolean {
  if (from === null) return false;
  if (isTerminal(kind, state)) return KEEPS_MAINTENANCE.has(state);
  if (from === 'all') return true;
  const states = OP_STATES[kind];
  const at = states.indexOf(state);
  return at < 0 || at >= states.indexOf(from);
}

/**
 * Whether an op of `kind` holds its maintenance flag in `state` ({@link KIND_MAINTENANCE_FROM}). Pass
 * {@link effectiveState} of an op, so that one in `needs_attention` is judged by the state it left (S4).
 */
export function holdsMaintenance(kind: OpKind, state: string): boolean {
  return holdsFrom(kind, KIND_MAINTENANCE_FROM[kind], state);
}

/**
 * What `start()` does about the op it finds (Task 25):
 * - `normal`: boots as usual (no op, an op that ended, or one that holds no maintenance);
 * - `ops_wait`: serves maintenance and waits for the op (a process that cannot step it may not serve);
 * - `update_boot`: this release is the update's target and boots it (migrations, verification, promotion);
 * - `revert`: steps the update's revert (`reverting`, `restoring`) in this release, which is not the target;
 * - `refuse`: rejects at once with `UPDATE_BOOT_FAILED`, before it opens anything, so that app.js reverts the pending
 *   release in the same process.
 */
export type BootPlan = 'normal' | 'ops_wait' | 'update_boot' | 'revert' | 'refuse';

/** The states of an update op the target boots through while it is pending (after the point of no return). */
const PENDING_BOOT_STATES: ReadonlySet<string> = new Set(['switched', 'booting', 'migrating', 'verifying']);

/** The states of an update op that the release it leaves steps back (§9.7). */
const REVERT_STATES: ReadonlySet<string> = new Set(['reverting', 'restoring']);

/** The plan before the pending-boot rule of {@link opBootPlan}. */
function planOf(op: OpFile | 'corrupt' | null, version: string, pendingBoot: boolean): BootPlan {
  if (op === null) return 'normal';
  if (op === 'corrupt') return 'ops_wait';
  if (isTerminal(op.kind, op.state)) return 'normal';
  const st = effectiveState(op);
  if (op.kind !== 'update') return holdsMaintenance(op.kind, st) ? 'ops_wait' : 'normal';
  if (op.params['target'] === version) {
    if (REVERT_STATES.has(st)) return 'refuse'; // the target never steps its own revert (B8)
    if (pendingBoot && op.state === NEEDS_ATTENTION) return 'refuse'; // stuck after the point of no return (1D-02)
    if (pendingBoot && PENDING_BOOT_STATES.has(st)) return 'update_boot';
    if (op.params['source'] === 'self' && st !== 'checking' && st !== 'downloading') {
      return op.state === NEEDS_ATTENTION ? 'ops_wait' : 'update_boot';
    }
    if (st === 'verifying') return 'update_boot'; // promoted, `finishUpdate` not yet written
  }
  if (REVERT_STATES.has(st)) return 'revert';
  // Steps of a release other than the target heal the op (Tasks 24, 25); `checking` and `downloading` hold nothing.
  return holdsMaintenance('update', st) ? 'ops_wait' : 'normal';
}

/**
 * The boot plan for the op `start()` finds (`readOpFile`: the op, `'corrupt'` for an unreadable op.json and `.bak`, or
 * null), in the release `version`, booting a pending release (`pendingBoot`, app.js's `ctx.pendingBoot`) or not.
 * Ops are judged by {@link effectiveState} (preflight S4, 1D-02). A pending holder never waits or boots normally: with
 * `pendingBoot` every plan but `update_boot` is `refuse`, so that it never keeps `boot.lock` while it waits.
 */
export function opBootPlan(op: OpFile | 'corrupt' | null, version: string, pendingBoot: boolean): BootPlan {
  const plan = planOf(op, version, pendingBoot);
  return pendingBoot && plan !== 'update_boot' ? 'refuse' : plan;
}
