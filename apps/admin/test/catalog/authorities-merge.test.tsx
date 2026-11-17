import type { AgentView } from '@altis/shared/api/catalog/authorities';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, type FakeHandler } from '../fake-api';
import {
  AGENT_PRAM,
  AGENT_PRAM2,
  AGENT_PRAM2_ID,
  AGENT_PRAM_ID,
  FIRST,
  PUBLISHER_GRAMEDIA,
  PUBLISHER_GRAMEDIA_ID,
  paged,
  publisher,
} from './authorities-fixtures';

// The merge panel of an authority's page (Phase 2 Task 26; spec §3.5 "Gabung", §13): it opens in the page under its
// button (a region named by its heading, not a dialog), searches the target among
// the live authorities of the same kind (agents: of the same type, since agents of different types cannot merge),
// asks for a confirmation that says the merge cannot be undone, and only then posts `{intoId, version}` to
// `POST catalog/<kind>/:id/merge` (the version is the source's). The page then shows the source as merged.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Pram's page and the agents; a merge posted (its body lands in `posted`) makes Pram merged into Pram2. */
function agentRoutes(extra: Record<string, FakeHandler> = {}, posted: unknown[] = []): Record<string, FakeHandler> {
  let merged = false;
  return {
    'GET catalog/agents/:id': (req): AgentView =>
      req.params.id === AGENT_PRAM_ID ? (merged ? { ...AGENT_PRAM, archived: true, mergedInto: AGENT_PRAM2_ID, version: 4, usage: 0 } : AGENT_PRAM) : AGENT_PRAM2,
    'GET catalog/agents': () => paged([AGENT_PRAM, AGENT_PRAM2]),
    'POST catalog/agents/:id/merge': (req) => {
      posted.push(req.body);
      merged = true;
      return { id: AGENT_PRAM_ID, version: 4 };
    },
    ...extra,
  };
}

async function openMerge(): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
  const open = screen.getByRole('button', { name: 'Gabungkan ke otoritas lain…' });
  open.focus();
  fireEvent.click(open);
  return screen.findByRole('region', { name: 'Gabungkan Toer, Pramoedya Ananta' });
}

/** The merge panel, or null once it closed. */
const panelShown = (): HTMLElement | null => screen.queryByRole('region', { name: /^Gabungkan / });

/** Opens the target picker of the panel, types `text` and picks the option `label`. */
async function pickTarget(dialog: HTMLElement, text: string, label: string): Promise<void> {
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }));
  fireEvent.change(await screen.findByPlaceholderText('Ketik bagian dari nama'), { target: { value: text } });
  fireEvent.click(await screen.findByRole('option', { name: label }));
  await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }).textContent).toContain(label));
}

