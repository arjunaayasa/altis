import { randomBytes } from 'node:crypto';
import {
  dataPath,
  ensureDir,
  isEnvSet,
  readBytes,
  removeTree,
  renameRetry,
  statOrNull,
  withFileLock,
  writeExclusive,
  type DataPath,
  type Env,
} from '@altis/platform';
import { DomainError, isDomainError, newId } from '@altis/shared';

// The install code (spec §7.7, §9.5 step 0; decision C19). Before the install, the wizard is open only to whoever
// can read this code: from the server's stdout, from DATA_DIR/install-code.txt through the hosting panel's File
// Manager, or (Docker) from ALTIS_INSTALL_CODE, which altis-init writes into .env.
//
// - 26 characters of Crockford's base32 (0-9, A-Z without I, L, O, U), 130 random bits, shown in groups 5-5-5-5-6.
//   What a person types back is normalized: case, white space and dashes do not matter, I and L read as 1, O as 0.
// - DATA_DIR/install-code.txt holds `{code, createdAt}` (the code as shown, epoch ms), mode 600. It is made with
//   O_EXCL only when there is none or it is older than 24 h; every process validates against that one file, so every
//   process prints the same code. Renewing a stale file happens under DATA_DIR/tmp/install-session.lock (moved aside
//   into tmp/, removed, then the new file created), so a process can never move away a code another process has just
//   written; a process that still loses the O_EXCL race reads the winner's code.
// - ALTIS_INSTALL_CODE, when set, wins and no file is written; a malformed value, or the code the documentation shows
//   as an example, is refused (INVALID_CONFIG naming the variable, never its value).

/** An install code stays valid this long after it was written (spec §7.7: "berumur > 24 jam"). */
export const INSTALL_CODE_TTL_MS = 86_400_000;

/**
 * The example code of the documentation, `ALTIS-CONTO-HKODE-INSTA-LASI01`, normalized: refused as
 * ALTIS_INSTALL_CODE, so that a copied example never opens an installation.
 */
export const EXAMPLE_INSTALL_CODE = 'A1T1SC0NT0HK0DE1NSTA1AS101';

/** A code written later than this ahead of the clock (a clock set back) is not trusted: a new one is made. */
const FUTURE_SKEW_MS = 5 * 60_000;

/** install-code.txt is a few dozen bytes; anything larger is not ours. */
const CODE_FILE_MAX_BYTES = 4096;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 26;
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Where the install code lives, how it was found, and whether this call wrote it. */
export interface InstallCodeInfo {
  /** The 26 characters, normalized (no dashes). */
  code: string;
  /** When the file was written (epoch ms); for ALTIS_INSTALL_CODE, the time of the call (it never expires). */
  createdAt: number;
  source: 'file' | 'env';
  /** True when this call wrote a new code (none before, or the old one had expired). */
  fresh: boolean;
}

/** A new install code: 26 Crockford characters, each the low 5 bits of a random byte (256 is a multiple of 32). */
export function generateInstallCode(): string {
  let out = '';
  for (const byte of randomBytes(CODE_LENGTH)) out += CROCKFORD[byte & 31];
  return out;
}

/** `code` (26 characters) in groups 5-5-5-5-6 joined by `-`, the way it is shown and stored. */
export function formatInstallCode(code: string): string {
  return [code.slice(0, 5), code.slice(5, 10), code.slice(10, 15), code.slice(15, 20), code.slice(20)].join('-');
}

/**
 * The 26 characters of an install code as typed, or null when it is not one: NFKC, upper case, white space and dashes
 * (`-` and the Unicode dashes autocorrect makes of it) removed, `I` and `L` read as `1` and `O` as `0` (Crockford's
 * decoding); what remains must be exactly 26 Crockford characters.
 */
export function normalizeInstallCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 256) return null;
  const normalized = input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s\-‐-―−]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CODE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * ALTIS_INSTALL_CODE, normalized; null when it is not set (blank counts as not set).
 *
 * @throws DomainError `INVALID_CONFIG` (`meta.env`) when it is malformed or the documentation's example
 */
export function envInstallCode(env: Env): string | null {
  if (!isEnvSet(env, 'ALTIS_INSTALL_CODE')) return null;
  const code = normalizeInstallCode(env['ALTIS_INSTALL_CODE']!);
  if (code === null || code === EXAMPLE_INSTALL_CODE) {
    throw new DomainError('INVALID_CONFIG', {
      detail:
        'ALTIS_INSTALL_CODE tidak valid: 26 karakter base32 (5-5-5-5-6), bukan contoh dari dokumentasi / ' +
        'ALTIS_INSTALL_CODE is invalid: 26 base32 characters (5-5-5-5-6), not the example of the documentation',
      meta: { env: 'ALTIS_INSTALL_CODE' },
    });
  }
  return code;
}

/** DATA_DIR/install-code.txt. */
export function installCodePath(dataDir: string): DataPath {
  return dataPath(dataDir, 'root', 'install-code.txt');
}

