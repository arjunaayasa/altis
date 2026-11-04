import type { SubjectView } from '@altis/shared/api/catalog/authorities';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, type FakeHandler } from '../fake-api';
import {
  FIRST,
  SUBJECT_ARKEOLOGI_ID,
  SUBJECT_SEJARAH,
  SUBJECT_SEJARAH_ID,
  SUBJECT_SEJARAH_INDONESIA,
  SUBJECT_SEJARAH_INDONESIA_ID,
  paged,
  subject,
} from './authorities-fixtures';

// The thesaurus editor of a subject's page (Phase 2 Task 26; spec §3.5, §13): the subject's outgoing relations
// (USE/UF, BT/NT, RT, SA) are edited as a list and saved as a whole (`PUT catalog/subjects/:id/relations`, with the
// subject's version). The preview shows what the other subject will hold, the reciprocal the server writes in the same
// transaction: adding `BT → X` previews "X NT ini".

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PATH = `/admin/catalog/authorities/subjects/${SUBJECT_SEJARAH_INDONESIA_ID}`;

function subjectRoutes(o: { view?: SubjectView; extra?: Record<string, FakeHandler> } = {}): Record<string, FakeHandler> {
  return {
    'GET catalog/subjects/:id': () => o.view ?? SUBJECT_SEJARAH_INDONESIA,
    'GET catalog/subjects': () => paged([SUBJECT_SEJARAH_INDONESIA, SUBJECT_SEJARAH]),
    ...o.extra,
  };
}

async function thesaurus(): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Sejarah Indonesia' }, FIRST);
  return screen.getByRole('region', { name: 'Tesaurus' });
}

/** Adds the relation `rel` (its label in the select) to the subject found by typing `text`, picking `label`. */
async function addRelation(region: HTMLElement, rel: string, text: string, label: string): Promise<void> {
  fireEvent.change(within(region).getByLabelText('Relasi'), { target: { value: rel } });
  fireEvent.click(within(region).getByRole('combobox', { name: 'Subjek tujuan' }));
  fireEvent.change(await screen.findByPlaceholderText('Ketik bagian dari istilah'), { target: { value: text } });
  fireEvent.click(await screen.findByRole('option', { name: label }));
  await waitFor(() => expect(within(region).getByRole('combobox', { name: 'Subjek tujuan' }).textContent).toContain(label));
  fireEvent.click(within(region).getByRole('button', { name: 'Tambah relasi' }));
}

