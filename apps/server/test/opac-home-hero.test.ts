import { HOME_CSS, OPAC_CSS } from '@altis/opac-theme';
import { OPAC_HOME_DEFAULT, OPAC_HOME_HERO_SIZE, OpacHomeContent, OpacHomeTarget, type OpacHomeSlide } from '@altis/shared/api/opac-home';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { Hero, heroSlidesAt, slideTargetPath } from '../src/opac/catalog/home.js';
import { opacText } from '../src/opac/catalog/messages.js';
import { OPAC_SLIDER_FILE, OPAC_SLIDER_JS } from '../src/opac/slider.js';

// The OPAC home page's hero: the slides that show today in one stack, each a panel of the library colour with its text
// (the first slide's heading is the page's `<h1>`) and a photo beside it. It works without a script: every slide is in
// the markup, an indicator is a link to its slide, and the buttons only the script can serve are hidden until it runs.
// With one slide there are no controls and nothing calls itself a carousel; with none the page's heading stands on the
// panel alone. A slide's button leads to a path of this site made from the target's kind, never to a free URL. The
// slides of a day are those of the library's calendar day. The theme styles every class the hero can carry, clips the
// track (nothing scrolls sideways) and never lets a photo set the height.

const NONE: { id: string | null; en: string | null } = { id: null, en: null };

