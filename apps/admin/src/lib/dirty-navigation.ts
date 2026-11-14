import { useBlocker } from '@tanstack/react-router';
import { useCallback } from 'react';
import { isSignInPath } from './api';
import { dirtyForms } from './dirty-forms';

/** Where a navigation starts or goes, as the router's blocker names it. */
interface Place {
  pathname: string;
  search: unknown;
}

/**
 * Whether going from `current` to `next` leaves what the page shows while a form holds unsaved changes: another path
 * or other search params (a tab, a period). The sign-in page after the session ended is let through: the shell already
 * said that the unsaved changes can no longer be saved, and the user chose to sign in again.
 */
function leavesUnsaved({ current, next }: { current: Place; next: Place }): boolean {
  if (dirtyForms.count() === 0 || isSignInPath(next.pathname)) return false;
  return current.pathname !== next.pathname || JSON.stringify(current.search) !== JSON.stringify(next.search);
}

/** The question asked before an in-app navigation drops unsaved changes: go on (`leave`) or stay. */
export interface UnsavedQuestion {
  leave(): void;
  stay(): void;
}

/**
 * Asks before an in-app navigation (a link, a tab or a period that moves the address, the browser's back button)
 * unmounts a form registered in {@link dirtyForms} with unsaved changes. Leaving the page itself (closing the tab,
 * typing another address) is the browser's own question (`useDirtyGuard`); this one covers the router. Answers the
 * question being asked, or null while none is: the caller shows it and calls `leave()` or `stay()`.
 */
export function useUnsavedNavigationQuestion(): UnsavedQuestion | null {
  const shouldBlockFn = useCallback((args: { current: Place; next: Place }) => leavesUnsaved(args), []);
  const blocker = useBlocker({ shouldBlockFn, enableBeforeUnload: false, withResolver: true });
  return blocker.status === 'blocked' ? { leave: blocker.proceed, stay: blocker.reset } : null;
}
