import { useSyncExternalStore } from 'react';
import { dirtyForms } from './dirty-forms';
import { page } from './page';

/**
 * Version sync (spec §4.8). Every API response carries `X-Altis-Build`, the version of the release the server runs;
 * the SPA was built as `__ALTIS_BUILD__` (the release build passes the same version). When they differ a newer
 * release is running and this tab holds an older bundle:
 *
 * - no form is being filled ({@link dirtyForms}) → the page reloads at once, which loads the new index.html;
 * - a form is → `mismatch` is set and the shell shows "ALTIS telah diperbarui — muat ulang"; the first response after
 *   the form is clean again reloads.
 *
 * One automatic reload per server build and tab (`sessionStorage['altis.build-reload']`): should the old bundle come
 * back anyway (a cache between the browser and the server ignoring `no-store`), the banner stays instead of a reload
 * loop. A bundle built outside the release (`dev`, Vite's dev server) never reloads.
 */

const RELOADED_KEY = 'altis.build-reload';
const DEV_BUILD = 'dev';

const listeners = new Set<() => void>();

/** Reads the build already reloaded for, or null; never throws (storage blocked or full). */
function reloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_KEY);
  } catch {
    return null;
  }
}

/** Remembers a reload for `build`; false when the storage refuses (then no automatic reload: it could loop). */
function rememberReload(build: string): boolean {
  try {
    sessionStorage.setItem(RELOADED_KEY, build);
    return true;
  } catch {
    return false;
  }
}

export const buildSync = {
  /** The version this bundle was built as. */
  clientBuild: __ALTIS_BUILD__,
  /** The last version a response named, or null before the first response. */
  serverBuild: null as string | null,
  /** The server runs another version than this bundle. */
  mismatch: false,

  /** Feeds one response's `X-Altis-Build`. */
  observe(serverBuild: string): void {
    if (serverBuild === '' || buildSync.clientBuild === DEV_BUILD) return;
    buildSync.serverBuild = serverBuild;
    if (serverBuild === buildSync.clientBuild) return;
    if (!buildSync.mismatch) {
      buildSync.mismatch = true;
      for (const listener of listeners) listener();
    }
    if (dirtyForms.count() === 0 && reloadedFor() !== serverBuild && rememberReload(serverBuild)) page.reload();
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Whether the banner "ALTIS telah diperbarui — muat ulang" shows. */
export function useBuildMismatch(): boolean {
  return useSyncExternalStore(
    buildSync.subscribe,
    () => buildSync.mismatch,
    () => false,
  );
}
