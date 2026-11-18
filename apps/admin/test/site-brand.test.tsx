import type { MeResponse } from '@altis/shared/api/auth';
import type { SiteIdentityPublic } from '@altis/shared/api/site-identity';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageBrand, SidebarBrand, brandOf } from '@/components/shell/brand';
import { ANON, fakeServer, json, problem, renderApp, signedIn, type FakeServer } from './fake-server';

// The library's brand from the site's identity (`GET site/identity/public`): in the sidebar the logo for dark
// backgrounds, else the main logo on a white plate, else the name as text, with the name beside a logo that asks for
// it, and the square icon once the sidebar is collapsed; on the sign-in card the main logo (the dark one in the dark
// theme), which needs no session and never keeps anybody from signing in.

const fetchMock = vi.fn<typeof fetch>();
let me: MeResponse;
let server: FakeServer;

const identity = (o: Partial<SiteIdentityPublic> = {}): SiteIdentityPublic => ({
  name: 'Taman Baca Kali Bening',
  tagline: { id: null, en: null },
  showNameBesideLogo: false,
  logo: null,
  logoDark: null,
  hasIcon: false,
  icon: { '32': '/site-icon/32.png', '180': '/site-icon/180.png', '192': '/site-icon/192.png' },
  ...o,
});
const LOGO = { url: '/files/01JZLOGO000000000000000001', alt: 'Logo Taman Baca' };
const DARK = { url: '/files/01JZLOGO000000000000000002' };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  me = signedIn();
  server = fakeServer(fetchMock, () => me);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

/** The brand row of the sidebar, once the navigation is drawn. */
async function sidebarBrand(): Promise<Element> {
  await screen.findByRole('navigation', { name: 'Navigasi utama' });
  return document.getElementById('altis-sidebar')!.firstElementChild!;
}

describe('the sidebar', () => {
  it('shows the logo for dark backgrounds, with the logo\'s own alternative text and no name beside it', async () => {
    server.on('GET site/identity/public', () => json(identity({ logo: LOGO, logoDark: DARK })));
    renderApp('/admin');
    const brand = await sidebarBrand();
    await waitFor(() => expect(brand.querySelector('img')?.getAttribute('src')).toBe(DARK.url));
    expect(brand.querySelector('img')!.getAttribute('alt')).toBe('Logo Taman Baca');
    expect(brand.querySelector('[data-slot=logo-plate]')).toBeNull();
    expect(brand.textContent).toBe('');
  });

  it('without a dark logo puts the main logo on a white plate, and writes the name beside a logo that asks for it', async () => {
    server.on('GET site/identity/public', () => json(identity({ logo: LOGO, showNameBesideLogo: true })));
    renderApp('/admin');
    const brand = await sidebarBrand();
    await waitFor(() => expect(brand.querySelector('[data-slot=logo-plate] img')?.getAttribute('src')).toBe(LOGO.url));
    expect(brand.querySelector('[data-slot=logo-plate]')!.className).toContain('bg-white');
    // The name is written out, so the image says nothing a second time.
    expect(brand.querySelector('img')!.getAttribute('alt')).toBe('');
    expect(brand.textContent).toBe('Taman Baca Kali Bening');
  });

  it('without a logo writes the site\'s name, and the library\'s name when the identity cannot be read', async () => {
    server.on('GET site/identity/public', () => json(identity()));
    const first = renderApp('/admin');
    const brand = await sidebarBrand();
    await waitFor(() => expect(brand.textContent).toBe('Taman Baca Kali Bening'));
    expect(brand.querySelector('img, svg')).toBeNull();
    first.view.unmount();

    server.on('GET site/identity/public', () => problem(500, 'INTERNAL'));
    renderApp('/admin');
    const again = await sidebarBrand();
    await waitFor(() => expect(server.callsTo('GET site/identity/public').length).toBe(2));
    expect(again.textContent).toBe('Perpustakaan Arsya');
    expect(again.querySelector('img, svg')).toBeNull();
  });

  it('collapsed, shows the square icon named by the site (the built-in one while the library has none)', () => {
    const { container, rerender } = render(<SidebarBrand {...brandOf(identity({ logo: LOGO, hasIcon: true }), 'x')} compact />);
    const icon = container.querySelector('img')!;
    expect(icon.getAttribute('src')).toBe('/site-icon/192.png');
    expect(icon.getAttribute('alt')).toBe('Taman Baca Kali Bening');
    expect(icon.className).toContain('size-7');
    expect(container.querySelectorAll('img').length).toBe(1);
    // Before the identity is known there is no picture, only the name for a screen reader.
    rerender(<SidebarBrand {...brandOf(undefined, 'Perpustakaan Arsya')} compact />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('Perpustakaan Arsya');
  });
});

describe('the sign-in card', () => {
  beforeEach(() => {
    me = ANON;
  });

  it('shows the main logo at 44 px, and the logo for dark backgrounds in the dark theme', async () => {
    server.on('GET site/identity/public', () => json(identity({ logo: LOGO, logoDark: DARK })));
    renderApp('/admin/login');
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    const logos = (await screen.findAllByAltText('Logo Taman Baca')) as HTMLImageElement[];
    expect(logos.map((img) => img.getAttribute('src'))).toEqual([LOGO.url, DARK.url]);
    expect(logos[0]!.className).toContain('h-11');
    expect(logos[0]!.className).toContain('dark:hidden');
    expect(logos[1]!.className).toMatch(/(^| )hidden( |$)/);
    expect(logos[1]!.className).toContain('dark:block');
    expect(screen.queryByText('Taman Baca Kali Bening')).toBeNull();
  });

  it('without a dark logo keeps the main logo, on a white plate in the dark theme; without any logo the name as text', () => {
    const { container, rerender } = render(<PageBrand {...brandOf(identity({ logo: LOGO, showNameBesideLogo: true }), 'x')} />);
    expect(container.querySelectorAll('img').length).toBe(1);
    expect(container.querySelector('[data-slot=logo-plate]')!.className).toContain('dark:bg-white');
    expect(container.textContent).toBe('Taman Baca Kali Bening');
    rerender(<PageBrand {...brandOf(identity(), 'x')} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('p')!.className).toContain('font-bold');
    expect(container.textContent).toBe('Taman Baca Kali Bening');
  });

  it('still signs in when the identity cannot be read: the library\'s name stands as text', async () => {
    server.on('GET site/identity/public', () => problem(500, 'INTERNAL'));
    server.on('POST auth/login', () => {
      me = signedIn();
      return json({ stage: 'full', mustChangePassword: false });
    });
    const { router } = renderApp('/admin/login');
    expect(await screen.findByText('Perpustakaan Arsya')).toBeTruthy();
    expect(document.querySelector('main img')).toBeNull();
    fireEvent.change(await screen.findByLabelText('Nama pengguna'), { target: { value: 'ani' } });
    fireEvent.change(screen.getByLabelText('Kata sandi'), { target: { value: 'buku-tua-di-rak-7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
  });

  it('is drawn with the library\'s name while the identity is still on its way', async () => {
    server.on('GET site/identity/public', () => new Promise<Response>(() => {}));
    renderApp('/admin/login');
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(screen.getByText('Perpustakaan Arsya')).toBeTruthy();
    expect(screen.getByLabelText('Nama pengguna')).toBeTruthy();
  });
});
