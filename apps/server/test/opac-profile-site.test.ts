import { OPAC_CSS } from '@altis/opac-theme';
import { OPAC_HOME_DEFAULT, OPAC_HOME_PHOTO_SIZE, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { SITE_IDENTITY_DEFAULT, type SiteIdentity } from '@altis/shared/api/site-identity';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { opacText } from '../src/opac/catalog/messages.js';
import { hasProfile, isoWeekday, siteLogo, todayHours } from '../src/opac/catalog/page.js';
import { newsCategoryOf, newsListPath } from '../src/opac/catalog/views/news-list.js';
import { galleryView, profileView, ruleText } from '../src/opac/catalog/views/profile.js';
import { Layout, NO_ICON, PageHead, toDocument, type PageFrame, type SiteLogo } from '../src/opac/layout.js';

// The frame of the library's site as its pure parts draw it, without a database: the logo in the header and the footer
// (a `<picture>` that picks the logo for dark backgrounds, a white plate under a logo that has none, the site's name as
// text without a logo), the site icon links, the strip above the header (today's hours, the language names), a page's
// head with its breadcrumb, and the views of the profile and the gallery. The pages through the app, with their
// settings and their news, are db/opac-profile-site.test.ts.

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

const render = (el: unknown): string => String((el as { toString(): string }).toString());

const NAME = 'Pustaka <Lembah> Hijau';
const LOGO = '/files/01JZFXQ0000000000000000001';
const LOGO_DARK = '/files/01JZFXQ0000000000000000002';

const FRAME: PageFrame = {
  homeHref: '/',
  langHrefs: { id: '/x?lang=id', en: '/x?lang=en' },
  nav: [
    { href: '/', label: 'Beranda' },
    { href: '/profil', label: 'Profil', current: true },
  ],
  search: null,
  footer: { address: null, hours: [], links: [{ href: '/cari', label: 'Katalog' }], member: [{ href: '/akun', label: 'Akun anggota' }] },
};

/** The page drawn with `frame` (none: a bare page). */
function page(frame: PageFrame | undefined, locale: 'id' | 'en' = 'id'): string {
  return toDocument(jsx(Layout as never, { locale, nonce: 'n', title: 'T', description: 'D', libraryName: NAME, accent: 'blue', frame }));
}

const headerOf = (html: string): string => /<header class="site-header">([\s\S]*?)<\/header>/.exec(html)![1]!;
const footerOf = (html: string): string => /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html)![1]!;
const stripOf = (html: string): string => /<div class="topstrip">([\s\S]*?)<header/.exec(html)![1]!;

