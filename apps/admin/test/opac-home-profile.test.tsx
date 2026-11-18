import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp } from './fake-api';
import { FIRST, SAVED, choosePhoto, fileId, openTab, puts, save, stubPhotoUpload, t, view } from './opac-home-fixtures';

// The tabs of OPAC › Halaman awal other than the slider: the short profile (heading, lead, "about" with its photo,
// history, the rows of the timeline, the mission and the people, added, moved and taken out), the services and
// facility photos, the gallery (up to eight photos, each with its alternative text), and the blocks with the library
// colour.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const start = (path: string, home: Parameters<typeof view>[0] = {}) =>
  startApp({ me: adminMe(), path: `/admin/opac/beranda/${path}`, routes: { 'GET opac/home': () => view(home), 'PUT opac/home': () => SAVED } });
const live = (): string => document.querySelector('form [aria-live=polite]')?.textContent ?? '';
const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const sent = (requests: Parameters<typeof puts>[0]): Record<string, unknown> => (puts(requests)[0] as { home: Record<string, unknown> }).home;

describe('OPAC › Halaman awal › Profil singkat', () => {
  it('edits the history, the timeline, the vision, the mission and the people, and saves them in their order', async () => {
    const { requests } = start('profil', { timeline: [{ year: 1987, text: { id: 'Berdiri', en: 'Founded' } }] });
    await screen.findByLabelText(t('opacHome.history.text_id'), undefined, FIRST);
    type(t('opacHome.history.text_id'), 'Dulu sebuah gudang.\n\nKini rumah baca.');
    type(t('opacHome.history.text_en'), 'Once a warehouse.');

    // The timeline: a second event, moved before the first, with the move said aloud.
    press(t('opacHome.timeline.add'));
    type(t('opacHome.timeline.year', { n: 2 }), '1975');
    type(t('opacHome.timeline.text_id', { n: 2 }), 'Gagasan pertama');
    const up = screen.getByRole('button', { name: t('opacHome.timeline.up', { n: 2 }) });
    up.focus();
    fireEvent.click(up);
    expect(live()).toBe(t('opacHome.row.moved', { from: 2, to: 1 }));
    expect((screen.getByLabelText(t('opacHome.timeline.year', { n: 1 })) as HTMLInputElement).value).toBe('1975');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: t('opacHome.timeline.down', { n: 1 }) })));

    type(t('opacHome.vision.text_id'), 'Warga gemar membaca.');
    const addMission = screen.getByRole('button', { name: t('opacHome.mission.add') });
    fireEvent.click(addMission);
    fireEvent.click(addMission);
    fireEvent.click(addMission);
    type(t('opacHome.mission.text_id', { n: 1 }), 'Melayani semua warga');
    type(t('opacHome.mission.text_en', { n: 1 }), 'Serve everyone');
    type(t('opacHome.mission.text_id', { n: 2 }), 'Dihapus');
    type(t('opacHome.mission.text_id', { n: 3 }), 'Merawat koleksi');
    press(t('opacHome.mission.remove', { n: 2 }));
    expect(live()).toBe(t('opacHome.row.removed', { n: 2 }));
    await waitFor(() => expect(document.activeElement).toBe(addMission));
    expect((screen.getByLabelText(t('opacHome.mission.text_id', { n: 2 })) as HTMLInputElement).value).toBe('Merawat koleksi');

    // The people are typed in here on purpose.
    const people = screen.getByRole('group', { name: t('opacHome.staff.list') });
    expect(people.getAttribute('aria-describedby')).toBe(within(people).getByText(t('opacHome.staff.hint')).id);
    press(t('opacHome.staff.add'));
    press(t('opacHome.staff.add'));
    type(t('opacHome.staff.name', { n: 1 }), 'Budi Santoso');
    type(t('opacHome.staff.name', { n: 2 }), 'Sri Wahyuni');
    type(t('opacHome.staff.role_id', { n: 2 }), 'Kepala perpustakaan');
    type(t('opacHome.staff.role_en', { n: 2 }), 'Head librarian');
    press(t('opacHome.staff.down', { n: 1 }));

    save();
    await screen.findByText(t('opacHome.saved'));
    const home = sent(requests);
    expect(home['about']).toEqual({ text: { id: null, en: null }, photo: null, founded: null, librarians: null, history: { id: 'Dulu sebuah gudang.\n\nKini rumah baca.', en: 'Once a warehouse.' } });
    expect(home['timeline']).toEqual([
      { year: 1975, text: { id: 'Gagasan pertama', en: null } },
      { year: 1987, text: { id: 'Berdiri', en: 'Founded' } },
    ]);
    expect(home['vision']).toEqual({ id: 'Warga gemar membaca.', en: null });
    expect(home['mission']).toEqual([
      { id: 'Melayani semua warga', en: 'Serve everyone' },
      { id: 'Merawat koleksi', en: null },
    ]);
    expect(home['staff']).toEqual([
      { name: 'Sri Wahyuni', role: { id: 'Kepala perpustakaan', en: 'Head librarian' } },
      { name: 'Budi Santoso', role: { id: null, en: null } },
    ]);
  });

  it('refuses a timeline row without a year or a text, a blank mission point and a nameless person, on their fields', async () => {
    const { requests } = start('profil');
    await screen.findByLabelText(t('opacHome.history.text_id'), undefined, FIRST);
    press(t('opacHome.timeline.add'));
    press(t('opacHome.mission.add'));
    press(t('opacHome.staff.add'));
    save();
    const year = screen.getByLabelText(t('opacHome.timeline.year', { n: 1 }));
    await waitFor(() => expect(year.getAttribute('aria-invalid')).toBe('true'));
    for (const label of [t('opacHome.timeline.text_id', { n: 1 }), t('opacHome.mission.text_id', { n: 1 }), t('opacHome.staff.name', { n: 1 })]) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute('aria-invalid'), label).toBe('true');
      expect(document.getElementById(field.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent, label).not.toBe('');
    }
    await waitFor(() => expect(document.activeElement).toBe(year));
    expect(puts(requests)).toEqual([]);
    // A row taken out takes its refusal with it.
    press(t('opacHome.timeline.remove', { n: 1 }));
    press(t('opacHome.mission.remove', { n: 1 }));
    press(t('opacHome.staff.remove', { n: 1 }));
    save();
    await screen.findByText(t('opacHome.saved'));
  });

  it('the "about" photo is uploaded after its crop and needs its alternative text', async () => {
    stubPhotoUpload(fileId(21));
    const { requests } = start('profil');
    await screen.findByLabelText(t('opacHome.photo.upload'), undefined, FIRST);
    await choosePhoto(t('opacHome.photo.upload'));
    const alt = await screen.findByLabelText(t('opacHome.photo.alt'));
    save();
    await waitFor(() => expect(alt.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(alt, { target: { value: 'Gedung perpustakaan' } });
    type(t('opacHome.about.founded'), '1987');
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(sent(requests)['about']).toEqual(expect.objectContaining({ photo: { fileId: fileId(21), alt: 'Gedung perpustakaan', caption: null }, founded: 1987 }));
  });
});

