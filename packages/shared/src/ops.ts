/**
 * The op vocabulary of Phase 1c (spec §9.4): which kinds of exclusive operation exist, the states each one moves
 * through, which of those end it, and which permission may drive, take over or cancel it.
 *
 * `OP_STATES` is the frozen `opSchema 1` set. Every release must be able to resume every state listed here, so a
 * state is never renamed or removed, and a change to the set means a new `opSchema` (`OP_SCHEMA`). `op.json` and
 * `releases_log.status` hold a state as text (at most 32 characters, lower-case words joined by `_`).
 *
 * No Node built-ins here: the browser bundles this package.
 */
import type { Permission } from './permissions.js';

/** The `opSchema` field of `op.json`. The state sets below are frozen for it. */
export const OP_SCHEMA = 1;

/** The kinds of operation, in the order of spec §9.4. Each takes the ops lock (`DATA_DIR/ops/op.json`, created with `wx`). */
export const OP_KINDS = Object.freeze(['install-migrate', 'update', 'rollback', 'restore', 'backup', 'migrate', 'reset'] as const);

export type OpKind = (typeof OP_KINDS)[number];

/** The one state every kind accepts: an op that did not move for 15 minutes, or whose `op.json` and `.bak` are both corrupt. */
export const NEEDS_ATTENTION = 'needs_attention';

/** Freezes a record of kind → list, and every list in it. */
function freezeLists(lists: Record<OpKind, readonly string[]>): Readonly<Record<OpKind, readonly string[]>> {
  for (const kind of OP_KINDS) Object.freeze(lists[kind]);
  return Object.freeze(lists);
}

/** The states of `opSchema 1` for each kind, in the order an op normally passes through them (copied from spec §9.4). */
const STATES = {
  update: [
    'checking',
    'downloading',
    'verified',
    'frozen',
    'backed_up',
    'staged',
    'switched',
    'booting',
    'migrating',
    'verifying',
    'done',
    'aborted',
    'reverting',
    'rolled_back',
    'restoring',
    'restored',
    'restore_failed',
  ],
  restore: [
    'verifying',
    'prechecked',
    'pre_restore',
    'preserving',
    'loading',
    'migrating',
    'finalizing',
    'done',
    'failed_restoring_pre',
    'failed',
  ],
  backup: ['frozen', 'exporting', 'done', 'aborted'],
  'install-migrate': ['running', 'done', 'failed'],
  migrate: ['running', 'done', 'failed'],
  reset: ['running', 'done', 'failed'],
  rollback: ['running', 'done', 'failed'],
} as const satisfies Record<OpKind, readonly string[]>;

/** Every state of every kind, plus {@link NEEDS_ATTENTION}: the names that need a label (`ops.state.<state>`). */
export type OpState = (typeof STATES)[OpKind][number] | typeof NEEDS_ATTENTION;

/** The `opSchema 1` states of each kind, without {@link NEEDS_ATTENTION}, which every kind also accepts. */
export const OP_STATES: Readonly<Record<OpKind, readonly string[]>> = freezeLists(STATES);

/** The states that end an op: nothing moves it afterwards. Every one of them is in the kind's {@link OP_STATES}. */
export const OP_TERMINAL_STATES: Readonly<Record<OpKind, readonly string[]>> = freezeLists({
  update: ['done', 'aborted', 'rolled_back', 'restored', 'restore_failed'],
  restore: ['done', 'failed'],
  backup: ['done', 'aborted'],
  'install-migrate': ['done', 'failed'],
  migrate: ['done', 'failed'],
  reset: ['done', 'failed'],
  rollback: ['done', 'failed'],
});

/**
 * The permission that may take over or cancel an op of the kind (and that decides who sees the maintenance page
 * `/admin/_update`): `update` and `rollback` need `system.update.run`, `restore` needs `system.backup.restore`,
 * `backup` needs `system.backup.create`; the install and CLI kinds are `system.config.manage`.
 */
export const OP_KIND_PERMISSION: Readonly<Record<OpKind, Permission>> = Object.freeze({
  update: 'system.update.run',
  rollback: 'system.update.run',
  restore: 'system.backup.restore',
  backup: 'system.backup.create',
  'install-migrate': 'system.config.manage',
  migrate: 'system.config.manage',
  reset: 'system.config.manage',
});

/** True when `kind` is one of {@link OP_KINDS}, as an own key: `constructor` and `__proto__` are not. */
function knownKind(kind: string): kind is OpKind {
  return Object.hasOwn(OP_STATES, kind);
}

/** True when `s` is a state of `kind`'s `opSchema 1` set, or {@link NEEDS_ATTENTION}, which every kind accepts. */
export function isOpState(kind: OpKind, s: string): boolean {
  if (!knownKind(kind)) return false;
  return s === NEEDS_ATTENTION || OP_STATES[kind].includes(s);
}

/** True when `s` ends an op of `kind`. {@link NEEDS_ATTENTION} does not: such an op is resumed, taken over or cancelled. */
export function isTerminal(kind: OpKind, s: string): boolean {
  if (!knownKind(kind)) return false;
  return OP_TERMINAL_STATES[kind].includes(s);
}
