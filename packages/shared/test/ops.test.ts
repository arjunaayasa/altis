import { describe, expect, it } from 'vitest';
import { opCliLines, type OpStatusView } from '../src/api/ops.js';
import {
  NEEDS_ATTENTION,
  OP_KINDS,
  OP_KIND_PERMISSION,
  OP_SCHEMA,
  OP_STATES,
  OP_TERMINAL_STATES,
  isOpState,
  isTerminal,
  type OpKind,
} from '../src/ops.js';
import { PERMISSIONS } from '../src/permissions.js';

// The op vocabulary of Phase 1c (spec §9.4): the kinds, and the `opSchema 1` state sets, which are frozen: every
// release must be able to resume every one of them, so a test pins them literally.

describe('OP_SCHEMA and OP_KINDS', () => {
  it('opSchema is 1', () => {
    expect(OP_SCHEMA).toBe(1);
  });

  it('lists the seven kinds of spec §9.4, in order', () => {
    expect([...OP_KINDS]).toEqual(['install-migrate', 'update', 'rollback', 'restore', 'backup', 'migrate', 'reset']);
    expect(Object.isFrozen(OP_KINDS)).toBe(true);
  });

  it('needs_attention is the one state every kind accepts', () => {
    expect(NEEDS_ATTENTION).toBe('needs_attention');
  });
});

describe('OP_STATES (copied verbatim from spec §9.4)', () => {
  it('deep-equals the literal lists', () => {
    expect(OP_STATES).toEqual({
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
    });
  });

  it('has a list for every kind and nothing else, with no duplicates', () => {
    expect(Object.keys(OP_STATES).sort()).toEqual([...OP_KINDS].sort());
    for (const kind of OP_KINDS) expect(new Set(OP_STATES[kind]).size, kind).toBe(OP_STATES[kind].length);
  });

  it('a state is lower-case words joined by "_" and fits op.json and releases_log.status (32 characters)', () => {
    for (const kind of OP_KINDS) {
      for (const state of [...OP_STATES[kind], NEEDS_ATTENTION]) {
        expect(state, `${kind}:${state}`).toMatch(/^[a-z_]+$/);
        expect(state.length, `${kind}:${state}`).toBeLessThanOrEqual(32);
      }
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(OP_STATES)).toBe(true);
    for (const kind of OP_KINDS) expect(Object.isFrozen(OP_STATES[kind]), kind).toBe(true);
  });
});

describe('OP_TERMINAL_STATES', () => {
  it('deep-equals the literal lists', () => {
    expect(OP_TERMINAL_STATES).toEqual({
      update: ['done', 'aborted', 'rolled_back', 'restored', 'restore_failed'],
      restore: ['done', 'failed'],
      backup: ['done', 'aborted'],
      'install-migrate': ['done', 'failed'],
      migrate: ['done', 'failed'],
      reset: ['done', 'failed'],
      rollback: ['done', 'failed'],
    });
  });

  it('every terminal state is in its kind list, and every kind has at least one', () => {
    expect(Object.keys(OP_TERMINAL_STATES).sort()).toEqual([...OP_KINDS].sort());
    for (const kind of OP_KINDS) {
      expect(OP_TERMINAL_STATES[kind].length, kind).toBeGreaterThan(0);
      for (const state of OP_TERMINAL_STATES[kind]) expect(OP_STATES[kind], `${kind}:${state}`).toContain(state);
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(OP_TERMINAL_STATES)).toBe(true);
    for (const kind of OP_KINDS) expect(Object.isFrozen(OP_TERMINAL_STATES[kind]), kind).toBe(true);
  });
});

describe('OP_KIND_PERMISSION', () => {
  it('maps each kind to the permission that may drive, take over or cancel it', () => {
    expect(OP_KIND_PERMISSION).toEqual({
      update: 'system.update.run',
      rollback: 'system.update.run',
      restore: 'system.backup.restore',
      backup: 'system.backup.create',
      'install-migrate': 'system.config.manage',
      migrate: 'system.config.manage',
      reset: 'system.config.manage',
    });
    expect(OP_KIND_PERMISSION.restore).toBe('system.backup.restore');
    expect(Object.isFrozen(OP_KIND_PERMISSION)).toBe(true);
  });

  it('every permission is in the catalog', () => {
    for (const kind of OP_KINDS) expect(PERMISSIONS as readonly string[], kind).toContain(OP_KIND_PERMISSION[kind]);
  });
});

describe('isOpState', () => {
  it('accepts every state of the kind, and needs_attention for every kind', () => {
    for (const kind of OP_KINDS) {
      for (const state of OP_STATES[kind]) expect(isOpState(kind, state), `${kind}:${state}`).toBe(true);
      expect(isOpState(kind, NEEDS_ATTENTION), `${kind}:needs_attention`).toBe(true);
    }
  });

  it('refuses a state of another kind, an unknown one and anything inherited', () => {
    expect(isOpState('backup', 'loading')).toBe(false);
    expect(isOpState('restore', 'exporting')).toBe(false);
    expect(isOpState('update', 'running')).toBe(false);
    expect(isOpState('migrate', 'checking')).toBe(false);
    expect(isOpState('restore', 'DONE')).toBe(false);
    expect(isOpState('restore', '')).toBe(false);
    expect(isOpState('restore', 'toString')).toBe(false);
    expect(isOpState('constructor' as OpKind, 'done')).toBe(false);
    expect(isOpState('__proto__' as OpKind, NEEDS_ATTENTION)).toBe(false);
  });
});

