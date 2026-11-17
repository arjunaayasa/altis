import { COMMUNITY_SOURCE_URL } from '@altis/shared';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { opacText } from '../src/opac/catalog/messages.js';
import { siteFooter, siteInfo, siteMenu } from '../src/opac/catalog/page.js';
import { dueText, shelfStatusText } from '../src/opac/catalog/shelf-status.js';
import { Layout, toDocument, type PageFrame } from '../src/opac/layout.js';

// The library's identity on every public page: its logo beside its name in the header and the footer (none: the name
// alone, never a placeholder), the telephone number and e-mail address it publishes as `tel:` and `mailto:` links in
// the footer (none: left out), the footer's line with the year and the library's name, and what a card says of a
// title's copies in each state.

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
  };
  return toDocument(jsx(Layout as never, { locale: 'id', nonce: 'n', title: 'T', description: 'D', libraryName: 'Perpustakaan <SMA>', accent: 'blue', frame }));
}

const footerOf = (html: string): string => /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html)![1]!;
const headerOf = (html: string): string => /<header[^>]*>([\s\S]*?)<\/header>/.exec(html)![1]!;

describe('the logo', () => {
  it('stands before the library name in the header and in the footer, with its alternative text', () => {
    const html = page(HOME, null);
    const img = `<img class="brand-logo" src="/files/${LOGO}" alt="${esc('Logo <perpustakaan>')}" height="40" decoding="async"/>`;
    expect(headerOf(html)).toContain(`<a class="brand brand-with-logo" href="/">${img}<span class="brand-name">Perpustakaan &lt;SMA&gt;</span></a>`);
    // The footer's first block: the logo and the name, even without an address.
    expect(footerOf(html)).toContain(`<div class="foot-block"><img class="foot-logo" src="/files/${LOGO}" alt="${esc('Logo <perpustakaan>')}" height="40" decoding="async"/><h2>Perpustakaan &lt;SMA&gt;</h2>`);
  });

  it('none: the name alone as before, no image and no placeholder anywhere', () => {
    const html = page(OPAC_HOME_DEFAULT, null);
    expect(headerOf(html)).toContain('<a class="brand" href="/">Perpustakaan &lt;SMA&gt;</a>');
    expect(html).not.toContain('brand-logo');
    expect(html).not.toContain('foot-logo');
    expect(html).not.toContain('<img');
    // Without an address, a contact or a logo the footer has no block for the library itself.
    expect(footerOf(html)).not.toContain('<h2>Perpustakaan &lt;SMA&gt;</h2>');
  });
});

describe('the public contact', () => {
  it('the telephone number and the e-mail address in the footer as tel: and mailto: links, each with its word', () => {
    const footer = footerOf(page(HOME, 'Jl. Kenari 12'));
    expect(footer).toContain('<p class="foot-address">Jl. Kenari 12</p>');
    expect(footer).toContain(
      `<p class="foot-contact"><span>${opacText('id', 'shell.contact.phone')} <a href="tel:0215550101">(021) 555-0101</a></span>` +
        `<span>${opacText('id', 'shell.contact.email')} <a href="mailto:pustaka@sekolah.example">pustaka@sekolah.example</a></span></p>`,
    );
    // The contact alone gives the menu its "Kontak" (the visit block shows it).
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
    const line = /<div class="foot-bottom">([\s\S]*)<\/div>/.exec(footer)![1]!;
    expect(line.startsWith(
      `<p><span>© 2031 Perpustakaan &lt;SMA&gt;</span><span>${esc(opacText('id', 'shell.footer.powered'))}</span><a href="${COMMUNITY_SOURCE_URL}" rel="noopener">${esc(opacText('id', 'shell.footer.source'))}</a></p><p><a href="/admin/login">`,
    )).toBe(true);
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
