import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A lazy route chunk that fails to load (a release replaced the files the tab knows) triggers one reload per build
// (spec §4.8): the flag `sessionStorage['altis.reload-once'] = __ALTIS_BUILD__` remembers it, and a second failure
// for the same build is rethrown to the error screen instead of reloading again.

async function load() {
  vi.resetModules();
  return {
    lazyWithReload: (await import('@/lib/lazy-reload')).lazyWithReload,
    page: (await import('@/lib/page')).page,
  };
}

/** Whether `promise` settled within a few ticks. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lazyWithReload', () => {
  it('passes a successful import through', async () => {
    const { lazyWithReload, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const loader = lazyWithReload(async () => ({ Screen: 'x' }));
    await expect(loader()).resolves.toEqual({ Screen: 'x' });
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('altis.reload-once')).toBeNull();
  });

  it('the first rejection reloads and sets the flag; the promise never settles (the page is going away)', async () => {
    const { lazyWithReload, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const loader = lazyWithReload(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    const pending = loader();
    expect(await settled(pending)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('altis.reload-once')).toBe('0.1.0');
  });

  it('the second rejection for the same build rethrows without reloading', async () => {
    const { lazyWithReload, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    sessionStorage.setItem('altis.reload-once', '0.1.0');
    const error = new TypeError('Failed to fetch dynamically imported module');
    await expect(lazyWithReload(() => Promise.reject(error))()).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a flag left by another build does not count', async () => {
    const { lazyWithReload, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    sessionStorage.setItem('altis.reload-once', '0.0.9');
    void lazyWithReload(() => Promise.reject(new Error('chunk')))();
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('altis.reload-once')).toBe('0.1.0');
  });

  it('without a usable sessionStorage it rethrows instead of risking a reload loop', async () => {
    const { lazyWithReload, page } = await load();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const error = new Error('chunk');
    await expect(lazyWithReload(() => Promise.reject(error))()).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });
});
