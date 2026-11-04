import { useEffect } from 'react';

/**
 * The forms being filled in right now (spec §4.8): while one is, a newer release on the server only shows the
 * "muat ulang" banner instead of reloading the page under the user's hands.
 */
const dirty = new Set<symbol>();

export const dirtyForms = {
  add(form: symbol): void {
    dirty.add(form);
  },
  remove(form: symbol): void {
    dirty.delete(form);
  },
  count(): number {
    return dirty.size;
  },
};

/** The browser's own "leave this page?" question while a form is dirty (closing the tab, typing another address). */
function askBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

/**
 * Registers the calling form in {@link dirtyForms} while `isDirty` (react-hook-form's `formState.isDirty`), and asks
 * before the page is left meanwhile. Unregisters when the form is clean again or unmounted.
 */
export function useDirtyGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return undefined;
    const form = Symbol('dirty-form');
    dirtyForms.add(form);
    window.addEventListener('beforeunload', askBeforeLeaving);
    return () => {
      dirtyForms.remove(form);
      window.removeEventListener('beforeunload', askBeforeLeaving);
    };
  }, [isDirty]);
}
