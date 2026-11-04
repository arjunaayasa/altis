import type { OpKindHandler, OpsMachine } from '@altis/core';
import { connect } from '@altis/db';
import type { Env } from '@altis/platform';
import { DomainError, isDomainError, type OpKind } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import type { BootContext } from '../index.js';
import { opKinds, testClockOffsetMs, updateRestoreRunner } from '../jobs/runtime.js';
import { createLogger } from '../logger.js';
import { appUpdateKindDeps, createAppOps } from '../services.js';
import { CliError } from './common.js';
import { auditIfAnswering } from './maintenance.js';
import { CLI_OP_ACTOR, opFailure, runOpToEnd } from './migrate.js';

// `node app.js ops:resume` and `ops:cancel` (spec §9.4; final review OPS-ATTN-EXIT): the CLI way out of an op that
// needs attention where nobody holds its `altis_ops` cookie (a scheduled backup's op is the system's) and every
// process that boots meanwhile waits in `ops_wait`, which resolves no session (C40), so the operations page cannot be
// reached by signing in.
//
// - `ops:resume`: an op in `needs_attention` goes back to the state it left (`ops.resume()`, which raises its
//   maintenance flag again), then this process steps it until it ends or needs attention again (≤ 20 s per step;
//   while another process steps it, this one waits and looks again). An op that did not stop is only stepped. It
//   never cancels the op. Exit 0 on `done`, else 1 with the op's error. Not audited, as the operations page's
//   resume (`POST ops/drive {resume: true}`) is not. An op of a kind this release has no step for (one a later
//   release began) is refused (OPS_KIND_UNKNOWN) and left as it is.
// - `ops:cancel`: the current op (not ended; `needs_attention` included) cancelled as `POST ops/cancel` does: the
//   kind's cancel runs, the op ends in its failure state and its flag is lowered. Refused past the point of no return
//   (409 OPS_POINT_OF_NO_RETURN, spec §9.4: `ops:resume` is the way on there). An op.json whose `.bak` cannot be read
//   either (nothing resumes, cancels or steps it) is set aside instead (OpsMachine.setAsideUnreadable): both files
//   move to `ops/<ULID>/`, maintenance stays as a manual flag (the data may be half done: `maintenance:off` once it is
//   checked, or a restore), and no process waits for the op any more. Audited `ops.cancel {opId, kind}` (`setAside:
//   true` for the latter), actor `cli`, when the database answers.
//
// Neither needs the database to answer to touch the op files; the op's own steps reach it as they do elsewhere.

/** What `ops:resume` moved on. */
export interface OpsResumeResult {
  opId: string;
  kind: OpKind | null;
  state: string;
}

/** What `ops:cancel` ended or set aside. */
export interface OpsCancelResult {
  /** The op cancelled, or the op the flag of an unreadable op.json named (null when none did). */
  opId: string | null;
  kind: OpKind | null;
  /** The state the op ended in; null for an unreadable op.json set aside. */
  state: string | null;
  /** Where an unreadable op.json was moved (`ops/<ULID>/`), else null. */
  setAside: string | null;
  audited: boolean;
}

function noOp(): DomainError {
  return new DomainError('OPS_NONE', { detail: 'Tidak ada operasi yang sedang berjalan / No operation is in progress' });
}

/**
 * 1d Task 24 (preflight S6): the test hook `ALTIS_TEST_CLI_OP_KINDS_WITHOUT=<kind>[,<kind>…]` (test builds only, R57)
 * leaves those kinds out of the command's machine, so a test can stand for a release that cannot step an op a later
 * release began, now that this release registers every kind it knows.
 */
export function withoutTestKinds(env: Env, kinds: OpKindHandler[]): OpKindHandler[] {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const value = env['ALTIS_TEST_CLI_OP_KINDS_WITHOUT'];
    if (typeof value === 'string' && value !== '') {
      const left = new Set(value.split(','));
      return kinds.filter((k) => !left.has(k.kind));
    }
  }
  return kinds;
}

/** The machine of a command, over the installed database when it answers (see the top of this file). */
async function cliMachine(
  ctx: BootContext,
  env: Env,
  command: string,
): Promise<{ ops: OpsMachine; kinds: ReadonlySet<OpKind>; close(): Promise<void> }> {
  const offset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + offset;
  // An unreadable config.json reads as none: the op files are still there to act on.
  const config: Config | null = await loadConfig(ctx.dataDir, env).catch(() => null);
  const log = createLogger({ dataDir: ctx.dataDir, level: config?.log.level ?? 'info' }).child({ command });
  const open = (c: Config) => connect(c.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'not_installed' };
  if (config !== null) {
    state.config = config;
    state.phase = 'db_unavailable';
    try {
      state.db = await open(config);
      state.phase = 'ready';
    } catch {
      // The op's steps open their own connection, or leave the op for a later step while the database is down.
    }
  }
  // 1c Task 25 (C17): what this process holds on a SQLite file, let go of for a restore's swap and opened again after.
  let released = false;
  const own = {
    async close(): Promise<void> {
      await ops.close();
      const h = state.db;
      state.db = undefined;
      if (h === undefined) return;
      released = true;
      await h.close();
    },
    async reopen(): Promise<void> {
      if (!released || state.db !== undefined || state.config === undefined) return;
      state.db = await open(state.config);
      released = false;
    },
  };
  const sqlite = { log, own };
  // 1d Task 24 (preflight S6): the update kind, over this command's own edition and feed client.
  const update = appUpdateKindDeps(state, {
    dataDir: ctx.dataDir,
    appRoot: ctx.appRoot,
    releaseDir: ctx.release.dir,
    version: ctx.release.version,
    env,
    clock,
    log,
    restore: updateRestoreRunner({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite }),
    requestRestart: (reason) => ctx.requestRestart(reason),
  });
  const kinds = withoutTestKinds(
    env,
    opKinds({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite, update }),
  );
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock, runtime: ctx.runtime, kinds });
  return {
    ops,
    kinds: new Set(kinds.map((k) => k.kind)),
    async close() {
      await ops.close();
      await state.db?.close();
    },
  };
}

