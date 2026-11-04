import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp, type FakeHandler } from '../fake-api';
import { AGENT_BALAI, AGENT_PRAM, FIRST, PUBLISHER_GRAMEDIA, SUBJECT_SEJARAH, paged } from './authorities-fixtures';

// Otoritas (Phase 2 Task 26; spec §13 "Otoritas", §3.5): the tabs Nama/Subjek/Penerbit, each a keyset list of its
// authorities (`GET catalog/{agents|subjects|publishers}`) with a search, a type filter and the usage count. The tab,
// the view and the applied filters live in the URL, and each tab reads under its own query key.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET catalog/agents': () => paged([AGENT_PRAM, AGENT_BALAI]),
    'GET catalog/subjects': () => paged([SUBJECT_SEJARAH]),
    'GET catalog/publishers': () => paged([PUBLISHER_GRAMEDIA]),
    ...extra,
  };
}

/** The keys of the queries a mounted component reads now. */
function activeKeys(queryClient: QueryClient): QueryKey[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((q) => q.getObserversCount() > 0)
    .map((q) => q.queryKey);
}

const startsWith = (key: QueryKey, prefix: readonly unknown[]): boolean => prefix.every((part, i) => key[i] === part);

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest('tr')!;

describe('Otoritas: the tabs', () => {
  it('Nama is the first tab; switching to Subjek and Penerbit switches the query key, the request and the URL', async () => {
    const { queryClient, requests, router } = startApp({ me: adminMe(), path: '/admin/catalog/authorities', routes: listRoutes() });
    expect(await screen.findByRole('heading', { name: 'Otoritas' }, FIRST)).toBeTruthy();
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    expect(screen.getByRole('tab', { name: 'Nama' }).getAttribute('aria-selected')).toBe('true');
    expect(activeKeys(queryClient).some((k) => startsWith(k, ['catalog', 'agents', 'list']))).toBe(true);
    expect(requests.filter((r) => r.method === 'GET').map((r) => r.path)).toContain('catalog/agents');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Subjek' }), { button: 0 });
    await screen.findByText('Sejarah', undefined, FIRST);
    const subjectKeys = activeKeys(queryClient);
    expect(subjectKeys.some((k) => startsWith(k, ['catalog', 'subjects', 'list']))).toBe(true);
    expect(subjectKeys.some((k) => startsWith(k, ['catalog', 'agents']))).toBe(false);
    expect(requests.at(-1)?.path).toBe('catalog/subjects');
    expect(router.state.location.search).toEqual({ kind: 'subjects' });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Penerbit' }), { button: 0 });
    await screen.findByText('Gramedia Pustaka Utama');
    expect(activeKeys(queryClient).some((k) => startsWith(k, ['catalog', 'publishers', 'list']))).toBe(true);
    expect(within(rowOf('Gramedia Pustaka Utama')).getByText('Jakarta')).toBeTruthy();
    expect(router.state.location.search).toEqual({ kind: 'publishers' });
  });

  it('a link with ?kind=subjects opens on the Subjek tab', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/catalog/authorities?kind=subjects', routes: listRoutes() });
    await screen.findByText('Sejarah', undefined, FIRST);
    expect(screen.getByRole('tab', { name: 'Subjek' }).getAttribute('aria-selected')).toBe('true');
    expect(requests.some((r) => r.path === 'catalog/agents')).toBe(false);
  });
});

