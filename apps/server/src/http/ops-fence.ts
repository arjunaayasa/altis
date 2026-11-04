import { activeOp, readDataEpoch, readMaintenance, type MaintenanceFlag, type OpFile } from '@altis/core';
import { NEEDS_ATTENTION, isDomainError, isTerminal, type OpKind } from '@altis/shared';
import type { LogFields, Logger } from '../logger.js';
import { loggableError } from '../safe-error.js';

// The ops part of the fence of spec §9.3 (plan Task 15; S19, S23, P14): what every process of an installation must
// learn from another process's operation within 2 s, without a timer (Passenger runs none):
//
// - `ops/maintenance.json`: the maintenance flag, which step 5 (http/maintenance.ts) and /_health read here;
// - `ops/data-epoch`: raised by a restore; a change calls `onEpoch(next, prev)` once (start(): the settings and grants
//   caches dropped, `ctx.requestRestart('data-epoch')`, so every serving process restarts whoever finished it, S23).
//   The first look only learns the epoch;
// - the kind, state and point of no return of `ops/op.json`'s active op (one that has not ended; `needs_attention`
//   included). An op.json that cannot be read (nor its `.bak`) counts as an active op: the op its maintenance flag
//   names, `needs_attention`, past its point of no return (nothing may assume its tables are there). `onOpEnded` fires
//   when a look finds no active op after one was seen (start() leaves `ops_wait`).
//
// - 1c Task 25 (decision C17; S19, S23, P14): the SQLite owner side, when start() gives one (`sqlite`). While the
//   flag carries `sqliteRelease` (a restore swaps its work file into place, or renames it back), every look calls
//   `sqlite.release(opId)`: the process lets go of `db/altis.sqlite` (its handle and the op connections; closing the
//   handle removes `tmp/sqlite-owner.json`), so the swap stops waiting. The process stays released until a look finds
//   the data epoch moved (the restore finished) or the op's flag gone (it ended): that look calls `sqlite.reopen()`
//   before `onEpoch` (the restart of S23 then serves from the restored file). Both are idempotent; a failure is logged
//   and the next look tries again.
//
// check() looks at most once per `intervalMs` (2 s); requests call it (step 4 of the chain) and so does the worker loop
// before each pass. Concurrent checks share one look. A look that cannot read a file keeps what the fence knew of it
// (logged once until a read works again), so the fence never rejects.

/** What the fence knows of the active op. */
export interface OpsFenceOp {
  opId: string;
  kind: OpKind;
  state: string;
  /** 1d review C16: the state an op in `needs_attention` left (op.json's `stateBefore`); absent otherwise. */
  stateBefore?: string;
  pointOfNoReturn: boolean;
}

/** How the fence reads the ops files (the @altis/core readers; tests spy on them). */
export interface OpsFenceReads {
  maintenance(dataDir: string): Promise<MaintenanceFlag | null>;
  epoch(dataDir: string): Promise<number>;
  /** The op of op.json (an ended one counts as none), `'corrupt'` for an unreadable op.json and `.bak`, or null. */
  op(dataDir: string): Promise<OpFile | 'corrupt' | null>;
}

export interface OpsFenceOptions {
  dataDir: string;
  /** The shortest time between two looks (default 2000 ms). */
  intervalMs?: number;
  /** Epoch ms. */
  clock(): number;
  /** The data epoch moved from `prev` to `next` (not called for the first look). A throw is logged. */
  onEpoch(next: number, prev: number): void;
  /** A look found no active op after one was seen. A throw is logged. */
  onOpEnded(): void;
  /**
   * 1c Task 25: this process's SQLite owner side (see the top of this file): `release(opId)` lets go of the database
   * file while a restore asks for it, `reopen()` opens it again once the restore moved the data epoch or ended. Both
   * idempotent; a rejection is logged and the next look tries again. Without it the fence releases nothing.
   */
  sqlite?: { release(opId: string): Promise<void>; reopen(): Promise<void> };
  log?: Logger;
  /** Default: readMaintenance, readDataEpoch and a reader of the active op (activeOp's rule). */
  reads?: Partial<OpsFenceReads>;
}

