import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp } from './fake-api';
import { FIRST, SAVED, choosePhoto, fileId, heroOf, puts, save, slide, stubPhotoUpload, t, view } from './opac-home-fixtures';

// The tab "Slider hero" of OPAC › Halaman awal: the list of slides (when each shows, where its button leads, the
// warning for a missing English text, moving by the buttons with the announcement, showing and hiding, removing after
// a confirmation, adding up to six), how the slides advance, the preview, and the drawer that edits one slide (a modal
// dialog that gives the focus back, the photo and its required alternative text, the title's limit, the button's
// target as a kind and a reference, the days it shows; "Selesai" puts the slide in the draft, "Batal" does not).

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const start = (...slides: ReturnType<typeof slide>[]) =>
  startApp({ me: adminMe(), path: '/admin/opac/beranda/slider', routes: { 'GET opac/home': () => view({ hero: heroOf(...slides) }), 'PUT opac/home': () => SAVED } });

const rows = async (): Promise<HTMLElement[]> => within(await screen.findByRole('list', { name: t('opacHome.slides.list') }, FIRST)).getAllByRole('listitem');
const titles = async (): Promise<(string | null | undefined)[]> => (await rows()).map((row) => row.querySelector('p')?.textContent);
const live = (): string => document.querySelector('form [aria-live=polite]')?.textContent ?? '';
const langField = (key: Parameters<typeof t>[0], lang: 'id' | 'en' = 'id'): string => `${t(key)} (${t(lang === 'id' ? 'opacHome.lang.id' : 'opacHome.lang.en')})`;
const done = (): void => {
  fireEvent.click(screen.getByRole('button', { name: t('opacHome.slide.done') }));
};

