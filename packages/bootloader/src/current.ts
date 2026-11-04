import {
  CURRENT_LOCK_WAIT_MS,
  dataPath,
  parseCurrentState,
  readJsonWithBak,
  updateCurrentState,
  withFileLock,
  type CurrentState,
} from '@altis/platform';

// DATA_DIR/releases/current.json (spec §9.3): which release runs.
//
// Reading, initialising and changing it (readCurrentState, updateCurrentState), where a release lives (releaseDir) and
// the validation of current.json (parseCurrentState) live in @altis/platform (current-state.ts, release-files.ts;
// S26, 1d Task 2), which the server uses too; they are re-exported here so the bootloader's modules keep importing
// them from this file.

export { CURRENT_LOCK_WAIT_MS, initialState, parseCurrentState, readCurrentState, releaseDir, updateCurrentState } from '@altis/platform';
export type { CurrentState, ReleaseRef, ReleaseSource } from '@altis/platform';

const CURRENT_FILE = 'current.json';
const CURRENT_LOCK = 'current.lock';

/**
 * Promotion of the pending release (spec §9.3: "`previous = active`, `active = pending`, `pending = null`"), under
 * current.lock through updateCurrentState: only when current.json's `pending` is `version`, and then `pendingSince`
 * is cleared too and `pinned` is kept (a pin is cleared by the next explicit update or `release:unpin`, §9.7).
 * Anything else (nothing pending, another version pending) writes nothing at all, so a second call, from another
 * process or a retry, is harmless. schema-meta.json is the migrator's to write, never this function's (D1d-22).
 *
 * The pending boot protocol (1d Task 16) calls it from the holder of boot.lock once the release is healthy.
 *
 * @returns `'promoted'` when this call wrote the promotion, `'not_pending'` otherwise
 * @throws DomainError `STATE_CORRUPT` as updateCurrentState (`state_missing` when neither current.json nor its `.bak`
 *   exists, unusable files, lock timeout)
 */
export async function promote(dataDir: string, version: string): Promise<'promoted' | 'not_pending'> {
  const result = await updateCurrentState(dataDir, function (state: CurrentState): CurrentState | null {
    const pending = state.pending;
    if (pending === null || pending.version !== version) return null;
    return { schema: 1, active: pending, previous: state.active, pending: null, pendingSince: null, pinned: state.pinned };
  });
  return result.changed ? 'promoted' : 'not_pending';
}

/**
 * ctx.markHealthy() of a release booted as `active` (1a): it reads the state under current.lock and writes nothing.
 * Promotion is {@link promote}, which only the pending boot protocol calls (1d Task 16): a release that runs as
 * `active` or as the `previous` fallback never promotes anything.
 *
 * @throws DomainError `STATE_CORRUPT` when current.json cannot be read (the server logs it and keeps serving)
 */
export async function markHealthy(dataDir: string, version: string): Promise<void> {
  void version;
  const file = dataPath(dataDir, 'releases', CURRENT_FILE);
  await withFileLock(
    dataPath(dataDir, 'releases', CURRENT_LOCK),
    async () => {
      const state = await readJsonWithBak(file, parseCurrentState);
      if (state === null || state.pending === null) return; // nothing pending: nothing to promote
    },
    { waitMs: CURRENT_LOCK_WAIT_MS },
  );
}
