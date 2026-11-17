import { useCallback, useSyncExternalStore } from 'react';

/**
 * The colour theme of the admin, chosen in the user menu: light, dark, or the system's (the default). The choice is
 * this browser's (localStorage), not the account's: a shared desk PC keeps the theme its staff picked.
 *
 * index.html applies a stored choice before the first paint with a small inline script (it carries the request's CSP
 * nonce, as the release build requires of any inline script): it sets `data-theme` on `<html>` to `light` or `dark`;
 * no attribute means "follow the system" (index.css reads `prefers-color-scheme` then). That script reads the same key
 * as {@link THEME_STORAGE_KEY}; test/theme.test.ts keeps the two in step.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

/** The choices in the order the user menu offers them. */
export const THEME_CHOICES: readonly ThemeChoice[] = Object.freeze(['light', 'dark', 'system'] as const);

/** The localStorage key of the choice. */
export const THEME_STORAGE_KEY = 'altis.admin.theme';

const isChoice = (value: unknown): value is ThemeChoice => typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);

/** The stored choice; `system` when none is stored, the value is unknown, or storage cannot be read (private mode). */
export function readThemeChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isChoice(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Puts `choice` on `<html>`: `data-theme="light|dark"`, or no attribute for the system's theme. */
export function applyThemeChoice(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

const listeners = new Set<() => void>();

/** The choice of this page when storage refused it. */
let fallback: ThemeChoice | null = null;

/** Stores `choice` (the system's theme removes the key) and applies it at once; storage that fails still applies it. */
export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    fallback = null;
  } catch {
    // Storage blocked: the choice lasts until the page is loaded again.
    fallback = choice;
  }
  applyThemeChoice(choice);
  for (const listener of listeners) listener();
}

function current(): ThemeChoice {
  return fallback ?? readThemeChoice();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of this browser changed it: follow, as that tab's next page load would.
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
    applyThemeChoice(current());
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The current choice and a setter that stores and applies it. */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore(subscribe, current, () => 'system' as const);
  const set = useCallback((next: ThemeChoice) => saveThemeChoice(next), []);
  return [choice, set];
}
