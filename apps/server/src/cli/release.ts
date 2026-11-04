import { beginRollback, checkRollback, notify, revertPending, rollbackKind } from '@altis/core';
import { connect } from '@altis/db';
import {
  dataPath,
  listNames,
  realPathOf,
  releaseDir,
  statOrNull,
  updateCurrentState,
  type CurrentState,
  type Env,
  type ReleaseRef,
} from '@altis/platform';
import { compareSemver, isSemver } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import type { BootContext } from '../index.js';
import { createLogger } from '../logger.js';
import { createAppOps } from '../services.js';
import { auditIfAnswering } from './maintenance.js';
import { CLI_OP_ACTOR, notInstalled, opFailure, runOpToEnd } from './migrate.js';

// `node app.js release:list`, `release:rollback [--force]` and `release:unpin` (spec §9.7, §13.6 "Rilis"; plan Task 26;
// decision D1d-33; preflight 1D-02, 1D-03), each with `--json`:
//
// - `release:list`: current.json's pointers (`active`, `previous`, `pending`, `pinned`), the releases installed in
//   DATA_DIR (`releases/<v>` with `.complete`), the bundled ones beside app.js (`bundled-release/<v>` with `.complete`:
//   the release app.js ships and any current.json names as bundled; app.js knows no other), and the last 10
//   `releases_log` rows, newest first (null when the database does not answer: the pointers still show).
// - `release:rollback`: with `pending` set (app.js lets this command through then, §9.2 step 4), the pending release
//   is reverted (core's revertPending: the update op recorded `reverting` first, then `pending = null`; a live process
//   booting or migrating it → RELEASE_PENDING, `--force` waits for it, at most 15 min) and a restart is requested;
//   the release that stays steps the op on. It needs no database. Otherwise the manual rollback (§9.7): availability
//   checked (ROLLBACK_UNAVAILABLE with its reason, exit 1), then the `rollback` op begun as `{type: 'cli'}` and stepped
//   to its end (the op writes `update.rollback` and requests the restart itself).
// - `release:unpin`: `pinned = null` (the pin a rollback set, §9.7), audited `release.unpin {version}` (actor `cli`)
//   when the database answers.

/** One `releases_log` row as `release:list` shows it. */
export interface ReleaseLogLine {
  id: string;
  action: string;
  version: string;
  fromVersion: string | null;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  backupId: string | null;
}

/** What `release:list` shows. */
export interface ReleaseListResult {
  active: ReleaseRef;
  previous: ReleaseRef | null;
  pending: ReleaseRef | null;
  pinned: string | null;
  /** `DATA_DIR/releases/<v>` holding `.complete`, by version. */
  installed: string[];
  /** `<appRoot>/bundled-release/<v>` holding `.complete`, by version. */
  bundled: string[];
  /** The last 10 rows, newest first; [] before the install; null when the database does not answer. */
  log: ReleaseLogLine[] | null;
}

/** What `release:rollback` did: reverted the pending release, found it gone meanwhile, or rolled back to `active`. */
export type ReleaseRollbackResult = { reverted: string } | { reverted: null; active: string } | { active: string };

/** What `release:unpin` did. */
export interface ReleaseUnpinResult {
  /** The version that was pinned; null when none was. */
  unpinned: string | null;
  audited: boolean;
}

/** How many `releases_log` rows `release:list` shows. */
const LOG_ROWS = 10;
/** Connecting for the history gives up sooner than a server would: the pointers are shown anyway. */
const LIST_CONNECT_MS = 5000;

/** current.json, read under current.lock (nothing written). */
async function readState(dataDir: string): Promise<CurrentState> {
  return (await updateCurrentState(dataDir, () => null)).state;
}

function byVersion(a: string, b: string): number {
  return compareSemver(a, b);
}

/** `DATA_DIR/releases/<v>` folders holding `.complete`. */
async function installedReleases(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listNames(dataPath(dataDir, 'releases'))) {
    if (!isSemver(name)) continue;
    if ((await statOrNull(dataPath(dataDir, 'releases', name, '.complete')))?.kind === 'file') out.push(name);
  }
  return out.sort(byVersion);
}

