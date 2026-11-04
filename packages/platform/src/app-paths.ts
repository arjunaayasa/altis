import fsp from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { quotaMapped, readBounded, replaceFile } from './data-files.js';

// The few files ALTIS touches in the application folder (appRoot: the folder of app.js), which is not DATA_DIR:
// - `app.js` itself;
// - `altis-data-dir.txt`, the pointer to DATA_DIR (spec §9.2);
// - `.altis/installed.json`, the install marker (spec §7.7), written only when appRoot is writable and the runtime is
//   not docker/service;
// - `tmp/restart.txt`, the file Passenger and LiteSpeed watch for a restart (P14).
// As with DataPath, apps/** builds no path of its own: these come from appPath only, and the helpers take an AppPath.
// The application folder is often read-only (Docker images, hardened hosting): a write there reports false instead of
// throwing for a refusal.
//
// Not imported by app.js's own code (packages/bootloader), though bundled with @altis/platform.

/** A path built by {@link appPath}. A subtype of `string`. */
export type AppPath = string & { readonly __appPath: true };

/** The application files ALTIS reads or writes. */
export type AppFileName = 'app.js' | 'altis-data-dir.txt' | 'installed-marker' | 'restart.txt';

// A plain literal (no Object.freeze call), so that app.js, which bundles @altis/platform, can leave it out.
const APP_FILES: Readonly<Record<AppFileName, readonly string[]>> = {
  'app.js': ['app.js'],
  'altis-data-dir.txt': ['altis-data-dir.txt'],
  'installed-marker': ['.altis', 'installed.json'],
  'restart.txt': ['tmp', 'restart.txt'],
};

/** Error codes that mean "the application folder is not writable": a write or removal there reports false. */
const NOT_WRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

const FILE_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * The path of application file `name` under `appRoot` (resolved against the working directory when relative):
 * `app.js`, `altis-data-dir.txt`, `.altis/installed.json` (`installed-marker`) or `tmp/restart.txt` (`restart.txt`).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` for any other name
 */
export function appPath(appRoot: string, name: AppFileName): AppPath {
  const parts = Object.prototype.hasOwnProperty.call(APP_FILES, name) ? APP_FILES[name] : undefined;
  if (parts === undefined) {
    const shown = typeof name === 'string' ? JSON.stringify(name).slice(0, 64) : `<${typeof name}>`;
    throw new DomainError('INVALID_PATH_SEGMENT', {
      detail: `Berkas aplikasi ${shown} tidak dikenal / ${shown} is not a known application file`,
      meta: { area: 'app', segment: shown },
    });
  }
  return path.join(path.resolve(appRoot), ...parts) as AppPath;
}

/**
 * The content of `p`, at most `maxBytes` bytes; null when it does not exist.
 *
 * @throws DomainError `STATE_CORRUPT` `not_a_file` or `too_large`; RangeError for a bad `maxBytes`
 */
export function readAppFile(p: AppPath, maxBytes: number): Promise<Buffer | null> {
  return readBounded(p, maxBytes);
}

/**
 * Replaces `p` atomically (temporary sibling, fsync, rename, fsync the folder), creating `.altis/` or `tmp/` when
 * missing. File mode 0600, folders 0700.
 *
 * @returns true when written; false when the application folder is not writable (EACCES, EPERM, EROFS): never throws
 *   for that
 * @throws DomainError `DISK_QUOTA` for a full disk; any other I/O error as it is
 */
export async function writeAppFileAtomic(p: AppPath, data: string | Uint8Array): Promise<boolean> {
  try {
    await replaceFile(p, data, FILE_MODE, false);
    return true;
  } catch (error) {
    if (NOT_WRITABLE.has(errorCode(error) ?? '')) return false;
    throw error;
  }
}

/**
 * Removes `p`.
 *
 * @returns true when it is gone (or was not there); false when the application folder is not writable
 */
export async function removeAppFile(p: AppPath): Promise<boolean> {
  try {
    await fsp.rm(p, { force: true });
    return true;
  } catch (error) {
    if (NOT_WRITABLE.has(errorCode(error) ?? '')) return false;
    throw quotaMapped(p, error);
  }
}
