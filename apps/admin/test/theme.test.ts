import fs from 'node:fs';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_CHOICES, THEME_STORAGE_KEY, applyThemeChoice, readThemeChoice, saveThemeChoice, useThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/utils';

// The colour theme of the admin: light, dark or the system's (the default), remembered in this browser and applied
// before the first paint by index.html's inline script.

const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  root.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('the theme choice', () => {
  it('offers Terang, Gelap and Ikuti sistem; follows the system when nothing (or nothing known) is stored', () => {
    expect([...THEME_CHOICES]).toEqual(['light', 'dark', 'system']);
    expect(readThemeChoice()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readThemeChoice()).toBe('system');
  });

  it('a choice is stored and put on <html>; the system choice removes both', () => {
    saveThemeChoice('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(readThemeChoice()).toBe('dark');
    saveThemeChoice('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    saveThemeChoice('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('storage that refuses (private mode, blocked site data) still applies the choice for this page', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readThemeChoice()).toBe('system');
    const { result } = renderHook(() => useThemeChoice());
    act(() => result.current[1]('dark'));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(result.current[0]).toBe('dark');
    vi.restoreAllMocks();
    act(() => result.current[1]('system'));
    expect(result.current[0]).toBe('system');
  });

  it('useThemeChoice follows a choice made in another tab of this browser', () => {
    const { result } = renderHook(() => useThemeChoice());
    expect(result.current[0]).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });
    expect(result.current[0]).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('applyThemeChoice only touches the attribute', () => {
    const el = document.createElement('html');
    applyThemeChoice('light', el);
    expect(el.getAttribute('data-theme')).toBe('light');
    applyThemeChoice('system', el);
    expect(el.hasAttribute('data-theme')).toBe(false);
  });
});

describe("index.html's theme script", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const inline = [...head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, , body]) => body!.trim() !== '');

  it('is the one inline script, in <head>, with the CSP nonce placeholder, reading the key lib/theme.ts writes', () => {
    expect(inline).toHaveLength(1);
    expect(inline[0]![1]).toContain('nonce="__CSP_NONCE__"');
    expect(inline[0]![2]).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  /** Runs the script against a stored value (or a storage that throws) on a fresh element; the attribute it leaves. */
  const boot = (stored: string | null | Error): string | null => {
    const el = document.createElement('html');
    const storage = {
      getItem: () => {
        if (stored instanceof Error) throw stored;
        return stored;
      },
    };
    new Function('window', 'document', inline[0]![2]!)({ localStorage: storage }, { documentElement: el });
    return el.getAttribute('data-theme');
  };

  it('applies light and dark, nothing for the system choice, an unknown value or a storage that throws', () => {
    expect(boot('dark')).toBe('dark');
    expect(boot('light')).toBe('light');
    expect(boot(null)).toBeNull();
    expect(boot('system')).toBeNull();
    expect(boot('"><script>')).toBeNull();
    expect(boot(new Error('blocked'))).toBeNull();
  });
});

describe('cn and the tokens index.css adds', () => {
  it('text-meta is a type size and shadow-pop a shadow: a colour beside them stays, a size or shadow before them goes', () => {
    expect(cn('text-primary-foreground', 'text-meta')).toBe('text-primary-foreground text-meta');
    expect(cn('text-sm', 'text-meta')).toBe('text-meta');
    expect(cn('shadow-md', 'shadow-pop')).toBe('shadow-pop');
  });
});
