import { OpacSettingsBody, type OpacSettings } from '@altis/shared/api/settings';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp, type FakeHandler } from '../fake-api';

// Pengaturan › OPAC, Phase 2 additions (spec §13 "Pengaturan › OPAC (tambahan)", §9, §10, §12.6; plan Task 28): the
// results per page, indexing, OAI-PMH (on, and its admin e-mail: without one OAI-PMH answers 503), the shelf map and
// the new titles, saved with the existing `PUT settings/opac` (only what changed).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPAC: OpacSettings = {
  welcome: { id: null, en: null },
  accent: 'teal',
  resultsPerPage: 20,
  indexable: true,
  oai: { enabled: true, adminEmail: '' },
  showShelfMap: true,
  newTitlesCount: 12,
};

function opacStore(o: Partial<OpacSettings> = {}) {
  const stored: OpacSettings = { ...structuredClone(OPAC), ...structuredClone(o) };
  const puts: unknown[] = [];
  const routes: Record<string, FakeHandler> = {
    'GET settings/opac': () => structuredClone(stored),
    'PUT settings/opac': (req) => {
      puts.push(req.body);
      const body = req.body as OpacSettingsBody;
      Object.assign(stored, { ...body, oai: { ...stored.oai, ...body.oai } });
      return { changed: Object.keys(body).map((k) => `opac.${k}`) };
    },
  };
  return { stored, puts, routes };
}

async function open(store = opacStore()) {
  const app = startApp({ me: adminMe(), path: '/admin/settings/opac', routes: store.routes });
  const perPage = (await screen.findByLabelText('Hasil per halaman')) as HTMLInputElement;
  await waitFor(() => expect(perPage.value).toBe('20'));
  return { ...app, store };
}

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

const OAI_WARNING = 'OAI-PMH aktif tetapi e-mail admin belum diisi, jadi pemanen menerima pesan kesalahan sampai e-mail diisi.';

describe('Pengaturan › OPAC: Phase 2 keys', () => {
  it('shows the six keys as stored and sends only what changed, in the strict body', async () => {
    const { store } = await open();
    expect(field('Jumlah judul baru di beranda').value).toBe('12');
    expect(field('Boleh diindeks mesin pencari').checked).toBe(true);
    expect(field('Tampilkan peta rak').checked).toBe(true);
    expect(field('Aktifkan OAI-PMH').checked).toBe(true);
    expect(field('E-mail admin OAI-PMH').value).toBe('');

    fireEvent.change(field('Hasil per halaman'), { target: { value: '30' } });
    fireEvent.change(field('Jumlah judul baru di beranda'), { target: { value: '0' } });
    fireEvent.click(field('Boleh diindeks mesin pencari'));
    fireEvent.click(field('Tampilkan peta rak'));
    fireEvent.change(field('E-mail admin OAI-PMH'), { target: { value: 'pustaka@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(store.puts).toHaveLength(1));
    expect(store.puts[0]).toEqual({
      resultsPerPage: 30,
      indexable: false,
      oai: { adminEmail: 'pustaka@perpus.example' },
      showShelfMap: false,
      newTitlesCount: 0,
    });
    expect(OpacSettingsBody.safeParse(store.puts[0]).success).toBe(true);
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
  });

  it('turning OAI-PMH off sends only that switch', async () => {
    const { store } = await open(opacStore({ oai: { enabled: true, adminEmail: 'pustaka@perpus.example' } }));
    fireEvent.click(field('Aktifkan OAI-PMH'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ oai: { enabled: false } }]));
  });

  it('a page size out of range and an address that is not an e-mail are refused before anything is sent', async () => {
    const { writes } = await open();
    fireEvent.change(field('Hasil per halaman'), { target: { value: '60' } });
    fireEvent.change(field('Jumlah judul baru di beranda'), { target: { value: '49' } });
    fireEvent.change(field('E-mail admin OAI-PMH'), { target: { value: 'bukan-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(field('Hasil per halaman').getAttribute('aria-invalid')).toBe('true'));
    expect(field('Jumlah judul baru di beranda').getAttribute('aria-invalid')).toBe('true');
    expect(field('E-mail admin OAI-PMH').getAttribute('aria-invalid')).toBe('true');
    expect(writes()).toEqual([]);
  });

  it('warns while OAI-PMH is on without an admin e-mail, and stops once one is typed or OAI-PMH is off', async () => {
    await open();
    expect(screen.getByText(OAI_WARNING)).toBeTruthy();
    fireEvent.change(field('E-mail admin OAI-PMH'), { target: { value: 'pustaka@perpus.example' } });
    await waitFor(() => expect(screen.queryByText(OAI_WARNING)).toBeNull());
    fireEvent.change(field('E-mail admin OAI-PMH'), { target: { value: '' } });
    expect(await screen.findByText(OAI_WARNING)).toBeTruthy();
    fireEvent.click(field('Aktifkan OAI-PMH'));
    await waitFor(() => expect(screen.queryByText(OAI_WARNING)).toBeNull());
  });
});
