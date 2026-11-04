import fsp from 'node:fs/promises';
import { releaseDir, type ReleaseRef } from './release-files.js';

// Path facts for Diagnostik (1c Task 23): real paths for the exposure check (decision C21: the URL suffixes are taken
// from the files' real paths, symbolic links resolved, so a DATA_DIR reached through a link is still tested where the
// web server would find it) and whether a release's folder exists (spec §11 "rilis yang hilang").
//
// Not imported by app.js's own code (packages/bootloader), though bundled with @altis/platform.

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * The real path of `p` (absolute, every symbolic link resolved), or null when it does not exist (ENOENT, ENOTDIR,
 * or a dangling link).
 *
 * @throws any other I/O error as it is (EACCES, ELOOP, ...)
 */
export async function realPathOf(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Whether the folder of release `ref` (`<appRoot>/bundled-release/<v>` or `DATA_DIR/releases/<v>`, releaseDir) exists
 * and is a folder (followed through a symbolic link). A folder that cannot be looked at counts as absent.
 */
export async function releaseDirExists(appRoot: string, dataDir: string, ref: ReleaseRef): Promise<boolean> {
  try {
    return (await fsp.stat(releaseDir(appRoot, dataDir, ref))).isDirectory();
  } catch {
    return false;
  }
}
