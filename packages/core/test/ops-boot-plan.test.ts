import { NEEDS_ATTENTION, OP_KINDS, OP_STATES, isTerminal, newId, type OpKind } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { backupKind } from '../src/backup/frozen-op.js';
import { KIND_MAINTENANCE_FROM, effectiveState, holdsMaintenance, opBootPlan, type BootPlan } from '../src/ops/boot-plan.js';
import type { OpFile } from '../src/ops/files.js';
import { installMigrateKind } from '../src/ops/kinds/install-migrate.js';
import { migrateKind } from '../src/ops/kinds/migrate.js';
import { resetKind } from '../src/ops/kinds/reset.js';
import type { OpKindHandler } from '../src/ops/machine.js';
import { restoreKind } from '../src/restore/kind.js';
import { rollbackKind } from '../src/updates/rollback.js';

// 1d Task 11 (decision D1d-14, preflight B8, S4, 1D-02): which states of an op hold its maintenance flag
// (KIND_MAINTENANCE_FROM: an update only from `verified`, a rollback never, every other kind in all its states), an op in
// `needs_attention` judged by the state it left (`effectiveState`), and the boot plan `start()` follows for the op it
// finds: boot normally, wait for the op, boot the update's target, step a revert, or refuse at once.

const T0 = 1_800_000_000_000;
/** The running release in most rows: the update's target. */
const V = '0.2.0-test';
/** A release that is not the target (the one the update leaves). */
const OLD = '0.1.0-test';

function opOf(kind: OpKind, state: string, o: { stateBefore?: string; target?: string; source?: string } = {}): OpFile {
  const params: Record<string, unknown> = {};
  if (o.target !== undefined) params['target'] = o.target;
  if (o.source !== undefined) params['source'] = o.source;
  return {
    opSchema: 1,
    opId: newId(T0),
    kind,
    actor: { type: 'cli', id: null },
    state,
    ...(o.stateBefore === undefined ? {} : { stateBefore: o.stateBefore }),
    version: o.target ?? OLD,
    backupId: null,
    heartbeatAt: T0,
    startedAt: T0,
    finishedAt: isTerminal(kind, state) ? T0 : null,
    error: null,
    opsTokenHash: null,
    pointOfNoReturn: false,
    params,
    progress: 0,
    message: null,
  };
}

describe('effectiveState and holdsMaintenance', () => {
  it('KIND_MAINTENANCE_FROM: update from verified, rollback never, every other kind in all its states', () => {
    expect(KIND_MAINTENANCE_FROM).toEqual({
      update: 'verified',
      rollback: null,
      restore: 'all',
      backup: 'all',
      migrate: 'all',
      reset: 'all',
      'install-migrate': 'all',
    });
    expect(Object.keys(KIND_MAINTENANCE_FROM).sort()).toEqual([...OP_KINDS].sort());
    expect(Object.isFrozen(KIND_MAINTENANCE_FROM)).toBe(true);
  });

  it('agrees with the registered handlers: their maintenance reason and maintenanceFrom', () => {
    const migrations = { appVersion: '0.1.0', migrations: {} };
    const unused = (): never => {
      throw new Error('not called');
    };
    // The kinds of this release (apps/server's opKinds); Tasks 24 and 26 add `update` and `rollback` here.
    const handlers: OpKindHandler[] = [
      migrateKind(migrations),
      resetKind(),
      installMigrateKind(migrations),
      backupKind(unused),
      restoreKind({ requestRestart: unused, sessionKey: unused, keyring: unused } as unknown as Parameters<typeof restoreKind>[0]),
      rollbackKind(unused), // Task 26
    ];
    for (const h of handlers) {
      expect([h.kind, h.maintenance === null ? null : (h.maintenanceFrom ?? 'all')]).toEqual([h.kind, KIND_MAINTENANCE_FROM[h.kind]]);
    }
  });

  it('effectiveState is the state an op in needs_attention left, else its state', () => {
    expect(effectiveState(opOf('update', NEEDS_ATTENTION, { stateBefore: 'downloading' }))).toBe('downloading');
    expect(effectiveState(opOf('update', 'frozen'))).toBe('frozen');
    expect(effectiveState(opOf('restore', 'done'))).toBe('done');
  });

  it('an update holds maintenance from verified to its end (restore_failed keeps it); before it, never', () => {
    const holds = OP_STATES.update.filter((s) => holdsMaintenance('update', s));
    expect(holds).toEqual(['verified', 'frozen', 'backed_up', 'staged', 'switched', 'booting', 'migrating', 'verifying', 'reverting', 'restoring', 'restore_failed']);
  });

  it('a rollback never holds it; the other kinds in every state that has not ended', () => {
    expect(OP_STATES.rollback.filter((s) => holdsMaintenance('rollback', s))).toEqual([]);
    for (const kind of ['restore', 'backup', 'migrate', 'reset', 'install-migrate'] as const) {
      expect(OP_STATES[kind].filter((s) => holdsMaintenance(kind, s))).toEqual(OP_STATES[kind].filter((s) => !isTerminal(kind, s)));
    }
  });

  it('an op in needs_attention follows its stateBefore (S4)', () => {
    const judged = (stateBefore: string): boolean => {
      const op = opOf('update', NEEDS_ATTENTION, { stateBefore });
      return holdsMaintenance(op.kind, effectiveState(op));
    };
    expect(judged('downloading')).toBe(false);
    expect(judged('checking')).toBe(false);
    expect(judged('frozen')).toBe(true);
    expect(judged('migrating')).toBe(true);
    // A state nobody can place (needs_attention without stateBefore) is judged as holding it.
    expect(holdsMaintenance('update', NEEDS_ATTENTION)).toBe(true);
  });
});