describe('Otoritas: the list', () => {
  it('shows the usage count and links each name to its page', async () => {
    startApp({ me: adminMe(), path: '/admin/catalog/authorities', routes: listRoutes() });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    const row = rowOf('Toer, Pramoedya Ananta');
    expect(within(row).getByText('3')).toBeTruthy();
    expect(within(row).getByText('1925-2006')).toBeTruthy();
    expect(within(row).getByText('Orang')).toBeTruthy();
    expect(within(rowOf('Balai Pustaka')).getByText('Badan')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Toer, Pramoedya Ananta' }).getAttribute('href')).toBe(
      `/admin/catalog/authorities/agents/${AGENT_PRAM.id}`,
    );
    expect(screen.getByRole('link', { name: 'Tambah nama' }).getAttribute('href')).toBe('/admin/catalog/authorities/agents/new');
  });

  it('the search and the type filter are applied together: in the request, the query key and the URL', async () => {
    const { requests, router, queryClient } = startApp({ me: adminMe(), path: '/admin/catalog/authorities', routes: listRoutes() });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    fireEvent.change(screen.getByLabelText('Cari'), { target: { value: ' toer ' } });
    fireEvent.change(screen.getByLabelText('Tipe'), { target: { value: 'person' } });
    // Nothing is read before "Terapkan".
    expect(requests.filter((r) => r.query.has('q'))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(requests.some((r) => r.path === 'catalog/agents' && r.query.get('q') === 'toer')).toBe(true));
    const last = requests.filter((r) => r.path === 'catalog/agents').at(-1)!;
    expect(last.query.get('type')).toBe('person');
    expect(last.query.has('includeArchived')).toBe(false);
    expect(router.state.location.search).toEqual({ q: 'toer', type: 'person' });
    expect(activeKeys(queryClient)).toContainEqual(['catalog', 'agents', 'list', { q: 'toer', type: 'person', includeArchived: false }]);
  });

  it('a search in the URL longer than the API takes (191 UTF-16 code units) is dropped, never sent', async () => {
    // 96 emoji are 96 code points but 192 UTF-16 code units: `shortText(191)` refuses them.
    const long = '\u{1F600}'.repeat(96);
    const { requests } = startApp({ me: adminMe(), path: `/admin/catalog/authorities?q=${encodeURIComponent(long)}`, routes: listRoutes() });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    expect(requests.filter((r) => r.path === 'catalog/agents').every((r) => !r.query.has('q'))).toBe(true);
    expect((screen.getByLabelText('Cari') as HTMLInputElement).value).toBe('');
  });

  it('the type filter lists the subject types on Subjek and is absent on Penerbit', async () => {
    startApp({ me: adminMe(), path: '/admin/catalog/authorities?kind=subjects', routes: listRoutes() });
    await screen.findByText('Sejarah', undefined, FIRST);
    const types = within(screen.getByLabelText('Tipe')).getAllByRole('option').map((o) => o.textContent);
    expect(types).toEqual(['Semua tipe', 'Topik', 'Geografis', 'Nama', 'Kurun waktu', 'Genre/bentuk', 'Pekerjaan']);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Penerbit' }), { button: 0 });
    await screen.findByText('Gramedia Pustaka Utama');
    expect(screen.queryByLabelText('Tipe')).toBeNull();
  });

  it('archived authorities are asked for on request and carry a badge', async () => {
    const archived = { ...AGENT_BALAI, archived: true, usage: 0 };
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/catalog/authorities',
      routes: listRoutes({ 'GET catalog/agents': (req) => paged(req.query.get('includeArchived') === 'true' ? [AGENT_PRAM, archived] : [AGENT_PRAM]) }),
    });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    expect(screen.queryByText('Balai Pustaka')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tampilkan yang diarsipkan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    await screen.findByText('Balai Pustaka');
    expect(requests.at(-1)?.query.get('includeArchived')).toBe('true');
    expect(within(rowOf('Balai Pustaka')).getByText('Diarsipkan')).toBeTruthy();
  });

  it('"Muat lagi" reads the next page with the cursor', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/catalog/authorities',
      routes: listRoutes({
        'GET catalog/agents': (req) => (req.query.get('cursor') === 'k.next' ? paged([AGENT_BALAI]) : paged([AGENT_PRAM], 'k.next')),
      }),
    });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    await screen.findByText('Balai Pustaka');
    expect(requests.at(-1)?.query.get('cursor')).toBe('k.next');
    expect(screen.getByText('Toer, Pramoedya Ananta')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).toBeNull();
  });

  it('without catalog.authorities.manage there is nothing to add', async () => {
    startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: '/admin/catalog/authorities', routes: listRoutes() });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    expect(screen.queryByRole('link', { name: 'Tambah nama' })).toBeNull();
  });

  it('in English for a user who chose English', async () => {
    const me = signedIn();
    startApp({ me: { ...me, user: { ...me.user, locale: 'en' } }, path: '/admin/catalog/authorities', routes: listRoutes() });
    await screen.findByText('Toer, Pramoedya Ananta', undefined, FIRST);
    expect(screen.getByRole('tab', { name: 'Names' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Subjects' })).toBeTruthy();
    expect(within(rowOf('Toer, Pramoedya Ananta')).getByText('Person')).toBeTruthy();
  });
});
