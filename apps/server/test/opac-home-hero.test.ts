import { HOME_CSS, OPAC_CSS } from '@altis/opac-theme';
import { OPAC_HOME_OVERLAY } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { Layout, toDocument, type HeroBand } from '../src/opac/layout.js';

// The OPAC home page's hero band as the frame draws it: the overlay over the photo as one class of the theme's steps
// (never lighter than the floor, whatever value reaches it), the library colour as a style element that carries the
// response's nonce and holds a colour rebuilt from six hex digits (anything else writes none), and the heading and lead
// marked with their language when they are the other language's. The theme styles every class the band can carry.

const NONCE = 'bm9uY2Utb2YtdGhlLXRlc3Q';

/** The document of the frame with `hero`. */
function render(hero: HeroBand): string {
  return toDocument(jsx(Layout as never, { locale: 'id', nonce: NONCE, title: 'Beranda', description: 'Katalog', libraryName: 'Perpustakaan', accent: 'teal', hero }));
}

const PHOTO = { src: '/files/01JZFILE000000000000000007', alt: 'Gedung', position: 40, width: 1600, height: 900 };

describe('the hero band', () => {
  it('writes the overlay as a step class, clamped to the floor and the top, rounded to a step', () => {
    for (const [overlay, cls] of [
      [60, 'hero-ov-60'],
      [75, 'hero-ov-75'],
      [40, 'hero-ov-60'],
      [99, 'hero-ov-80'],
      [67, 'hero-ov-65'],
      [Number.NaN, 'hero-ov-60'],
    ] as const) {
      expect(render({ title: 'Judul', lead: null, photo: { ...PHOTO, overlay } }), String(overlay)).toContain(`<header class="site-header hero-band hero-photo ${cls}">`);
    }
  });

  it('the theme has a class for every step, the floor as the plain band, and none lighter', () => {
    expect(HOME_CSS).toContain('.hero-photo::before{content:"";position:absolute;inset:0;z-index:-1;background:rgb(8 12 20/.6)}');
    for (let p = OPAC_HOME_OVERLAY.min; p <= OPAC_HOME_OVERLAY.max; p += OPAC_HOME_OVERLAY.step) {
      expect(HOME_CSS).toContain(`.hero-ov-${p}::before{background:rgb(8 12 20/.${p})}`);
    }
    expect([...HOME_CSS.matchAll(/\.hero-ov-(\d+)/g)].map((m) => Number(m[1]))).toEqual([60, 65, 70, 75, 80]);
    expect(OPAC_CSS).toContain(HOME_CSS);
    for (const cls of ['subject-pills', 'pill-count', 'card-status', 'status-muted', 'class-ranking', 'class-place', 'class-label', 'class-counts']) {
      expect(HOME_CSS, cls).toContain(`.${cls}`);
    }
    expect(HOME_CSS).toContain('.hours .today th,.hours .today td{font-weight:700}');
  });

  it('the library colour: a style element with the nonce and the colour rebuilt from its digits; anything else none', () => {
    const html = render({ title: 'Judul', lead: null, photo: null, brand: '#1e3a8a' });
    expect(html).toContain(`<style nonce="${NONCE}">.hero-band{--hero-bg:#1e3a8a}</style>`);
    expect(html).not.toContain('style=');
    for (const brand of ['#1E3A8A', '#1e3a8a;}body{display:none', 'red', '', null, undefined]) {
      expect(render({ title: 'Judul', lead: null, photo: null, brand }), String(brand)).not.toContain('<style');
    }
  });

  it('a heading and lead of the other language carry its lang', () => {
    const html = render({ title: 'Reading room', titleLang: 'en', lead: 'Find a book.', leadLang: 'en', photo: null });
    expect(html).toContain('<h1 lang="en">Reading room</h1>');
    expect(html).toContain('<p class="hero-lead" lang="en">Find a book.</p>');
    const own = render({ title: 'Ruang baca', lead: 'Cari buku.', photo: null });
    expect(own).toContain('<h1>Ruang baca</h1>');
    expect(own).toContain('<p class="hero-lead">Cari buku.</p>');
  });
});
