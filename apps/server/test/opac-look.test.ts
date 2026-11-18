import {
  ACCENTS,
  ACCENT_COLORS,
  BRAND_BACKDROPS,
  COVER_CLASSES,
  COVER_COLORS,
  OPAC_CSS,
  PANEL_COLORS,
  SCHEME_COLORS,
  SPINE_LABEL_COLORS,
  brandCss,
  brandTokens,
  contrastRatio,
  hexRgb,
  oklchHex,
  rgbToOklch,
} from '@altis/opac-theme';
import { OPAC_HOME_DEFAULT, opacHomeBrandField, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { BookCover, SPINE_LABEL_LINES_MAX, coverClass, spineLabelLines, type CoverSource } from '../src/opac/catalog/cover.js';
import { opacText } from '../src/opac/catalog/messages.js';
import { siteFooter, siteInfo, siteMenu } from '../src/opac/catalog/page.js';
import { OPAC_ADVANCED_PATH, scopedText, unscopedText } from '../src/opac/catalog/search-params.js';
import { mapLink } from '../src/opac/catalog/site-blocks.js';
import { Layout, toDocument, type PageFrame } from '../src/opac/layout.js';

// The look of the public pages: the substitute cover (its class, its spine label, its markup and the contrast of its
// palette), the theme's colours at WCAG AA in both schemes, the library colour's tokens (worked out from the one colour
// a library sets, each held to its contrast), what the stylesheet never does (a gradient, capitals, wide letter
// spacing, a fetch), the site menu and the footer's blocks (each only with content, never a placeholder), the field a
// search is limited to, and the map link of the visit block.

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

  it("every accent at 4.5:1 as a link on the page and the second layer, and under a button's text; white at 4.5:1 on every panel colour", () => {
    for (const name of ACCENTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const c = SCHEME_COLORS[scheme];
        const accent = ACCENT_COLORS[name][scheme];
        for (const surface of [c.bg, c.layer]) expect(contrastRatio(accent, surface), `${name} ${scheme} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        // `--accent-ink`, the text of a primary button: white on the light page, the page's colour on the dark one.
        expect(contrastRatio(scheme === 'light' ? '#ffffff' : c.bg, accent), `${name} ${scheme} button`).toBeGreaterThanOrEqual(4.5);
        // The panel behind a slide's text (`--on-panel` is white), and the inverse button on it.
        expect(contrastRatio('#ffffff', PANEL_COLORS[name][scheme]), `${name} ${scheme} panel`).toBeGreaterThanOrEqual(4.5);
        expect(OPAC_CSS).toContain(`--accent:${accent};`);
        expect(OPAC_CSS).toContain(`--panel:${PANEL_COLORS[name][scheme]}`);
      }
    }
    expect(OPAC_CSS).toContain('--on-panel:#ffffff;');
    // What the library colour's tokens are measured against is the second layer of each scheme.
    expect(BRAND_BACKDROPS).toEqual({ light: SCHEME_COLORS.light.layer, dark: SCHEME_COLORS.dark.layer });
  });

  it('no gradient, no blur, reduced motion honoured', () => {
    expect(OPAC_CSS).not.toMatch(/gradient|blur\(|backdrop-filter/);
    expect(OPAC_CSS).toContain('@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important');
  });

  it('no capitals by style but the guest book code, letter spacing 0 or -.01em only, nothing fetched', () => {
    const transforms = [...OPAC_CSS.matchAll(/([^{}]*)\{[^{}]*text-transform:[^{}]*\}/g)].map((m) => m[1]!.trim());
    expect(transforms).toEqual(['.guestbook-code']);
    expect(OPAC_CSS.match(/text-transform/g)).toHaveLength(1);
    const spacings = [...OPAC_CSS.matchAll(/letter-spacing:([^;}]*)/g)].map((m) => m[1]);
    expect(spacings.length).toBeGreaterThan(0);
    for (const value of spacings) expect(['0', '-.01em']).toContain(value);
    expect(OPAC_CSS).not.toMatch(/url\(/i);
    expect(OPAC_CSS).not.toMatch(/@import/i);
  });
});

describe("the library colour's tokens", () => {
  const COLOURS = ['#17624f', '#1e3a8a', '#767676', '#000000', '#7e22ce', '#b91c1c', '#0f766e', '#3b3b3b', '#8a6d00', '#f5d76e', '#ffffff'];

  it.each(COLOURS)('%s: each accent at 4.5:1 on the second layer of its scheme (and so on the page), white at 4.5:1 on both panels', (colour) => {
    const tokens = brandTokens(colour);
    expect(contrastRatio(tokens.light.accent, BRAND_BACKDROPS.light), 'light accent').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.light.accent, SCHEME_COLORS.light.bg), 'light accent on the page').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.dark.accent, BRAND_BACKDROPS.dark), 'dark accent').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.dark.accent, SCHEME_COLORS.dark.bg), 'dark accent on the page').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', tokens.light.panel), 'light panel').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', tokens.dark.panel), 'dark panel').toBeGreaterThanOrEqual(4.5);
    // A primary button's text on the accent: white on the light page, the page's colour on the dark one.
    expect(contrastRatio('#ffffff', tokens.light.accent), 'light button').toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(SCHEME_COLORS.dark.bg, tokens.dark.accent), 'dark button').toBeGreaterThanOrEqual(4.5);
    for (const value of [...Object.values(tokens.light), ...Object.values(tokens.dark)]) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('a colour that already reads is kept as it is: the light accent and the light panel are the colour itself', () => {
    for (const colour of ['#17624f', '#1e3a8a', '#000000']) {
      const tokens = brandTokens(colour);
      expect(tokens.light.accent).toBe(colour);
      expect(tokens.light.panel).toBe(colour);
    }
    expect(brandTokens('#17624F')).toEqual(brandTokens('#17624f'));
    // At the limit on white (4.54:1) the colour is the panel, and only darkened as far as the second layer asks as accent.
    const limit = brandTokens('#767676');
    expect(limit.light.panel).toBe('#767676');
    expect(contrastRatio('#767676', BRAND_BACKDROPS.light)).toBeLessThan(4.5);
    expect(limit.light.accent).not.toBe('#767676');
    expect(contrastRatio(limit.light.accent, BRAND_BACKDROPS.light)).toBeLessThan(5);
    // The hue is kept where the colour has one.
    const hue = (hex: string): number => rgbToOklch(hexRgb(hex))[2];
    for (const scheme of ['light', 'dark'] as const) expect(Math.abs(hue(brandTokens('#17624f')[scheme].accent) - hue('#17624f'))).toBeLessThan(6);
  });

  it('brandCss: the tokens of both schemes on the root element, nothing but hex colours; not a colour throws', () => {
    for (const colour of COLOURS) {
      const t = brandTokens(colour);
      expect(brandCss(colour)).toBe(
        `:root{--accent:${t.light.accent};--accent-hover:${t.light.accentHover};--panel:${t.light.panel}}` +
          `@media (prefers-color-scheme:dark){:root{--accent:${t.dark.accent};--accent-hover:${t.dark.accentHover};--panel:${t.dark.panel}}}`,
      );
      expect(brandCss(colour)).toMatch(
        /^:root\{--accent:#[0-9a-f]{6};--accent-hover:#[0-9a-f]{6};--panel:#[0-9a-f]{6}\}@media \(prefers-color-scheme:dark\)\{:root\{--accent:#[0-9a-f]{6};--accent-hover:#[0-9a-f]{6};--panel:#[0-9a-f]{6}\}\}$/,
      );
    }
    for (const bad of ['red', '#fff', '#1e3a8a;}body{display:none', '']) expect(() => brandCss(bad), bad).toThrow(TypeError);
  });

  it('the setting still refuses a colour too light for white text, and stores a colour in lower case', () => {
    for (const light of ['#f5d76e', '#ffffff', '#9ca3af']) expect(opacHomeBrandField.safeParse(light).success, light).toBe(false);
    expect(JSON.stringify(opacHomeBrandField.safeParse('#f5d76e').error?.issues)).toContain('low_contrast');
    expect(opacHomeBrandField.parse(' #17624F ')).toBe('#17624f');
    for (const dark of ['#17624f', '#767676', '#000000']) expect(opacHomeBrandField.safeParse(dark).success, dark).toBe(true);
    for (const bad of ['17624f', '#17624', 'teal', '#17624f;color:red']) expect(opacHomeBrandField.safeParse(bad).success, bad).toBe(false);
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
  it('siteInfo: each of the profile, the services and the visit only with its home block switched on and with content', () => {
    expect(siteInfo(OPAC_HOME_DEFAULT, null, false)).toEqual({
      address: null,
      hours: [],
      brand: null,
      profile: false,
      services: false,
      contact: false,
      news: false,
      gallery: false,
      logo: null,
      name: null,
      tagline: { id: null, en: null },
      phone: null,
      email: null,
      today: null,
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
      gallery: false,
      logo: null,
      name: null,
      tagline: { id: null, en: null },
      phone: null,
      email: null,
      today: null,
    });
    const off = siteInfo({ ...HOME, blocks: { ...HOME.blocks, about: false, services: false, visit: false } }, '  ', false, null, { today: { open: true, time: '07.00–15.00' } });
    expect(off).toMatchObject({ address: null, hours: [], profile: false, services: false, contact: false, today: null });
    // The site's name and tagline (the identity's) and today's hours are handed in; the gallery is the content's.
    const more = siteInfo({ ...HOME, gallery: [{ fileId: '01JZFXQ00000000000000000A1', alt: 'Ruang baca', caption: { id: null, en: null } }] }, null, false, null, {
      name: 'Pustaka Lembah Hijau',
      tagline: { id: 'Membaca bersama', en: null },
      today: { open: false, time: '' },
    });
    expect(more).toMatchObject({ gallery: true, name: 'Pustaka Lembah Hijau', tagline: { id: 'Membaca bersama', en: null }, today: { open: false, time: '' } });
  });

  it('siteMenu: the site entries with content, then the pages; the language kept; the current section marked', () => {
    const site = siteInfo(HOME, 'Jl. Kenari 12', true);
    const pages = [{ href: '/halaman/sejarah', label: 'Sejarah' }];
    expect(siteMenu('id', site, pages, null, '/katalog/01JZ/rumah')).toEqual([
      { href: '/', label: opacText('id', 'shell.menu.home'), current: false },
      { href: '/cari', label: opacText('id', 'shell.menu.catalog'), current: true },
      { href: '/profil', label: opacText('id', 'shell.menu.profile'), current: false },
      { href: '/berita', label: opacText('id', 'shell.menu.news'), current: false },
      { href: '/#kunjungi', label: opacText('id', 'shell.menu.contact'), current: false },
      { href: '/halaman/sejarah', label: 'Sejarah', lang: undefined, current: false },
    ]);
    expect(siteMenu('id', site, pages, null, '/').map((l) => l.label)).toEqual(['Beranda', 'Katalog', 'Profil', 'Berita & agenda', 'Jam & lokasi', 'Sejarah']);
    // The section a page belongs to is the entry marked: a news post under the news, the gallery under the profile; the
    // link to a part of the home page is never the current page.
    const currentAt = (path: string): string[] => siteMenu('id', site, pages, null, path).filter((l) => l.current === true).map((l) => l.href);
    expect(currentAt('/')).toEqual(['/']);
    expect(currentAt('/berita/bedah-buku')).toEqual(['/berita']);
    expect(currentAt('/profil')).toEqual(['/profil']);
    expect(currentAt('/galeri')).toEqual(['/profil']);
    expect(currentAt('/cari/lanjutan')).toEqual(['/cari']);
    expect(siteMenu('en', site, [], 'en', '/x').map((l) => l.href)).toEqual(['/?lang=en', '/cari?lang=en', '/profil?lang=en', '/berita?lang=en', '/?lang=en#kunjungi']);
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

  it('the footer with every block: the library with its tagline and address, the links, the member links, the hours, then the bottom line', () => {
    const site = siteInfo(HOME, 'Jl. Kenari 12\nLembah Hijau', true, null, { tagline: { id: 'Membaca <bersama>', en: null } });
    const footer = footerOf(frameWith(siteFooter('id', site, [{ href: '/halaman/sejarah', label: 'Sejarah' }], null)));
    expect(footer).toContain(
      '<div class="foot-block foot-about"><a class="sitelogo" href="/"><span class="sitename">Perpustakaan &lt;SMA&gt;</span></a>' +
        '<p class="foot-tagline">Membaca &lt;bersama&gt;</p><p class="foot-address">Jl. Kenari 12\nLembah Hijau</p></div>',
    );
    const lists = [...footer.matchAll(/<h2[^>]*>([^<]*)<\/h2><ul class="foot-links">([\s\S]*?)<\/ul>/g)].map((m) => [m[1], [...m[2]!.matchAll(/href="([^"]*)"/g)].map((h) => h[1])]);
    expect(lists).toEqual([
      [esc(opacText('id', 'shell.footer.links')), ['/cari', OPAC_ADVANCED_PATH, '/profil', '/berita', '/halaman/sejarah']],
      [esc(opacText('id', 'shell.footer.member')), ['/akun', '/profil#anggota', '/#kunjungi']],
    ]);
    expect(footer).toContain(`<h2 id="kaki-jam">${esc(opacText('id', 'shell.footer.hours'))}</h2><table class="foot-hours" aria-labelledby="kaki-jam">`);
    expect(footer).toContain('<tr><th scope="row">Senin–Jumat</th><td>07.00–15.00</td></tr>');
    // No search field in the footer: no form control at all.
    expect(footer).not.toMatch(/<form|<input|<button|<select/);
    expect(footer).toContain(`<span>${esc(opacText('id', 'shell.footer.powered'))}</span>`);
    expect(footer).toContain(`<a href="/berita/rss" type="application/rss+xml">${esc(opacText('id', 'shell.footer.feed'))}</a>`);
    // The gallery joins the links when it has a photo; a page in the other language marks the library's own texts.
    const gallery = siteFooter('en', { ...site, gallery: true, contentLang: 'id' }, [], 'en');
    expect(gallery.links.map((l) => l.href)).toEqual(['/cari?lang=en', `${OPAC_ADVANCED_PATH}?lang=en`, '/profil?lang=en', '/berita?lang=en', '/galeri?lang=en']);
    expect(gallery.member.map((l) => l.href)).toEqual(['/akun?lang=en', '/profil?lang=en#anggota', '/?lang=en#kunjungi']);
    // A tagline written in one language only is shown on a page in the other one too.
    expect(gallery.tagline).toBe('Membaca <bersama>');
    const other = footerOf(frameWith(gallery));
    expect(other).toContain('<p class="foot-address" lang="id">');
    expect(other).toContain('<tbody lang="id">');
  });

  it('a footer block without content is left out, never filled with a placeholder', () => {
    const footer = footerOf(frameWith(siteFooter('id', siteInfo(OPAC_HOME_DEFAULT, null, false), [], null)));
    for (const absent of ['foot-address', 'foot-hours', 'foot-tagline', 'foot-contact', 'rss']) expect(footer, absent).not.toContain(absent);
    expect([...footer.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1])).toEqual([esc(opacText('id', 'shell.footer.links')), esc(opacText('id', 'shell.footer.member'))]);
    expect([...footer.matchAll(/<li><a href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/cari', OPAC_ADVANCED_PATH, '/akun']);
    expect(footer).not.toMatch(/<p[^>]*>\s*<\/p>|<ul[^>]*>\s*<\/ul>|<h2[^>]*>\s*<\/h2>/);
    // Hours without an address: the hours block alone joins the two lists.
    const hoursOnly = footerOf(frameWith(siteFooter('id', siteInfo(HOME, null, false), [], null)));
    expect(hoursOnly).toContain('class="foot-hours"');
    expect(hoursOnly).not.toContain('foot-address');
    // A page without the catalogue's frame (the 1b pages): the bottom line only.
    const bare = footerOf({ homeHref: '/', langHrefs: { id: '?lang=id', en: '?lang=en' }, nav: [], search: null });
    expect(bare).not.toContain('foot-cols');
    expect(bare).not.toContain('foot-block');
    expect(bare).toContain('class="foot-bottom"');
  });

  it("the library colour of a page frame is every page's accent and panel, through the one style element, which carries the nonce", () => {
    const withBrand = (brand: unknown): string =>
      toDocument(jsx(Layout as never, { locale: 'id', nonce: 'n0nce', title: 'T', description: 'D', libraryName: 'P', accent: 'blue', frame: { ...frameWith(undefined), brand } }));
    const html = withBrand('#1e3a8a');
    expect(html).toContain(`<style nonce="n0nce">${brandCss('#1e3a8a')}</style>`);
    expect(html.match(/<style/g)).toHaveLength(1);
    // After the stylesheet, so that it wins over the named accent's tokens.
    expect(html.indexOf('<style')).toBeGreaterThan(html.indexOf('rel="stylesheet"'));
    expect(html).not.toMatch(/<[a-z][^>]*\sstyle=/i);
    // Anything that is not `#` and six lower-case hex digits writes no style element at all.
    for (const brand of ['#1E3A8A', '#1e3a8a;}body{display:none', 'red', '', null, undefined]) expect(withBrand(brand), String(brand)).not.toContain('<style');
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
