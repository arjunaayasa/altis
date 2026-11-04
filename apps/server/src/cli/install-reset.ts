import { readOpFile } from '@altis/core';
import { connect, type DbHandle } from '@altis/db';
import type { Env } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import type { BootContext } from '../index.js';
import { createLogger } from '../logger.js';
import { createAppOps } from '../services.js';
import { CliError } from './common.js';
import { CLI_OP_ACTOR, opFailure, runOpToEnd } from './migrate.js';

// `node app.js install:reset [--wipe-db] [--confirm-db <name>]` (spec §13.6, §7.7; ruling R1c-5; 1c Task 24): undoes
// the installation of DATA_DIR under the ops lock, so that the wizard (or `install --config`) can run again:
//
// 1. With --wipe-db, before anything else: the database's name (`config.db.database`, or `altis.sqlite`) must be
//    given as --confirm-db or typed at the TTY prompt; otherwise exit 1 and nothing is touched (no op either).
// 2. `ops.begin('reset', {type: 'cli'}, {wipeDb, appRoot})` (maintenance `reset`; another op in progress →
//    OPS_IN_PROGRESS), then the op is stepped to its end (core ops/kinds/reset.ts): `install.reset` audited when the
//    database answers, the registered tables dropped with --wipe-db, install.lock removed, config.json renamed to
//    config.json.bak-<epoch ms>, the install marker <appRoot>/.altis/installed.json removed.
//
// It also works on a DATA_DIR that is not (or no longer) installed: a marker left behind (the DATA_DIR_MISMATCH page
// names this command, R1c-5), a half-finished install, an unreadable config.json (moved aside like any other; only
// --wipe-db needs a readable one). The database is not needed then, and nothing is audited.

/** What `install:reset` did. */
export interface InstallResetResult {
  /** The name config.json was moved to (in DATA_DIR), or null when there was none. */
  configBackup: string | null;
  wipedDb: boolean;
  /** Whether the install marker is gone (null: unknown, the op was finished by another process). */
  markerRemoved: boolean | null;
}

export interface InstallResetOptions {
  wipeDb: boolean;
  /** --confirm-db. */
  confirmDb?: string | undefined;
  /** Asks the operator at the TTY; null when there is none. */
  prompt(question: string): Promise<string | null>;
}

/** The name the operator types to confirm --wipe-db: the database's name, or the SQLite file's. */
export function databaseName(config: Config): string {
  return config.db.dialect === 'sqlite' ? 'altis.sqlite' : (config.db.database ?? '');
}

/** Step 1: the database's name confirmed, or the command refused before anything happened. */
async function confirmWipe(config: Config | null, o: InstallResetOptions): Promise<void> {
  if (config === null) {
    throw new DomainError('NOT_INSTALLED', {
      detail:
        'config.json tidak ada, jadi database tidak diketahui; jalankan tanpa --wipe-db / ' +
        'There is no config.json, so the database is unknown; run it without --wipe-db',
    });
  }
  const name = databaseName(config);
  const typed =
    o.confirmDb ??
    (await o.prompt(
      `Semua tabel ALTIS di database "${name}" akan dihapus. Ketik nama database untuk melanjutkan / ` +
        `Every ALTIS table in the database "${name}" will be dropped. Type the database's name to go on: `,
    ));
  if (typed === null) {
    throw new CliError(
      'CONFIRM_REQUIRED',
      `--wipe-db memerlukan nama database "${name}" lewat --confirm-db atau prompt TTY / ` +
        `--wipe-db needs the database's name "${name}" as --confirm-db or at a TTY prompt`,
    );
  }
  if (typed.trim() !== name) {
    throw new CliError(
      'CONFIRM_MISMATCH',
      `Nama yang diketik bukan "${name}"; tidak ada yang dihapus / The name typed is not "${name}"; nothing was dropped`,
    );
  }
}

/**
 * Resets the installation of `ctx.dataDir` (see the top of this file).
 *
 * @throws CliError `CONFIRM_REQUIRED`/`CONFIRM_MISMATCH` (--wipe-db not confirmed); DomainError `NOT_INSTALLED`
 *   (--wipe-db without config.json), `OPS_IN_PROGRESS`, `DB_UNAVAILABLE` (--wipe-db and the database does not
 *   answer), or what loadConfig throws with --wipe-db
 */
export async function installReset(ctx: BootContext, env: Env, o: InstallResetOptions): Promise<InstallResetResult> {
  let config: Config | null = null;
  try {
    config = await loadConfig(ctx.dataDir, env);
  } catch (error) {
    if (o.wipeDb) throw error; // the database to drop must be known for certain
  }
  if (o.wipeDb) await confirmWipe(config, o);

  // The database, when it answers: the audit entry, and the wipe (which needs it).
  let h: DbHandle | undefined;
  if (config !== null) {
    try {
      h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
    } catch (error) {
      if (o.wipeDb) throw error;
    }
  }
  const log = createLogger({ dataDir: ctx.dataDir, level: config?.log.level ?? 'info' }).child({ command: 'install:reset' });
  const state: AppState = h !== undefined && config !== null ? { phase: 'ready', db: h, config } : { phase: 'not_installed' };
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock: () => Date.now(), runtime: ctx.runtime });
  try {
    const { opId } = await ops.begin('reset', CLI_OP_ACTOR, { wipeDb: o.wipeDb, appRoot: ctx.appRoot });
    const status = await runOpToEnd(ops, opId);
    if (status.state !== 'done') throw opFailure(status);
    const op = await readOpFile(ctx.dataDir);
    const params = op !== null && op !== 'corrupt' && op.opId === opId ? op.params : {};
    const backup = params['configBackup'];
    const marker = params['markerRemoved'];
    return {
      configBackup: typeof backup === 'string' ? backup : null,
      wipedDb: o.wipeDb,
      markerRemoved: typeof marker === 'boolean' ? marker : null,
    };
  } finally {
    await ops.close();
    await h?.close();
  }
}

/** The human lines of a reset (the command first, so scripts can match it). */
export function describeReset(result: InstallResetResult): string {
  const lines = ['install:reset: instalasi direset / the installation was reset'];
  if (result.configBackup !== null) {
    lines.push(`  config.json → ${result.configBackup} (salinan lama, berisi rahasia; hapus bila tidak perlu / the old copy, holding secrets; delete it when not needed)`);
  }
  if (result.wipedDb) lines.push('  tabel database ALTIS dihapus / the ALTIS database tables were dropped');
  if (result.markerRemoved === false) {
    lines.push('  penanda .altis/installed.json tidak dapat dihapus; hapus manual / the marker .altis/installed.json could not be removed; delete it by hand');
  }
  lines.push('Pasang lagi lewat /install atau / Install again through /install or: node app.js install --config <file>');
  return lines.join('\n');
}
