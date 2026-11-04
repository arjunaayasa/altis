import { page } from './page';

/**
 * Lazy route chunks (spec §4.8: "Impor lazy route yang gagal memicu satu kali muat ulang"). After an update the tab
 * may ask for a chunk of its own (older) build that the new release no longer has (the server falls back to the
 * previous release's assets, but only one release back). A failed import therefore reloads the page once per build;
 * should the import fail again for the same build, the error reaches the route's error screen.
 */

const FLAG = 'altis.reload-once';

/**
 * Wraps a dynamic import. On the first failure for this build it stores `sessionStorage['altis.reload-once'] =
 * __ALTIS_BUILD__` and reloads (the returned promise never settles: the page is going away); on a failure with the
 * flag already set for this build, or when the storage cannot keep the flag (a reload could then loop), it rethrows.
 */
export function lazyWithReload<T>(importer: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await importer();
    } catch (error) {
      let reloadedBefore: boolean;
      try {
        reloadedBefore = sessionStorage.getItem(FLAG) === __ALTIS_BUILD__;
        if (!reloadedBefore) sessionStorage.setItem(FLAG, __ALTIS_BUILD__);
      } catch {
        throw error;
      }
      if (reloadedBefore) throw error;
      page.reload();
      return new Promise<T>(() => {});
    }
  };
}
