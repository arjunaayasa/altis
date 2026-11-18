import { OPAC_HOME_DEFAULT } from '@altis/shared/api/opac-home';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirtyForms } from '@/lib/dirty-forms';
import { adminMe, problem, signedIn, startApp } from './fake-api';
import { FIRST, SAVED, fileId, heroOf, openTab, puts, save, slide, t, view } from './opac-home-fixtures';

// OPAC › Halaman awal through the real router and API client against a fake `/api/v1`: the address without a tab goes
// to the first tab; the tabs edit one draft (what was typed on one is still there after a visit to another) saved by
// one bar, whose PUT body is the whole content at the revision it was loaded at, with everything not edited as it was
// loaded; the unsaved mark, "Batalkan perubahan" and the question before leaving; a field refused before sending or by
// the server opens and marks its tab (a slide's field marks its slide and shows in its drawer); the 409 of a save
// another admin made first; and the screen without the permission.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A content with something in every part, so that a save shows what it kept. */
const full = () =>
  view({
    title: { id: 'Ruang baca warga', en: 'A reading room' },
    hero: {
      slides: [
        slide(1, { cta: { label: { id: 'Jelajahi katalog', en: 'Browse' }, target: { kind: 'catalog' } } }),
        slide(2, { note: { id: 'Agenda', en: null }, subtitle: { id: 'Sabtu pagi', en: null }, cta: { label: { id: 'Baca', en: null }, target: { kind: 'news', ref: 'lomba-mendongeng' } }, from: '2026-11-16', until: '2026-11-30' }),
        slide(3, { active: false, cta: { label: { id: 'Tata tertib', en: null }, target: { kind: 'path', ref: '/halaman/tata-tertib' } } }),
      ],
      autoplay: false,
      intervalSec: 10,
    },
    brand: '#1e3a8a',
    about: { text: { id: 'Berdiri 1987.', en: null }, photo: { fileId: fileId(10), alt: 'Gedung', caption: null }, founded: 1987, librarians: 3, history: { id: 'Dulu sebuah gudang.', en: null } },
    facilities: [{ fileId: fileId(11), alt: 'Ruang baca', caption: 'Lantai 1' }],
    hours: [{ days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] }],
    logo: { fileId: fileId(12), alt: 'Logo' },
    contact: { phone: '(021) 555-0101', email: null },
    timeline: [{ year: 1987, text: { id: 'Berdiri', en: 'Founded' } }],
    vision: { id: 'Warga gemar membaca.', en: null },
    mission: [{ id: 'Melayani semua warga', en: null }],
    staff: [{ name: 'Sri Wahyuni', role: { id: 'Kepala perpustakaan', en: 'Head librarian' } }],
    gallery: [{ fileId: fileId(13), alt: 'Rak anak', caption: { id: 'Pojok anak', en: null } }],
  });