describe('the logo in the header and the footer', () => {
  const withLogo = (logo: SiteLogo | null): string => page({ ...FRAME, logo });

  it('a logo and one for dark backgrounds: a <picture> that picks the dark one in the dark scheme; the footer, always dark, shows the dark one', () => {
    const html = withLogo({ src: LOGO, alt: 'Logo "Lembah Hijau"', dark: LOGO_DARK });
    const alt = esc('Logo "Lembah Hijau"');
    expect(headerOf(html)).toContain(
      `<a class="sitelogo" href="/"><picture><source srcset="${LOGO_DARK}" media="(prefers-color-scheme: dark)"/><img src="${LOGO}" alt="${alt}" height="40" decoding="async"/></picture></a>`,
    );
    expect(footerOf(html)).toContain(`<a class="sitelogo" href="/"><img src="${LOGO_DARK}" alt="${alt}" height="36" decoding="async"/></a>`);
    // Neither needs the white plate, and the footer does not load the logo for light backgrounds.
    expect(html).not.toContain('logo-plate');
    expect(footerOf(html)).not.toContain(LOGO);
    expect(footerOf(html)).not.toContain('<picture');
  });

  it('a logo without one for dark backgrounds: on a white plate where the background is dark, which the footer always is', () => {
    for (const dark of [null, undefined]) {
      const html = withLogo({ src: LOGO, alt: 'Logo', dark });
      expect(headerOf(html)).toContain(`<a class="sitelogo" href="/"><img class="logo-plate" src="${LOGO}" alt="Logo" height="40" decoding="async"/></a>`);
      expect(footerOf(html)).toContain(`<a class="sitelogo" href="/"><img class="logo-plate logo-plate-on" src="${LOGO}" alt="Logo" height="36" decoding="async"/></a>`);
      expect(html).not.toContain('<picture');
      expect(html).not.toContain('<source');
    }
    // The plate is white in the dark scheme only; the footer's is white in both.
    expect(OPAC_CSS).toMatch(/@media \(prefers-color-scheme:dark\)\{\.logo-plate\{background:#fff;/);
    expect(OPAC_CSS).toMatch(/\.logo-plate-on\{background:#fff;/);
    expect(OPAC_CSS.split('\n').filter((line) => line.startsWith('.logo-plate{'))).toEqual([]);
  });

  it("no logo: the site's name as text, linking home; no image and no placeholder in the header or the footer", () => {
    for (const html of [withLogo(null), page(FRAME)]) {
      const name = `<a class="sitelogo" href="/"><span class="sitename">${esc(NAME)}</span></a>`;
      expect(headerOf(html)).toContain(name);
      expect(footerOf(html)).toContain(name);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<picture');
    }
  });

  it('showName: the name beside the logo, in the header and in the footer; otherwise the logo alone, named by its alternative text', () => {
    const beside = withLogo({ src: LOGO, alt: 'Logo', dark: LOGO_DARK, showName: true });
    expect(headerOf(beside)).toContain(`decoding="async"/></picture><span class="sitename">${esc(NAME)}</span></a>`);
    expect(footerOf(beside)).toContain(`<img src="${LOGO_DARK}" alt="Logo" height="36" decoding="async"/><span class="sitename">${esc(NAME)}</span></a>`);
    const plate = withLogo({ src: LOGO, alt: 'Logo', showName: true });
    expect(headerOf(plate)).toContain(`<img class="logo-plate" src="${LOGO}" alt="Logo" height="40" decoding="async"/><span class="sitename">${esc(NAME)}</span></a>`);
    for (const showName of [false, undefined]) {
      const alone = withLogo({ src: LOGO, alt: 'Logo', showName });
      expect(alone).not.toContain('class="sitename"');
      // The link still has a name: the logo's alternative text is never empty here.
      expect(headerOf(alone)).toMatch(/<a class="sitelogo" href="\/"><img [^>]*alt="Logo"/);
    }
  });

  it('the home link keeps the page language, in the header and in the footer', () => {
    const html = page({ ...FRAME, homeHref: '/?lang=en', logo: { src: LOGO, alt: 'Logo' } }, 'en');
    expect(html.match(/<a class="sitelogo" href="\/\?lang=en">/g)).toHaveLength(2);
  });

  it('siteLogo: the saved identity\'s logo with its dark one and whether the name stands beside it; a blank alternative text is the site\'s name', () => {
    const identity: SiteIdentity = {
      ...SITE_IDENTITY_DEFAULT,
      logo: { fileId: '01JZFXQ0000000000000000001', alt: '' },
      logoDark: { fileId: '01JZFXQ0000000000000000002' },
      showNameBesideLogo: false,
    };
    expect(siteLogo(identity, OPAC_HOME_DEFAULT, 'Perpus')).toEqual({ src: LOGO, alt: 'Perpus', dark: LOGO_DARK, showName: false });
    expect(siteLogo({ ...identity, logoDark: null, name: 'Pustaka', showNameBesideLogo: true }, OPAC_HOME_DEFAULT, 'Perpus')).toEqual({ src: LOGO, alt: 'Pustaka', dark: null, showName: true });
    expect(siteLogo({ ...identity, logo: null }, OPAC_HOME_DEFAULT, 'Perpus')).toBeNull();
    expect(siteLogo(null, OPAC_HOME_DEFAULT, 'Perpus')).toBeNull();
  });
});

describe('the site icon', () => {
  it('a page of the site links the icon in three sizes; a bare page names the empty icon and none of them', () => {
    const html = page(FRAME);
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/site-icon/32.png"/>');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="192x192" href="/site-icon/192.png"/>');
    expect(html).toContain('<link rel="apple-touch-icon" href="/site-icon/180.png"/>');
    expect([...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/site-icon/32.png', '/site-icon/192.png', '/site-icon/180.png']);
    const bare = page(undefined);
    expect([...bare.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]*)"/g)].map((m) => m[1])).toEqual([NO_ICON]);
    expect(bare).not.toContain('/site-icon/');
  });
});

describe('the strip above the header', () => {
  it("today's hours in words beside a dot that is only decoration; closed is said, not only shown", () => {
    const open = stripOf(page({ ...FRAME, today: { open: true, time: '07.00–15.00' } }));
    expect(open).toContain('<span class="top-today"><span class="open-dot" aria-hidden="true"></span>Buka hari ini 07.00–15.00</span>');
    const closed = stripOf(page({ ...FRAME, today: { open: false, time: '' } }));
    expect(closed).toContain('<span class="top-today"><span class="open-dot open-dot-off" aria-hidden="true"></span>Tutup hari ini</span>');
    expect(stripOf(page({ ...FRAME, today: { open: true, time: '08.00–12.00' } }, 'en'))).toContain('Open today 08.00–12.00');
    expect(stripOf(page({ ...FRAME, today: { open: false, time: '' } }, 'en'))).toContain('Closed today');
    // Not known: nothing is said.
    for (const today of [null, undefined]) expect(stripOf(page({ ...FRAME, today }))).not.toContain('top-today');
  });

  it('the language switch names each language in that language, marks the page\'s, and stands on a bare page too', () => {
    for (const locale of ['id', 'en'] as const) {
      const strip = stripOf(page(FRAME, locale));
      const nav = /<nav class="lang" aria-label="[^"]+">([\s\S]*?)<\/nav>/.exec(strip)![1]!;
      expect(nav).toBe(
        `<a href="/x?lang=id" hreflang="id" lang="id"${locale === 'id' ? ' aria-current="true"' : ''}>Indonesia</a>` +
          `<a href="/x?lang=en" hreflang="en" lang="en"${locale === 'en' ? ' aria-current="true"' : ''}>English</a>`,
      );
    }
    expect(stripOf(page(undefined))).toContain('<a href="?lang=en" hreflang="en" lang="en">English</a>');
  });

  it('todayHours: the hours of the rows that cover the weekday, joined; closed on a closed day or a weekday no row covers; null without hours', () => {
    const hours: OpacHomeContent['hours'] = [
      { days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] },
      { days: 'Jumat sore', time: '16.00–18.00', weekdays: [5] },
      { days: 'Sabtu', time: '08.00–12.00', weekdays: [6] },
    ];
    // 2026-11-16 is a Monday.
    expect(isoWeekday('2026-11-16')).toBe(1);
    expect(isoWeekday('2026-11-22')).toBe(7);
    expect(todayHours(hours, '2026-11-16', false)).toEqual({ open: true, time: '07.00–15.00' });
    expect(todayHours(hours, '2026-11-20', false)).toEqual({ open: true, time: '07.00–15.00, 16.00–18.00' });
    expect(todayHours(hours, '2026-11-21', false)).toEqual({ open: true, time: '08.00–12.00' });
    expect(todayHours(hours, '2026-11-22', false)).toEqual({ open: false, time: '' });
    expect(todayHours(hours, '2026-11-16', true)).toEqual({ open: false, time: '' });
    expect(todayHours([], '2026-11-16', false)).toBeNull();
    // A row that only says the library is closed (no digit in its time) is not an opening.
    expect(todayHours([{ days: 'Minggu', time: 'Tutup', weekdays: [7] }], '2026-11-22', false)).toEqual({ open: false, time: '' });
  });
});

describe('the menu', () => {
  it('marks the current entry for a screen reader, in the header and in the phone menu', () => {
    const html = page(FRAME);
    const header = headerOf(html);
    expect(header).toContain('<a href="/">Beranda</a><a href="/profil" aria-current="page">Profil</a></nav>');
    expect(header.match(/aria-current="page"/g)).toHaveLength(2);
    // Two navigation landmarks with different names.
    const labels = [...header.matchAll(/<nav[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(labels).toEqual([opacText('id', 'shell.nav.label'), opacText('id', 'shell.nav.label_mobile')]);
    expect(new Set(labels).size).toBe(2);
  });
});

describe("a page's head", () => {
  it('the breadcrumb as an ordered list in a named landmark, the last step the page itself; then the heading and its lead', () => {
    const html = render(
      jsx(PageHead as never, {
        locale: 'id',
        crumbs: [{ label: 'Beranda', href: '/' }, { label: 'Berita & agenda', href: '/berita' }, { label: 'Bedah <buku>', lang: 'en' }],
        title: 'Bedah <buku>',
        lead: 'Kabar & kegiatan.',
        titleLang: 'en',
      }),
    );
    expect(html).toMatch(new RegExp(`^<div class="pagehead"><div class="wrap"><nav class="crumbs" aria-label="${opacText('id', 'shell.crumbs.label')}"><ol>`));
    const steps = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<svg[\s\S]*?<\/svg>/g, '[>]'));
    expect(steps).toEqual(['<a href="/">Beranda</a>', '[>]<a href="/berita">Berita &amp; agenda</a>', '[>]<span aria-current="page">Bedah &lt;buku&gt;</span>']);
    expect(html).toContain('<li lang="en">');
    // The separators are drawings, hidden from a screen reader.
    for (const svg of html.match(/<svg[^>]*>/g)!) expect(svg).toContain('aria-hidden="true"');
    expect(html).toContain('<h1 lang="en">Bedah &lt;buku&gt;</h1><p class="pagehead-lead">Kabar &amp; kegiatan.</p>');
  });

  it('without a title (the heading stands in the content): the breadcrumb alone, no <h1> of its own', () => {
    const html = render(jsx(PageHead as never, { locale: 'en', crumbs: [{ label: 'Home', href: '/?lang=en' }, { label: 'Rules' }] }));
    expect(html).toMatch(new RegExp(`^<div class="pagehead pagehead-slim"><div class="wrap"><nav class="crumbs" aria-label="${opacText('en', 'shell.crumbs.label')}">`));
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('pagehead-lead');
  });

  it('stands inside <main>, above the content, which keeps its column unless the page is made of bands', () => {
    const head = jsx(PageHead as never, { locale: 'id', crumbs: [{ label: 'Beranda' }], title: 'Judul' });
    const props = { locale: 'id', nonce: 'n', title: 'T', description: 'D', libraryName: NAME, accent: 'blue', frame: FRAME };
    const html = toDocument(jsx(Layout as never, { ...props, pageHead: head }, jsx('p', null, 'isi')));
    expect(html).toContain('<main id="isi" tabindex="-1"><div class="pagehead">');
    expect(html).toContain('</div></div><div class="wrap page"><p>isi</p></div></main>');
    const bleed = toDocument(jsx(Layout as never, { ...props, bleed: true }, jsx('p', null, 'isi')));
    expect(bleed).toContain('<main id="isi" tabindex="-1"><p>isi</p></main>');
  });
});

describe('the news list', () => {
  it('newsListPath: the kind before the page, page 1 without a number; newsCategoryOf: one of the four kinds or nothing', () => {
    expect(newsListPath(1)).toBe('/berita');
    expect(newsListPath(3)).toBe('/berita?hal=3');
    expect(newsListPath(1, 'agenda')).toBe('/berita?kategori=agenda');
    expect(newsListPath(2, 'collection')).toBe('/berita?kategori=collection&hal=2');
    for (const kind of ['agenda', 'collection', 'announcement', 'activity']) expect(newsCategoryOf(kind)).toBe(kind);
    for (const other of [undefined, '', 'AGENDA', 'agenda ', 'news', '<script>', 'constructor', '__proto__']) expect(newsCategoryOf(other)).toBeNull();
  });
});

const NONE = { id: null, en: null };
const PHOTO = (n: number): string => `01JZFXQ00000000000000000B${n}`;

const PROFILE: OpacHomeContent = {
  ...OPAC_HOME_DEFAULT,
  about: { ...OPAC_HOME_DEFAULT.about, history: { id: 'Berdiri pada 1987.\n\nPindah <gedung> pada 2004.', en: null } },
  timeline: [{ year: 1987, text: { id: 'Didirikan', en: 'Founded' } }],
  vision: { id: 'Semua orang membaca.', en: null },
  mission: [{ id: 'Merawat koleksi', en: null }],
  staff: [
    { name: 'Larasati Wibowo', role: { id: 'Kepala perpustakaan', en: 'Head librarian' } },
    { name: 'Bagas Pratama', role: { id: null, en: 'Cataloguer' } },
    { name: 'Sekar Ayu', role: NONE },
  ],
  facilities: [{ fileId: PHOTO(1), alt: 'Ruang baca', caption: 'Ruang baca lantai 1' }],
};

describe('the profile view', () => {
  const view = (home: OpacHomeContent, o: { locale?: 'id' | 'en'; lang?: 'id' | 'en' | null; hours?: boolean } = {}): string =>
    render(profileView({ home, rules: [{ name: 'Siswa', limit: 3, days: 7 }], locale: o.locale ?? 'id', lang: o.lang ?? null, contentLang: undefined, hours: o.hours ?? false }));

  const ids = (html: string): string[] => [...html.matchAll(/<section class="psec" id="([^"]+)" aria-labelledby="([^"]+)">/g)].map((m) => m[1]!);
  const navHrefs = (html: string): string[] => [...(/<nav class="sidenav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!).matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);

  it('each section only with content; the navigation of the page links exactly the sections it has, each named by its heading', () => {
    const full = view(PROFILE);
    expect(ids(full)).toEqual(['sejarah', 'visi', 'pengelola', 'fasilitas', 'anggota']);
    expect(navHrefs(full)).toEqual(ids(full));
    for (const [, id, labelledBy] of full.matchAll(/<section class="psec" id="([^"]+)" aria-labelledby="([^"]+)">/g)) {
      expect(labelledBy).toBe(`${id}-judul`);
      expect(full).toContain(`<h2 id="${labelledBy}">`);
    }
    expect(full).toContain(`<nav class="sidenav" aria-label="${opacText('id', 'pages.profile.nav')}">`);
    // How to become a member is always there; the rest only with content.
    const bare = view(OPAC_HOME_DEFAULT);
    expect(ids(bare)).toEqual(['anggota']);
    expect(navHrefs(bare)).toEqual(['anggota']);
    // The profile is for people who read: no script, no form, no inline style.
    expect(full).not.toMatch(/<script|<form|<input|\sstyle=|\son[a-z]+=/);
  });

  it('the history in paragraphs with its timeline, the vision as a quotation, the mission as a list; a section of one of the two is named for it', () => {
    const html = view(PROFILE);
    expect(html).toContain('<p>Berdiri pada 1987.</p><p>Pindah &lt;gedung&gt; pada 2004.</p>');
    expect(html).toContain('<ol class="timeline"><li><span class="timeline-year">1987</span><p>Didirikan</p></li></ol>');
    expect(html).toContain(`<h2 id="visi-judul">${opacText('id', 'pages.profile.vision')}</h2><blockquote class="vision">Semua orang membaca.</blockquote><ol class="mission"><li><span>Merawat koleksi</span></li></ol>`);
    const visionOnly = view({ ...PROFILE, mission: [] });
    expect(visionOnly).toContain(`<h2 id="visi-judul">${opacText('id', 'pages.profile.vision_only')}</h2>`);
    expect(visionOnly).toContain(`<a href="#visi">${opacText('id', 'pages.profile.vision_only')}</a>`);
    expect(visionOnly).not.toContain('class="mission"');
    const missionOnly = view({ ...PROFILE, vision: NONE });
    expect(missionOnly).toContain(`<h2 id="visi-judul">${opacText('id', 'pages.profile.mission_only')}</h2>`);
    expect(missionOnly).not.toContain('<blockquote');
    // Without a history of its own the "about" text is the history.
    const about = view({ ...OPAC_HOME_DEFAULT, about: { ...OPAC_HOME_DEFAULT.about, text: { id: 'Perpustakaan sekolah.', en: null } } });
    expect(about).toContain(`<h2 id="sejarah-judul">${opacText('id', 'pages.profile.history')}</h2><p>Perpustakaan sekolah.</p>`);
  });

  it("the people: each name with its role in the page's language, else the other language's marked with its lang, else the name alone", () => {
    const id = view(PROFILE);
    expect(id).toContain(
      '<ul class="people"><li><b>Larasati Wibowo</b><span>Kepala perpustakaan</span></li><li><b>Bagas Pratama</b><span lang="en">Cataloguer</span></li><li><b>Sekar Ayu</b></li></ul>',
    );
    const en = view(PROFILE, { locale: 'en', lang: 'en' });
    expect(en).toContain('<li><b>Larasati Wibowo</b><span>Head librarian</span></li><li><b>Bagas Pratama</b><span>Cataloguer</span></li>');
    // The texts written in Indonesian only are marked so on the English page.
    expect(en).toContain('<p lang="id">Berdiri pada 1987.</p>');
    expect(en).toContain('<blockquote class="vision" lang="id">');
    expect(en).toContain('<li lang="id"><span>Merawat koleksi</span></li>');
    expect(en).toContain('<span class="timeline-year">1987</span><p>Founded</p>');
    expect(en).toContain(`<h2 id="pengelola-judul">${opacText('en', 'pages.profile.staff')}</h2>`);
  });

  it('the facilities as photos with their alternative text and caption; how to become a member with the loan rules; the links keep the language', () => {
    const html = view(PROFILE, { hours: true });
    const { width, height } = OPAC_HOME_PHOTO_SIZE;
    expect(html).toContain(
      `<ul class="facilities"><li><figure><img src="/files/${PHOTO(1)}" alt="Ruang baca" width="${width}" height="${height}" loading="lazy" decoding="async"/><figcaption>Ruang baca lantai 1</figcaption></figure></li></ul>`,
    );
    const join = /<section class="psec" id="anggota"[^>]*>([\s\S]*?)<\/section>/.exec(html)![1]!;
    expect(join).toContain('<ol class="steps"><li>');
    expect(join).toContain(`<table class="rules" aria-label="${opacText('id', 'pages.profile.rules')}">`);
    expect(join).toContain('<th scope="col">');
    expect(join).toContain('<tr><th scope="row">Siswa</th><td>3 eksemplar, 7 hari</td></tr>');
    expect([...join.matchAll(/<a class="btn btn-outline" href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/#kunjungi', '/akun']);
    const en = view(PROFILE, { locale: 'en', lang: 'en', hours: true });
    expect([...en.matchAll(/<a class="btn btn-outline" href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/?lang=en#kunjungi', '/akun?lang=en']);
    // Without opening hours on the home page there is no link to them; without rules no table.
    expect(view(PROFILE)).not.toContain('#kunjungi');
    expect(render(profileView({ home: PROFILE, rules: [], locale: 'id', lang: null, contentLang: undefined, hours: false }))).not.toContain('<table');
  });

  it('ruleText: the limit and the loan period in words', () => {
    expect(ruleText({ name: 'Siswa', limit: 3, days: 7 }, 'id')).toBe('3 eksemplar, 7 hari');
    expect(ruleText({ name: 'Guru', limit: null, days: 14 }, 'id')).toBe(`${opacText('id', 'home.rules.no_limit')}, 14 hari`);
    expect(ruleText({ name: 'Tamu', limit: 1, days: 0 }, 'id')).toBe(`1 eksemplar, ${opacText('id', 'home.rules.same_day')}`);
    expect(ruleText({ name: 'Student', limit: 1, days: 1 }, 'en')).toBe(
      `${opacText('en', 'home.rules.items_one', { count: '1' })}, ${opacText('en', 'home.rules.days_one', { count: '1' })}`,
    );
  });

  it('hasProfile: something of the profile is filled in; services, hours, the gallery and the contact are not the profile', () => {
    expect(hasProfile(OPAC_HOME_DEFAULT)).toBe(false);
    expect(hasProfile(PROFILE)).toBe(true);
    const base = OPAC_HOME_DEFAULT;
    const filled: OpacHomeContent[] = [
      { ...base, about: { ...base.about, text: { id: null, en: 'A school library.' } } },
      { ...base, about: { ...base.about, history: { id: 'Berdiri 1987.', en: null } } },
      { ...base, about: { ...base.about, founded: 1987 } },
      { ...base, about: { ...base.about, librarians: 2 } },
      { ...base, about: { ...base.about, photo: { fileId: PHOTO(1), alt: 'Gedung', caption: null } } },
      { ...base, vision: { id: 'Visi', en: null } },
      { ...base, timeline: [{ year: 1987, text: { id: 'Didirikan', en: null } }] },
      { ...base, mission: [{ id: 'Misi', en: null }] },
      { ...base, staff: [{ name: 'Larasati Wibowo', role: NONE }] },
      { ...base, facilities: [{ fileId: PHOTO(1), alt: 'Ruang baca', caption: null }] },
    ];
    for (const [i, home] of filled.entries()) expect(hasProfile(home), String(i)).toBe(true);
    const other: OpacHomeContent = {
      ...base,
      about: { ...base.about, text: { id: '  ', en: '' } },
      services: [{ title: 'Peminjaman', text: null }],
      hours: [{ days: 'Senin', time: '07.00–15.00', weekdays: [1] }],
      gallery: [{ fileId: PHOTO(2), alt: 'Ruang baca', caption: NONE }],
      contact: { phone: '(021) 555-0101', email: null },
    };
    expect(hasProfile(other)).toBe(false);
  });
});

describe('the gallery view', () => {
  it("every photo with its alternative text and its caption in the page's language (else the other one's, marked); a photo without a caption has no <figcaption>", () => {
    const home: OpacHomeContent = {
      ...OPAC_HOME_DEFAULT,
      gallery: [
        { fileId: PHOTO(1), alt: 'Ruang <baca>', caption: { id: 'Ruang baca', en: 'Reading room' } },
        { fileId: PHOTO(2), alt: 'Rak koleksi', caption: { id: 'Rak koleksi baru', en: null } },
        { fileId: PHOTO(3), alt: 'Bedah buku', caption: NONE },
      ],
    };
    const { width, height } = OPAC_HOME_PHOTO_SIZE;
    const img = (n: number, alt: string): string => `<img src="/files/${PHOTO(n)}" alt="${alt}" width="${width}" height="${height}" loading="lazy" decoding="async"/>`;
    expect(render(galleryView({ home, locale: 'id' }))).toBe(
      '<ul class="gallery gallery-page">' +
        `<li><figure>${img(1, 'Ruang &lt;baca&gt;')}<figcaption>Ruang baca</figcaption></figure></li>` +
        `<li><figure>${img(2, 'Rak koleksi')}<figcaption>Rak koleksi baru</figcaption></figure></li>` +
        `<li><figure>${img(3, 'Bedah buku')}</figure></li>` +
        '</ul>',
    );
    const en = render(galleryView({ home, locale: 'en' }));
    expect(en).toContain(`<li><figure>${img(1, 'Ruang &lt;baca&gt;')}<figcaption>Reading room</figcaption></figure></li>`);
    expect(en).toContain(`<li><figure lang="id">${img(2, 'Rak koleksi')}<figcaption>Rak koleksi baru</figcaption></figure></li>`);
    expect(render(galleryView({ home: OPAC_HOME_DEFAULT, locale: 'id' }))).toBe('<ul class="gallery gallery-page"></ul>');
  });
});