export interface OpsFence {
  /** Looks at the ops files when `intervalMs` passed since the last look (the first check always looks). Never rejects. */
  check(): Promise<void>;
  /** Looks now, whatever the interval (start() before it decides to touch the database). Never rejects. */
  refresh(): Promise<void>;
  /** The maintenance flag of the last look; null when off (or never looked). */
  maintenance(): MaintenanceFlag | null;
  /** The data epoch of the last look that could read it (0 before). */
  epoch(): number;
  /** The active op of the last look (see the top of this file for an unreadable op.json); null when none. */
  op(): OpsFenceOp | null;
  /** True while an op holds the ops lock: an active op, or an op.json nobody can read. */
  active(): boolean;
  /** A restore holds the installation: its op is active, or the flag's reason is `restore`. */
  restoreInProgress(): boolean;
  /** The restore passed its point of no return: its tables may be gone, no route may read them (S3). */
  restorePastPonr(): boolean;
}

const DEFAULT_INTERVAL_MS = 2000;

/** The kind of the op a maintenance reason belongs to (an unreadable op.json's kind comes from its flag). */
const REASON_KIND: Readonly<Record<MaintenanceFlag['reason'], OpKind | null>> = {
  restore: 'restore',
  backup: 'backup',
  update: 'update',
  install: 'install-migrate',
  migrate: 'migrate',
  reset: 'reset',
  manual: null,
};

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger };

function errorFields(error: unknown): LogFields {
  if (isDomainError(error)) return { code: error.code, reason: error.meta?.['reason'] as string | undefined };
  return { error: loggableError(error) };
}

/**
 * The ops fence of one process (see the top of this file).
 *
 * @throws TypeError for an `intervalMs` that is not a finite number of at least 0
 */