describe('OPAC › Halaman awal › Layanan, Galeri, Susunan blok', () => {
  it('the services move by their buttons; a facility photo is added with its alternative text', async () => {
    stubPhotoUpload(fileId(31));
    const { requests } = start('layanan', { services: [{ title: 'Peminjaman', text: null }, { title: 'Ruang baca', text: 'Buka tiap hari' }] });
    await screen.findByLabelText(t('opacHome.services.name', { n: 1 }), undefined, FIRST);
    press(t('opacHome.services.down_label', { n: 1 }));
    expect((screen.getByLabelText(t('opacHome.services.name', { n: 1 })) as HTMLInputElement).value).toBe('Ruang baca');
    expect(screen.getByText(t('opacHome.facilities.empty'))).toBeTruthy();
    await choosePhoto(t('opacHome.facilities.add'));
    const photo = await screen.findByRole('group', { name: t('opacHome.facilities.photo', { n: 1 }) });
    fireEvent.change(within(photo).getByLabelText(t('opacHome.photo.alt')), { target: { value: 'Pojok anak' } });
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(sent(requests)['services']).toEqual([
      { title: 'Ruang baca', text: 'Buka tiap hari' },
      { title: 'Peminjaman', text: null },
    ]);
    expect(sent(requests)['facilities']).toEqual([{ fileId: fileId(31), alt: 'Pojok anak', caption: null }]);
  });

  it('the gallery starts empty, takes a photo with its alternative text and captions, and refuses one without', async () => {
    stubPhotoUpload(fileId(41), fileId(42));
    const { requests, router } = start('galeri');
    expect(await screen.findByRole('heading', { name: t('opacHome.gallery.empty') }, FIRST)).toBeTruthy();
    await choosePhoto(t('opacHome.gallery.add'));
    const first = await screen.findByRole('listitem', { name: t('opacHome.gallery.photo', { n: 1 }) });
    expect(first.querySelector('img')!.getAttribute('src')).toBe(`/files/${fileId(41)}`);
    await choosePhoto(t('opacHome.gallery.add'));
    await screen.findByRole('listitem', { name: t('opacHome.gallery.photo', { n: 2 }) });
    type(t('opacHome.gallery.alt', { n: 2 }), 'Rak anak');
    type(t('opacHome.gallery.caption_id', { n: 2 }), 'Pojok anak');
    type(t('opacHome.gallery.caption_en', { n: 2 }), "Children's corner");

    // Saved from another tab: the photo without its alternative text brings the gallery back, marked.
    await openTab('opacHome.tab.blocks');
    save();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/opac/beranda/galeri'));
    const alt = (await screen.findByLabelText(t('opacHome.gallery.alt', { n: 1 }))) as HTMLInputElement;
    expect(alt.required).toBe(true);
    expect(alt.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('link', { name: new RegExp(`^${t('opacHome.tab.gallery')}`) }).textContent).toContain(t('opacHome.tab.check'));
    expect(puts(requests)).toEqual([]);
    fireEvent.change(alt, { target: { value: 'Ruang baca' } });

    press(t('opacHome.gallery.down', { n: 1 }));
    expect(live()).toBe(t('opacHome.gallery.moved', { from: 1, to: 2 }));
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(sent(requests)['gallery']).toEqual([
      { fileId: fileId(41 + 1), alt: 'Rak anak', caption: { id: 'Pojok anak', en: "Children's corner" } },
      { fileId: fileId(41), alt: 'Ruang baca', caption: { id: null, en: null } },
    ]);
  });

  it('at eight photos the gallery takes no more until one is removed', async () => {
    const gallery = Array.from({ length: 8 }, (_, i) => ({ fileId: fileId(50 + i), alt: `Foto ${i + 1}`, caption: { id: null, en: null } }));
    const { requests } = start('galeri', { gallery });
    expect(within(await screen.findByRole('list', { name: t('opacHome.gallery.list') }, FIRST)).getAllByRole('listitem').length).toBe(8);
    expect(screen.getByText(t('opacHome.gallery.full', { max: 8 }))).toBeTruthy();
    expect(screen.queryByLabelText(t('opacHome.gallery.add'))).toBeNull();
    press(t('opacHome.gallery.remove', { n: 8 }));
    expect(live()).toBe(t('opacHome.gallery.removed', { n: 8 }));
    expect(screen.getByLabelText(t('opacHome.gallery.add'))).toBeTruthy();
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(sent(requests)['gallery']).toEqual(gallery.slice(0, 7));
  });

  it('the blocks are switches named by their rows, and the library colour is checked for its contrast', async () => {
    const { requests } = start('blok');
    const reading = await screen.findByRole('switch', { name: t('opacHome.blocks.readingClasses') }, FIRST);
    expect(reading.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(reading.getAttribute('aria-describedby')!)?.textContent).toBe(t('opacHome.blocks.readingClasses_hint'));
    fireEvent.click(reading);
    expect(screen.getAllByRole('switch').length).toBe(9);
    // Too light a colour is refused before sending, with its own message; a dark one is taken (and stored lower case).
    const brand = screen.getByLabelText(t('opacHome.brand.label')) as HTMLInputElement;
    fireEvent.change(brand, { target: { value: '#ffd966' } });
    save();
    expect(await screen.findByText(t('opacHome.brand.low_contrast'))).toBeTruthy();
    expect(brand.getAttribute('aria-invalid')).toBe('true');
    expect(puts(requests)).toEqual([]);
    fireEvent.change(brand, { target: { value: '#1E3A8A' } });
    expect(screen.queryByText(t('opacHome.brand.low_contrast'))).toBeNull();
    expect(brand.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText(t('opacHome.brand.contrast_ok', { ratio: '10,3', min: '4,5' }))).toBeTruthy();
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(sent(requests)).toEqual(expect.objectContaining({ brand: '#1e3a8a', blocks: expect.objectContaining({ readingClasses: true, news: true }) }));
  });
});