/** DATA_DIR/tmp/install-session.lock: the code's renewal, the claim counter and install-session.json (session.ts). */
export function installLockPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'tmp', 'install-session.lock');
}

/**
 * Creates DATA_DIR/tmp when missing (for the lock file and the state files below it). DATA_DIR itself is never
 * created: one that vanished (an unmounted volume) must not come back empty.
 *
 * @throws DomainError `STATE_CORRUPT` (`reason: 'datadir_missing'`) when DATA_DIR does not exist
 */
export async function ensureInstallTmp(dataDir: string): Promise<void> {
  if ((await statOrNull(dataPath(dataDir, 'root')))?.kind !== 'dir') {
    throw new DomainError('STATE_CORRUPT', {
      detail: 'DATA_DIR tidak ada; kode instalasi tidak dapat ditulis / DATA_DIR does not exist; the install code cannot be written',
      meta: { reason: 'datadir_missing' },
    });
  }
  await ensureDir(dataPath(dataDir, 'tmp'));
}

/** The content of install-code.txt, or null when it is missing or unusable (not JSON, a bad code or time). */
async function readCodeFile(file: DataPath): Promise<{ code: string; createdAt: number } | null> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(file, CODE_FILE_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null; // a folder, a huge file: not ours
    throw error;
  }
  if (bytes === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { code, createdAt } = raw as { code?: unknown; createdAt?: unknown };
  const normalized = typeof code === 'string' ? normalizeInstallCode(code) : null;
  if (normalized === null || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) return null;
  return { code: normalized, createdAt };
}

/** Whether a code written at `createdAt` is still valid at `now`: at most 24 h old, and not from the future. */
function isLive(createdAt: number, now: number): boolean {
  return now - createdAt <= INSTALL_CODE_TTL_MS && createdAt - now <= FUTURE_SKEW_MS;
}

/**
 * The code a claim is checked against at `now`: ALTIS_INSTALL_CODE when set, else the code of install-code.txt while
 * it is valid; null when there is none (missing, unusable or expired). Never writes.
 *
 * @throws DomainError `INVALID_CONFIG` for a malformed ALTIS_INSTALL_CODE (see {@link envInstallCode})
 */
export async function currentInstallCode(dataDir: string, o: { now: number; env: Env }): Promise<string | null> {
  const fromEnv = envInstallCode(o.env);
  if (fromEnv !== null) return fromEnv;
  const file = await readCodeFile(installCodePath(dataDir));
  return file !== null && isLive(file.createdAt, o.now) ? file.code : null;
}

/**
 * The install code every process validates against (see the top of this file): ALTIS_INSTALL_CODE when set;
 * otherwise install-code.txt, written first (O_EXCL, mode 600) when it is missing, unusable or older than 24 h
 * (`fresh: true`, the caller prints it to stdout).
 *
 * @throws DomainError `INVALID_CONFIG` for a malformed ALTIS_INSTALL_CODE; `STATE_CORRUPT` (`datadir_missing`) when
 *   DATA_DIR does not exist; `DISK_QUOTA` (P21) when the disk is full; a lock or file system error as it is
 */
export async function ensureInstallCode(dataDir: string, o: { now: number; env: Env }): Promise<InstallCodeInfo> {
  const fromEnv = envInstallCode(o.env);
  if (fromEnv !== null) return { code: fromEnv, createdAt: o.now, source: 'env', fresh: false };

  const file = installCodePath(dataDir);
  const current = await readCodeFile(file);
  if (current !== null && isLive(current.createdAt, o.now)) return { ...current, source: 'file', fresh: false };

  await ensureInstallTmp(dataDir);
  return withFileLock(installLockPath(dataDir), async (lock) => {
    // Another process may have renewed it while this one waited for the lock.
    const seen = await readCodeFile(file);
    if (seen !== null && isLive(seen.createdAt, o.now)) return { ...seen, source: 'file', fresh: false };
    if ((await statOrNull(file)) !== null) {
      // Stale or unusable: moved aside first, so the new one is still created with O_EXCL.
      const aside = dataPath(dataDir, 'tmp', newId());
      lock.assertHeld();
      await renameRetry(file, aside);
      await removeTree(aside);
    }
    const code = generateInstallCode();
    lock.assertHeld();
    if (await writeExclusive(file, JSON.stringify({ code: formatInstallCode(code), createdAt: o.now }), 0o600)) {
      return { code, createdAt: o.now, source: 'file', fresh: true };
    }
    // Lost the O_EXCL race to a writer that did not take the lock: its code is the one.
    const winner = await readCodeFile(file);
    if (winner === null) {
      throw new DomainError('STATE_CORRUPT', {
        detail: 'install-code.txt tidak dapat dibaca setelah dibuat / install-code.txt cannot be read after it was created',
        meta: { reason: 'install_code' },
      });
    }
    return { ...winner, source: 'file', fresh: false };
  });
}