export function createOpsFence(o: OpsFenceOptions): OpsFence {
  const intervalMs = o.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('createOpsFence: intervalMs must be a finite number of at least 0');
  const log = o.log ?? silentLogger;
  const reads: OpsFenceReads = {
    maintenance: o.reads?.maintenance ?? readMaintenance,
    epoch: o.reads?.epoch ?? readDataEpoch,
    op: o.reads?.op ?? activeOp,
  };

  let looked = false;
  let lastLookAt = 0;
  let running: Promise<void> | undefined;

  let flag: MaintenanceFlag | null = null;
  let epoch: number | undefined;
  let op: OpsFenceOp | null = null;
  let corrupt = false;
  /** Whether a look saw an active op since onOpEnded last fired. */
  let seen = false;
  /** Which reads failed on the last look (each logged once until it works again). */
  const failing = new Set<keyof OpsFenceReads>();
  /** 1c Task 25: the op this process let go of the SQLite file for, and whether a reopen is due (until one works). */
  let releasedFor: string | null = null;
  let reopenDue = false;

  const failed = (what: keyof OpsFenceReads, error: unknown): void => {
    if (failing.has(what)) return;
    failing.add(what);
    log.error(`ops fence: ${what} cannot be read; what the fence knew is kept`, errorFields(error));
  };

  const call = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log.error(`ops fence: ${what} failed`, { error: loggableError(error) });
    }
  };

  /**
   * 1c Task 25: the SQLite owner side of one look (see the top of this file), after the flag and the epoch were read.
   * Never rejects.
   */
  async function sqliteSide(epochMoved: boolean): Promise<void> {
    const hooks = o.sqlite;
    if (hooks === undefined) return;
    const asked = flag?.sqliteRelease ?? null;
    try {
      if (asked !== null) {
        reopenDue = false;
        await hooks.release(asked);
        if (releasedFor !== asked) log.warn('ops fence: the SQLite database file was let go for a restore', { opId: asked });
        releasedFor = asked;
        return;
      }
      if (epochMoved || (releasedFor !== null && (flag === null || flag.opId !== releasedFor))) reopenDue = true;
      if (!reopenDue) return;
      await hooks.reopen();
      reopenDue = false;
      releasedFor = null;
    } catch (error) {
      log.error(`ops fence: ${asked !== null ? 'releasing' : 'reopening'} the SQLite database file failed; the next look tries again`, errorFields(error));
    }
  }

  async function look(): Promise<void> {
    const [f, e, a] = await Promise.allSettled([reads.maintenance(o.dataDir), reads.epoch(o.dataDir), reads.op(o.dataDir)]);
    if (f.status === 'fulfilled') {
      flag = f.value;
      failing.delete('maintenance');
    } else {
      failed('maintenance', f.reason);
    }
    let moved: { next: number; prev: number } | null = null;
    if (e.status === 'fulfilled') {
      failing.delete('epoch');
      const prev = epoch;
      epoch = e.value;
      if (prev !== undefined && prev !== e.value) moved = { next: e.value, prev };
    } else {
      failed('epoch', e.reason);
    }
    // 1c Task 25: released or reopened first, so that the restart onEpoch asks for serves from the restored file.
    await sqliteSide(moved !== null);
    if (moved !== null) {
      const { next, prev } = moved;
      log.warn('ops fence: the data epoch changed', { from: prev, to: next });
      call('onEpoch', () => o.onEpoch(next, prev));
    }
    if (a.status === 'fulfilled') {
      failing.delete('op');
      const value = a.value;
      corrupt = value === 'corrupt';
      op =
        value === null || value === 'corrupt' || isTerminal(value.kind, value.state)
          ? null
          : {
              opId: value.opId,
              kind: value.kind,
              state: value.state,
              ...(value.stateBefore === undefined ? {} : { stateBefore: value.stateBefore }),
              pointOfNoReturn: value.pointOfNoReturn,
            };
      const isActive = corrupt || op !== null;
      if (isActive) {
        seen = true;
      } else if (seen) {
        seen = false;
        call('onOpEnded', () => o.onOpEnded());
      }
    } else {
      failed('op', a.reason);
    }
  }

  function run(): Promise<void> {
    lastLookAt = o.clock();
    looked = true;
    running = look()
      .catch((error: unknown) => {
        log.error('ops fence: the look failed', { error: loggableError(error) });
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  /** The op of an unreadable op.json: the one its maintenance flag names, if any. */
  function corruptOp(): OpsFenceOp | null {
    const kind = flag === null ? null : REASON_KIND[flag.reason];
    if (flag === null || flag.opId === null || kind === null) return null;
    return { opId: flag.opId, kind, state: NEEDS_ATTENTION, pointOfNoReturn: true };
  }

  const currentOp = (): OpsFenceOp | null => (corrupt ? corruptOp() : op);

  return {
    check(): Promise<void> {
      if (running !== undefined) return running;
      const now = o.clock();
      // A clock that went back counts as due, so that a wrong reading cannot stop the fence for good.
      if (looked && now >= lastLookAt && now - lastLookAt < intervalMs) return Promise.resolve();
      return run();
    },
    async refresh(): Promise<void> {
      if (running !== undefined) await running;
      await run();
    },
    maintenance: () => flag,
    epoch: () => epoch ?? 0,
    op: currentOp,
    active: () => corrupt || op !== null,
    restoreInProgress: () => currentOp()?.kind === 'restore' || flag?.reason === 'restore',
    restorePastPonr() {
      const current = currentOp();
      if (current !== null) return current.kind === 'restore' && current.pointOfNoReturn;
      // An unreadable op.json under a restore flag that names no op: nothing may assume the tables are there.
      return corrupt && flag?.reason === 'restore';
    },
  };
}
