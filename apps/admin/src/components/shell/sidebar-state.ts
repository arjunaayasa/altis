import { useCallback, useState } from 'react';

/** The localStorage key of the sidebar's width in this browser: `collapsed` (icons only) or `expanded`. */
export const SIDEBAR_STORAGE_KEY = 'altis.admin.sidebar';

/** Whether this browser keeps the sidebar collapsed; false when nothing is stored or storage cannot be read. */
export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/**
 * The sidebar's width as the user left it: collapsed to its icons or not, remembered in this browser (not in the
 * account: a shared desk PC keeps what its staff picked). Storage that fails (private mode, a full quota) still
 * changes the width, until the page is loaded again.
 */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const set = useCallback((next: boolean): void => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? 'collapsed' : 'expanded');
    } catch {
      // Storage blocked: the choice lasts until the page is loaded again.
    }
  }, []);
  return [collapsed, set];
}
