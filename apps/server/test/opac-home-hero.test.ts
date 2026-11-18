import { HOME_CSS, OPAC_CSS } from '@altis/opac-theme';
import { OPAC_HOME_DEFAULT, OpacHomeContent, contrastWithWhite } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { heroSlideAt } from '../src/opac/catalog/home.js';
import { HERO_OVERLAY, Layout, toDocument, type HeroBand } from '../src/opac/layout.js';

// The OPAC home page's hero band as the frame draws it: the photo of the slide that shows now (the first that is on and
// within its days, by the library's calendar) under the one overlay that keeps white text readable over any photo, the
// library colour (of the header bar) as a style element that carries the
// response's nonce and holds a colour rebuilt from six hex digits (anything else writes none), and the heading and lead
// marked with their language when they are the other language's. The theme styles every class the band can carry.

const NONCE = 'bm9uY2Utb2YtdGhlLXRlc3Q';

/** The document of the frame with `hero`. */
function render(hero: HeroBand): string {
  return toDocument(jsx(Layout as never, { locale: 'id', nonce: NONCE, title: 'Beranda', description: 'Katalog', libraryName: 'Perpustakaan', accent: 'teal', hero }));
}

const PHOTO = { src: '/files/01JZFILE000000000000000007', alt: 'Gedung', position: 40, width: 1600, height: 900 };

describe('the hero band', () => {
  it('a photo sits under the one overlay, at its position; without a photo the band is the library colour', () => {
    const html = render({ title: 'Judul', lead: null, photo: PHOTO });
    expect(html).toContain(`<header class="site-header hero-band hero-photo hero-ov-${HERO_OVERLAY}">`);
    expect(html).toContain('<img class="hero-img hero-pos-40" src="/files/01JZFILE000000000000000007" alt="Gedung" width="1600" height="900" decoding="async"/>');
    expect(html.match(/hero-ov-/g)).toHaveLength(1);
    expect(render({ title: 'Judul', lead: null, photo: null })).toContain('<header class="site-header hero-band">');
  });

  it('the overlay keeps white text at 4.5:1 or more over a pure white photo, and the theme paints it so', () => {
    expect(HERO_OVERLAY).toBe(60);
    // A white pixel under the theme's overlay colour (8 12 20) at that darkness.
    const a = HERO_OVERLAY / 100;
    const under = [8, 12, 20].map((c) => 255 * (1 - a) + c * a) as [number, number, number];
    expect(contrastWithWhite(under)).toBeGreaterThanOrEqual(4.5);
    expect(HOME_CSS).toContain('.hero-photo::before{content:"";position:absolute;inset:0;z-index:-1;background:rgb(8 12 20/.6)}');
    expect(HOME_CSS).toContain(`.hero-ov-${HERO_OVERLAY}::before{background:rgb(8 12 20/.${HERO_OVERLAY})}`);
    // The theme has no step lighter than it.
    expect(Math.min(...[...HOME_CSS.matchAll(/\.hero-ov-(\d+)/g)].map((m) => Number(m[1])))).toBe(HERO_OVERLAY);
    expect(OPAC_CSS).toContain(HOME_CSS);
    for (const cls of ['subject-pills', 'pill-count', 'card-status', 'status-muted', 'class-ranking', 'class-place', 'class-label', 'class-counts']) {
      expect(HOME_CSS, cls).toContain(`.${cls}`);
    }
    expect(HOME_CSS).toContain('.hours .today th,.hours .today td{font-weight:700}');
  });

  it('the library colour: a style element with the nonce and the colour rebuilt from its digits; anything else none', () => {
    const html = render({ title: 'Judul', lead: null, photo: null, brand: '#1e3a8a' });
    expect(html).toContain(`<style nonce="${NONCE}">.site-header{--hero-bg:#1e3a8a}</style>`);
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

describe('the slide the band shows', () => {
  const NONE = { id: null, en: null };
  const slide = (id: string, n: number, over: Record<string, unknown> = {}) => ({
    id,
    fileId: `01JZFXQ00000000000000000A${n}`,
    alt: id,
    position: 50,
    note: NONE,
    title: NONE,
    subtitle: NONE,
    cta: null,
    active: true,
    from: null,
    until: null,
    ...over,
  });
  const home = OpacHomeContent.parse({
    ...OPAC_HOME_DEFAULT,
    hero: { slides: [slide('off', 1, { active: false }), slide('november', 2, { from: '2026-11-01', until: '2026-11-18' }), slide('later', 3, { from: '2026-11-19' }), slide('always', 4)] },
  });
  const at = (timeZone: string, iso: string) => heroSlideAt(home, timeZone, Date.parse(iso))?.id ?? null;

  it('is the first slide that is on and within its days, by the calendar of the library time zone', () => {
    expect(at('Asia/Jakarta', '2026-11-10T03:00:00Z')).toBe('november');
    // 23:59 on the 18th in Jakarta, then midnight: the slide ends with the library's day, seven hours before UTC's.
    expect(at('Asia/Jakarta', '2026-11-18T16:59:59Z')).toBe('november');
    expect(at('Asia/Jakarta', '2026-11-18T17:00:00Z')).toBe('later');
    expect(at('UTC', '2026-11-18T17:00:00Z')).toBe('november');
    expect(at('Asia/Jakarta', '2026-10-31T16:59:59Z')).toBe('always');
  });

  it('none when no slide shows; a time zone the setting got wrong is read as UTC, never an error page', () => {
    expect(heroSlideAt(OPAC_HOME_DEFAULT, 'Asia/Jakarta', 0)).toBeNull();
    const off = OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, hero: { slides: [slide('off', 1, { active: false }), slide('past', 2, { until: '2020-01-01' })] } });
    expect(heroSlideAt(off, 'Asia/Jakarta', Date.parse('2026-11-18T00:00:00Z'))).toBeNull();
    expect(at('Bukan/Zona', '2026-11-18T17:00:00Z')).toBe('november');
  });

  it('a hero saved as one photo is the slide shown, whenever', () => {
    const old = OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, hero: { fileId: '01JZFXQ00000000000000000A9', alt: 'Gedung', position: 40, overlay: 75 } });
    expect(heroSlideAt(old, 'Asia/Jakarta', 0)).toMatchObject({ fileId: '01JZFXQ00000000000000000A9', alt: 'Gedung', position: 40 });
  });
});