/**
 * The bundled releases this installation knows (app.js's own, the running one when bundled, those current.json names as
 * bundled) whose `<appRoot>/bundled-release/<v>` holds `.complete`.
 */
async function bundledReleases(ctx: BootContext, state: CurrentState): Promise<string[]> {
  const known = new Set<string>();
  const add = (version: string | undefined): void => {
    if (version !== undefined && isSemver(version)) known.add(version);
  };
  add(ctx.appJsVersion);
  add(ctx.bundledRelease?.version);
  if (ctx.release.source === 'bundled') add(ctx.release.version);
  for (const ref of [state.active, state.previous, state.pending]) if (ref !== null && ref.source === 'bundled') add(ref.version);
  const out: string[] = [];
  for (const version of known) {
    const dir = releaseDir(ctx.appRoot, ctx.dataDir, { version, source: 'bundled' });
    if ((await realPathOf(`${dir}/.complete`).catch(() => null)) !== null) out.push(version);
  }
  return out.sort(byVersion);
}

/** The last rows of `releases_log`: [] before the install, null when the database cannot be read. */
async function recentLog(ctx: BootContext, env: Env): Promise<ReleaseLogLine[] | null> {
  let config: Config | null;
  try {
    config = await loadConfig(ctx.dataDir, env);
  } catch {
    return null;
  }
  if (config === null || config.installState !== 'complete') return [];
  try {
    const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir, connectTimeoutMs: LIST_CONNECT_MS });
    try {
      const rows = await h.db.selectFrom('releases_log').selectAll().orderBy('started_at', 'desc').orderBy('id', 'desc').limit(LOG_ROWS).execute();
      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        version: r.version,
        fromVersion: r.from_version,
        status: r.status,
        startedAt: Number(r.started_at),
        finishedAt: r.finished_at === null ? null : Number(r.finished_at),
        backupId: r.backup_id,
      }));
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

/** `release:list` (see the top of this file). @throws DomainError `STATE_CORRUPT` for a current.json that cannot be read */
export async function releaseList(ctx: BootContext, env: Env): Promise<ReleaseListResult> {
  const state = await readState(ctx.dataDir);
  return {
    active: state.active,
    previous: state.previous,
    pending: state.pending,
    pinned: state.pinned,
    installed: await installedReleases(ctx.dataDir),
    bundled: await bundledReleases(ctx, state),
    log: await recentLog(ctx, env),
  };
}

/**
 * `release:rollback` (see the top of this file). `o.onWait` is told, while `--force` waits for the process booting
 * the pending release, how long it has waited.
 *
 * @throws DomainError `RELEASE_PENDING` (a live process boots the pending release, or ops/step.lock stays busy;
 *   nothing changed), `ROLLBACK_UNAVAILABLE` (with its reason), `NOT_INSTALLED`, `OPS_IN_PROGRESS`, the op's own error
 *   when it ended `failed`, or what loadConfig and connect throw
 */
export async function releaseRollback(ctx: BootContext, env: Env, o: { force: boolean; onWait?: (waitedMs: number) => void }): Promise<ReleaseRollbackResult> {
  const state = await readState(ctx.dataDir);
  if (state.pending !== null) {
    const reverted = await revertPending(ctx.dataDir, Date.now(), { force: o.force, ...(o.onWait === undefined ? {} : { onWait: o.onWait }) });
    if (reverted === null) return { reverted: null, active: (await readState(ctx.dataDir)).active.version };
    // The processes that wait for boot.lock load `active` at their next try; a restart has them do it now.
    await ctx.requestRestart('rollback').catch(() => undefined);
    return { reverted };
  }

  // Refused before anything opens (the database may be down): the same check the op makes again in its step.
  await checkRollback(ctx.dataDir, ctx.appRoot);
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'release:rollback' });
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const app: AppState = { phase: 'ready', db: h, config };
  const kinds = [rollbackKind(() => ({ dataDir: ctx.dataDir, appRoot: ctx.appRoot, requestRestart: (reason) => ctx.requestRestart(reason), notify }))];
  const ops = createAppOps(app, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock: () => Date.now(), runtime: ctx.runtime, kinds });
  try {
    const begun = await beginRollback(ops, { dataDir: ctx.dataDir, appRoot: ctx.appRoot, actor: CLI_OP_ACTOR });
    const status = await runOpToEnd(ops, begun.opId);
    if (status.state !== 'done') throw opFailure(status);
    return { active: begun.target };
  } finally {
    await ops.close();
    await h.close();
  }
}

