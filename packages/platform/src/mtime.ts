import fsp from 'node:fs/promises';
import { dataPath } from './datapath.js';

/**
 * The modification time of `DATA_DIR/config.json` in epoch ms, or null when the file does not exist. The server's
 * config fence (spec §9.3, decision D34) compares it every few seconds to notice a config written by another
 * process (`PUT system/config`, `config:set`).
 *
 * @throws the underlying error for anything but a missing file (EACCES, EIO, ...); DomainError
 *   `INVALID_PATH_SEGMENT` when DATA_DIR's root is reached through a link out of it (see dataPath)
 */
export async function configMtimeMs(dataDir: string): Promise<number | null> {
  try {
    return (await fsp.stat(dataPath(dataDir, 'root', 'config.json'))).mtimeMs;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}
