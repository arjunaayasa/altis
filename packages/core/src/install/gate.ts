import { listCatalogTables, type DbHandle } from '@altis/db';
import { appPath, dataPath, isEnvSet, readAppFile, statOrNull, type Env } from '@altis/platform';
import { isDomainError } from '@altis/shared';

// The install gate (spec §7.7, §9.5; decision C19): what an installation that is not running serves, decided per
// request from files (P6: what another process wrote is seen at once, no restart and no fence), in this order:
//
// 1. installed         DATA_DIR/install.lock exists (whatever it holds), or config.json says installState 'complete':
//                      the wizard is gone (/install* → 404 in every process, also one spawned before completion);
// 2. datadir_mismatch  a usable install marker <appRoot>/.altis/installed.json exists while DATA_DIR is not installed
//                      (ruling R1c-5). The marker is written only after install.lock and removed only by install:reset,
//                      so it always means "this app was installed": its data folder is not the one in use, whether
//                      the marker names another path or this very one recreated empty (the bootloader's
//                      prepareDataDir makes a deleted DATA_DIR again) → 503, never the wizard. The way back is
//                      install:reset (or deleting the marker by hand);
// 3. volume_missing    no config.json, ALTIS_DB_DIALECT set, and the database the environment names already holds a
//                      schema_meta.install_id (Docker lost its data volume) → 503, never the wizard;
// 4. resume            config.json exists with another installState: the wizard resumes at that step;
// 5. fresh             nothing yet.
//
// The env database's answer is the caller's (`envDbInstallId`, cached per process by the server, M35): connecting
// is far too slow to repeat per request, and the answer cannot change while the volume stays missing. It fails
// closed: a database that cannot be read makes `envDbInstallId` throw (DB_UNAVAILABLE), and the gate with it, never
// `fresh` (an unreachable database is not an empty one).

export type InstallGate =
  | { kind: 'installed' }
  | { kind: 'fresh' }
  | { kind: 'resume'; installState: string }
  | { kind: 'volume_missing' }
  | { kind: 'datadir_mismatch' };

export interface InstallGateOptions {
  dataDir: string;
  /** The application folder (the marker's); null skips the marker check (an app that runs from no appRoot). */
  appRoot: string | null;
  env: Env;
  /** config.json as loaded (or as the config fence keeps it), or null when there is none. */
  config: { installState: string } | null;
  /**
   * schema_meta.install_id of the database the environment names, or null (none named, or no install id in it yet).
   * Throws (DB_UNAVAILABLE) when that database cannot be read: the gate then cannot decide and throws the same.
   */
  envDbInstallId(): Promise<string | null>;
}

/** The install marker is a few dozen bytes. */
const MARKER_MAX_BYTES = 64 * 1024;

/** Whether DATA_DIR/install.lock exists (a damaged one still marks an install). */
export async function installLockExists(dataDir: string): Promise<boolean> {
  return (await statOrNull(dataPath(dataDir, 'root', 'install.lock'))) !== null;
}

/**
 * The `dataDir` the install marker names, or null when there is no usable marker (none, a folder, too large, not
 * JSON, or no `dataDir` string in it).
 */
async function markerDataDir(appRoot: string): Promise<string | null> {
  let bytes: Buffer | null;
  try {
    bytes = await readAppFile(appPath(appRoot, 'installed-marker'), MARKER_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null; // a folder, a huge file: not a marker
    throw error;
  }
  if (bytes === null) return null;
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    const value = typeof raw === 'object' && raw !== null ? (raw as { dataDir?: unknown }).dataDir : undefined;
    return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') ? value : null;
  } catch {
    return null;
  }
}

/**
 * The install gate of `o.dataDir` now (see the top of this file).
 *
 * @throws a file system error other than a missing or unusable file; `envDbInstallId`'s error (DB_UNAVAILABLE)
 */
export async function installGate(o: InstallGateOptions): Promise<InstallGate> {
  if ((await installLockExists(o.dataDir)) || o.config?.installState === 'complete') return { kind: 'installed' };
  // R1c-5: whichever path the marker names (the same one too), this app was installed and DATA_DIR is not.
  if (o.appRoot !== null && (await markerDataDir(o.appRoot)) !== null) return { kind: 'datadir_mismatch' };
  if (o.config === null) {
    if (isEnvSet(o.env, 'ALTIS_DB_DIALECT') && (await o.envDbInstallId()) !== null) return { kind: 'volume_missing' };
    return { kind: 'fresh' };
  }
  return { kind: 'resume', installState: o.config.installState };
}

/**
 * schema_meta.install_id of the database `h` is connected to: null when it has no schema_meta table (an empty
 * database), no row, or a NULL id.
 */
export async function dbInstallId(h: DbHandle): Promise<string | null> {
  const tables = await listCatalogTables(h);
  if (!tables.includes('schema_meta')) return null;
  const row = await h.db.selectFrom('schema_meta').select('install_id').where('id', '=', 1).executeTakeFirst();
  return row?.install_id ?? null;
}