describe('the merge panel', () => {
  it('searches live agents of the same type, leaves the source out, and posts {intoId, version} only after the confirmation', async () => {
    const posted: unknown[] = [];
    const { requests, writes } = startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: agentRoutes({}, posted),
    });
    const dialog = await openMerge();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }));
    fireEvent.change(await screen.findByPlaceholderText('Ketik bagian dari nama'), { target: { value: 'toer' } });
    await waitFor(() => expect(requests.some((r) => r.path === 'catalog/agents' && r.query.get('q') === 'toer')).toBe(true));
    const search = requests.filter((r) => r.path === 'catalog/agents' && r.query.get('q') === 'toer').at(-1)!;
    expect(search.query.get('type')).toBe('person');
    expect(search.query.has('includeArchived')).toBe(false);
    // The source itself is not a target.
    await screen.findByRole('option', { name: 'Toer, Pramoedya A.' });
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Toer, Pramoedya A.']);
    fireEvent.click(screen.getByRole('option', { name: 'Toer, Pramoedya A.' }));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }).textContent).toContain('Toer, Pramoedya A.'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Lanjut' }));
    expect(await within(dialog).findByText('Gabungkan Toer, Pramoedya Ananta (1925-2006) ke Toer, Pramoedya A.?')).toBeTruthy();
    expect(within(dialog).getByText(/tidak bisa dibatalkan/)).toBeTruthy();
    expect(writes()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Gabungkan' }));
    await waitFor(() => expect(writes()).toEqual([`POST catalog/agents/${AGENT_PRAM_ID}/merge`]));
    expect(posted).toEqual([{ intoId: AGENT_PRAM2_ID, version: 3 }]);
    await waitFor(() => expect(panelShown()).toBeNull());
    expect(await screen.findByText(/Digabungkan ke Toer, Pramoedya A\./)).toBeTruthy();
    // The page reads the source again: it is merged now, with a link to the target and no more actions.
    expect(await screen.findByRole('link', { name: 'Buka otoritas tujuan' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Buka otoritas tujuan' }).getAttribute('href')).toBe(`/admin/catalog/authorities/agents/${AGENT_PRAM2_ID}`);
    expect(screen.queryByRole('button', { name: 'Gabungkan ke otoritas lain…' })).toBeNull();
  });

  it('"Kembali" returns to the choice; Esc closes the panel, posts nothing and gives the focus back to its button', async () => {
    const { writes } = startApp({ me: adminMe(), path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`, routes: agentRoutes() });
    const dialog = await openMerge();
    expect((within(dialog).getByRole('button', { name: 'Lanjut' }) as HTMLButtonElement).disabled).toBe(true);
    await pickTarget(dialog, 'toer', 'Toer, Pramoedya A.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lanjut' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Kembali' }));
    expect(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' })).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }), { key: 'Escape' });
    await waitFor(() => expect(panelShown()).toBeNull());
    expect(writes()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Gabungkan ke otoritas lain…' }));
  });

  it('the search list opens inside the panel, reads nothing before a letter is typed, and Escape closes the list first', async () => {
    const { requests } = startApp({ me: adminMe(), path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`, routes: agentRoutes() });
    const dialog = await openMerge();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }));
    const input = await within(dialog).findByPlaceholderText('Ketik bagian dari nama');
    expect(within(dialog).getByText('Ketik beberapa huruf untuk mencari.')).toBeTruthy();
    expect(requests.some((r) => r.path === 'catalog/agents')).toBe(false);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(within(dialog).queryByPlaceholderText('Ketik bagian dari nama')).toBeNull());
    expect(screen.getByRole('region', { name: 'Gabungkan Toer, Pramoedya Ananta' })).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }), { key: 'Escape' });
    await waitFor(() => expect(panelShown()).toBeNull());
  });

  it('a long search is cut to what the API takes (191 UTF-16 code units), never inside a surrogate pair', async () => {
    const { requests } = startApp({ me: adminMe(), path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`, routes: agentRoutes() });
    const dialog = await openMerge();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Otoritas tujuan' }));
    fireEvent.change(await within(dialog).findByPlaceholderText('Ketik bagian dari nama'), { target: { value: '\u{1F600}'.repeat(150) } });
    await waitFor(() => expect(requests.some((r) => r.path === 'catalog/agents' && r.query.has('q'))).toBe(true));
    const q = requests.filter((r) => r.path === 'catalog/agents' && r.query.has('q')).at(-1)!.query.get('q')!;
    expect(q).toBe('\u{1F600}'.repeat(95));
  });

  it('a refused merge stays in the panel with its reason', async () => {
    startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: agentRoutes({ 'POST catalog/agents/:id/merge': () => problem(422, 'CATALOG_MERGE_INVALID') }),
    });
    const dialog = await openMerge();
    await pickTarget(dialog, 'toer', 'Toer, Pramoedya A.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lanjut' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Gabungkan' }));
    expect(await within(dialog).findByText('Penggabungan ini tidak dapat dilakukan. Pilih tujuan lain yang masih aktif.')).toBeTruthy();
    expect(panelShown()).toBeTruthy();
  });

  it('publishers search without a type and post the publisher’s version', async () => {
    const target = publisher({ id: '01JZ00000000000000000000P2', name: 'Gramedia', place: 'Jakarta' });
    const posted: unknown[] = [];
    const { requests } = startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/publishers/${PUBLISHER_GRAMEDIA_ID}`,
      routes: {
        'GET catalog/publishers/:id': () => PUBLISHER_GRAMEDIA,
        'GET catalog/publishers': () => paged([PUBLISHER_GRAMEDIA, target]),
        'POST catalog/publishers/:id/merge': (req) => {
          posted.push(req.body);
          return { id: PUBLISHER_GRAMEDIA_ID, version: 5 };
        },
      },
    });
    await screen.findByRole('heading', { name: 'Gramedia Pustaka Utama' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Gabungkan ke otoritas lain…' }));
    const dialog = await screen.findByRole('region', { name: 'Gabungkan Gramedia Pustaka Utama' });
    await pickTarget(dialog, 'gramedia', 'Gramedia (Jakarta)');
    expect(requests.filter((r) => r.path === 'catalog/publishers').every((r) => !r.query.has('type'))).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lanjut' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Gabungkan' }));
    await waitFor(() => expect(posted).toEqual([{ intoId: target.id, version: 4 }]));
  });

  it('without catalog.authorities.manage there is no merge', async () => {
    startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`, routes: agentRoutes() });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    expect(screen.queryByRole('button', { name: 'Gabungkan ke otoritas lain…' })).toBeNull();
  });
});
