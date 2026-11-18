export { RUNTIMES, detectRuntime, isEnvSet, sqliteAllowed } from './runtime.js';
export type { Env, Runtime } from './runtime.js';
export { DEFAULT_PORT, resolvePort } from './port.js';
export type { PortSource } from './port.js';
export { poolSize } from './pool.js';
export type { ConnectionLimits, PoolPurpose } from './pool.js';
export { atomicWriteJson, readJsonWithBak } from './atomic.js';
export type { AtomicWriteOptions } from './atomic.js';
export { lockHostIdentity, processStartMs, withFileLock } from './lock.js';
export type { FileLockOptions } from './lock.js';
export { DATA_DIR_POINTER_FILE, resolveDataDir } from './datadir.js';
export type { DataDirSource, ResolveDataDirOptions } from './datadir.js';
export { checkDocroot } from './docroot.js';
export type { DocrootCheck, DocrootCheckOptions } from './docroot.js';
export { DATA_AREAS, dataPath, uploadPath } from './datapath.js';
export type { DataArea } from './datapath.js';
export { ensureHeadroom } from './headroom.js';
export { ensureDir } from './ensure-dir.js';
export { createRotatingFile } from './rotating-file.js';
export type { RotatingFile, RotatingFileOptions } from './rotating-file.js';
export { CLI_INPUT_MAX_BYTES, readCliInputFile } from './cli-input.js';
export type { ReadCliInputOptions } from './cli-input.js';
export { configMtimeMs } from './mtime.js';
export { ADMIN_ASSET_NAME, OPAC_FONT_NAME, parseCurrentState, readPreviousRelease, readReleaseFile, releaseDir } from './release-files.js';
export type { CurrentState, ReleaseFileKind, ReleaseRef, ReleaseSource } from './release-files.js';
export { ALTISBAK_ENTRY, altisbakCentralPath, backupImportedPath, backupPartPath, extractedEntryPath, opKeepPath } from './datapath.js';
export type { DataPath } from './datapath.js';
export {
  copyFileTo,
  dataDirUsage,
  fsyncDir,
  listNames,
  openAppend,
  openRead,
  openReadWrite,
  readBytes,
  removeFile,
  removeTree,
  renameRetry,
  statOrNull,
  truncateFile,
  withTempSibling,
  writeBytesAtomic,
  writeBytesInFolder,
  writeExclusive,
  writeStreamAtomic,
} from './data-files.js';
export type { DataDirUsage, DataDirUsageOptions, FileStat } from './data-files.js';
export { appPath, readAppFile, removeAppFile, writeAppFileAtomic } from './app-paths.js';
export type { AppFileName, AppPath } from './app-paths.js';
export type { HeldFileLock } from './lock.js';
export { faultArmed, killSelf, resetTestFaults } from './fault.js';
export type { TestFault } from './fault.js';
// 1c Task 23: real paths for the exposure check, and a release folder's presence (Diagnostik).
export { realPathOf, releaseDirExists } from './real-path.js';
// 1c Task 18: the anchor log's line append, and the sweep of temporary siblings a killed process left behind.
export { appendLine, removeStaleTemps } from './data-files.js';
// 1c Task 29: the operator's archive copied into DATA_DIR (`backup:restore <file>`).
export { copyOperatorFile } from './data-files.js';
// 1d Task 2: current.json shared by app.js and the server (with `pending`), the boot lock, the boot markers and release
// staging paths, the update faults.
export { CURRENT_LOCK_WAIT_MS, initialState, readCurrentState, updateCurrentState } from './current-state.js';
export { acquireFileLock, processGone } from './lock.js';
export type { HeldFileLockHandle } from './lock.js';
export { bootMarkerPath, isReleaseStagingName, releaseStagingName, releaseStagingPath, stagedReleaseFile } from './datapath.js';
export { faultMatchesVersion } from './fault.js';
// 1d Task 25: the release fence's look at tmp/restart.txt (preflight 1D-21).
export { restartRequestedSince } from './release-files.js';
// 1d Task 32 (L8, decision D1d-36): PM2's cluster signals, which refuse SQLite under runtime pm2 (boot and doctor).
export { pm2ClusterSignals } from './runtime.js';
// ---- Phase 2 (catalog): Task 3 ----
// The exports area's files, a catalog run's work files, and a real run taking over its dry run's work (S3).
export { exportFilePath, runWorkDir, runWorkPath } from './datapath.js';
export type { ExportFileExt } from './datapath.js';
export { adoptRunWork } from './data-files.js';
// Phase 2 Task 10: a file below an operator-named folder (realpath-bounded), and a run work file from its folder.
export { dataDirOf, openUnderRoot, runWorkFileIn } from './root-files.js';
// ---- Komunitas K1 (report paths) ----
// A report run's file and work files: the only builders of paths under `exports/reports/` and `tmp/reports/`.
export { reportExportPath, reportExportsDir, reportWorkDir, reportWorkPath, reportWorkRoot } from './datapath.js';
export type { ReportFileExt } from './datapath.js';
