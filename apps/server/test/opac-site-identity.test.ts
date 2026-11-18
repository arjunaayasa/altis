import { COMMUNITY_SOURCE_URL, t } from '@altis/shared';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { opacText } from '../src/opac/catalog/messages.js';
import { siteFooter, siteInfo, siteMenu } from '../src/opac/catalog/page.js';
import { dueText, shelfStatusText } from '../src/opac/catalog/shelf-status.js';
import { Layout, toDocument, type PageFrame } from '../src/opac/layout.js';

// The library's identity on every public page: its logo in the header and the footer (none: the name as text, never a
// placeholder), the telephone number and e-mail address it publishes as `tel:` and `mailto:` links in the strip above
// the header and in the footer (none: left out), the footer's line with the year and the library's name, and what a
// card says of a title's copies in each state.

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

const LOGO = '01JZFXQ0000000000000000009';

const HOME: OpacHomeContent = {
  ...OPAC_HOME_DEFAULT,
  logo: { fileId: LOGO, alt: 'Logo <perpustakaan>' },
  contact: { phone: '(021) 555-0101', email: 'pustaka@sekolah.example' },
};

/** The page drawn with the frame of `home`, `address` and `year`. */
function page(home: OpacHomeContent, address: string | null, year = 2031): string {
  const site = siteInfo(home, address, false);
  const frame: PageFrame = {
    homeHref: '/',
    langHrefs: { id: '/x?lang=id', en: '/x?lang=en' },
    nav: siteMenu('id', site, [], null, '/'),
    search: null,
    footer: siteFooter('id', site, [], null),
    logo: site.logo,
    year,
    phone: site.phone,
    email: site.email,
  };
  return toDocument(jsx(Layout as never, { locale: 'id', nonce: 'n', title: 'T', description: 'D', libraryName: 'Perpustakaan <SMA>', accent: 'blue', frame }));
}

const footerOf = (html: string): string => /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html)![1]!;
const headerOf = (html: string): string => /<header[^>]*>([\s\S]*?)<\/header>/.exec(html)![1]!;

describe('the logo', () => {
  it('links home from the header and from the footer, with its alternative text; it stands for the name', () => {
    const html = page(HOME, null);
    const alt = esc('Logo <perpustakaan>');
    // A logo without one for dark backgrounds: on a white plate where the background is dark (always, in the footer).
    expect(headerOf(html)).toContain(`<a class="sitelogo" href="/"><img class="logo-plate" src="/files/${LOGO}" alt="${alt}" height="40" decoding="async"/></a>`);
    // The footer's first block: the logo, even without an address.
    expect(footerOf(html)).toContain(
      `<div class="foot-block foot-about"><a class="sitelogo" href="/"><img class="logo-plate logo-plate-on" src="/files/${LOGO}" alt="${alt}" height="36" decoding="async"/></a>`,
    );
    // The logo names the site: the name is not printed beside it unless the identity asks for it.
    expect(html).not.toContain('class="sitename"');
  });

  it('none: the name alone as text, no image and no placeholder anywhere', () => {
    const html = page(OPAC_HOME_DEFAULT, null);
    const name = '<a class="sitelogo" href="/"><span class="sitename">Perpustakaan &lt;SMA&gt;</span></a>';
    expect(headerOf(html)).toContain(name);
    expect(footerOf(html)).toContain(`<div class="foot-block foot-about">${name}</div>`);
    expect(html).not.toContain('logo-plate');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<picture');
  });
});