/** `release:unpin` (see the top of this file). @throws DomainError `STATE_CORRUPT` for a current.json that cannot be changed */
export async function releaseUnpin(ctx: BootContext, env: Env): Promise<ReleaseUnpinResult> {
  const seen: { pinned: string | null } = { pinned: null };
  await updateCurrentState(ctx.dataDir, (s) => {
    seen.pinned = s.pinned;
    return s.pinned === null ? null : { ...s, pinned: null };
  });
  const unpinned = seen.pinned;
  if (unpinned === null) return { unpinned: null, audited: false };
  const audited = await auditIfAnswering(ctx, env, { action: 'release.unpin', entity: null, entityId: null, meta: { version: unpinned } });
  return { unpinned, audited };
}

function refOf(ref: ReleaseRef | null): string {
  return ref === null ? '-' : `${ref.version} (${ref.source})`;
}

function listOf(versions: readonly string[]): string {
  return versions.length === 0 ? '-' : versions.join(', ');
}

/** The human lines of `release:list`. */
export function describeReleaseList(r: ReleaseListResult): string {
  const lines = [
    `Aktif / Active:            ${refOf(r.active)}`,
    `Sebelumnya / Previous:     ${refOf(r.previous)}`,
    `Tertunda / Pending:        ${refOf(r.pending)}`,
    `Disematkan / Pinned:       ${r.pinned ?? '-'}`,
    `Terpasang / Installed:     ${listOf(r.installed)}`,
    `Terbundel / Bundled:       ${listOf(r.bundled)}`,
  ];
  if (r.log === null) {
    lines.push('Riwayat / History: tidak dapat dibaca, database tidak menjawab / cannot be read, the database did not answer');
  } else if (r.log.length === 0) {
    lines.push('Riwayat / History: -');
  } else {
    lines.push('Riwayat / History:');
    for (const row of r.log) {
      lines.push(`  ${new Date(row.startedAt).toISOString()}  ${row.action.padEnd(8)} ${row.fromVersion ?? '-'} -> ${row.version}  ${row.status}`);
    }
  }
  return lines.join('\n');
}

/** The human line of `release:rollback` (the command first, so scripts can match it). */
export function describeReleaseRollback(r: ReleaseRollbackResult): string {
  if ('reverted' in r && r.reverted !== null) {
    return (
      `release:rollback: rilis tertunda ${r.reverted} dibatalkan; versi aktif dimuat ulang / ` +
      `the pending release ${r.reverted} was reverted; the active version is loaded again`
    );
  }
  if ('reverted' in r) {
    return (
      `release:rollback: tidak ada lagi rilis tertunda (sudah dipromosikan atau dibatalkan); tidak ada yang diubah, versi aktif ${r.active} / ` +
      `no release is pending any more (promoted or reverted meanwhile); nothing was changed, the active version is ${r.active}`
    );
  }
  return (
    `release:rollback: kembali ke versi ${r.active}; ALTIS dimulai ulang untuk memuatnya (bila tidak, mulai ulang layanannya) / ` +
    `back to version ${r.active}; ALTIS restarts to load it (if it does not, restart the service)`
  );
}

/** The human line of `release:unpin`. */
export function describeReleaseUnpin(r: ReleaseUnpinResult): string {
  if (r.unpinned === null) return 'release:unpin: tidak ada versi yang disematkan / no version is pinned';
  const note = r.audited ? '' : ' (audit tidak ditulis: database tidak menjawab / not audited: the database did not answer)';
  return `release:unpin: sematan versi ${r.unpinned} dilepas / the pin of version ${r.unpinned} was removed${note}`;
}
