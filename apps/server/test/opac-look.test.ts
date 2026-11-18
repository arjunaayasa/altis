import {
  ACCENTS,
  ACCENT_COLORS,
  BAR_COLORS,
  COVER_CLASSES,
  COVER_COLORS,
  OPAC_CSS,
  SCHEME_COLORS,
  SPINE_LABEL_COLORS,
  contrastRatio,
  oklchHex,
} from '@altis/opac-theme';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { BookCover, SPINE_LABEL_LINES_MAX, coverClass, spineLabelLines, type CoverSource } from '../src/opac/catalog/cover.js';
import { mapLink } from '../src/opac/catalog/home.js';
import { opacText } from '../src/opac/catalog/messages.js';
import { siteFooter, siteInfo, siteMenu } from '../src/opac/catalog/page.js';
import { scopedText, unscopedText } from '../src/opac/catalog/search-params.js';
import { Layout, toDocument, type PageFrame } from '../src/opac/layout.js';

// The look of the public pages: the substitute cover (its class, its spine label, its markup and the contrast of its
// palette), the theme's colours at WCAG AA in both schemes, the site menu and the footer's blocks (each only with
// content, never a placeholder), the field a search is limited to, and the map link of the visit block.

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

const render = (el: unknown): string => String((el as { toString(): string }).toString());

const BOOK: CoverSource = { title: 'Rumah di <Ujung> Sawah', author: 'Larasati Wibowo', callNumber: '899.221 3 WIB r', classification: '899.221', coverFileId: null };

describe('the substitute cover', () => {
  it('its class: the DDC main class of the classification, else of the call number; 2X is the 200s; anything else x', () => {
    expect(coverClass('899.221', null)).toBe('8');
    expect(coverClass('005.133', 'R 899 ABC')).toBe('0');
    expect(coverClass(null, '899.221 3 WIB r')).toBe('8');
    expect(coverClass('', 'R 297.1 ABC')).toBe('2');
    expect(coverClass(null, 'FIK WIB r')).toBe('x');
    expect(coverClass('2X4.3', null)).toBe('2');
    expect(coverClass('Novel', null)).toBe('x');
    expect(coverClass(null, null)).toBe('x');
    expect(coverClass('12', null)).toBe('x');
  });

  it('its spine label: each part of the call number on its own line, a number after a number kept on its line', () => {
    expect(spineLabelLines('899.221 3 WIB r')).toEqual(['899.221 3', 'WIB', 'r']);
    expect(spineLabelLines('R 899.221 WIB r')).toEqual(['R', '899.221', 'WIB', 'r']);
    expect(spineLabelLines('  530   TIM  f ')).toEqual(['530', 'TIM', 'f']);
    expect(spineLabelLines('FIK WIB r')).toEqual(['FIK', 'WIB', 'r']);
    expect(spineLabelLines('a b c d e f g')).toHaveLength(SPINE_LABEL_LINES_MAX);
    expect(spineLabelLines('')).toEqual([]);
    expect(spineLabelLines(null)).toEqual([]);
  });

  it('a stored cover is shown as it is, never replaced', () => {
    const html = render(jsx(BookCover as never, { book: { ...BOOK, coverFileId: '01JZFILE000000000000000007' }, size: 'card', imgClass: 'card-cover', width: 120, height: 180 }));
    expect(html).toBe('<img class="card-cover" src="/files/01JZFILE000000000000000007" alt="" loading="lazy" decoding="async" width="120" height="180"/>');
  });

  it('without one: the cloth of its class, the title and author escaped, the stacked spine label; aria-hidden', () => {
    const html = render(jsx(BookCover as never, { book: BOOK, size: 'card', imgClass: 'card-cover', width: 120, height: 180 }));
    expect(html).toBe(
      '<span class="book-cover cover-8" aria-hidden="true"><span class="cover-text"><span class="cover-title">Rumah di &lt;Ujung&gt; Sawah</span>' +
        '<span class="cover-author">Larasati Wibowo</span></span>' +
        '<span class="spine-label"><span>899.221 3</span><span>WIB</span><span>r</span></span></span>',
    );
    // No author, no call number: the title alone, the grey of "no class".
    const bare = render(jsx(BookCover as never, { book: { ...BOOK, author: null, callNumber: null, classification: null }, size: 'detail', imgClass: 'record-cover', width: 200, height: 300 }));
    expect(bare).toBe('<span class="book-cover cover-x book-cover-lg" aria-hidden="true"><span class="cover-text"><span class="cover-title">Rumah di &lt;Ujung&gt; Sawah</span></span></span>');
    // A result row: the cloth strip only.
    expect(render(jsx(BookCover as never, { book: BOOK, size: 'list', imgClass: 'card-cover', width: 120, height: 180 }))).toBe(
      '<span class="book-cover cover-8 book-cover-sm" aria-hidden="true"></span>',
    );
  });

  it('the palette: ten classes and "no class", each in both schemes, its title and author at WCAG AA (4.5:1) on its cloth', () => {
    expect([...COVER_CLASSES]).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'x']);
    for (const scheme of ['light', 'dark'] as const) {
      const cloths = new Set<string>();
      for (const cls of COVER_CLASSES) {
        const c = COVER_COLORS[scheme][cls];
        expect(contrastRatio(c.ink, c.bg), `${scheme} ${cls} title`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.sub, c.bg), `${scheme} ${cls} author`).toBeGreaterThanOrEqual(4.5);
        cloths.add(c.bg);
        expect(OPAC_CSS).toContain(`.cover-${cls}{--cover:${c.bg};--cover-ink:${c.ink};--cover-sub:${c.sub}}`);
      }
      expect(cloths.size, scheme).toBe(COVER_CLASSES.length);
    }
    expect(contrastRatio(SPINE_LABEL_COLORS.text, SPINE_LABEL_COLORS.bg)).toBeGreaterThanOrEqual(7);
  });
});