describe('the thesaurus editor', () => {
  it('lists the relations and previews their reciprocals', async () => {
    startApp({ me: adminMe(), path: PATH, routes: subjectRoutes() });
    const region = await thesaurus();
    const row = within(region).getByRole('button', { name: 'Hapus relasi RT Arkeologi' }).closest('tr')!;
    expect(within(row).getByText('Arkeologi')).toBeTruthy();
    expect(within(row).getByText('Istilah terkait (RT)')).toBeTruthy();
    expect(within(region).getByText('Arkeologi RT ini')).toBeTruthy();
    expect((within(region).getByRole('button', { name: 'Simpan relasi' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adding BT → X previews "X NT ini" and puts the relation in the request with the version', async () => {
    const put: unknown[] = [];
    const { writes, requests } = startApp({
      me: adminMe(),
      path: PATH,
      routes: subjectRoutes({
        extra: {
          'PUT catalog/subjects/:id/relations': (req) => {
            put.push(req.body);
            return { id: SUBJECT_SEJARAH_INDONESIA_ID, version: 6 };
          },
        },
      }),
    });
    const region = await thesaurus();
    await addRelation(region, 'bt', 'sej', 'Sejarah (Topik)');
    // The subject search leaves the subject itself out.
    expect(requests.some((r) => r.path === 'catalog/subjects' && r.query.get('q') === 'sej')).toBe(true);
    const preview = within(region).getByText('Sejarah NT ini');
    expect(within(preview.closest('li')!).getByText('baru')).toBeTruthy();
    expect(within(region).getByText('Arkeologi RT ini')).toBeTruthy();
    expect(writes()).toEqual([]);

    fireEvent.click(within(region).getByRole('button', { name: 'Simpan relasi' }));
    await waitFor(() => expect(writes()).toEqual([`PUT catalog/subjects/${SUBJECT_SEJARAH_INDONESIA_ID}/relations`]));
    expect(put).toEqual([
      {
        relations: [
          { rel: 'rt', subjectId: SUBJECT_ARKEOLOGI_ID },
          { rel: 'bt', subjectId: SUBJECT_SEJARAH_ID },
        ],
        version: 5,
      },
    ]);
    expect(await within(region).findByText('Relasi disimpan.')).toBeTruthy();
  });

  it('removing a relation previews its reciprocal as removed and saves the list without it', async () => {
    const put: unknown[] = [];
    startApp({
      me: adminMe(),
      path: PATH,
      routes: subjectRoutes({
        extra: {
          'PUT catalog/subjects/:id/relations': (req) => {
            put.push(req.body);
            return { id: SUBJECT_SEJARAH_INDONESIA_ID, version: 6 };
          },
        },
      }),
    });
    const region = await thesaurus();
    fireEvent.click(within(region).getByRole('button', { name: 'Hapus relasi RT Arkeologi' }));
    const removed = within(region).getByText('Arkeologi RT ini');
    expect(within(removed.closest('li')!).getByText('dihapus')).toBeTruthy();
    expect(within(region).getByText('Belum ada relasi.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Simpan relasi' }));
    await waitFor(() => expect(put).toEqual([{ relations: [], version: 5 }]));
  });

  it('every relation type has its reciprocal: USE → UF, UF → USE, NT → BT, SA → SA', async () => {
    startApp({ me: adminMe(), path: PATH, routes: subjectRoutes() });
    const region = await thesaurus();
    await addRelation(region, 'use', 'sej', 'Sejarah (Topik)');
    expect(within(region).getByText('Sejarah UF ini')).toBeTruthy();
    await addRelation(region, 'uf', 'sej', 'Sejarah (Topik)');
    expect(within(region).getByText('Sejarah USE ini')).toBeTruthy();
    await addRelation(region, 'nt', 'sej', 'Sejarah (Topik)');
    expect(within(region).getByText('Sejarah BT ini')).toBeTruthy();
    await addRelation(region, 'sa', 'sej', 'Sejarah (Topik)');
    expect(within(region).getByText('Sejarah SA ini')).toBeTruthy();
  });

  it('the same relation twice is refused before anything is sent', async () => {
    const { writes } = startApp({ me: adminMe(), path: PATH, routes: subjectRoutes() });
    const region = await thesaurus();
    await addRelation(region, 'bt', 'sej', 'Sejarah (Topik)');
    await addRelation(region, 'bt', 'sej', 'Sejarah (Topik)');
    expect(within(region).getByText('Relasi ini sudah ada.')).toBeTruthy();
    expect(within(region).getAllByText('Sejarah NT ini')).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it('a server refusal of one relation is shown on its row', async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: subjectRoutes({
        extra: {
          'PUT catalog/subjects/:id/relations': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'relations.1.subjectId', code: 'not_found' }] }),
        },
      }),
    });
    const region = await thesaurus();
    await addRelation(region, 'bt', 'sej', 'Sejarah (Topik)');
    fireEvent.click(within(region).getByRole('button', { name: 'Simpan relasi' }));
    const message = await within(region).findByText('Subjek ini sudah tidak ada.');
    expect(within(message.closest('tr')!).getByText('Sejarah')).toBeTruthy();
  });

  it('a BT/NT cycle is reported', async () => {
    const view = subject({
      ...SUBJECT_SEJARAH_INDONESIA,
      relations: [{ rel: 'bt', subjectId: SUBJECT_SEJARAH_ID, term: 'Sejarah', type: 'topic' }],
      cycles: [[SUBJECT_SEJARAH_INDONESIA_ID, SUBJECT_SEJARAH_ID, SUBJECT_SEJARAH_INDONESIA_ID]],
    });
    startApp({ me: adminMe(), path: PATH, routes: subjectRoutes({ view }) });
    await thesaurus();
    expect(screen.getByText(/berada dalam siklus BT\/NT/)).toBeTruthy();
    expect(screen.getByText('Sejarah Indonesia → Sejarah → Sejarah Indonesia')).toBeTruthy();
  });

  it('read-only without catalog.authorities.manage', async () => {
    startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: PATH, routes: subjectRoutes() });
    const region = await thesaurus();
    expect(within(region).getByText('Arkeologi RT ini')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Simpan relasi' })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Tambah relasi' })).toBeNull();
  });
});