const slide = (id: string, n: number, over: Partial<OpacHomeSlide> = {}): OpacHomeSlide => ({
  id,
  fileId: `01JZFXQ00000000000000000A${n}`,
  alt: `Foto ${id}`,
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

const DEFAULTS: { libraryName: string; title: typeof NONE; welcome: typeof NONE } = { libraryName: 'Perpustakaan <SMA>', title: NONE, welcome: { id: 'Cari buku di katalog.', en: null } };

interface HeroOptions {
  autoplay?: boolean;
  intervalSec?: number;
  locale?: 'id' | 'en';
  lang?: 'id' | 'en' | null;
  defaults?: typeof DEFAULTS;
}

/** The markup of the hero with `slides`. */
function hero(slides: OpacHomeSlide[], o: HeroOptions = {}): string {
  const props = { slides, autoplay: o.autoplay ?? true, intervalSec: o.intervalSec ?? 7, defaults: o.defaults ?? DEFAULTS, locale: o.locale ?? 'id', lang: o.lang ?? null };
  return String(jsx(Hero as never, props));
}

const THREE = [
  slide('satu', 1, { title: { id: 'Ruang baca <baru>', en: null }, subtitle: { id: 'Buka setiap hari.', en: null }, note: { id: 'Pengumuman', en: null }, position: 40 }),
  slide('dua', 2, { title: { id: 'Bedah buku', en: null } }),
  slide('tiga', 3, { title: { id: 'Koleksi baru', en: null } }),
];

/** The start tags of `tag` in `html`. */
const tags = (html: string, tag: string): string[] => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((m) => m[0]);

describe('the hero with several slides', () => {
  const html = hero(THREE, { autoplay: false, intervalSec: 10 });
  const track = /<div class="hero-track"[^>]*>([\s\S]*)<\/div><div class="hero-ui">/.exec(html)![1]!;

  it('every slide is in the track, in order: the first with the <h1>, the others with an <h2>, each with its photo', () => {
    expect([...track.matchAll(/<div class="slide" id="(slide-\d)"/g)].map((m) => m[1])).toEqual(['slide-1', 'slide-2', 'slide-3']);
    expect([...html.matchAll(/<(h[1-6])[^>]*>([^<]*)<\/h[1-6]>/g)].map((m) => [m[1], m[2]])).toEqual([
      ['h1', 'Ruang baca &lt;baru&gt;'],
      ['h2', 'Bedah buku'],
      ['h2', 'Koleksi baru'],
    ]);
    const { width, height } = OPAC_HOME_HERO_SIZE;
    // The first photo is fetched at once; the others, which lie under it, only when the browser gets to them.
    expect(tags(track, 'img')).toEqual([
      `<img class="hero-pos-40" src="/files/01JZFXQ00000000000000000A1" alt="Foto satu" width="${width}" height="${height}" decoding="async"/>`,
      `<img class="hero-pos-50" src="/files/01JZFXQ00000000000000000A2" alt="Foto dua" width="${width}" height="${height}" loading="lazy" decoding="async"/>`,
      `<img class="hero-pos-50" src="/files/01JZFXQ00000000000000000A3" alt="Foto tiga" width="${width}" height="${height}" loading="lazy" decoding="async"/>`,
    ]);
    expect(track).toContain('<p class="slide-note">Pengumuman</p>');
    expect(track).toContain('<p class="slide-lead">Buka setiap hari.</p>');
    // A slide without a lead of its own takes the welcome text.
    expect(track.match(/<p class="slide-lead">Cari buku di katalog\.<\/p>/g)).toHaveLength(2);
  });

  it('the indicators are links to the slides, each named "Slide n dari N" for a screen reader and showing no number', () => {
    const dots = /<nav class="hero-dots" aria-label="([^"]*)">([\s\S]*?)<\/nav>/.exec(html)!;
    expect(dots[1]).toBe(opacText('id', 'home.hero.pick'));
    expect(dots[2]).toBe(
      '<a href="#slide-1" aria-current="true"><span class="visually-hidden">Slide 1 dari 3</span></a>' +
        '<a href="#slide-2" aria-current="false"><span class="visually-hidden">Slide 2 dari 3</span></a>' +
        '<a href="#slide-3" aria-current="false"><span class="visually-hidden">Slide 3 dari 3</span></a>',
    );
    // Nothing but the hidden label is text in an indicator.
    expect(dots[2]!.replace(/<span class="visually-hidden">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '')).toBe('');
    // Each link's target is a slide of this page.
    for (const href of [...dots[2]!.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])) expect(track).toContain(`id="${href}"`);
    const en = hero(THREE, { locale: 'en', lang: 'en' });
    expect(en).toContain('<span class="visually-hidden">Slide 2 of 3</span>');
  });

  it('the previous, next and pause buttons are hidden until the script shows them, each named by its aria-label', () => {
    const buttons = tags(html, 'button');
    expect(buttons).toHaveLength(3);
    for (const [i, [hook, label]] of ([['data-prev', 'home.hero.prev'], ['data-next', 'home.hero.next'], ['data-pause', 'home.hero.pause']] as const).entries()) {
      const button = buttons[i]!;
      expect(button).toMatch(/^<button type="button" /);
      expect(button).toMatch(/\sdata-js(?:="[^"]*")?[\s>]/);
      expect(button).toMatch(/\shidden(?:="")?[\s>]/);
      expect(button).toMatch(new RegExp(`\\s${hook}(?:="[^"]*")?[\\s>]`));
      expect(button).toContain(` aria-label="${opacText('id', label)}"`);
    }
    expect(buttons[2]).toContain(` data-label-pause="${opacText('id', 'home.hero.pause')}" data-label-play="${opacText('id', 'home.hero.play')}"`);
    // Without the script the visitor meets no button that does nothing: the indicators are the only controls shown.
    expect(html.match(/<button\b/g)).toHaveLength(html.match(/<button\b[^>]*\shidden(?:="")?[\s>]/g)!.length);
    // Their drawings are decorative.
    const ui = html.slice(html.indexOf('<div class="hero-ui">'));
    for (const svg of tags(ui, 'svg')) expect(svg).toContain('aria-hidden="true"');
    expect(ui).toMatch(/<span data-icon-pause(?:="[^"]*")?><svg/);
    expect(ui).toMatch(/<span data-icon-play(?:="[^"]*")? hidden(?:="")?><svg/);
    // No inline handler, no inline style, no script in the markup.
    expect(html).not.toMatch(/<[a-z][^>]*\s(?:style|on[a-z]+)=/i);
    expect(html).not.toContain('<script');
  });

  it('ARIA: a carousel of slide groups, each labelled with its place; the track announces nothing by itself', () => {
    expect(html).toMatch(
      new RegExp(`^<section class="hero" data-hero(?:="")? data-autoplay="false" data-interval="10" aria-roledescription="carousel" aria-label="${opacText('id', 'home.hero.label')}">`),
    );
    expect(html).toContain('<div class="hero-track" aria-live="off">');
    expect(tags(track, 'div').filter((t) => t.includes('class="slide"'))).toEqual([
      '<div class="slide" id="slide-1" role="group" aria-roledescription="slide" aria-label="1 dari 3">',
      '<div class="slide" id="slide-2" role="group" aria-roledescription="slide" aria-label="2 dari 3">',
      '<div class="slide" id="slide-3" role="group" aria-roledescription="slide" aria-label="3 dari 3">',
    ]);
    // No slide is hidden from assistive technology in the markup: without the script all of them are there to read.
    expect(html).not.toContain('aria-hidden="true" class="slide"');
    expect(html).not.toMatch(/<div class="slide"[^>]*(?:aria-hidden|inert|hidden)/);
  });

  it('data-autoplay and data-interval are the setting\'s', () => {
    for (const [autoplay, intervalSec] of [[true, 5], [true, 7], [false, 10]] as const) {
      expect(hero(THREE, { autoplay, intervalSec })).toMatch(new RegExp(`^<section class="hero" data-hero(?:="")? data-autoplay="${String(autoplay)}" data-interval="${intervalSec}" `));
    }
  });
});

describe('the hero with one slide, and with none', () => {
  it('one slide: no controls, nothing of a carousel, the slide alone with the <h1>', () => {
    const html = hero([THREE[0]!]);
    expect(html).toMatch(new RegExp(`^<section class="hero" aria-label="${opacText('id', 'home.hero.label')}"><div class="hero-track"><div class="slide" id="slide-1"><div class="slide-text">`));
    for (const absent of ['hero-ui', 'hero-dots', '<button', 'data-hero', 'data-autoplay', 'data-interval', 'aria-roledescription', 'role="group"', 'aria-live', '<script', '<h2']) {
      expect(html, absent).not.toContain(absent);
    }
    expect(html).toContain('<h1>Ruang baca &lt;baru&gt;</h1>');
    expect(tags(html, 'img')).toHaveLength(1);
  });

  it('no slide: the page heading and the welcome text on the panel alone, no photo and no controls', () => {
    const html = hero([]);
    expect(html).toBe(
      `<section class="hero" aria-label="${opacText('id', 'home.hero.label')}"><div class="hero-track"><div class="slide slide-nophoto"><div class="slide-text"><div class="slide-body">` +
        '<h1>Perpustakaan &lt;SMA&gt;</h1><p class="slide-lead">Cari buku di katalog.</p></div></div></div></div></section>',
    );
    // The page's own heading, when the content has one, stands for the library's name.
    const titled = hero([], { defaults: { ...DEFAULTS, title: { id: 'Selamat datang', en: null }, welcome: NONE } });
    expect(titled).toContain('<h1>Selamat datang</h1>');
    expect(titled).not.toContain('slide-lead');
  });

  it('a heading, note and lead of the other language carry its lang', () => {
    const html = hero([slide('a', 1, { note: { id: null, en: 'Notice' }, title: { id: null, en: 'Reading room' }, subtitle: { id: null, en: 'Find a book.' } })]);
    expect(html).toContain('<p class="slide-note" lang="en">Notice</p>');
    expect(html).toContain('<h1 lang="en">Reading room</h1>');
    expect(html).toContain('<p class="slide-lead" lang="en">Find a book.</p>');
    const own = hero([slide('a', 1, { title: { id: 'Ruang baca', en: 'Reading room' }, subtitle: { id: 'Cari buku.', en: null } })]);
    expect(own).toContain('<h1>Ruang baca</h1>');
    expect(own).toContain('<p class="slide-lead">Cari buku.</p>');
    // On an English page the welcome text falls back to the Indonesian one, marked so.
    expect(hero([], { locale: 'en', lang: 'en' })).toContain('<p class="slide-lead" lang="id">Cari buku di katalog.</p>');
  });
});

describe("a slide's button", () => {
  const withTarget = (target: OpacHomeTarget, lang: 'en' | null = null): string =>
    hero([slide('a', 1, { cta: { label: { id: 'Lihat <semua>', en: null }, target } })], lang === null ? {} : { locale: 'en', lang });

  it('leads to a path of this site made from the kind of its target, the page language kept', () => {
    const cases: [OpacHomeTarget, string][] = [
      [{ kind: 'catalog' }, '/cari'],
      [{ kind: 'profile' }, '/profil'],
      [{ kind: 'news' }, '/berita'],
      [{ kind: 'news', ref: 'bedah-buku' }, '/berita/bedah-buku'],
      [{ kind: 'path', ref: '/halaman/tata-tertib' }, '/halaman/tata-tertib'],
    ];
    for (const [target, path] of cases) {
      expect(OpacHomeTarget.safeParse(target).success, path).toBe(true);
      expect(slideTargetPath(target)).toBe(path);
      expect(withTarget(target)).toContain(`<p class="slide-cta"><a class="btn btn-inv" href="${path}">Lihat &lt;semua&gt;</a></p>`);
      expect(withTarget(target, 'en')).toContain(`<a class="btn btn-inv" href="${path}?lang=en" lang="id">Lihat &lt;semua&gt;</a>`);
    }
  });

  it('a path that is not a safe path of this site gives no button at all (the setting cannot hold one)', () => {
    for (const ref of ['//evil.example', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a//b', 'cari', '']) {
      expect(OpacHomeTarget.safeParse({ kind: 'path', ref }).success, ref).toBe(false);
      expect(slideTargetPath({ kind: 'path', ref }), ref).toBeNull();
      const html = withTarget({ kind: 'path', ref });
      expect(html, ref).not.toContain('slide-cta');
      expect(html, ref).not.toContain('<a ');
      expect(html, ref).not.toContain('evil.example');
    }
    // A slide without a button has none either.
    expect(hero([slide('a', 1)])).not.toContain('slide-cta');
  });
});

describe("the hero's styles", () => {
  /** The declarations of the rule whose selector is exactly `selector`. */
  const rule = (selector: string): string => {
    const at = HOME_CSS.split('\n').find((line) => line.startsWith(`${selector}{`));
    expect(at, selector).toBeDefined();
    return at!.slice(selector.length + 1, at!.indexOf('}'));
  };

  it('the track clips its slides and nothing scrolls sideways', () => {
    expect(rule('.hero-track').split(';')).toContain('overflow:hidden');
    expect(HOME_CSS).not.toMatch(/overflow-x:\s*(?:auto|scroll)|overflow:\s*(?:auto|scroll)|scroll-snap/);
    // The slides share one grid cell.
    expect(rule('.hero-track').split(';')).toContain('display:grid');
    expect(rule('.hero-track>.slide')).toContain('grid-area:1/1');
  });

  it('without the script every slide is drawn, the first on top, the one an indicator points at above it', () => {
    expect(HOME_CSS).toContain('.hero-track:not(.js)>.slide{visibility:visible;opacity:1;z-index:0}');
    expect(HOME_CSS).toContain('.hero-track:not(.js)>.slide:first-child{z-index:1}');
    expect(HOME_CSS).toContain('.hero-track:not(.js)>.slide:target{z-index:2}');
    // With it only the slide that is on shows.
    expect(HOME_CSS).toContain('.hero-track.js>.slide.is-on{visibility:visible;opacity:1}');
  });

  it('a slide is at least 440 px high and its photo never sets the height', () => {
    expect(rule('.slide').split(';')).toContain('min-height:27.5rem');
    const img = rule('.slide>img').split(';');
    expect(img).toContain('contain:size');
    expect(img).toContain('object-fit:cover');
    for (let p = 0; p <= 100; p += 10) expect(HOME_CSS).toContain(`.hero-pos-${p}{object-position:50% ${p}%}`);
  });

  it('the panel is one flat colour under white text, a change fades only when motion is welcome, focus shows on the panel', () => {
    expect(rule('.slide-text')).toContain('background:var(--panel);color:var(--on-panel)');
    expect(HOME_CSS).not.toMatch(/gradient|rgba?\(8 12 20|hero-ov-|hero-photo/);
    expect(HOME_CSS).toContain('@media (prefers-reduced-motion:no-preference){.hero-track.js>.slide{transition:opacity .45s ease,visibility .45s}}');
    expect(HOME_CSS.replace(/@media \(prefers-reduced-motion:no-preference\)\{[^}]*\}\}/, '')).not.toMatch(/\.slide[^{]*\{[^}]*transition/);
    expect(HOME_CSS).toContain('.hero a:focus-visible,.hero button:focus-visible{outline-color:var(--on-panel)}');
    expect(OPAC_CSS).toContain(HOME_CSS);
  });

  it('every class the hero and the home blocks can carry is styled', () => {
    const classes = new Set([...hero(THREE).matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
    for (const cls of ['slide-nophoto', 'slide-cta', 'card-status', 'status-muted', 'class-ranking', 'class-place', 'class-label', 'class-counts', 'figures', 'svc-grid', 'rank', 'ddc', 'gallery', 'visit', 'cta']) {
      classes.add(cls);
    }
    for (const cls of classes) expect(OPAC_CSS, cls).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
    // Today's row of the opening hours is marked by weight and by the word "today", not by colour.
    expect(HOME_CSS).toMatch(/\.hours \.today th,\.hours \.today td\{font-weight:[67]00\}/);
  });
});

describe("the slider's script", () => {
  it('is served under its content hash and builds no markup from text', () => {
    expect(OPAC_SLIDER_FILE).toMatch(/^opac-slider-[0-9a-f]{10}\.js$/);
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval', 'new Function', 'fetch(', 'XMLHttpRequest', 'import(', 'cookie', 'localStorage']) {
      expect(OPAC_SLIDER_JS, banned).not.toContain(banned);
    }
    // Timers are given functions, never text.
    expect([...OPAC_SLIDER_JS.matchAll(/set(?:Interval|Timeout)\(([^,]{0,12})/g)].every((m) => m[1]!.startsWith('function'))).toBe(true);
  });

  it('finds the hero by the attributes the page writes, honours reduced motion and leaves a lone slide alone', () => {
    const html = hero(THREE);
    for (const hook of ['data-hero', 'data-pause', 'data-prev', 'data-next', 'data-js', 'data-interval', 'data-autoplay', 'data-label-play', 'data-label-pause', 'data-icon-pause', 'data-icon-play']) {
      expect(OPAC_SLIDER_JS, hook).toContain(hook);
      expect(html, hook).toMatch(new RegExp(`\\s${hook}[=\\s>]`));
    }
    expect(OPAC_SLIDER_JS).toContain("root.querySelectorAll('.hero-dots a')");
    expect(OPAC_SLIDER_JS).toContain("root.querySelector('.hero-track')");
    expect(OPAC_SLIDER_JS).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
    expect(OPAC_SLIDER_JS).toContain('paused = !auto || reduce.matches');
    expect(OPAC_SLIDER_JS).toContain('if (slides.length < 2) return;');
  });
});

describe('the slides of a day', () => {
  const home = OpacHomeContent.parse({
    ...OPAC_HOME_DEFAULT,
    hero: {
      slides: [slide('off', 1, { active: false }), slide('november', 2, { from: '2026-11-01', until: '2026-11-18' }), slide('later', 3, { from: '2026-11-19' }), slide('always', 4)],
    },
  });
  const at = (timeZone: string, iso: string): string[] => heroSlidesAt(home, timeZone, Date.parse(iso)).map((s) => s.id);

  it('are all the slides that are on and within their days, in their order', () => {
    expect(at('Asia/Jakarta', '2026-11-10T03:00:00Z')).toEqual(['november', 'always']);
    expect(at('Asia/Jakarta', '2026-12-01T03:00:00Z')).toEqual(['later', 'always']);
    expect(at('Asia/Jakarta', '2026-10-31T16:59:59Z')).toEqual(['always']);
    expect(heroSlidesAt(OPAC_HOME_DEFAULT, 'Asia/Jakarta', 0)).toEqual([]);
  });

  it("a slide's last day ends at the library's midnight, not UTC's", () => {
    // 23:30 on the 18th in Jakarta (UTC+7) is 16:30 UTC on the 18th: the slide still shows.
    expect(at('Asia/Jakarta', '2026-11-18T16:30:00Z')).toEqual(['november', 'always']);
    expect(at('Asia/Jakarta', '2026-11-18T16:59:59Z')).toEqual(['november', 'always']);
    // 00:30 on the 19th in Jakarta is still the 18th in UTC (17:30): the slide is over.
    expect(at('Asia/Jakarta', '2026-11-18T17:30:00Z')).toEqual(['later', 'always']);
    expect(at('UTC', '2026-11-18T17:30:00Z')).toEqual(['november', 'always']);
    // West of UTC the other way round: 23:30 on the 18th in New York is already the 19th in UTC, and the slide still shows.
    expect(at('America/New_York', '2026-11-19T04:30:00Z')).toEqual(['november', 'always']);
    expect(at('UTC', '2026-11-19T04:30:00Z')).toEqual(['later', 'always']);
    expect(at('America/New_York', '2026-11-19T05:00:00Z')).toEqual(['later', 'always']);
  });

  it("a slide's first day starts at the library's midnight", () => {
    // `later` starts on the 19th: not yet at 23:30 on the 18th in Jakarta, there at 00:30 on the 19th (the 18th in UTC).
    expect(at('Asia/Jakarta', '2026-11-18T16:30:00Z')).not.toContain('later');
    expect(at('Asia/Jakarta', '2026-11-18T17:00:00Z')).toContain('later');
    expect(at('Asia/Jakarta', '2026-11-18T17:30:00Z')).toContain('later');
    expect(at('UTC', '2026-11-18T17:30:00Z')).not.toContain('later');
    // `november` starts on the 1st: 00:30 on the 1st in Jakarta is the 31st of October in UTC.
    expect(at('Asia/Jakarta', '2026-10-31T17:30:00Z')).toContain('november');
    expect(at('UTC', '2026-10-31T17:30:00Z')).not.toContain('november');
  });

  it('a slide that is switched off never shows, whatever its days', () => {
    const off = OpacHomeContent.parse({
      ...OPAC_HOME_DEFAULT,
      hero: { slides: [slide('off', 1, { active: false }), slide('off-dated', 2, { active: false, from: '2026-11-01', until: '2026-11-30' }), slide('past', 3, { until: '2020-01-01' })] },
    });
    for (const iso of ['2019-12-31T00:00:00Z', '2026-11-18T00:00:00Z', '2030-01-01T00:00:00Z']) {
      expect(heroSlidesAt(off, 'Asia/Jakarta', Date.parse(iso)).map((s) => s.id)).toEqual(iso.startsWith('2019') ? ['past'] : []);
    }
    for (const iso of ['2026-10-01T00:00:00Z', '2026-11-18T16:30:00Z', '2026-11-18T17:30:00Z', '2027-01-01T00:00:00Z']) expect(at('Asia/Jakarta', iso)).not.toContain('off');
  });

  it('a time zone the setting got wrong is read as UTC, never an error', () => {
    for (const zone of ['Bukan/Zona', '', 'UTC+25', 'Asia/Jakarta; DROP']) {
      expect(() => at(zone, '2026-11-18T17:30:00Z'), zone).not.toThrow();
      expect(at(zone, '2026-11-18T17:30:00Z'), zone).toEqual(at('UTC', '2026-11-18T17:30:00Z'));
      expect(at(zone, '2026-11-19T04:30:00Z'), zone).toEqual(['later', 'always']);
    }
  });

  it('a hero saved as one photo is one slide that always shows', () => {
    const old = OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, hero: { fileId: '01JZFXQ00000000000000000A9', alt: 'Gedung', position: 40, overlay: 75 } });
    const slides = heroSlidesAt(old, 'Asia/Jakarta', 0);
    expect(slides).toHaveLength(1);
    expect(slides[0]).toMatchObject({ fileId: '01JZFXQ00000000000000000A9', alt: 'Gedung', position: 40, active: true, from: null, until: null });
    // One slide: the hero has no controls.
    expect(hero(slides)).not.toContain('hero-ui');
  });
});