describe('OPAC › Halaman awal › Slider hero', () => {
  it('lists each slide with when it shows, where its button leads and what is missing', async () => {
    start(
      slide(1, { title: { id: 'Ruang baca', en: 'Reading room' }, cta: { label: { id: 'Jelajahi', en: 'Browse' }, target: { kind: 'catalog' } } }),
      slide(2, { from: '2000-01-05', until: '2999-12-31', cta: { label: { id: 'Baca', en: null }, target: { kind: 'news', ref: 'lomba' } } }),
      slide(3, { from: '2999-01-01', title: { id: null, en: null } }),
      slide(4, { until: '2000-01-31', active: false }),
    );
    const [first, second, third, fourth] = (await rows()) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(first.textContent).toContain('1. Ruang baca');
    expect(first.textContent).toContain(t('opacHome.slides.always'));
    expect(first.textContent).toContain(t('opacHome.slides.button', { label: 'Jelajahi', target: t('opacHome.target.catalog') }));
    expect(first.textContent).not.toContain(t('opacHome.slides.english_missing'));
    expect(second.textContent).toContain(t('opacHome.slides.range', { from: '5 Jan 2000', until: '31 Des 2999' }));
    expect(second.textContent).toContain(t('opacHome.slides.button', { label: 'Baca', target: t('opacHome.target.news') }));
    expect(second.textContent).toContain(t('opacHome.slides.english_missing'));
    expect(third.textContent).toContain(`3. ${t('opacHome.slides.untitled')}`);
    expect(third.textContent).toContain(t('opacHome.slides.not_started', { date: '1 Jan 2999' }));
    expect(third.textContent).toContain(t('opacHome.slides.no_button'));
    expect(fourth.textContent).toContain(t('opacHome.slides.ended', { date: '31 Jan 2000' }));
    expect(fourth.textContent).toContain(t('opacHome.slides.hidden'));
    // Two show today: the first and the second.
    expect(screen.getByText(t('opacHome.slides.description', { shown: 2, max: 6 }))).toBeTruthy();
    const thumb = first.querySelector('img')!;
    expect([thumb.getAttribute('src'), thumb.getAttribute('alt')]).toEqual([`/files/${fileId(1)}`, '']);
    // No handle to drag: the buttons move a slide.
    expect(document.querySelector('[draggable=true]')).toBeNull();
  });

  it('moves a slide with its buttons and says so, shows and hides it, and removes it after a confirmation', async () => {
    const { requests } = start(slide(1), slide(2), slide(3));
    expect(await titles()).toEqual(['1. Judul 1', '2. Judul 2', '3. Judul 3']);
    expect((screen.getByRole('button', { name: t('opacHome.slides.up', { n: 1 }) }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('opacHome.slides.down', { n: 3 }) }) as HTMLButtonElement).disabled).toBe(true);

    const up = screen.getByRole('button', { name: t('opacHome.slides.up', { n: 2 }) });
    up.focus();
    fireEvent.click(up);
    expect(await titles()).toEqual(['1. Judul 2', '2. Judul 1', '3. Judul 3']);
    expect(live()).toBe(t('opacHome.slides.moved', { from: 2, to: 1 }));
    // The slide is first now: its "up" is off, so the focus is on its "down".
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: t('opacHome.slides.down', { n: 1 }) })));
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.slides.down', { n: 2 }) }));
    expect(await titles()).toEqual(['1. Judul 2', '2. Judul 3', '3. Judul 1']);
    expect(live()).toBe(t('opacHome.slides.moved', { from: 2, to: 3 }));

    const shown = screen.getByRole('switch', { name: t('opacHome.slides.show', { n: 1 }) });
    expect(shown.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(shown);
    expect(shown.getAttribute('aria-checked')).toBe('false');
    expect((await rows())[0]!.textContent).toContain(t('opacHome.slides.hidden'));

    fireEvent.click(screen.getByRole('button', { name: t('opacHome.slides.remove', { n: 2 }) }));
    const question = await screen.findByRole('alertdialog', { name: t('opacHome.slides.remove_title', { n: 2 }) });
    fireEvent.click(within(question).getByRole('button', { name: t('form.cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((await titles()).length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.slides.remove', { n: 2 }) }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: t('opacHome.slides.remove_confirm') }));
    await waitFor(async () => expect(await titles()).toEqual(['1. Judul 2', '2. Judul 1']));
    expect(live()).toBe(t('opacHome.slides.removed', { n: 2 }));

    // How the slides advance.
    const interval = screen.getByLabelText(t('opacHome.autoplay.interval')) as HTMLSelectElement;
    expect(interval.value).toBe('7');
    expect(Array.from(interval.options).map((o) => o.value)).toEqual(['5', '7', '10']);
    fireEvent.change(interval, { target: { value: '5' } });

    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      expect.objectContaining({ home: expect.objectContaining({ hero: { slides: [slide(2, { active: false }), slide(1)], autoplay: true, intervalSec: 5 } }) }),
    ]);
  });

  it('the automatic change can be switched off, which sets the interval aside', async () => {
    const { requests } = start(slide(1));
    await rows();
    const auto = screen.getByRole('switch', { name: t('opacHome.autoplay.title') });
    fireEvent.click(auto);
    expect(auto.getAttribute('aria-checked')).toBe('false');
    expect((screen.getByLabelText(t('opacHome.autoplay.interval')) as HTMLSelectElement).disabled).toBe(true);
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([expect.objectContaining({ home: expect.objectContaining({ hero: { slides: [slide(1)], autoplay: false, intervalSec: 7 } }) })]);
  });

  it('without slides it says so; a new slide needs a photo and its alternative text; at six no more can be added', async () => {
    stubPhotoUpload(fileId(6));
    const { requests } = start();
    expect(await screen.findByRole('heading', { name: t('opacHome.slides.empty') }, FIRST)).toBeTruthy();
    expect(screen.getByText(t('opacHome.preview.none'))).toBeTruthy();
    const add = screen.getByRole('button', { name: t('opacHome.slides.add') }) as HTMLButtonElement;
    fireEvent.click(add);
    const drawer = await screen.findByRole('dialog', { name: t('opacHome.slide.new') });
    done();
    expect(await within(drawer).findByText(t('opacHome.slide.photo_required'))).toBeTruthy();
    expect(screen.queryByRole('list', { name: t('opacHome.slides.list') })).toBeNull();

    await choosePhoto(t('opacHome.photo.upload'));
    await within(drawer).findByLabelText(t('opacHome.photo.replace'));
    expect(within(drawer).queryByText(t('opacHome.slide.photo_required'))).toBeNull();
    done();
    const alt = within(drawer).getByLabelText(t('opacHome.slide.alt')) as HTMLInputElement;
    await waitFor(() => expect(alt.getAttribute('aria-invalid')).toBe('true'));
    expect(alt.required).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(alt));
    fireEvent.change(alt, { target: { value: 'Aula perpustakaan' } });
    fireEvent.change(within(drawer).getByLabelText(langField('opacHome.slide.title')), { target: { value: 'Selamat datang' } });
    done();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await titles()).toEqual(['1. Selamat datang']);
    // Nothing was sent: the slide is in the draft.
    expect(puts(requests)).toEqual([]);
    expect(screen.getByText(t('opacHome.dirty'))).toBeTruthy();
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      expect.objectContaining({
        home: expect.objectContaining({
          hero: { slides: [slide(1, { fileId: fileId(6), alt: 'Aula perpustakaan', title: { id: 'Selamat datang', en: null } })], autoplay: true, intervalSec: 7 },
        }),
      }),
    ]);
  });

  it('at six slides "Tambah slide" is off and says why', async () => {
    start(slide(1), slide(2), slide(3), slide(4), slide(5), slide(6));
    expect((await rows()).length).toBe(6);
    const add = screen.getByRole('button', { name: t('opacHome.slides.add') }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    const why = document.getElementById(add.getAttribute('aria-describedby')!)!;
    expect(why.textContent).toBe(t('opacHome.slides.full', { max: 6 }));
  });

  it('the preview shows the picked slide over its full-bleed photo, wide or as on a phone', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/opac/beranda/slider',
      routes: { 'GET opac/home': () => view({ brand: '#1e3a8a', hero: heroOf(slide(1, { active: false }), slide(2, { subtitle: { id: 'Sabtu pagi', en: null }, cta: { label: { id: 'Baca', en: null }, target: { kind: 'news' } }, position: 20 })) }) },
    });
    const side = await screen.findByRole('complementary', { name: t('opacHome.preview.title') }, FIRST);
    expect(within(side).getByText(t('opacHome.preview.which', { n: 2, count: 2 }))).toBeTruthy();
    const preview = side.querySelector<HTMLElement>('[data-slot=slide-preview]')!;
    expect(within(preview).getByText('Judul 2')).toBeTruthy();
    expect(within(preview).getByText('Sabtu pagi')).toBeTruthy();
    expect(within(preview).getByText('Baca')).toBeTruthy();
    expect(preview.querySelector('img')!.style.objectPosition).toBe('50% 20%');
    expect(preview.className).toContain('aspect-video');
    const phone = within(side).getByRole('button', { name: t('opacHome.preview.phone') });
    fireEvent.click(phone);
    expect(phone.getAttribute('aria-pressed')).toBe('true');
    expect(preview.className).toContain('aspect-[4/5]');
    fireEvent.focus(screen.getByRole('switch', { name: t('opacHome.slides.show', { n: 1 }) }));
    expect(within(side).getByText(t('opacHome.preview.which', { n: 1, count: 2 }))).toBeTruthy();
    expect(within(preview).getByText('Selamat datang.')).toBeTruthy();
  });
});