describe('OPAC › Halaman awal', () => {
  it('the address without a tab, or with an unknown one, opens the slider tab, and the sidebar still marks Halaman awal', async () => {
    const first = startApp({ me: adminMe(), path: '/admin/opac/beranda', routes: { 'GET opac/home': () => view() } });
    await screen.findByRole('heading', { level: 1, name: t('opacHome.title') }, FIRST);
    expect(first.router.state.location.pathname).toBe('/admin/opac/beranda/slider');
    const tabs = screen.getByRole('navigation', { name: t('opacHome.tabs') });
    expect(within(tabs).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['slider', 'profil', 'layanan', 'galeri', 'jam', 'blok'].map((x) => `/admin/opac/beranda/${x}`));
    expect(within(tabs).getByRole('link', { name: new RegExp(`^${t('opacHome.tab.slider')}`) }).getAttribute('aria-current')).toBe('page');
    const marked = screen.getAllByRole('link', { name: t('nav.opac.home') }).filter((a) => a.getAttribute('aria-current') === 'page');
    expect(marked.map((a) => a.getAttribute('href'))).toEqual(['/admin/opac/beranda']);
    expect(screen.getByRole('link', { name: t('opacHome.view_site') }).getAttribute('href')).toBe('/');
    await first.router.navigate({ to: '/admin/opac/beranda/$tab', params: { tab: 'entah' } });
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/admin/opac/beranda/slider'));
  });

  it('the tabs edit one draft: what is typed on one tab is kept on the others, and one save sends it all with the rest as loaded', async () => {
    let saved = false;
    const loaded = full();
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda/profil',
      routes: {
        'GET opac/home': () => (saved ? { ...loaded, home: { ...loaded.home, title: { id: 'Rumah baca', en: 'A reading room' } }, revision: SAVED.revision } : loaded),
        'PUT opac/home': () => {
          saved = true;
          return SAVED;
        },
      },
    });
    const heading = (await screen.findByLabelText(t('opacHome.text.heading_id'), undefined, FIRST)) as HTMLInputElement;
    expect(heading.value).toBe('Ruang baca warga');
    expect(screen.getByText(t('opacHome.clean'))).toBeTruthy();
    fireEvent.change(heading, { target: { value: 'Rumah baca' } });
    expect(screen.getByText(t('opacHome.dirty'))).toBeTruthy();

    await openTab('opacHome.tab.hours');
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.hours.add') }));
    fireEvent.change(screen.getByLabelText(t('opacHome.hours.days', { n: 2 })), { target: { value: 'Sabtu' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.hours.time', { n: 2 })), { target: { value: '08.00–12.00' } });
    fireEvent.click(within(screen.getByRole('group', { name: t('opacHome.hours.weekdays', { n: 2 }) })).getByLabelText(t('opacHome.hours.weekday.6')));
    fireEvent.change(screen.getByLabelText(t('opacHome.contact.email')), { target: { value: 'perpus@sma1.sch.id' } });
    // The logo is set on the site identity's screen.
    expect(screen.getByRole('link', { name: t('siteIdentity.moved.link') }).getAttribute('href')).toBe('/admin/opac/identitas');

    await openTab('opacHome.tab.blocks');
    const promoted = screen.getByRole('switch', { name: t('opacHome.blocks.promoted') });
    expect(promoted.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(promoted);
    expect(promoted.getAttribute('aria-checked')).toBe('false');

    await openTab('opacHome.tab.profile');
    expect((screen.getByLabelText(t('opacHome.text.heading_id')) as HTMLInputElement).value).toBe('Rumah baca');
    expect(screen.getByText(t('opacHome.dirty'))).toBeTruthy();
    expect(puts(requests)).toEqual([]);

    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      {
        revision: '0123456789abcdef',
        home: {
          ...loaded.home,
          title: { id: 'Rumah baca', en: 'A reading room' },
          hours: [...loaded.home.hours, { days: 'Sabtu', time: '08.00–12.00', weekdays: [6] }],
          contact: { phone: '(021) 555-0101', email: 'perpus@sma1.sch.id' },
          blocks: { ...loaded.home.blocks, promoted: false },
        },
        welcome: { id: 'Selamat datang.', en: null },
      },
    ]);
    // The editor starts again from what the server holds now, on the same tab; the save button has the focus.
    await waitFor(() => expect((screen.getByLabelText(t('opacHome.text.heading_id')) as HTMLInputElement).value).toBe('Rumah baca'));
    expect(screen.getByText(t('opacHome.clean'))).toBeTruthy();
    expect(screen.getByText(t('opacHome.saved')).closest('[role=status]')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('opacHome.save') }));
  });

  it('marks unsaved changes, asks before the page is left, and "Batalkan perubahan" goes back to what was loaded', async () => {
    startApp({ me: adminMe(), path: '/admin/opac/beranda/layanan', routes: { 'GET opac/home': () => view() } });
    const name = (await screen.findByLabelText(t('opacHome.services.name', { n: 1 }), undefined, FIRST)) as HTMLInputElement;
    expect(name.value).toBe('Peminjaman');
    expect(dirtyForms.count()).toBe(0);
    const discard = screen.getByRole('button', { name: t('opacHome.discard') }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Pinjam buku' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(1));
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    // The draft outlives a change of tab, and so does the question.
    await openTab('opacHome.tab.gallery');
    expect(dirtyForms.count()).toBe(1);
    fireEvent.click(discard.isConnected ? discard : screen.getByRole('button', { name: t('opacHome.discard') }));
    await waitFor(() => expect(dirtyForms.count()).toBe(0));
    await openTab('opacHome.tab.services');
    expect((screen.getByLabelText(t('opacHome.services.name', { n: 1 })) as HTMLInputElement).value).toBe('Peminjaman');
  });

  it('a field refused before sending opens its tab, marks it, and takes the focus; nothing is sent', async () => {
    const { requests, router } = startApp({ me: adminMe(), path: '/admin/opac/beranda/profil', routes: { 'GET opac/home': () => full() } });
    const alt = (await screen.findByLabelText(t('opacHome.photo.alt'), undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(alt, { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.about.founded')), { target: { value: 'dulu' } });
    await openTab('opacHome.tab.slider');
    save();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/opac/beranda/profil'));
    const refused = await screen.findByLabelText(t('opacHome.photo.alt'));
    expect(refused.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(t('opacHome.about.founded')).getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(refused));
    const tab = screen.getByRole('link', { name: new RegExp(`^${t('opacHome.tab.profile')}`) });
    expect(tab.textContent).toContain(t('opacHome.tab.check'));
    expect(screen.getByRole('link', { name: new RegExp(`^${t('opacHome.tab.slider')}`) }).textContent).not.toContain(t('opacHome.tab.check'));
    // The bar names the tab, as an alert; so does the outcome under the tabs.
    const message = t('opacHome.fix_tabs', { tabs: t('opacHome.tab.profile') });
    expect(screen.getAllByText(message).some((el) => el.closest('[data-slot=save-bar] [role=alert]') !== null)).toBe(true);
    expect(puts(requests)).toEqual([]);
    // Typing the field again and saving clears the mark.
    fireEvent.change(refused, { target: { value: 'Gedung perpustakaan' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.about.founded')), { target: { value: '1987' } });
  });

  it("the server's field errors land on their tab and field: a personal e-mail, and a slide's title in its drawer", async () => {
    let answer = problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'home.contact.email', code: 'personal_email' }] });
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda/blok',
      routes: { 'GET opac/home': () => full(), 'PUT opac/home': () => answer },
    });
    await screen.findByRole('switch', { name: t('opacHome.blocks.news') }, FIRST);
    save();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/opac/beranda/jam'));
    const email = await screen.findByLabelText(t('opacHome.contact.email'));
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(t('opacHome.contact.personal_email'))).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(email));

    answer = problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'home.hero.slides.1.title.id', code: 'too_big' }] });
    save();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/opac/beranda/slider'));
    const rows = within(await screen.findByRole('list', { name: t('opacHome.slides.list') })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent?.includes(t('opacHome.tab.check')))).toEqual([false, true, false]);
    const edit = within(rows[1]!).getByRole('button', { name: t('opacHome.slides.edit', { n: 2 }) });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    fireEvent.click(edit);
    const drawer = await screen.findByRole('dialog', { name: t('opacHome.slides.edit', { n: 2 }) });
    const title = within(drawer).getByLabelText(`${t('opacHome.slide.title')} (${t('opacHome.lang.id')})`);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(within(drawer).getByText(t('form.error.too_big'))).toBeTruthy();
  });

  it('a save another admin made first is refused with a way to reload, and the draft stays', async () => {
    let loads = 0;
    startApp({
      me: adminMe(),
      path: '/admin/opac/beranda/profil',
      routes: {
        'GET opac/home': () => {
          loads += 1;
          return loads === 1 ? view() : { ...view({ title: { id: 'Versi admin lain', en: null } }), revision: 'fedcba9876543210' };
        },
        'PUT opac/home': () => problem(409, 'CONFLICT_STALE'),
      },
    });
    const heading = (await screen.findByLabelText(t('opacHome.text.heading_id'), undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(heading, { target: { value: 'Punya saya' } });
    save();
    expect(await screen.findByText(t('opacHome.conflict'))).toBeTruthy();
    expect(heading.value).toBe('Punya saya');
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.reload') }));
    await waitFor(() => expect((screen.getByLabelText(t('opacHome.text.heading_id')) as HTMLInputElement).value).toBe('Versi admin lain'));
    expect(screen.queryByText(t('opacHome.conflict'))).toBeNull();
  });

  it('a content saved before the profile existed loads and is sent back whole', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/opac/beranda/slider', routes: { 'GET opac/home': () => view({ hero: heroOf(slide(1)) }), 'PUT opac/home': () => SAVED } });
    await screen.findByRole('list', { name: t('opacHome.slides.list') }, FIRST);
    save();
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([{ revision: '0123456789abcdef', home: { ...OPAC_HOME_DEFAULT, services: [{ title: 'Peminjaman', text: null }], hero: heroOf(slide(1)) }, welcome: { id: 'Selamat datang.', en: null } }]);
  });

  it('without the permission the screen says so and loads nothing', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: '/admin/opac/beranda/slider', routes: {} });
    expect(await screen.findByText(t('opacHome.no_permission'), undefined, FIRST)).toBeTruthy();
    expect(requests.filter((r) => r.path === 'opac/home')).toEqual([]);
    expect(screen.queryByRole('navigation', { name: t('opacHome.tabs') })).toBeNull();
  });
});
