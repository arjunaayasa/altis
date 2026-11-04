import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { isDirectory } from './pathutil.js';
import { isEnvSet, type Env } from './runtime.js';

// DATA_DIR resolution (spec P16). Everything the installation owns that must survive an update or a
// reinstall (config.json, the database file, uploads, backups, releases) lives here, so it must be found the
// same way by app.js, the server and the CLI: whichever of these applies first wins.

export type DataDirSource = 'env' | 'pointer' | 'home-altis-data' | 'sibling';

export interface ResolveDataDirOptions {
  /** The process environment. `ALTIS_DATA_DIR` (Docker sets `/data`) is read from it. */
  env: Env;
  /** The folder that holds `app.js`. */
  appRoot: string;
  /** The user's home directory. */
  home: string;
}

/** Name of the one-line file, next to `app.js`, that holds the DATA_DIR path. */
export const DATA_DIR_POINTER_FILE = 'altis-data-dir.txt';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** C0 controls (NUL, tab, escape, ...) and DEL: never part of a path that an operator meant to type. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The path in `<appRoot>/altis-data-dir.txt`: its first non-blank line, trimmed (a UTF-8 byte-order mark is
 * dropped, because Notepad adds one; a bare CR ends a line too). The rest of the file is ignored, so it can
 * hold a note. Null when the file is absent or blank.
 *
 * A file that exists but cannot be read, or whose path holds a control character, is an error, not an
 * absence: falling through to another directory would quietly start a second, empty installation next to the
 * real one.
 */
function readPointer(appRoot: string): string | null {
  const file = path.join(appRoot, DATA_DIR_POINTER_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new DomainError('INVALID_CONFIG', {
      detail:
        `Berkas ${file} ada tetapi tidak dapat dibaca (${code ?? 'galat tak dikenal'}); perbaiki izinnya atau hapus berkas itu / ` +
        `The file ${file} exists but cannot be read (${code ?? 'unknown error'}); fix its permissions or delete it`,
      meta: { reason: 'data_dir_pointer_unreadable', path: file, code },
      cause: error,
    });
  }
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
  const value = lines.map((line) => line.trim()).find((line) => line !== '');
  if (value === undefined) return null;
  if (hasControlCharacter(value)) {
    throw new DomainError('INVALID_CONFIG', {
      detail:
        `Baris pertama ${file} memuat karakter kontrol (misalnya NUL atau tab); tulis satu path biasa di baris pertama / ` +
        `The first line of ${file} holds a control character (such as NUL or a tab); write one plain path on the first line`,
      meta: { reason: 'data_dir_pointer_invalid', path: file },
    });
  }
  return value;
}

/**
 * Finds DATA_DIR. The first rule that applies wins:
 *
 * 1. `ALTIS_DATA_DIR` in the environment (`source: 'env'`);
 * 2. the first line of `<appRoot>/altis-data-dir.txt`, trimmed (`'pointer'`);
 * 3. when `$HOME/public_html` exists: `$HOME/altis-data/<name of the app folder>` (`'home-altis-data'`),
 *    which keeps the data out of the web root on cPanel-style hosting;
 * 4. `<appRoot>/../altis-data` (`'sibling'`).
 *
 * A relative path from rule 1 or 2 is taken relative to `appRoot` (the working directory is not reliable
 * under Passenger). The directory is not created and nothing is checked about it: pass the result to
 * `checkDocroot` before using it.
 *
 * @throws DomainError `INVALID_CONFIG` when `altis-data-dir.txt` exists but cannot be read, or its path holds a
 *   control character
 */
export function resolveDataDir(o: ResolveDataDirOptions): { dir: string; source: DataDirSource } {
  const appRoot = path.resolve(o.appRoot);

  if (isEnvSet(o.env, 'ALTIS_DATA_DIR')) {
    return { dir: path.resolve(appRoot, (o.env['ALTIS_DATA_DIR'] as string).trim()), source: 'env' };
  }

  const pointed = readPointer(appRoot);
  if (pointed !== null) return { dir: path.resolve(appRoot, pointed), source: 'pointer' };

  if (o.home.trim() !== '' && isDirectory(path.join(o.home, 'public_html'))) {
    const name = path.basename(appRoot) || 'app';
    return { dir: path.resolve(o.home, 'altis-data', name), source: 'home-altis-data' };
  }

  return { dir: path.resolve(appRoot, '..', 'altis-data'), source: 'sibling' };
}
