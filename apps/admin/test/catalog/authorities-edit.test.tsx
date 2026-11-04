import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, json, problem, signedIn, startApp, type FakeHandler } from '../fake-api';
import {
  AGENT_PRAM,
  AGENT_PRAM2,
  AGENT_PRAM2_ID,
  AGENT_PRAM_ID,
  FIRST,
  PUBLISHER_GRAMEDIA,
  PUBLISHER_GRAMEDIA_ID,
  SUBJECT_SEJARAH,
  SUBJECT_SEJARAH_ID,
  agent,
  paged,
} from './authorities-fixtures';

// An authority's page (Phase 2 Task 26; spec §3.5, §13): the form of its kind (an agent's type, name, dates, source,
// reference and note; a subject's type, term, classification, scope note and source; a publisher's name and place),
// saved with the row's version and only what changed (`PATCH catalog/<kind>/:id`, answered `{id, version}`, S15,
// then read again); creating one (`…/<kind>/new`, `POST catalog/<kind>`); archiving one no record uses.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NEW_ID = '01JZ00000000000000000000A9';

describe('an authority’s form', () => {
  it('a publisher’s edit PATCHes only what changed, with its version, and reads the publisher again', async () => {
    const patched: unknown[] = [];
    let reads = 0;
    const { writes } = startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/publishers/${PUBLISHER_GRAMEDIA_ID}`,
      routes: {
        'GET catalog/publishers/:id': () => {
          reads += 1;
          return patched.length === 0 ? PUBLISHER_GRAMEDIA : { ...PUBLISHER_GRAMEDIA, place: 'Jakarta Pusat', version: 5 };
        },
        'PATCH catalog/publishers/:id': (req) => {
          patched.push(req.body);
          return { id: PUBLISHER_GRAMEDIA_ID, version: 5 };
        },
      },
    });
    await screen.findByRole('heading', { name: 'Gramedia Pustaka Utama' }, FIRST);
    expect(screen.getByText('Dipakai 40 cantuman')).toBeTruthy();
    const place = screen.getByLabelText('Tempat terbit') as HTMLInputElement;
    expect(place.value).toBe('Jakarta');
    fireEvent.change(place, { target: { value: 'Jakarta Pusat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(writes()).toEqual([`PATCH catalog/publishers/${PUBLISHER_GRAMEDIA_ID}`]));
    expect(patched).toEqual([{ version: 4, place: 'Jakarta Pusat' }]);
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
  });

  it('a second save after the first sends the version the first one answered', async () => {
    const patched: { version: number }[] = [];
    let version = 3;
    startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: {
        'GET catalog/agents/:id': () => ({ ...AGENT_PRAM, version }),
        'PATCH catalog/agents/:id': (req) => {
          patched.push(req.body as { version: number });
          version += 1;
          return { id: AGENT_PRAM_ID, version };
        },
      },
    });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    fireEvent.change(screen.getByLabelText('Catatan'), { target: { value: 'Sastrawan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await screen.findByText('Perubahan disimpan.');
    fireEvent.change(screen.getByLabelText('Catatan'), { target: { value: 'Sastrawan Indonesia.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patched).toHaveLength(2));
    expect(patched).toEqual([
      { version: 3, note: 'Sastrawan.' },
      { version: 4, note: 'Sastrawan Indonesia.' },
    ]);
  });

  it('a renamed agent that records use says they are re-indexed', async () => {
    startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: { 'GET catalog/agents/:id': () => AGENT_PRAM, 'PATCH catalog/agents/:id': () => ({ id: AGENT_PRAM_ID, version: 4 }) },
    });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: 'Toer, Pramoedya' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Cantuman yang memakai otoritas ini diindeks ulang di latar belakang.')).toBeTruthy();
  });

  // C08: the server re-indexes a subject's records when its classification changes, and a publisher's when its place
  // does (the documents hold both); the note says so for those fields too.
  const REINDEX_NOTE = 'Cantuman yang memakai otoritas ini diindeks ulang di latar belakang.';

  it("a subject's new classification that records use says they are re-indexed", async () => {
    const { writes } = startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/subjects/${SUBJECT_SEJARAH_ID}`,
      routes: {
        'GET catalog/subjects/:id': () => SUBJECT_SEJARAH,
        'GET catalog/subjects': () => paged([SUBJECT_SEJARAH]),
        'PATCH catalog/subjects/:id': () => ({ id: SUBJECT_SEJARAH_ID, version: 2 }),
      },
    });
    await screen.findByRole('heading', { name: 'Sejarah' }, FIRST);
    fireEvent.change(screen.getByLabelText('Klasifikasi'), { target: { value: '959.8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(writes()).toEqual([`PATCH catalog/subjects/${SUBJECT_SEJARAH_ID}`]));
    expect(await screen.findByText(REINDEX_NOTE)).toBeTruthy();
  });

  it("a publisher's new place that records use says they are re-indexed", async () => {
    startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/publishers/${PUBLISHER_GRAMEDIA_ID}`,
      routes: {
        'GET catalog/publishers/:id': () => PUBLISHER_GRAMEDIA,
        'PATCH catalog/publishers/:id': () => ({ id: PUBLISHER_GRAMEDIA_ID, version: 5 }),
      },
    });
    await screen.findByRole('heading', { name: 'Gramedia Pustaka Utama' }, FIRST);
    fireEvent.change(screen.getByLabelText('Tempat terbit'), { target: { value: 'Jakarta Pusat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText(REINDEX_NOTE)).toBeTruthy();
  });

  it('a taken name lands on the name field', async () => {
    startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: {
        'GET catalog/agents/:id': () => AGENT_PRAM,
        'PATCH catalog/agents/:id': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'name', code: 'taken' }] }),
      },
    });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: 'Toer, Pramoedya A.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Sudah dipakai. Gunakan yang lain.')).toBeTruthy();
    expect(screen.getByLabelText('Nama').getAttribute('aria-invalid')).toBe('true');
  });

  it('a stale save offers to reload the data', async () => {
    let version = 3;
    startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: {
        'GET catalog/agents/:id': () => ({ ...AGENT_PRAM, version, note: version > 3 ? 'Diubah orang lain.' : null }),
        'PATCH catalog/agents/:id': () => {
          version = 9;
          return problem(409, 'CONFLICT_STALE');
        },
      },
    });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    fireEvent.change(screen.getByLabelText('Catatan'), { target: { value: 'Catatan saya.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Muat ulang data' }));
    await waitFor(() => expect((screen.getByLabelText('Catatan') as HTMLTextAreaElement).value).toBe('Diubah orang lain.'));
  });

  it('creating an agent posts the strict body and opens its page', async () => {
    const posted: unknown[] = [];
    const created = agent({ id: NEW_ID, name: 'Balai Pustaka', type: 'organization' });
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/catalog/authorities/agents/new',
      routes: {
        'POST catalog/agents': (req) => {
          posted.push(req.body);
          return json({ id: NEW_ID, version: 1 }, 201);
        },
        'GET catalog/agents/:id': () => created,
      },
    });
    await screen.findByRole('heading', { name: 'Nama baru' }, FIRST);
    fireEvent.change(screen.getByLabelText('Tipe'), { target: { value: 'organization' } });
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: 'Balai Pustaka' } });
    fireEvent.change(screen.getByLabelText('Sumber otoritas'), { target: { value: 'Perpusnas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ type: 'organization', name: 'Balai Pustaka', authoritySource: 'Perpusnas' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/authorities/agents/${NEW_ID}`));
    expect(await screen.findByRole('heading', { name: 'Balai Pustaka' }, FIRST)).toBeTruthy();
    expect(screen.getByText('Otoritas disimpan.')).toBeTruthy();
  });

  it('a create with an empty name is refused before anything is sent', async () => {
    const { writes } = startApp({ me: adminMe(), path: '/admin/catalog/authorities/subjects/new', routes: {} });
    await screen.findByRole('heading', { name: 'Subjek baru' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Wajib diisi.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('an unknown kind or id is not found', async () => {
    startApp({ me: adminMe(), path: `/admin/catalog/authorities/records/${AGENT_PRAM_ID}`, routes: {} });
    expect(await screen.findByText('Data atau halaman yang diminta tidak ditemukan.', undefined, FIRST)).toBeTruthy();
  });

  it('an id that is no ULID (one above the 48-bit time, as ulidField refuses) is not found and reads nothing', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/catalog/authorities/agents/ZZZZZZZZZZZZZZZZZZZZZZZZZZ', routes: {} });
    expect(await screen.findByText('Data atau halaman yang diminta tidak ditemukan.', undefined, FIRST)).toBeTruthy();
    expect(requests.some((r) => r.path.startsWith('catalog/agents'))).toBe(false);
  });

  it('without catalog.authorities.manage the form is read-only', async () => {
    startApp({
      me: signedIn({ permissions: ['catalog.records.read'] }),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`,
      routes: { 'GET catalog/agents/:id': () => AGENT_PRAM },
    });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect((screen.getByLabelText('Nama') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Arsipkan' })).toBeNull();
  });
});

describe('archiving an authority', () => {
  function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
    return { 'GET catalog/agents/:id': (req) => (req.params.id === AGENT_PRAM_ID ? AGENT_PRAM : { ...AGENT_PRAM2, usage: 0 }), 'GET catalog/agents': () => paged([]), ...extra };
  }

  it('one no record uses is archived after confirmation, with its version', async () => {
    const deleted: unknown[] = [];
    const { writes } = startApp({
      me: adminMe(),
      path: `/admin/catalog/authorities/agents/${AGENT_PRAM2_ID}`,
      routes: routes({
        'DELETE catalog/agents/:id': (req) => {
          deleted.push(req.body);
          return { id: AGENT_PRAM2_ID, version: 3 };
        },
      }),
    });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya A.' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Arsipkan' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan Toer, Pramoedya A.?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(writes()).toEqual([`DELETE catalog/agents/${AGENT_PRAM2_ID}`]));
    expect(deleted).toEqual([{ version: 2 }]);
    expect(await screen.findByText('Toer, Pramoedya A. diarsipkan.')).toBeTruthy();
  });

  it('one that records use cannot be archived; the page says to merge it instead', async () => {
    startApp({ me: adminMe(), path: `/admin/catalog/authorities/agents/${AGENT_PRAM_ID}`, routes: routes() });
    await screen.findByRole('heading', { name: 'Toer, Pramoedya Ananta' }, FIRST);
    expect((screen.getByRole('button', { name: 'Arsipkan' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Masih dipakai 3 cantuman, jadi belum dapat diarsipkan. Gabungkan ke otoritas lain bila otoritas ini ganda.')).toBeTruthy();
  });
});
