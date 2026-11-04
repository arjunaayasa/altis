import { COMMUNITY_SOURCE_URL } from '@altis/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedIn, startApp } from './fake-api';

// Spec §13.3 "Kerangka admin" — halaman Tentang (Task 30): the build this SPA is (`__ALTIS_BUILD__`, '0.1.0' under
// Vitest), the edition, the software licence with the link to the source code (AGPL §13, ruling R24) and the
// third-party notices.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The value of the row `label` in the facts list. */
function row(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  expect(value?.tagName).toBe('DD');
  return value as HTMLElement;
}

describe('about', () => {
  it('shows the build and links the third-party notices', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin/about', routes: {} });
    expect(await screen.findByRole('heading', { name: 'Tentang ALTIS' })).toBeTruthy();
    expect(screen.getByText('0.1.0')).toBeTruthy();
    const link = screen.getByRole('link', { name: /pihak ketiga/ });
    expect(link.getAttribute('href')).toBe('/legal/third-party-notices.txt');
  });

  it('names the edition, the AGPL-3.0-only licence and links the source code, for any staff user', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin/about', routes: {} });
    await screen.findByRole('heading', { name: 'Tentang ALTIS' });
    expect(row('Edisi').textContent).toBe('Edisi Komunitas');
    expect(row('Lisensi perangkat lunak').textContent).toBe('AGPL-3.0-only');
    const source = within(row('Kode sumber')).getByRole('link');
    expect(COMMUNITY_SOURCE_URL).toBe('https://github.com/arjunaayasa/altis');
    expect(source.getAttribute('href')).toBe(COMMUNITY_SOURCE_URL);
    expect(source.getAttribute('rel')).toBe('noopener');
    expect(source.textContent).toBe('github.com/arjunaayasa/altis');
  });
});