describe('isTerminal', () => {
  it('is true exactly for the terminal states of the kind', () => {
    for (const kind of OP_KINDS) {
      for (const state of OP_STATES[kind]) {
        expect(isTerminal(kind, state), `${kind}:${state}`).toBe(OP_TERMINAL_STATES[kind].includes(state));
      }
    }
    expect(isTerminal('update', 'rolled_back')).toBe(true);
    expect(isTerminal('update', 'reverting')).toBe(false);
    expect(isTerminal('restore', 'failed_restoring_pre')).toBe(false);
    expect(isTerminal('restore', 'failed')).toBe(true);
    expect(isTerminal('backup', 'exporting')).toBe(false);
  });

  it('needs_attention is not terminal (an op in it is resumed or cancelled), nor is an unknown state or kind', () => {
    for (const kind of OP_KINDS) expect(isTerminal(kind, NEEDS_ATTENTION), kind).toBe(false);
    expect(isTerminal('restore', 'nonsense')).toBe(false);
    expect(isTerminal('backup', 'failed')).toBe(false);
    expect(isTerminal('constructor' as OpKind, 'done')).toBe(false);
  });
});

// 1d Task 29 (spec §9.7): an update whose revert could not restore its `pre_update` backup ends `restore_failed`, and
// `/admin/_update` (and Diagnostik) show the CLI way out: `backup:restore <id>` and `release:rollback`.
describe('opCliLines (1d Task 29)', () => {
  const BACKUP = '01JB00000000000000000000BK';
  const status = (over: Partial<OpStatusView>): OpStatusView => ({
    opId: '01JB0000000000000000000000',
    kind: 'update',
    state: 'migrating',
    terminal: false,
    needsAttention: false,
    startedAt: 1_000,
    heartbeatAt: 1_000,
    finishedAt: null,
    progress: 50,
    message: null,
    error: null,
    pointOfNoReturn: true,
    backupId: BACKUP,
    actor: { type: 'staff', id: '01JB0000000000000000000001' },
    ...over,
  });

  it('an update in restore_failed → maintenance:off --force, backup:restore <backupId>, release:rollback', () => {
    const op = status({ state: 'restore_failed', terminal: true, finishedAt: 2_000, error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } });
    expect(opCliLines(op)).toEqual([
      'node app.js maintenance:off --force',
      `node app.js backup:restore ${BACKUP}`,
      'node app.js release:rollback',
    ]);
    expect(opCliLines(op, true)).toEqual(opCliLines(op));
    // Without a backup id the placeholder stays, as for a restore.
    expect(opCliLines({ ...op, backupId: null })[1]).toBe('node app.js backup:restore <backupId>');
  });

  it('a schemaHold update that failed (UPDATE_SCHEMA_HOLD_FAILED) has no release to roll back to: the first two lines', () => {
    const op = status({ state: 'restore_failed', terminal: true, finishedAt: 2_000, error: { code: 'UPDATE_SCHEMA_HOLD_FAILED', detail: '…' } });
    expect(opCliLines(op)).toEqual(['node app.js maintenance:off --force', `node app.js backup:restore ${BACKUP}`]);
  });

  it('an update that ended otherwise, or is still running, shows no CLI lines', () => {
    for (const state of ['migrating', 'done', 'aborted', 'rolled_back', 'restored', 'reverting', 'restoring']) {
      expect(opCliLines(status({ state, terminal: ['done', 'aborted', 'rolled_back', 'restored'].includes(state) })), state).toEqual([]);
    }
  });

  it('the 1c lines stay: needs_attention, an unreadable op.json, a restore that failed after pre_restore', () => {
    expect(opCliLines(status({ state: 'needs_attention', needsAttention: true }))).toEqual(['node app.js ops:resume']);
    expect(opCliLines(status({ state: 'needs_attention', needsAttention: true, pointOfNoReturn: false }))).toEqual([
      'node app.js ops:resume',
      'node app.js ops:cancel',
    ]);
    expect(opCliLines(status({ state: 'needs_attention', needsAttention: true, startedAt: null }))).toEqual([
      'node app.js ops:cancel',
      'node app.js maintenance:off',
      `node app.js backup:restore ${BACKUP}`,
    ]);
    const failed = status({ kind: 'restore', state: 'failed', terminal: true, pointOfNoReturn: false });
    expect(opCliLines(failed)).toEqual([]);
    expect(opCliLines(failed, true)).toEqual(['node app.js maintenance:off --force', `node app.js backup:restore ${BACKUP}`]);
    expect(opCliLines(null)).toEqual([]);
  });
});