describe('opBootPlan (preflight B8, S4, 1D-02)', () => {
  type Row = [name: string, op: OpFile | 'corrupt' | null, version: string, pendingBoot: boolean, plan: BootPlan];
  const rows: Row[] = [
    // The brief's table.
    ['switched, target v, pending boot', opOf('update', 'switched', { target: V, source: 'feed' }), V, true, 'update_boot'],
    ['switched, target v, run by the old release', opOf('update', 'switched', { target: V, source: 'feed' }), OLD, false, 'ops_wait'],
    ['reverting, target other', opOf('update', 'reverting', { target: V, source: 'feed' }), OLD, false, 'revert'],
    ['restoring, target other', opOf('update', 'restoring', { target: V, source: 'feed' }), OLD, false, 'revert'],
    ['reverting, target v (B8)', opOf('update', 'reverting', { target: V, source: 'feed' }), V, false, 'refuse'],
    ['restoring, target v (B8)', opOf('update', 'restoring', { target: V, source: 'feed' }), V, false, 'refuse'],
    ['needs_attention from migrating, target v, pending boot', opOf('update', NEEDS_ATTENTION, { stateBefore: 'migrating', target: V, source: 'feed' }), V, true, 'refuse'],
    ['needs_attention from migrating, run by the old release', opOf('update', NEEDS_ATTENTION, { stateBefore: 'migrating', target: V, source: 'feed' }), OLD, false, 'ops_wait'],
    ['needs_attention from checking (the T33 persona op)', opOf('update', NEEDS_ATTENTION, { stateBefore: 'checking', target: V, source: 'feed' }), OLD, false, 'normal'],
    ['needs_attention from checking, run by the target', opOf('update', NEEDS_ATTENTION, { stateBefore: 'checking', target: V, source: 'feed' }), V, false, 'normal'],
    ['downloading', opOf('update', 'downloading', { target: V, source: 'feed' }), OLD, false, 'normal'],
    ['verified, source self, target v', opOf('update', 'verified', { target: V, source: 'self' }), V, false, 'update_boot'],
    ['needs_attention from frozen, source self, target v', opOf('update', NEEDS_ATTENTION, { stateBefore: 'frozen', target: V, source: 'self' }), V, false, 'ops_wait'],
    ['verifying, target v, no pending boot (promoted)', opOf('update', 'verifying', { target: V, source: 'feed' }), V, false, 'update_boot'],
    ['done', opOf('update', 'done', { target: V, source: 'feed' }), V, false, 'normal'],
    ['restore loading', opOf('restore', 'loading'), V, false, 'ops_wait'],
    ['restore needs_attention from loading', opOf('restore', NEEDS_ATTENTION, { stateBefore: 'loading' }), V, false, 'ops_wait'],
    ['rollback running', opOf('rollback', 'running'), V, false, 'normal'],
    ['corrupt', 'corrupt', V, false, 'ops_wait'],
    ['corrupt, pending boot', 'corrupt', V, true, 'refuse'],
    ['no op', null, V, false, 'normal'],
    ['no op, pending boot', null, V, true, 'refuse'],
    // More of the same rules.
    ['booting, target v, pending boot', opOf('update', 'booting', { target: V, source: 'feed' }), V, true, 'update_boot'],
    ['migrating, target v, pending boot', opOf('update', 'migrating', { target: V, source: 'feed' }), V, true, 'update_boot'],
    ['verifying, target v, pending boot', opOf('update', 'verifying', { target: V, source: 'feed' }), V, true, 'update_boot'],
    ['switched, target v, no pending boot (not yet pending, or reverted)', opOf('update', 'switched', { target: V, source: 'feed' }), V, false, 'ops_wait'],
    ['reverting, target v, pending boot (B8)', opOf('update', 'reverting', { target: V, source: 'feed' }), V, true, 'refuse'],
    ['reverting, target other, pending boot of another release', opOf('update', 'reverting', { target: '0.3.0-test', source: 'feed' }), V, true, 'refuse'],
    ['staged, target v, pending boot', opOf('update', 'staged', { target: V, source: 'feed' }), V, true, 'refuse'],
    ['verified, target other', opOf('update', 'verified', { target: V, source: 'feed' }), OLD, false, 'ops_wait'],
    ['checking, source self, target v', opOf('update', 'checking', { target: V, source: 'self' }), V, false, 'normal'],
    ['frozen, source self, target v', opOf('update', 'frozen', { target: V, source: 'self' }), V, false, 'update_boot'],
    ['frozen, source self, target v, pending boot', opOf('update', 'frozen', { target: V, source: 'self' }), V, true, 'update_boot'],
    ['needs_attention from frozen, source self, target v, pending boot', opOf('update', NEEDS_ATTENTION, { stateBefore: 'frozen', target: V, source: 'self' }), V, true, 'refuse'],
    ['needs_attention from downloading, pending boot', opOf('update', NEEDS_ATTENTION, { stateBefore: 'downloading', target: V, source: 'feed' }), V, true, 'refuse'],
    ['restore_failed (ended; its flag keeps maintenance)', opOf('update', 'restore_failed', { target: V, source: 'feed' }), OLD, false, 'normal'],
    ['done, pending boot', opOf('update', 'done', { target: V, source: 'feed' }), V, true, 'refuse'],
    ['backup frozen', opOf('backup', 'frozen'), V, false, 'ops_wait'],
    ['migrate running', opOf('migrate', 'running'), V, false, 'ops_wait'],
    ['reset running', opOf('reset', 'running'), V, false, 'ops_wait'],
    ['install-migrate running', opOf('install-migrate', 'running'), V, false, 'ops_wait'],
    ['restore done', opOf('restore', 'done'), V, false, 'normal'],
    ['rollback running, pending boot', opOf('rollback', 'running'), V, true, 'refuse'],
    ['restore loading, pending boot', opOf('restore', 'loading'), V, true, 'refuse'],
  ];

  it.each(rows)('%s → %s', (_name, op, version, pendingBoot, plan) => {
    expect(opBootPlan(op, version, pendingBoot)).toBe(plan);
  });

  it('a pending holder never waits or boots normally: with pendingBoot the plan is update_boot or refuse', () => {
    for (const [, op, version] of rows) {
      expect(['update_boot', 'refuse']).toContain(opBootPlan(op, version, true));
    }
  });
});
