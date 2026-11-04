import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Version sync (spec §4.8): the SPA was built as __ALTIS_BUILD__ (0.1.0 under Vitest); a server answering with
// another X-Altis-Build means a newer release is running. The page reloads at once when no form is being filled,
// else the banner "ALTIS telah diperbarui — muat ulang" shows. One automatic reload per server build and tab, so a
// stale cache between the browser and the server can never make the page reload forever.

async function load() {
  vi.resetModules();
  return {
    buildSync: (await import('@/lib/build-sync')).buildSync,
    useBuildMismatch: (await import('@/lib/build-sync')).useBuildMismatch,
    page: (await import('@/lib/page')).page,
    dirty: await import('@/lib/dirty-forms'),
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSync.observe', () => {
  it('the SPA build is __ALTIS_BUILD__', async () => {
    const { buildSync } = await load();
    expect(buildSync.clientBuild).toBe('0.1.0');
  });

  it('a mismatch without a dirty form reloads once, and sets mismatch', async () => {
    const { buildSync, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    buildSync.observe('0.2.0');
    expect(buildSync.mismatch).toBe(true);
    expect(buildSync.serverBuild).toBe('0.2.0');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('with a dirty form: no reload; once the form is clean, the next response reloads', async () => {
    const { buildSync, page, dirty } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const form = Symbol('form');
    dirty.dirtyForms.add(form);
    buildSync.observe('0.2.0');
    expect(reload).not.toHaveBeenCalled();
    expect(buildSync.mismatch).toBe(true);
    dirty.dirtyForms.remove(form);
    buildSync.observe('0.2.0');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('after one automatic reload for a server build, the same mismatch only shows the banner', async () => {
    const first = await load();
    vi.spyOn(first.page, 'reload').mockImplementation(() => {});
    first.buildSync.observe('0.2.0');
    // The page "reloaded" but the old bundle came back (a cache ignored no-store): a fresh module state.
    const second = await load();
    const reload = vi.spyOn(second.page, 'reload').mockImplementation(() => {});
    second.buildSync.observe('0.2.0');
    expect(second.buildSync.mismatch).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    // A newer build still gets its one reload.
    second.buildSync.observe('0.3.0');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the same build, or no header value, changes nothing', async () => {
    const { buildSync, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    buildSync.observe('0.1.0');
    buildSync.observe('');
    expect(buildSync.mismatch).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('useBuildMismatch follows the flag', async () => {
    const { buildSync, page, dirty, useBuildMismatch } = await load();
    vi.spyOn(page, 'reload').mockImplementation(() => {});
    dirty.dirtyForms.add(Symbol('form'));
    const { result, rerender } = renderHook(() => useBuildMismatch());
    expect(result.current).toBe(false);
    buildSync.observe('0.2.0');
    rerender();
    expect(result.current).toBe(true);
  });
});

describe('useDirtyGuard', () => {
  it('registers the form while it is dirty and unregisters it when clean or unmounted', async () => {
    const { dirty } = await load();
    const { rerender, unmount } = renderHook(({ isDirty }) => dirty.useDirtyGuard(isDirty), { initialProps: { isDirty: false } });
    expect(dirty.dirtyForms.count()).toBe(0);
    rerender({ isDirty: true });
    expect(dirty.dirtyForms.count()).toBe(1);
    rerender({ isDirty: false });
    expect(dirty.dirtyForms.count()).toBe(0);
    rerender({ isDirty: true });
    unmount();
    expect(dirty.dirtyForms.count()).toBe(0);
  });

  it('asks before the page is left while a form is dirty', async () => {
    const { dirty } = await load();
    const { unmount } = renderHook(() => dirty.useDirtyGuard(true));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    unmount();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