describe('the public contact', () => {
  it('the telephone number and the e-mail address as tel: and mailto: links: in the footer, and in the strip above the header, each named there', () => {
    const html = page(HOME, 'Jl. Kenari 12');
    const footer = footerOf(html);
    expect(footer).toContain('<p class="foot-address">Jl. Kenari 12</p>');
    expect(footer).toContain('<p class="foot-contact"><a href="tel:0215550101">(021) 555-0101</a><a href="mailto:pustaka@sekolah.example">pustaka@sekolah.example</a></p>');
    // In the strip each stands after an icon, so the link itself says what it is.
    const strip = /<div class="topstrip">([\s\S]*?)<header/.exec(html)![1]!;
    expect(strip).toContain(`<a href="tel:0215550101" aria-label="${opacText('id', 'shell.contact.phone')} (021) 555-0101">(021) 555-0101</a>`);
    expect(strip).toContain(`<a href="mailto:pustaka@sekolah.example" aria-label="${opacText('id', 'shell.contact.email')} pustaka@sekolah.example">pustaka@sekolah.example</a>`);
    expect([...strip.matchAll(/<svg class="ico"[^>]*>/g)].every((m) => m[0].includes('aria-hidden="true"'))).toBe(true);
    // The contact alone gives the menu its "Jam & lokasi" (the visit block shows it).
    expect(siteInfo({ ...OPAC_HOME_DEFAULT, contact: { phone: null, email: 'pustaka@sekolah.example' } }, null, false).contact).toBe(true);
  });

  it('either one alone; none: left out', () => {
    const phoneOnly = footerOf(page({ ...HOME, logo: null, contact: { phone: '+62 21 5550101', email: null } }, null));
    expect(phoneOnly).toContain('<a href="tel:+62215550101">+62 21 5550101</a>');
    expect(phoneOnly).not.toContain('mailto:');
    const none = page({ ...HOME, contact: { phone: null, email: null } }, 'Jl. Kenari 12');
    expect(none).not.toContain('foot-contact');
    expect(none).not.toContain('tel:');
    expect(none).not.toContain('mailto:');
    expect(siteInfo({ ...OPAC_HOME_DEFAULT, blocks: { ...OPAC_HOME_DEFAULT.blocks, visit: false }, contact: { phone: '021 5550101', email: null } }, null, false).contact).toBe(false);
  });
});

describe("the footer's line", () => {
  it('the year and the library name, then the software, the source code and the staff sign-in', () => {
    const footer = footerOf(page(OPAC_HOME_DEFAULT, null, 2031));
    const line = /<div class="foot-bottom"><div class="wrap">([\s\S]*)<\/div><\/div>/.exec(footer)![1]!;
    expect(line).toBe(
      `<span>© 2031 Perpustakaan &lt;SMA&gt;</span><span>${esc(opacText('id', 'shell.footer.powered'))}</span>` +
        `<a href="${COMMUNITY_SOURCE_URL}" rel="noopener">${esc(opacText('id', 'shell.footer.source'))}</a>` +
        `<a class="foot-staff" href="/admin/login">${esc(t('id', 'opac.home.staff_login'))}</a>`,
    );
  });

  it('with news published the line links the news feed, between the source code and the staff sign-in', () => {
    const site = siteInfo(OPAC_HOME_DEFAULT, null, true);
    const frame: PageFrame = { homeHref: '/', langHrefs: { id: '/x?lang=id', en: '/x?lang=en' }, nav: [], search: null, footer: siteFooter('en', site, [], 'en'), year: 2031 };
    const footer = footerOf(toDocument(jsx(Layout as never, { locale: 'en', nonce: 'n', title: 'T', description: 'D', libraryName: 'P', accent: 'blue', frame })));
    expect(footer).toContain(
      `rel="noopener">${esc(opacText('en', 'shell.footer.source'))}</a><a href="/berita/rss?lang=en" type="application/rss+xml">${esc(opacText('en', 'shell.footer.feed'))}</a><a class="foot-staff"`,
    );
    expect(footerOf(page(OPAC_HOME_DEFAULT, null))).not.toContain('rss');
  });
});

describe('what a card says of the copies', () => {
  it('every state in words, in both languages; a due date without its year when it is this year', () => {
    expect(shelfStatusText({ kind: 'available', shelf: 2, total: 2 }, 'id', 2026)).toBe('Tersedia');
    expect(shelfStatusText({ kind: 'available', shelf: 1, total: 3 }, 'id', 2026)).toBe('Tersedia 1 dari 3');
    expect(shelfStatusText({ kind: 'available', shelf: 1, total: 3 }, 'en', 2026)).toBe('Available: 1 of 3');
    expect(shelfStatusText({ kind: 'on_loan', dueOn: '2026-11-21' }, 'id', 2026)).toBe('Dipinjam, kembali 21 Nov');
    expect(shelfStatusText({ kind: 'on_loan', dueOn: '2026-11-21' }, 'en', 2026)).toBe('On loan, due back 21 Nov');
    expect(shelfStatusText({ kind: 'on_loan', dueOn: '2027-01-04' }, 'id', 2026)).toBe('Dipinjam, kembali 4 Jan 2027');
    expect(shelfStatusText({ kind: 'library_use' }, 'id', 2026)).toBe('Hanya baca di tempat');
    expect(shelfStatusText({ kind: 'library_use' }, 'en', 2026)).toBe('Library use only');
    expect(shelfStatusText({ kind: 'unavailable' }, 'id', 2026)).toBe(opacText('id', 'search.card.off_shelf'));
    expect(dueText('not a date', 'id', 2026)).toBe('not a date');
  });
});
