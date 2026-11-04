import type { MeResponse } from '@altis/shared/api/auth';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '@/lib/page';
import { fakeServer, renderInBrowser, signedIn } from './fake-server';

// 1c Task 19: `/admin/_update` is the server's operations page (ops.update_page, served before the SPA's index). Were
// the SPA document itself ever served there (a server that does not know the page, a dev server answering every path
// with index.html), loading the page again would only load the SPA again, without end: the route says "not found"
// instead. What tells the case is the address the document was LOADED at, read once when the bundle starts, never the
// address bar now (the router has already moved it there by the time the route's beforeLoad runs).
//
// This file is that page load: the address is set before any module of the app is evaluated (vi.hoisted runs before
// the imports above).
vi.hoisted(() => {
  window.history.replaceState(null, '', '/admin/_update');
});

const fetchMock = vi.fn<typeof fetch>();
let me: MeResponse;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  me = signedIn();
  fakeServer(fetchMock, () => me);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the SPA document served at /admin/_update', () => {
  it('shows "not found" and never loads the page again (no assign loop)', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    renderInBrowser('/admin/_update');
    expect(await screen.findByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('the rest of the SPA still works from there, and a later navigation back says "not found" again', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const { router } = renderInBrowser('/admin/_update');
    await screen.findByRole('heading', { name: 'Halaman tidak ditemukan' });
    await router.navigate({ href: '/admin' });
    expect(await screen.findByText('Selamat datang, Ani.')).toBeTruthy();
    await router.navigate({ href: '/admin/_update' });
    expect(await screen.findByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/admin/_update'));
    expect(assign).not.toHaveBeenCalled();
  });
});
