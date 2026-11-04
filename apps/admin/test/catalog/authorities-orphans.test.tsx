import type { OrphansArchiveResponse } from '@altis/shared/api/catalog/authorities';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';
import { FIRST, orphanAgents, paged } from './authorities-fixtures';

// Otoritas › Yatim (Phase 2 Task 26; spec §3.5 "Yatim", §13): the authorities of a kind that no record links to
// (`GET catalog/orphans?kind=`), with a bulk archive of at most 500 ids per request (`POST catalog/orphans/archive`,
// one audit entry), which answers `{archived, skipped}`: one that a record started to use meanwhile is skipped.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const THREE = orphanAgents(1, 3);

function orphanRoutes(o: { pages?: Record<string, ReturnType<typeof paged>>; archive?: (req: FakeRequest) => OrphansArchiveResponse } = {}) {
  const routes: Record<string, FakeHandler> = {
    'GET catalog/agents': () => paged([]),
    'GET catalog/orphans': (req) => o.pages?.[req.query.get('cursor') ?? ''] ?? paged(THREE),
    'POST catalog/orphans/archive': (req) => o.archive?.(req) ?? { archived: 0, skipped: 0 },
  };
  return routes;
}

describe('Otoritas: the orphans view', () => {
  it('lists the orphans of the tab’s kind', async () => {
    const { requests, router } = startApp({ me: adminMe(), path: '/admin/catalog/authorities', routes: orphanRoutes() });
    fireEvent.click(await screen.findByRole('button', { name: 'Yatim' }, FIRST));
    await screen.findByText('Yatim 1', undefined, FIRST);
    const read = requests.filter((r) => r.path === 'catalog/orphans').at(-1)!;
    expect(read.query.get('kind')).toBe('agents');
    expect(router.state.location.search).toEqual({ view: 'orphans' });
    expect(screen.getByRole('link', { name: 'Yatim 2' }).getAttribute('href')).toBe(`/admin/catalog/authorities/agents/${THREE[1]!.id}`);
  });

  it('archives the selected orphans after confirmation and shows {archived, skipped}', async () => {
    const posted: unknown[] = [];
    const { writes } = startApp({
      me: adminMe(),
      path: '/admin/catalog/authorities?view=orphans',
      routes: orphanRoutes({
        archive: (req) => {
          posted.push(req.body);
          return { archived: 1, skipped: 1 };
        },
      }),
    });
    await screen.findByText('Yatim 1', undefined, FIRST);
    const archive = screen.getByRole('button', { name: 'Arsipkan terpilih' });
    expect(archive.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Yatim 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Yatim 3' }));
    expect(screen.getByText('2 dipilih')).toBeTruthy();
    fireEvent.click(archive);
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan 2 otoritas yatim?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(writes()).toEqual(['POST catalog/orphans/archive']));
    expect(posted).toEqual([{ kind: 'agents', ids: [THREE[0]!.id, THREE[2]!.id] }]);
    expect(await screen.findByText('1 diarsipkan, 1 dilewati karena masih dipakai.')).toBeTruthy();
    // The selection is cleared and the list is read again.
    expect(screen.queryByText('2 dipilih')).toBeNull();
  });

  it('selects at most 500 at once: "Pilih semua" over 600 loaded orphans posts 500 ids', async () => {
    const all = orphanAgents(1, 600);
    const posted: { kind: string; ids: string[] }[] = [];
    startApp({
      me: adminMe(),
      path: '/admin/catalog/authorities?view=orphans',
      routes: orphanRoutes({
        pages: {
          '': paged(all.slice(0, 200), 'k.200'),
          'k.200': paged(all.slice(200, 400), 'k.400'),
          'k.400': paged(all.slice(400, 600)),
        },
        archive: (req) => {
          posted.push(req.body as { kind: string; ids: string[] });
          return { archived: 500, skipped: 0 };
        },
      }),
    });
    // 600 rows: text and label queries, since a role query over this DOM computes every element's role and name and
    // takes seconds in jsdom.
    await screen.findByText('Yatim 200', undefined, FIRST);
    fireEvent.click(screen.getByText('Muat lagi'));
    await screen.findByText('Yatim 400', undefined, { timeout: 4000 });
    fireEvent.click(screen.getByText('Muat lagi'));
    await screen.findByText('Yatim 600', undefined, { timeout: 4000 });
    fireEvent.click(screen.getByLabelText('Pilih semua yang tampil (paling banyak 500)'));
    expect(screen.getByText('500 dipilih')).toBeTruthy();
    expect(screen.getByText('Paling banyak 500 otoritas sekaligus. Arsipkan yang terpilih dulu, lalu pilih lagi.')).toBeTruthy();
    // The 501st cannot be added to the selection.
    const box501 = screen.getByLabelText('Pilih Yatim 501') as HTMLInputElement;
    expect(box501.checked).toBe(false);
    expect(box501.disabled).toBe(true);
    fireEvent.click(screen.getByText('Arsipkan terpilih'));
    const dialog = (await screen.findByText('Arsipkan 500 otoritas yatim?', undefined, { timeout: 4000 })).closest<HTMLElement>('[role="alertdialog"]')!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(posted).toHaveLength(1), { timeout: 4000 });
    expect(posted[0]!.kind).toBe('agents');
    expect(posted[0]!.ids).toHaveLength(500);
    expect(posted[0]!.ids).toEqual(all.slice(0, 500).map((o) => o.id));
    expect(await screen.findByText('500 diarsipkan, 0 dilewati karena masih dipakai.', undefined, { timeout: 4000 })).toBeTruthy();
    // Rendering 600 rows several times takes about 2 s in jsdom alone: more than the default 5 s on a loaded machine.
  }, 20_000);

  it('on Subjek the orphans are the subjects', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/catalog/authorities?kind=subjects&view=orphans',
      routes: { ...orphanRoutes(), 'GET catalog/orphans': () => paged([{ id: THREE[0]!.id, label: 'Ilmu gaib', type: 'topic' }]) },
    });
    await screen.findByText('Ilmu gaib', undefined, FIRST);
    expect(requests.filter((r) => r.path === 'catalog/orphans').at(-1)?.query.get('kind')).toBe('subjects');
    expect(within(screen.getByText('Ilmu gaib').closest('tr')!).getByText('Topik')).toBeTruthy();
  });

  it('without catalog.authorities.manage the orphans are listed without selection or archive', async () => {
    startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: '/admin/catalog/authorities?view=orphans', routes: orphanRoutes() });
    await screen.findByText('Yatim 1', undefined, FIRST);
    expect(screen.queryByRole('checkbox', { name: 'Pilih Yatim 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Arsipkan terpilih' })).toBeNull();
  });
});