describe('OPAC › Halaman awal › Ubah slide', () => {
  const open = async (n: number): Promise<{ drawer: HTMLElement; opener: HTMLElement }> => {
    const opener = screen.getByRole('button', { name: t('opacHome.slides.edit', { n }) });
    opener.focus();
    fireEvent.click(opener);
    return { drawer: await screen.findByRole('dialog', { name: t('opacHome.slides.edit', { n }) }), opener };
  };

  it('is a modal dialog that keeps the focus inside and gives it back to the edit button; Esc and Batal drop its changes', async () => {
    const { requests } = start(slide(1), slide(2));
    await rows();
    const { drawer, opener } = await open(2);
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(within(drawer).getByText(t('opacHome.slide.description'))).toBeTruthy();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    // The page behind it is out of reach while it is open.
    expect(opener.closest('[aria-hidden=true]')).not.toBeNull();
    const title = within(drawer).getByLabelText(langField('opacHome.slide.title')) as HTMLInputElement;
    expect(title.value).toBe('Judul 2');
    fireEvent.change(title, { target: { value: 'Diubah lalu dibuang' } });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(await titles()).toEqual(['1. Judul 1', '2. Judul 2']);
    expect(screen.getByText(t('opacHome.clean'))).toBeTruthy();

    const again = await open(2);
    fireEvent.change(within(again.drawer).getByLabelText(langField('opacHome.slide.title')), { target: { value: 'Dibuang juga' } });
    fireEvent.click(within(again.drawer).getByRole('button', { name: t('form.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await titles()).toEqual(['1. Judul 1', '2. Judul 2']);
    const third = await open(2);
    fireEvent.click(within(third.drawer).getByRole('button', { name: t('opacHome.slide.close') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(third.opener));
    expect(puts(requests)).toEqual([]);
  });

  it('"Selesai" puts the texts of both languages, the note and the switch in the draft, not on the server', async () => {
    const { requests } = start(slide(1));
    await rows();
    const { drawer } = await open(1);
    const title = within(drawer).getByLabelText(langField('opacHome.slide.title')) as HTMLInputElement;
    expect(title.maxLength).toBe(80);
    expect(within(drawer).getByText(t('opacHome.slide.title_count', { count: 7, max: 80 }))).toBeTruthy();
    fireEvent.change(title, { target: { value: 'Ruang baca warga' } });
    expect(within(drawer).getByText(t('opacHome.slide.title_count', { count: 16, max: 80 }))).toBeTruthy();
    fireEvent.change(within(drawer).getByLabelText(langField('opacHome.slide.subtitle')), { target: { value: 'Gratis untuk warga.' } });
    fireEvent.change(within(drawer).getByLabelText(langField('opacHome.slide.note')), { target: { value: 'Agenda' } });
    // The preview in the drawer follows.
    expect(within(drawer.querySelector<HTMLElement>('[data-slot=slide-preview]')!).getByText('Ruang baca warga')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: t('opacHome.lang.en') }));
    const english = within(drawer).getByLabelText(langField('opacHome.slide.title', 'en')) as HTMLInputElement;
    expect(english.value).toBe('');
    expect(english.lang).toBe('en');
    fireEvent.change(english, { target: { value: 'A reading room' } });
    fireEvent.change(within(drawer).getByLabelText(t('opacHome.slide.position')), { target: { value: '30' } });
    fireEvent.click(within(drawer).getByRole('switch', { name: t('opacHome.slide.active') }));
    done();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [row] = await rows();
    expect(row!.textContent).toContain('1. Ruang baca warga');
    expect(row!.textContent).toContain(t('opacHome.slides.hidden'));
    expect(row!.textContent).toContain(t('opacHome.slides.english_missing'));
    expect(puts(requests)).toEqual([]);
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      expect.objectContaining({
        home: expect.objectContaining({
          hero: expect.objectContaining({
            slides: [slide(1, { position: 30, active: false, title: { id: 'Ruang baca warga', en: 'A reading room' }, subtitle: { id: 'Gratis untuk warga.', en: null }, note: { id: 'Agenda', en: null } })],
          }),
        }),
      }),
    ]);
  });

  it('refuses a title over the limit, a button without a label, an address that is not a path of this site, and days out of order', async () => {
    const { requests } = start(slide(1));
    await rows();
    const { drawer } = await open(1);
    const title = within(drawer).getByLabelText(langField('opacHome.slide.title'));
    fireEvent.change(title, { target: { value: 'x'.repeat(81) } });
    done();
    await waitFor(() => expect(title.getAttribute('aria-invalid')).toBe('true'));
    expect(within(drawer).getByText(t('form.error.too_big'))).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(title, { target: { value: 'Tata tertib baru' } });
    expect(title.getAttribute('aria-invalid')).toBeNull();

    // The button: none, or a kind of place with its reference.
    const target = within(drawer).getByLabelText(t('opacHome.slide.target')) as HTMLSelectElement;
    expect(target.value).toBe('none');
    expect(Array.from(target.options).map((o) => o.textContent)).toEqual(
      (['opacHome.target.none', 'opacHome.target.catalog', 'opacHome.target.profile', 'opacHome.target.news', 'opacHome.target.path'] as const).map((k) => t(k)),
    );
    expect(within(drawer).queryByLabelText(langField('opacHome.slide.label'))).toBeNull();
    fireEvent.change(target, { target: { value: 'path' } });
    const path = within(drawer).getByLabelText(t('opacHome.slide.path_ref')) as HTMLInputElement;
    for (const bad of ['', 'https://contoh.test/x', '//contoh.test', '/dua kata', 'javascript:alert(1)']) {
      fireEvent.change(path, { target: { value: bad } });
      done();
      await waitFor(() => expect(path.getAttribute('aria-invalid')).toBe('true'));
      expect(within(drawer).getByText(t('opacHome.slide.path_invalid'))).toBeTruthy();
    }
    // The label is required too (in Indonesian or English).
    const label = within(drawer).getByLabelText(langField('opacHome.slide.label'));
    expect(label.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(label, { target: { value: 'Baca tata tertib' } });
    fireEvent.change(path, { target: { value: '/halaman/tata-tertib' } });
    expect(path.getAttribute('aria-invalid')).toBeNull();

    // A news post is named by its short address; none is the list of news.
    fireEvent.change(target, { target: { value: 'news' } });
    expect(within(drawer).queryByLabelText(t('opacHome.slide.path_ref'))).toBeNull();
    const post = within(drawer).getByLabelText(t('opacHome.slide.news_ref')) as HTMLInputElement;
    expect(post.value).toBe('');
    fireEvent.change(post, { target: { value: 'Lomba Mendongeng' } });
    done();
    expect(await within(drawer).findByText(t('opacHome.slide.slug_invalid'))).toBeTruthy();
    fireEvent.change(target, { target: { value: 'path' } });
    fireEvent.change(within(drawer).getByLabelText(t('opacHome.slide.path_ref')), { target: { value: '/halaman/tata-tertib' } });

    // The days: the last one not before the first.
    const from = within(drawer).getByLabelText(t('opacHome.slide.from'));
    const until = within(drawer).getByLabelText(t('opacHome.slide.until'));
    fireEvent.change(from, { target: { value: '2026-12-20' } });
    fireEvent.change(until, { target: { value: '2026-12-01' } });
    done();
    await waitFor(() => expect(until.getAttribute('aria-invalid')).toBe('true'));
    expect(within(drawer).getByText(t('opacHome.slide.until_before'))).toBeTruthy();
    fireEvent.change(until, { target: { value: '2026-12-31' } });
    done();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await rows())[0]!.textContent).toContain(t('opacHome.slides.button', { label: 'Baca tata tertib', target: t('opacHome.target.path') }));
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      expect.objectContaining({
        home: expect.objectContaining({
          hero: expect.objectContaining({
            slides: [
              slide(1, {
                title: { id: 'Tata tertib baru', en: null },
                cta: { label: { id: 'Baca tata tertib', en: null }, target: { kind: 'path', ref: '/halaman/tata-tertib' } },
                from: '2026-12-20',
                until: '2026-12-31',
              }),
            ],
          }),
        }),
      }),
    ]);
  });

  it('a new photo replaces the old one and asks for its alternative text again; Esc in the crop panel closes the panel only', async () => {
    stubPhotoUpload(fileId(9));
    start(slide(1));
    await rows();
    const { drawer } = await open(1);
    const file = within(drawer).getByLabelText(t('opacHome.photo.replace'));
    fireEvent.change(file, { target: { files: [new File(['x'], 'foto.jpg', { type: 'image/jpeg' })] } });
    const use = await within(drawer).findByRole('button', { name: t('opacHome.crop.use') });
    fireEvent.keyDown(use, { key: 'Escape' });
    await waitFor(() => expect(within(drawer).queryByRole('button', { name: t('opacHome.crop.use') })).toBeNull());
    expect(screen.getByRole('dialog')).toBe(drawer);
    await choosePhoto(t('opacHome.photo.replace'));
    await waitFor(() => expect((within(drawer).getByLabelText(t('opacHome.slide.alt')) as HTMLInputElement).value).toBe(''));
    expect(drawer.querySelector('img')!.getAttribute('src')).toBe(`/files/${fileId(9)}`);
    // A file that is not an image is refused before anything is sent.
    fireEvent.change(within(drawer).getByLabelText(t('opacHome.photo.replace')), { target: { files: [new File(['x'], 'catatan.txt', { type: 'text/plain' })] } });
    expect(await within(drawer).findByText(t('opacHome.photo.not_image'))).toBeTruthy();
  });
});
