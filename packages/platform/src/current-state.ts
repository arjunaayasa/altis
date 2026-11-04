import fsp from 'node:fs/promises';
import { DomainError } from '@altis/shared';
import { atomicWriteJson, readJsonWithBak } from './atomic.js';
import { dataPath } from './datapath.js';
import { ensureDir } from './ensure-dir.js';
import { withFileLock } from './lock.js';
import { parseCurrentState, type CurrentState } from './release-files.js';

// DATA_DIR/releases/current.json (spec §9.3): which release runs. Read, initialised and changed under
// releases/current.lock with the atomic-file rules (temp → fsync → rename, `.bak` copy), validated by
// parseCurrentState (release-files.ts).
//
// Moved from packages/bootloader/src/current.ts in 1d (Task 2) so that app.js and the server share one reader and
// one writer: app.js bundles this module (ES2017, P1: no object spread here), and the server's update and rollback
// steps change the same file through updateCurrentState.

const CURRENT_FILE = 'current.json';
const CURRENT_LOCK = 'current.lock';

/**
 * How long a caller waits for current.lock: longer than a lock can stay fresh without its holder. A holder that this
 * process cannot judge by its pid (another PID namespace: a Docker container killed while it held the lock and
 * recreated a second later; another host) is judged by the lock's age alone, and that becomes stale only after 30 s
 * (the platform's floor). withFileLock's default wait of 10 s would end first, and the boot would fail with a
 * STATE_CORRUPT rescue page that stays until a restart; with 45 s the leftover lock is always taken over.
 */
export const CURRENT_LOCK_WAIT_MS = 45_000;

/** The state of a fresh installation: the bundled release, nothing else. */
export function initialState(bundledVersion: string): CurrentState {
  return { schema: 1, active: { version: bundledVersion, source: 'bundled' }, previous: null, pending: null, pendingSince: null, pinned: null };
}

/** The fields this release knows (release-files.ts CurrentState); a later release may add others. */
const KNOWN_FIELDS = ['schema', 'active', 'previous', 'pending', 'pendingSince', 'pinned'];

/** What was read: the state's known fields, and the object as it is in the file. */
interface ReadState {
  state: CurrentState;
  raw: Record<string, unknown>;
}

function parseRead(raw: unknown): ReadState {
  const state = parseCurrentState(raw);
  return { state, raw: raw as Record<string, unknown> };
}

/**
 * What is written: `state` (the known fields), then the fields of `raw` this release does not know, as they are.
 * Contract v1 lets a later release add fields to current.json, and app.js (promotion, revert), frozen with the first
 * public release, writes through here: dropping them would undo the later release's format at every promotion. Each
 * field is defined as an own property, so one named `__proto__` stays a field and never becomes the prototype.
 */
function withLaterFields(state: CurrentState, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schema: state.schema,
    active: state.active,
    previous: state.previous,
    pending: state.pending,
    pendingSince: state.pendingSince,
    pinned: state.pinned,
  };
  for (const key of Object.keys(raw)) {
    if (KNOWN_FIELDS.indexOf(key) !== -1) continue;
    Object.defineProperty(out, key, { value: raw[key], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** True when the main file is missing or is not JSON at all (a write cut short), as opposed to JSON that fails validation. */
async function mainFileTorn(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  try {
    JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return false;
  } catch {
    return true;
  }
}

/** True when the main file holds a valid state by itself (not missing, torn, or JSON that parseCurrentState refuses). */
async function mainFileValid(file: string): Promise<boolean> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    parseCurrentState(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads current.json under current.lock (falling back to its `.bak`), or creates it with {@link initialState}
 * when neither exists. A main file torn by a power cut is rewritten from the `.bak` content, a later release's fields
 * included (Review Focus 2); a main
 * file that is JSON but not a valid state is left for an operator to look at.
 *
 * The wait for current.lock ({@link CURRENT_LOCK_WAIT_MS}) outlasts the lock's staleness, so a lock left behind by
 * a killed process, in any PID namespace, is taken over rather than failing the boot.
 *
 * @throws DomainError `STATE_CORRUPT` when the file and its `.bak` both exist and neither is usable, or when the
 *   lock cannot be taken (held and refreshed by a live process for the whole wait); the I/O error itself for other
 *   failures
 */
export async function readCurrentState(dataDir: string, bundledVersion: string): Promise<CurrentState> {
  await ensureDir(dataPath(dataDir, 'releases'));
  const file = dataPath(dataDir, 'releases', CURRENT_FILE);
  return withFileLock(
    dataPath(dataDir, 'releases', CURRENT_LOCK),
    async () => {
      const read = await readJsonWithBak(file, parseRead);
      if (read === null) {
        const fresh = initialState(bundledVersion);
        await atomicWriteJson(file, fresh);
        return fresh;
      }
      if (await mainFileTorn(file)) await atomicWriteJson(file, withLaterFields(read.state, read.raw));
      return read.state;
    },
    { waitMs: CURRENT_LOCK_WAIT_MS },
  );
}

/**
 * Changes current.json under current.lock, for app.js (promotion, revert) and the server (the update's point of no
 * return, rollback, pin) alike, so that no two changes are lost to a race across processes.
 *
 * Reads the state (from the `.bak` when the main file is torn or not a valid state), hands `change` a copy of its
 * own, validates what it returns with parseCurrentState (only its known fields are written, plus the fields a later
 * release added to the file, kept as they are) and writes that atomically, the old state becoming the `.bak`. When the state came from the `.bak`, the main file is first rewritten
 * with it (as {@link readCurrentState} does for a torn one), so the `.bak` then holds the state the change was applied
 * to rather than the unusable content. A `change` that returns null writes nothing at all.
 *
 * Unlike readCurrentState it never creates the file: only a boot knows the bundled version an initial state names.
 *
 * @returns the state now in the file and whether this call wrote it
 * @throws TypeError from parseCurrentState when the changed state is not valid (nothing is written); `change`'s own
 *   error as it is (nothing is written); DomainError `STATE_CORRUPT` `{reason: 'state_missing'}` when neither
 *   current.json nor its `.bak` exists, and as {@link readCurrentState} otherwise (unusable files, lock timeout,
 *   `lock_lost` when the lock was taken over before the write)
 */
export async function updateCurrentState(
  dataDir: string,
  change: (state: CurrentState) => CurrentState | null,
): Promise<{ state: CurrentState; changed: boolean }> {
  await ensureDir(dataPath(dataDir, 'releases'));
  const file = dataPath(dataDir, 'releases', CURRENT_FILE);
  return withFileLock(
    dataPath(dataDir, 'releases', CURRENT_LOCK),
    async (lock) => {
      const read = await readJsonWithBak(file, parseRead);
      if (read === null) {
        throw new DomainError('STATE_CORRUPT', {
          detail:
            `Berkas status ${file} tidak ada (juga salinan .bak-nya); jalankan ALTIS sekali agar dibuat ulang / ` +
            `State file ${file} does not exist (nor its .bak copy); start ALTIS once so that it is created again`,
          meta: { reason: 'state_missing', path: file },
        });
      }
      const state = read.state;
      const next = change(parseCurrentState(state));
      if (next === null) return { state, changed: false };
      const valid = parseCurrentState(next);
      lock.assertHeld();
      if (!(await mainFileValid(file))) await atomicWriteJson(file, withLaterFields(state, read.raw));
      await atomicWriteJson(file, withLaterFields(valid, read.raw));
      return { state: valid, changed: true };
    },
    { waitMs: CURRENT_LOCK_WAIT_MS },
  );
}