describe('the theme colours', () => {
  it('converts OKLCH to sRGB hex (white, black, the design accent)', () => {
    expect(oklchHex(1, 0, 0)).toBe('#ffffff');
    expect(oklchHex(0, 0, 0)).toBe('#000000');
    expect(ACCENT_COLORS.blue.light).toBe(oklchHex(0.48, 0.14, 255));
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('text, muted text and statuses at 4.5:1 on the page and the second layer; the footer texts on the footer; both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const c = SCHEME_COLORS[scheme];
      for (const surface of [c.bg, c.layer]) {
        for (const [name, colour] of Object.entries({ text: c.text, muted: c.muted, faint: c.faint, ok: c.ok, warn: c.warn, danger: c.danger })) {
          expect(contrastRatio(colour, surface), `${scheme} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrastRatio(c.footText, c.footBg), scheme).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.footMuted, c.footBg), scheme).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#ffffff', c.footBg), `${scheme} focus ring on the footer`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every accent at 4.5:1 as a link on the page and the second layer; white at 4.5:1 on every header bar colour', () => {
    for (const name of ACCENTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const c = SCHEME_COLORS[scheme];
        for (const surface of [c.bg, c.layer]) expect(contrastRatio(ACCENT_COLORS[name][scheme], surface), `${name} ${scheme}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio('#ffffff', BAR_COLORS[name][scheme]), `${name} ${scheme} bar`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('no gradient, no blur, reduced motion honoured', () => {
    expect(OPAC_CSS).not.toMatch(/gradient\(|blur\(|backdrop-filter/);
    expect(OPAC_CSS).toContain('@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important');
  });
});

const HOME: OpacHomeContent = {
  ...OPAC_HOME_DEFAULT,
  about: { ...OPAC_HOME_DEFAULT.about, text: { id: 'Berdiri sejak 1987.', en: null } },
  services: [{ title: 'Peminjaman', text: null }],
  hours: [
    { days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] },
    { days: 'Sabtu', time: '08.00–12.00', weekdays: [6] },
  ],
};

describe('the site menu and the footer', () => {
  it('siteInfo: each of Profil, Layanan and Kontak only with its home block switched on and with content', () => {
    expect(siteInfo(OPAC_HOME_DEFAULT, null, false)).toEqual({
      address: null,
      hours: [],
      brand: null,
      profile: false,
      services: false,
      contact: false,
      news: false,
      logo: null,
      phone: null,
      email: null,
    });
    expect(siteInfo(HOME, 'Jl. Kenari 12', true)).toEqual({
      address: 'Jl. Kenari 12',
      hours: [
        { days: 'Senin–Jumat', time: '07.00–15.00' },
        { days: 'Sabtu', time: '08.00–12.00' },
      ],
      brand: null,
      profile: true,
      services: true,
      contact: true,
      news: true,
      logo: null,
      phone: null,
      email: null,
    });
    const off = siteInfo({ ...HOME, blocks: { ...HOME.blocks, about: false, services: false, visit: false } }, '  ', false);
    expect(off).toMatchObject({ address: null, hours: [], profile: false, services: false, contact: false });
  });

  it('siteMenu: the site entries with content, then the pages; the language kept; the current section marked', () => {
    const site = siteInfo(HOME, 'Jl. Kenari 12', true);
    const pages = [{ href: '/halaman/sejarah', label: 'Sejarah' }];
    expect(siteMenu('id', site, pages, null, '/katalog/01JZ/rumah')).toEqual([
      { href: '/', label: opacText('id', 'shell.menu.home'), current: false },
      { href: '/cari', label: opacText('id', 'shell.menu.catalog'), current: true },
      { href: '/#tentang', label: opacText('id', 'shell.menu.profile'), current: false },
      { href: '/#layanan', label: opacText('id', 'shell.menu.services'), current: false },
      { href: '/berita', label: opacText('id', 'shell.menu.news'), current: false },
      { href: '/#kunjungi', label: opacText('id', 'shell.menu.contact'), current: false },
      { href: '/halaman/sejarah', label: 'Sejarah', lang: undefined, current: false },
    ]);
    const en = siteMenu('en', siteInfo(OPAC_HOME_DEFAULT, null, false), pages, 'en', '/halaman/sejarah');
    expect(en.map((l) => [l.href, l.current])).toEqual([
      ['/?lang=en', false],
      ['/cari?lang=en', false],
      ['/halaman/sejarah?lang=en', true],
    ]);
  });

  /** The footer of a page drawn with `frame`. */
  function footerOf(frame: PageFrame): string {
    const html = toDocument(jsx(Layout as never, { locale: 'id', nonce: 'n', title: 'T', description: 'D', libraryName: 'Perpustakaan <SMA>', accent: 'blue', frame }));
    return /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html)![1]!;
  }

  const frameWith = (footer: PageFrame['footer']): PageFrame => ({ homeHref: '/', langHrefs: { id: '/x?lang=id', en: '/x?lang=en' }, nav: [], search: null, footer });

  it('the footer with every block: the library and its address, the links, the hours, the search field, then the bottom line', () => {
    const site = siteInfo(HOME, 'Jl. Kenari 12\nLembah Hijau', true);
    const footer = footerOf(frameWith(siteFooter('id', site, [{ href: '/halaman/sejarah', label: 'Sejarah' }], null)));
    expect(footer).toContain('<div class="foot-block"><h2>Perpustakaan &lt;SMA&gt;</h2><p class="foot-address">Jl. Kenari 12\nLembah Hijau</p></div>');
    const links = /<ul class="foot-links">([\s\S]*?)<\/ul>/.exec(footer)![1]!;
    expect([...links.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/cari', '/#tentang', '/#layanan', '/berita', '/#kunjungi', '/halaman/sejarah']);
    expect(footer).toContain('<tr><th scope="row">Senin–Jumat</th><td>07.00–15.00</td></tr>');
    expect(footer).toContain(`<h2>${esc(opacText('id', 'shell.footer.search'))}</h2><form class="search-box" role="search" method="get" action="/cari">`);
    expect(footer).toContain('id="cari-kaki"');
    expect(footer).toContain(`<span>${esc(opacText('id', 'shell.footer.powered'))}</span>`);
    // Four blocks: the wide grid's four columns.
    expect(footer).toContain('<div class="foot-grid">');
  });

  it('a footer block without content is left out, never filled with a placeholder', () => {
    const footer = footerOf(frameWith(siteFooter('id', siteInfo(OPAC_HOME_DEFAULT, null, false), [], null)));
    expect(footer).not.toContain('foot-address');
    expect(footer).not.toContain('foot-hours');
    expect([...footer.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual([esc(opacText('id', 'shell.footer.links')), esc(opacText('id', 'shell.footer.search'))]);
    const links = /<ul class="foot-links">([\s\S]*?)<\/ul>/.exec(footer)![1]!;
    expect([...links.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/cari']);
    // The blocks left share the wide row: no empty column, the search field not squeezed beside one.
    expect(footer).toContain('<div class="foot-grid foot-grid-2">');
    const hoursOnly = footerOf(frameWith(siteFooter('id', siteInfo(HOME, null, false), [], null)));
    expect(hoursOnly).toContain('<div class="foot-grid foot-grid-3">');
    // A page without the catalogue's frame (the 1b pages): the bottom line only.
    const bare = footerOf({ homeHref: '/', langHrefs: { id: '?lang=id', en: '?lang=en' }, nav: [], search: null });
    expect(bare).not.toContain('foot-grid');
    expect(bare).toContain('class="foot-bottom"');
  });

  it('the library colour of a page frame colours the header bar of every page, through the nonce style element', () => {
    const html = toDocument(
      jsx(Layout as never, { locale: 'id', nonce: 'n0nce', title: 'T', description: 'D', libraryName: 'P', accent: 'blue', frame: { ...frameWith(undefined), brand: '#1e3a8a' } }),
    );
    expect(html).toContain('<style nonce="n0nce">.site-header{--hero-bg:#1e3a8a}</style>');
  });
});

describe('the field a search is limited to', () => {
  it('scopedText: every word and phrase in the field; fields, operators and an unbalanced quote as typed; semua as it is', () => {
    expect(scopedText('rumah sawah', 'judul')).toBe('judul:rumah judul:sawah');
    expect(scopedText('"ujung sawah" -kota', 'judul')).toBe('judul:"ujung sawah" -judul:kota');
    expect(scopedText('wibowo ATAU kusuma', 'pengarang')).toBe('pengarang:wibowo ATAU pengarang:kusuma');
    expect(scopedText('judul:rumah pengarang:"larasati wibowo" novel', 'subjek')).toBe('judul:rumah pengarang:"larasati wibowo" subjek:novel');
    expect(scopedText('"tanpa akhir', 'judul')).toBe('" judul:tanpa judul:akhir');
    expect(scopedText('rumah sawah', 'semua')).toBe('rumah sawah');
  });

  it('unscopedText: the field taken off again, for the spelling line', () => {
    expect(unscopedText('judul:rumah -judul:sawah', 'judul')).toBe('rumah -sawah');
    expect(unscopedText(scopedText('rumah sawah', 'pengarang'), 'pengarang')).toBe('rumah sawah');
    expect(unscopedText('judul:rumah', 'semua')).toBe('judul:rumah');
  });
});

describe('the map link of the visit block', () => {
  it('a search for the address on one line, nothing embedded', () => {
    expect(mapLink('Jl. Kenari 12\nLembah Hijau')).toBe('https://www.openstreetmap.org/search?query=Jl.%20Kenari%2012%20Lembah%20Hijau');
  });
});