/**
 * `ops:resume` (see the top of this file).
 *
 * @throws DomainError `OPS_NONE` (no op that has not ended), `STATE_CORRUPT` (op.json and its `.bak` unreadable),
 *   `OPS_IN_PROGRESS` (another process kept the op busy), the op's own error when it ended otherwise than `done` or
 *   needs attention again, or a step's `DB_UNAVAILABLE` (the op is left as it is)
 */
export async function opsResume(ctx: BootContext, env: Env): Promise<OpsResumeResult> {
  const m = await cliMachine(ctx, env, 'ops:resume');
  try {
    const before = await m.ops.current();
    if (before === null || before.terminal) throw noOp();
    if (before.startedAt === null || before.opId === null) throw unreadable(); // an unreadable op.json and .bak
    if (before.kind !== null && !m.kinds.has(before.kind)) {
      // Nothing here would move it (and stepping would wait for ever): the release that began it does.
      throw new CliError(
        'OPS_KIND_UNKNOWN',
        `Rilis ini tidak dapat menjalankan operasi jenis ${before.kind}; jalankan dengan rilis yang memulainya / ` +
          `This release cannot run an operation of kind ${before.kind}; run it with the release that began it`,
      );
    }
    if (before.needsAttention) await m.ops.resume();
    const status = await runOpToEnd(m.ops, before.opId, { cancel: false });
    if (status.state !== 'done') throw opFailure(status);
    return { opId: before.opId, kind: status.kind, state: status.state };
  } finally {
    await m.close();
  }
}

function unreadable(): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      'ops/op.json dan .bak-nya tidak dapat dibaca, jadi operasi tidak dapat dilanjutkan; sisihkan dengan: node app.js ops:cancel / ' +
      'ops/op.json and its .bak cannot be read, so the operation cannot be resumed; set it aside with: node app.js ops:cancel',
    meta: { reason: 'op_unreadable' },
  });
}

/**
 * `ops:cancel` (see the top of this file). Everything it opened is closed before the audit entry is written.
 *
 * @throws DomainError `OPS_NONE` (no op that has not ended), `OPS_POINT_OF_NO_RETURN` (409), `OPS_IN_PROGRESS`
 *   (another process kept the op busy)
 */
export async function opsCancel(ctx: BootContext, env: Env): Promise<OpsCancelResult> {
  const m = await cliMachine(ctx, env, 'ops:cancel');
  let result: Omit<OpsCancelResult, 'audited'>;
  try {
    const aside = await m.ops.setAsideUnreadable(CLI_OP_ACTOR);
    if (aside !== null) {
      result = { opId: aside.opId, kind: aside.kind, state: null, setAside: `ops/${aside.folder}/` };
    } else {
      const status = await m.ops.cancel(CLI_OP_ACTOR).catch((error: unknown) => {
        throw isDomainError(error) && error.code === 'OPS_POINT_OF_NO_RETURN' ? pastPonr() : error;
      });
      result = { opId: status.opId, kind: status.kind, state: status.state, setAside: null };
    }
  } finally {
    await m.close();
  }
  const meta: Record<string, unknown> = { opId: result.opId, kind: result.kind };
  if (result.setAside !== null) meta['setAside'] = true;
  const audited = await auditIfAnswering(ctx, env, { action: 'ops.cancel', entity: 'op', entityId: result.opId, meta });
  return { ...result, audited };
}

function pastPonr(): DomainError {
  return new DomainError('OPS_POINT_OF_NO_RETURN', {
    detail:
      'Operasi sudah melewati titik tanpa kembali dan tidak dapat dibatalkan; perbaiki penyebabnya lalu: node app.js ops:resume / ' +
      'The operation is past its point of no return and cannot be cancelled; fix the cause, then: node app.js ops:resume',
  });
}

/** The human line of `ops:resume` (the command first, so scripts can match it). */
export function describeResume(result: OpsResumeResult): string {
  return `ops:resume: operasi ${result.opId} (${result.kind ?? '-'}) selesai / the operation ${result.opId} (${result.kind ?? '-'}) is done`;
}

/** The human lines of `ops:cancel`. */
export function describeCancel(result: OpsCancelResult): string {
  const note = result.audited ? '' : ' (audit tidak ditulis: database tidak menjawab / not audited: the database did not answer)';
  if (result.setAside !== null) {
    return (
      `ops:cancel: op.json yang tidak terbaca dipindahkan ke ${result.setAside}; mode pemeliharaan tetap aktif / ` +
      `the unreadable op.json was moved to ${result.setAside}; maintenance mode stays on${note}\n` +
      'Periksa data, lalu / Check the data, then: node app.js maintenance:off (atau pulihkan backup / or restore a backup)'
    );
  }
  return `ops:cancel: operasi ${result.opId ?? '-'} (${result.kind ?? '-'}) dibatalkan: ${result.state ?? '-'} / the operation was cancelled${note}`;
}
