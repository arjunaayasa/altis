import { describe, expect, it } from 'vitest';
import { issueCode } from '../src/api/common.js';
import {
  OPAC_HOME_BLOCK_DEFAULTS,
  OPAC_HOME_BLOCKS,
  OPAC_HOME_DEFAULT,
  OPAC_HOME_INTERVALS,
  OPAC_HOME_LEGACY_SLIDE_ID,
  OPAC_HOME_LIMITS,
  OpacHomeContact,
  OpacHomeContent,
  OpacHomePutBody,
  brandRgb,
  contrastWithWhite,
  opacHomeBrandField,
  isSafeInternalPath,
  opacHomeFileIds,
  opacHomeFilePaths,
  opacHomeSlideShown,
  opacHomeSlidesAt,
  opacHomeTextIn,
  phoneHref,
  type OpacHomeSlide,
} from '../src/api/opac-home.js';

// The content of the OPAC home page (`opac.home`): the hero's slides (their limits, where a button may lead, the days a
// slide shows), a hero saved as one photo read as its one slide, the library's profile and gallery, every photo counted
// as a file of the content, the library colour taken only as a dark enough `#rrggbb`, the heading and "about" paragraph per language with the
// other language as fallback (a content saved with one text each still reads, as the Indonesian texts), the weekdays
// of an opening hours row, and the loans per class off unless a library switches them on.

const FILE = '01JZFXQ0000000000000000007';

/** The codes of the issues `value` raises under `schema`, by path. */
function issues(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; params?: Record<string, unknown> }[] } } }, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error!.issues.map((i) => ({ path: i.path.map(String).join('.'), code: issueCode(i) }));
}

const FILE2 = '01JZFXQ0000000000000000008';
const NONE = { id: null, en: null };

/** A slide as the editor sends it, with `over` in place of its fields. */
function slide(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'a1', fileId: FILE, alt: 'Ruang baca', position: 50, note: NONE, title: NONE, subtitle: NONE, cta: null, active: true, from: null, until: null, ...over };
}

/** A content whose hero holds `slides` (and `more` of the hero's own fields). */
const withSlides = (slides: unknown[], more: Record<string, unknown> = {}) => ({ ...OPAC_HOME_DEFAULT, hero: { slides, autoplay: true, intervalSec: 7, ...more } });

describe('the hero slides', () => {
  it('a slide: photo, alternative text, position, texts per language, a button or none, on or off, its days', () => {
    const full = slide({
      note: { id: 'Baru', en: 'New' },
      title: { id: ' Pekan literasi ', en: null },
      subtitle: { id: 'Pameran buku dan lokakarya', en: 'Book fair and workshops' },
      cta: { label: { id: 'Lihat agenda', en: null }, target: { kind: 'news', ref: 'pekan-literasi' } },
      from: '2026-11-01',
      until: '2026-11-30',
    });
    const read = OpacHomeContent.parse(withSlides([full]));
    expect(read.hero.slides).toEqual([{ ...full, title: { id: 'Pekan literasi', en: null } }]);
    expect(read.hero.autoplay).toBe(true);
    expect(read.hero.intervalSec).toBe(7);
    // Stored and read again, it is the same.
    expect(OpacHomeContent.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
  });

  it('at most 6 slides, each id once, each photo once; the slider advances every 5, 7 or 10 seconds (7 unless said)', () => {
    expect(OPAC_HOME_LIMITS.slides).toBe(6);
    expect(OPAC_HOME_INTERVALS).toEqual([5, 7, 10]);
    const many = (n: number) => Array.from({ length: n }, (_, i) => slide({ id: `s${i}`, fileId: `01JZFXQ00000000000000000A${i}` }));
    expect(OpacHomeContent.parse(withSlides(many(6))).hero.slides).toHaveLength(6);
    expect(issues(OpacHomeContent, withSlides(many(7)))).toEqual([{ path: 'hero.slides', code: 'too_big' }]);
    expect(issues(OpacHomeContent, withSlides([slide(), slide({ fileId: FILE2 })]))).toEqual([{ path: 'hero.slides.1.id', code: 'duplicate' }]);
    expect(issues(OpacHomeContent, withSlides([slide(), slide({ id: 'b2' })]))).toEqual([{ path: 'hero.slides.1.fileId', code: 'duplicate' }]);
    for (const ok of [5, 7, 10]) expect(OpacHomeContent.parse(withSlides([], { intervalSec: ok })).hero.intervalSec).toBe(ok);
    for (const bad of [0, 6, 7.5, 60, '7']) expect(issues(OpacHomeContent, withSlides([], { intervalSec: bad })).map((i) => i.path), String(bad)).toEqual(['hero.intervalSec']);
    const bare = OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, hero: { slides: [] } });
    expect(bare.hero).toEqual({ slides: [], autoplay: true, intervalSec: 7 });
    expect(OpacHomeContent.parse(withSlides([], { autoplay: false })).hero.autoplay).toBe(false);
    expect(issues(OpacHomeContent, withSlides([], { overlay: 60 }))).toEqual([{ path: 'hero', code: 'unrecognized_keys' }]);
  });

  it('the widths: title 80, subtitle 200, note 60, button label 40, alternative text required; ids of letters, digits, _ and -', () => {
    expect(OPAC_HOME_LIMITS.slideTitle).toBe(80);
    const one = (over: Record<string, unknown>) => issues(OpacHomeContent, withSlides([slide(over)]));
    expect(one({ title: { id: 'a'.repeat(80), en: 'b'.repeat(80) } })).toEqual([]);
    expect(one({ title: { id: 'a'.repeat(81), en: null } })).toEqual([{ path: 'hero.slides.0.title.id', code: 'too_big' }]);
    expect(one({ subtitle: { id: null, en: 'b'.repeat(201) } })).toEqual([{ path: 'hero.slides.0.subtitle.en', code: 'too_big' }]);
    expect(one({ note: { id: 'c'.repeat(61), en: null } })).toEqual([{ path: 'hero.slides.0.note.id', code: 'too_big' }]);
    expect(one({ alt: '   ' })).toEqual([{ path: 'hero.slides.0.alt', code: 'too_small' }]);
    expect(one({ position: 55 })).toEqual([{ path: 'hero.slides.0.position', code: 'not_multiple_of' }]);
    expect(one({ overlay: 60 })).toEqual([{ path: 'hero.slides.0', code: 'unrecognized_keys' }]);
    expect(one({ fileId: 'bukan-ulid' }).map((i) => i.path)).toEqual(['hero.slides.0.fileId']);
    for (const ok of ['a', 'slide-1', 'S_2', '01JZFXQ0000000000000000007']) expect(one({ id: ok }), ok).toEqual([]);
    for (const bad of ['', 'a b', 'a/b', 'é', 'x'.repeat(33), '<b>']) expect(one({ id: bad }).map((i) => i.path), bad).toEqual(['hero.slides.0.id']);
    // The page's own heading keeps its width.
    expect(issues(OpacHomeContent, { ...OPAC_HOME_DEFAULT, title: { id: 'a'.repeat(91), en: null } })).toEqual([{ path: 'title.id', code: 'too_big' }]);
  });

  it('a button needs a label in one language at least, and leads to a kind of place with its reference, never a free URL', () => {
    const cta = (target: unknown, label: unknown = { id: 'Selengkapnya', en: null }) => issues(OpacHomeContent, withSlides([slide({ cta: { label, target } })]));
    expect(cta({ kind: 'catalog' })).toEqual([]);
    expect(cta({ kind: 'profile' })).toEqual([]);
    expect(cta({ kind: 'news' })).toEqual([]);
    expect(cta({ kind: 'news', ref: 'pekan-literasi-2026' })).toEqual([]);
    expect(cta({ kind: 'path', ref: '/halaman/layanan' })).toEqual([]);
    expect(cta({ kind: 'catalog' }, { id: null, en: 'More' })).toEqual([]);
    expect(cta({ kind: 'catalog' }, { id: ' ', en: null })).toEqual([{ path: 'hero.slides.0.cta.label', code: 'required' }]);
    expect(cta({ kind: 'catalog' }, { id: 'a'.repeat(41), en: null })).toEqual([{ path: 'hero.slides.0.cta.label.id', code: 'too_big' }]);
    // No reference where the kind takes none; a slug where it takes one; a path of this site, or nothing.
    expect(cta({ kind: 'catalog', ref: '/cari' })).toEqual([{ path: 'hero.slides.0.cta.target', code: 'unrecognized_keys' }]);
    expect(cta({ kind: 'profile', ref: 'x' })).toEqual([{ path: 'hero.slides.0.cta.target', code: 'unrecognized_keys' }]);
    for (const bad of ['Pekan Literasi', 'a/b', '../x', 'https://contoh.example', '', 'a'.repeat(192)]) {
      expect(cta({ kind: 'news', ref: bad }), bad).toEqual([{ path: 'hero.slides.0.cta.target.ref', code: 'invalid_format' }]);
    }
    expect(cta({ kind: 'path' }).map((i) => i.path)).toEqual(['hero.slides.0.cta.target.ref']);
    expect(cta({ kind: 'path', ref: 'https://contoh.example/x' })).toEqual([{ path: 'hero.slides.0.cta.target.ref', code: 'invalid' }]);
    expect(cta({ kind: 'url', ref: 'https://contoh.example' }).map((i) => i.path)).toEqual(['hero.slides.0.cta.target.kind']);
    expect(cta({ kind: 'path', ref: '/x', url: 'https://contoh.example' })).toEqual([{ path: 'hero.slides.0.cta.target', code: 'unrecognized_keys' }]);
    expect(cta('https://contoh.example').map((i) => i.path)).toEqual(['hero.slides.0.cta.target']);
  });

  it('a path of this site: one leading slash, no scheme, no //, no backslash, no space or control character, 200 at most', () => {
    for (const ok of ['/', '/cari', '/cari?q=sejarah&ruas=judul#hasil', '/halaman/tata-tertib', '/berita/rss', '/akun', '/x:y', '/é', `/${'a'.repeat(199)}`]) {
      expect(isSafeInternalPath(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'cari',
      './cari',
      '//contoh.example',
      '//contoh.example/x',
      '/x//y',
      '/\\contoh.example',
      '\\\\contoh.example',
      '/x\\y',
      'https://contoh.example',
      'http:/x',
      'javascript:alert(1)',
      'data:text/html,x',
      'mailto:a@b.example',
      ' /cari',
      '/cari ',
      '/ca ri',
      '/ca\tri',
      '/ca\nri',
      '/ca\rri',
      '/ca\u0000ri',
      '/ca\u007fri',
      '/ca\u0085ri',
      '/ca\u2028ri',
      '/ca\u2029ri',
      `/${'a'.repeat(200)}`,
      null,
      undefined,
      7,
      ['/cari'],
    ]) {
      expect(isSafeInternalPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the days a slide shows are calendar dates, the first not after the last; either may be open', () => {
    const days = (from: unknown, until: unknown) => issues(OpacHomeContent, withSlides([slide({ from, until })]));
    expect(days('2026-11-01', '2026-11-30')).toEqual([]);
    expect(days('2026-11-18', '2026-11-18')).toEqual([]);
    expect(days('2026-11-01', null)).toEqual([]);
    expect(days(null, '2026-11-30')).toEqual([]);
    expect(days('2026-12-01', '2026-11-30')).toEqual([{ path: 'hero.slides.0.until', code: 'invalid' }]);
    expect(days('2026-02-30', null)).toEqual([{ path: 'hero.slides.0.from', code: 'invalid_format' }]);
    expect(days(null, '30-11-2026')).toEqual([{ path: 'hero.slides.0.until', code: 'invalid_format' }]);
    expect(days('2026-11-01T00:00:00Z', null)).toEqual([{ path: 'hero.slides.0.from', code: 'invalid_format' }]);
    expect(days(1_793_059_200_000, null).map((i) => i.path)).toEqual(['hero.slides.0.from']);
  });

  it('a slide shows when it is on and today is within its days, both ends included', () => {
    const on = (over: Partial<OpacHomeSlide>) => opacHomeSlideShown({ active: true, from: null, until: null, ...over }, '2026-11-18');
    expect(on({})).toBe(true);
    expect(on({ active: false })).toBe(false);
    expect(on({ from: '2026-11-18' })).toBe(true);
    expect(on({ from: '2026-11-19' })).toBe(false);
    expect(on({ until: '2026-11-18' })).toBe(true);
    expect(on({ until: '2026-11-17' })).toBe(false);
    expect(on({ from: '2026-11-01', until: '2026-11-30' })).toBe(true);
    expect(on({ from: '2026-11-01', until: '2026-11-30', active: false })).toBe(false);
    expect(on({ from: '2025-11-01', until: '2025-11-30' })).toBe(false);
  });

  it('today is the calendar day of the library time zone: a slide ends at the library midnight, not at UTC midnight', () => {
    const hero = OpacHomeContent.parse(
      withSlides([
        slide({ id: 'off', active: false }),
        slide({ id: 'until-18', fileId: FILE2, until: '2026-11-18' }),
        slide({ id: 'from-19', fileId: '01JZFXQ00000000000000000A1', from: '2026-11-19' }),
        slide({ id: 'always', fileId: '01JZFXQ00000000000000000A2' }),
      ]),
    ).hero;
    const ids = (timeZone: string, iso: string) => opacHomeSlidesAt(hero, timeZone, Date.parse(iso)).map((s) => s.id);
    // 16:59 UTC on the 18th is 23:59 in Jakarta (UTC+7); a minute later it is the 19th there, still the 18th in UTC.
    expect(ids('Asia/Jakarta', '2026-11-18T16:59:00Z')).toEqual(['until-18', 'always']);
    expect(ids('Asia/Jakarta', '2026-11-18T17:00:00Z')).toEqual(['from-19', 'always']);
    expect(ids('UTC', '2026-11-18T17:00:00Z')).toEqual(['until-18', 'always']);
    // Jayapura (UTC+9) is two hours ahead of Jakarta.
    expect(ids('Asia/Jayapura', '2026-11-18T15:00:00Z')).toEqual(['from-19', 'always']);
    expect(ids('Asia/Jakarta', '2026-11-18T15:00:00Z')).toEqual(['until-18', 'always']);
    expect(() => opacHomeSlidesAt(hero, 'Bukan/Zona', 0)).toThrow(RangeError);
    expect(opacHomeSlidesAt({ slides: [] }, 'Asia/Jakarta', 0)).toEqual([]);
  });
});

describe('a hero saved as one photo', () => {
  it('reads as its one slide: shown always, no texts or button of its own, the old overlay dropped', () => {
    const expected = {
      slides: [{ id: OPAC_HOME_LEGACY_SLIDE_ID, fileId: FILE, alt: 'Gedung', position: 40, note: NONE, title: NONE, subtitle: NONE, cta: null, active: true, from: null, until: null }],
      autoplay: true,
      intervalSec: 7,
    };
    for (const old of [
      { fileId: FILE, alt: 'Gedung', position: 40, overlay: 70 },
      { fileId: FILE, alt: ' Gedung ', position: 40 },
      { fileId: FILE, alt: 'Gedung', position: 40, overlay: 40 }, // a darkness out of the old range: dropped all the same
    ]) {
      const read = OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, hero: old });
      expect(read.hero, JSON.stringify(old)).toEqual(expected);
      expect(opacHomeSlidesAt(read.hero, 'Asia/Jakarta', 0)).toHaveLength(1);
      expect(OpacHomeContent.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
    }
    // What made the old photo invalid still does.
    expect(issues(OpacHomeContent, { ...OPAC_HOME_DEFAULT, hero: { fileId: FILE, alt: '', position: 40 } })).toEqual([{ path: 'hero.slides.0.alt', code: 'too_small' }]);
    expect(issues(OpacHomeContent, { ...OPAC_HOME_DEFAULT, hero: { fileId: FILE, alt: 'Gedung', position: 45 } })).toEqual([{ path: 'hero.slides.0.position', code: 'not_multiple_of' }]);
  });

  it('no hero (null, or none at all) reads as a hero without slides', () => {
    const empty = { slides: [], autoplay: true, intervalSec: 7 };
    expect(OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, hero: null }).hero).toEqual(empty);
    const without: Record<string, unknown> = { ...OPAC_HOME_DEFAULT };
    delete without['hero'];
    expect(OpacHomeContent.parse(without).hero).toEqual(empty);
    expect(OPAC_HOME_DEFAULT.hero).toEqual(empty);
    expect(OpacHomeContent.parse(OPAC_HOME_DEFAULT)).toEqual(OPAC_HOME_DEFAULT);
  });
});

describe('the profile and the gallery', () => {
  it('a content saved before they existed reads them as none', () => {
    const old = JSON.parse(JSON.stringify(OPAC_HOME_DEFAULT)) as Record<string, unknown>;
    for (const key of ['timeline', 'vision', 'mission', 'staff', 'gallery']) delete old[key];
    delete (old['about'] as Record<string, unknown>)['history'];
    const read = OpacHomeContent.parse(old);
    expect(read.about.history).toEqual(NONE);
    expect(read.timeline).toEqual([]);
    expect(read.vision).toEqual(NONE);
    expect(read.mission).toEqual([]);
    expect(read.staff).toEqual([]);
    expect(read.gallery).toEqual([]);
    expect(read).toEqual(OPAC_HOME_DEFAULT);
  });

  it('history, timeline, vision, mission, the people (a name and a role, typed in) and up to 8 gallery photos', () => {
    const profile = {
      ...OPAC_HOME_DEFAULT,
      about: { ...OPAC_HOME_DEFAULT.about, founded: 1987, history: { id: ' Berdiri pada 1987.\n\nPindah gedung pada 2010. ', en: null } },
      timeline: [
        { year: 1987, text: { id: 'Perpustakaan berdiri', en: 'The library opens' } },
        { year: 2010, text: { id: 'Gedung baru', en: null } },
      ],
      vision: { id: 'Menjadi pusat belajar warga', en: 'A learning centre for everyone' },
      mission: [{ id: 'Menyediakan koleksi yang mutakhir', en: null }, { id: null, en: 'Teach information literacy' }],
      staff: [
        { name: ' Sri Wahyuni ', role: { id: 'Kepala perpustakaan', en: 'Head librarian' } },
        { name: 'Budi Santoso', role: NONE },
      ],
      gallery: [
        { fileId: FILE, alt: 'Ruang baca', caption: { id: 'Ruang baca lantai dua', en: 'Second-floor reading room' } },
        { fileId: FILE2, alt: 'Pojok anak', caption: NONE },
      ],
    };
    const read = OpacHomeContent.parse(profile);
    expect(read.about.history).toEqual({ id: 'Berdiri pada 1987.\n\nPindah gedung pada 2010.', en: null });
    expect(read.staff[0]).toEqual({ name: 'Sri Wahyuni', role: { id: 'Kepala perpustakaan', en: 'Head librarian' } });
    expect(read.timeline).toEqual(profile.timeline);
    expect(read.mission).toEqual(profile.mission);
    expect(read.gallery).toEqual(profile.gallery);
    expect(OpacHomeContent.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
  });

  it('their limits', () => {
    const L = OPAC_HOME_LIMITS;
    expect({ gallery: L.gallery, timeline: L.timeline, mission: L.mission, staff: L.staff }).toEqual({ gallery: 8, timeline: 12, mission: 8, staff: 24 });
    const check = (over: Record<string, unknown>) => issues(OpacHomeContent, { ...OPAC_HOME_DEFAULT, ...over });
    const photo = (i: number) => ({ fileId: `01JZFXQ00000000000000000B${i}`, alt: `Foto ${i}`, caption: NONE });
    expect(check({ gallery: Array.from({ length: 8 }, (_, i) => photo(i)) })).toEqual([]);
    expect(check({ gallery: Array.from({ length: 9 }, (_, i) => photo(i)) })).toEqual([{ path: 'gallery', code: 'too_big' }]);
    expect(check({ gallery: [{ ...photo(0), alt: ' ' }] })).toEqual([{ path: 'gallery.0.alt', code: 'too_small' }]);
    expect(check({ gallery: [{ ...photo(0), caption: { id: 'a'.repeat(L.caption + 1), en: null } }] })).toEqual([{ path: 'gallery.0.caption.id', code: 'too_big' }]);
    expect(check({ gallery: [photo(0), photo(0)] })).toEqual([{ path: 'gallery.1.fileId', code: 'duplicate' }]);
    const entry = { year: 2000, text: { id: 'x', en: null } };
    expect(check({ timeline: Array.from({ length: L.timeline + 1 }, () => entry) })).toEqual([{ path: 'timeline', code: 'too_big' }]);
    expect(check({ timeline: [{ year: 999, text: entry.text }] })).toEqual([{ path: 'timeline.0.year', code: 'too_small' }]);
    expect(check({ timeline: [{ year: 2101, text: entry.text }] })).toEqual([{ path: 'timeline.0.year', code: 'too_big' }]);
    expect(check({ timeline: [{ year: 2000, text: NONE }] })).toEqual([{ path: 'timeline.0.text', code: 'required' }]);
    expect(check({ timeline: [{ year: 2000, text: { id: 'a'.repeat(L.timelineText + 1), en: null } }] })).toEqual([{ path: 'timeline.0.text.id', code: 'too_big' }]);
    expect(check({ vision: { id: 'a'.repeat(L.vision + 1), en: null } })).toEqual([{ path: 'vision.id', code: 'too_big' }]);
    expect(check({ mission: Array.from({ length: L.mission + 1 }, () => ({ id: 'x', en: null })) })).toEqual([{ path: 'mission', code: 'too_big' }]);
    expect(check({ mission: [{ id: '  ', en: null }] })).toEqual([{ path: 'mission.0', code: 'required' }]);
    expect(check({ mission: [{ id: null, en: 'a'.repeat(L.missionText + 1) }] })).toEqual([{ path: 'mission.0.en', code: 'too_big' }]);
    expect(check({ staff: Array.from({ length: L.staff + 1 }, () => ({ name: 'A', role: NONE })) })).toEqual([{ path: 'staff', code: 'too_big' }]);
    expect(check({ staff: [{ name: ' ', role: NONE }] })).toEqual([{ path: 'staff.0.name', code: 'too_small' }]);
    expect(check({ staff: [{ name: 'a'.repeat(L.staffName + 1), role: NONE }] })).toEqual([{ path: 'staff.0.name', code: 'too_big' }]);
    expect(check({ staff: [{ name: 'A', role: { id: 'a'.repeat(L.staffRole + 1), en: null } }] })).toEqual([{ path: 'staff.0.role.id', code: 'too_big' }]);
    // A person of the profile is a name and a role, nothing else: no member, user, e-mail or photo to attach.
    for (const extra of ['memberId', 'userId', 'email', 'phone', 'fileId']) {
      expect(check({ staff: [{ name: 'A', role: NONE, [extra]: 'x' }] }), extra).toEqual([{ path: 'staff.0', code: 'unrecognized_keys' }]);
    }
    expect(check({ about: { ...OPAC_HOME_DEFAULT.about, history: { id: 'a'.repeat(L.history + 1), en: null } } })).toEqual([{ path: 'about.history.id', code: 'too_big' }]);
  });
});

describe('the files of a content', () => {
  it('every slide, the logo, the "about" photo, the facilities and the gallery, each with its place; a photo is used once', () => {
    const id = (n: number) => `01JZFXQ00000000000000000C${n}`;
    const home = OpacHomeContent.parse({
      ...OPAC_HOME_DEFAULT,
      hero: { slides: [slide({ id: 'a', fileId: id(1) }), slide({ id: 'b', fileId: id(2), active: false }), slide({ id: 'c', fileId: id(3), until: '2020-01-01' })] },
      logo: { fileId: id(4), alt: 'Logo' },
      about: { ...OPAC_HOME_DEFAULT.about, photo: { fileId: id(5), alt: 'Gedung', caption: null } },
      facilities: [{ fileId: id(6), alt: 'Ruang baca', caption: null }],
      gallery: [
        { fileId: id(7), alt: 'Pojok anak', caption: NONE },
        { fileId: id(8), alt: 'Ruang diskusi', caption: NONE },
      ],
    });
    // A slide that is off or past its days still holds its photo.
    expect(opacHomeFileIds(home)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(id));
    expect(opacHomeFilePaths(home).map((f) => f.path.join('.'))).toEqual([
      'hero.slides.0.fileId',
      'hero.slides.1.fileId',
      'hero.slides.2.fileId',
      'logo.fileId',
      'about.photo.fileId',
      'facilities.0.fileId',
      'gallery.0.fileId',
      'gallery.1.fileId',
    ]);
    expect(opacHomeFileIds(OPAC_HOME_DEFAULT)).toEqual([]);
    const clash = (over: Record<string, unknown>) => issues(OpacHomeContent, { ...JSON.parse(JSON.stringify(home)), ...over });
    expect(clash({ logo: { fileId: id(2), alt: 'Logo' } })).toEqual([{ path: 'logo.fileId', code: 'duplicate' }]);
    expect(clash({ gallery: [{ fileId: id(3), alt: 'x', caption: NONE }] })).toEqual([{ path: 'gallery.0.fileId', code: 'duplicate' }]);
    expect(clash({ gallery: [{ fileId: id(6), alt: 'x', caption: NONE }] })).toEqual([{ path: 'gallery.0.fileId', code: 'duplicate' }]);
  });
});

describe('the library colour', () => {
  it('is a #rrggbb, stored lower case, on which white text keeps 4.5:1; anything else is refused', () => {
    expect(opacHomeBrandField.parse(' #1E3A8A ')).toBe('#1e3a8a');
    expect(issues(opacHomeBrandField, '#ffd966')).toEqual([{ path: '', code: 'low_contrast' }]);
    for (const bad of ['red', '#fff', '#12345g', '#1e3a8a;x', 'url(x)', '#1e3a8a}body{display:none', 'rgb(0 0 0)']) {
      expect(issues(opacHomeBrandField, bad).map((i) => i.code), bad).toEqual(['invalid_format']);
    }
    expect(brandRgb('#1e3a8a')).toEqual([30, 58, 138]);
    expect(brandRgb('#1E3A8A')).toBeNull();
    expect(brandRgb('#1e3a8a;')).toBeNull();
    expect(contrastWithWhite([0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrastWithWhite([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it('is optional: null (the accent) by default and for a content saved before it existed', () => {
    expect(OPAC_HOME_DEFAULT.brand).toBeNull();
    expect(issues(OpacHomeContent, { ...OPAC_HOME_DEFAULT, brand: '#eeeeee' })).toEqual([{ path: 'brand', code: 'low_contrast' }]);
  });
});

describe('the texts per language', () => {
  it('the page shows its own language, else the other one, with the language it is in', () => {
    expect(opacHomeTextIn({ id: 'Ruang baca', en: 'Reading room' }, 'en')).toEqual({ text: 'Reading room', lang: 'en' });
    expect(opacHomeTextIn({ id: 'Ruang baca', en: '   ' }, 'en')).toEqual({ text: 'Ruang baca', lang: 'id' });
    expect(opacHomeTextIn({ id: null, en: 'Reading room' }, 'id')).toEqual({ text: 'Reading room', lang: 'en' });
    expect(opacHomeTextIn({ id: null, en: null }, 'id')).toBeNull();
  });

  it('a content saved with one heading and one paragraph reads as before: those texts as the Indonesian ones', () => {
    const legacy = {
      title: 'Ruang baca untuk semua',
      hero: { fileId: FILE, alt: 'Gedung', position: 40 },
      about: { text: 'Berdiri sejak 1987.', photo: null, founded: 1987, librarians: 3 },
      services: [{ title: 'Peminjaman', text: null }],
      facilities: [],
      hours: [{ days: 'Senin–Jumat', time: '07.00–15.00' }],
      blocks: { classes: true, popular: true, newTitles: true, promoted: false, about: true, services: true, news: true, visit: true },
    };
    const read = OpacHomeContent.parse(legacy);
    expect(read.title).toEqual({ id: 'Ruang baca untuk semua', en: null });
    expect(read.about.text).toEqual({ id: 'Berdiri sejak 1987.', en: null });
    expect(read.hero.slides).toHaveLength(1);
    expect(read.hero.slides[0]).toMatchObject({ id: OPAC_HOME_LEGACY_SLIDE_ID, fileId: FILE, alt: 'Gedung', position: 40, active: true, from: null, until: null });
    expect(read.brand).toBeNull();
    expect(read.hours).toEqual([{ days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [] }]);
    expect(read.blocks).toEqual({ ...legacy.blocks, readingClasses: false });
    // Read again as stored, it is the same.
    expect(OpacHomeContent.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
    // In either language the page shows the same heading as before.
    expect(opacHomeTextIn(read.title, 'id')?.text).toBe('Ruang baca untuk semua');
    expect(opacHomeTextIn(read.title, 'en')?.text).toBe('Ruang baca untuk semua');
    expect(OpacHomeContent.parse({ ...legacy, title: null }).title).toEqual({ id: null, en: null });
  });

  it('each language keeps its own width, and an error names its language', () => {
    const body = (title: unknown) => ({ revision: '0123456789abcdef', home: { ...OPAC_HOME_DEFAULT, title }, welcome: { id: null, en: null } });
    expect(issues(OpacHomePutBody, body({ id: 'a'.repeat(90), en: 'b'.repeat(91) }))).toEqual([{ path: 'home.title.en', code: 'too_big' }]);
    expect(issues(OpacHomePutBody, body({ id: null, en: null, fr: 'x' }))).toEqual([{ path: 'home.title', code: 'unrecognized_keys' }]);
  });
});

describe('the opening hours and the blocks', () => {
  it('a row names ISO weekdays 1-7, each once', () => {
    const hours = (weekdays: unknown) => ({ ...OPAC_HOME_DEFAULT, hours: [{ days: 'Senin', time: '07.00–15.00', weekdays }] });
    expect(OpacHomeContent.parse(hours([1, 2, 3])).hours[0]!.weekdays).toEqual([1, 2, 3]);
    expect(issues(OpacHomeContent, hours([1, 1]))).toEqual([{ path: 'hours.0.weekdays', code: 'duplicate' }]);
    expect(issues(OpacHomeContent, hours([0]))).toEqual([{ path: 'hours.0.weekdays.0', code: 'too_small' }]);
    expect(issues(OpacHomeContent, hours([8]))).toEqual([{ path: 'hours.0.weekdays.0', code: 'too_big' }]);
  });

  it('the loans per class are off unless switched on; every other block is on by default', () => {
    expect(OPAC_HOME_BLOCKS).toContain('readingClasses');
    expect(OPAC_HOME_BLOCK_DEFAULTS.readingClasses).toBe(false);
    for (const b of OPAC_HOME_BLOCKS) if (b !== 'readingClasses') expect(OPAC_HOME_BLOCK_DEFAULTS[b], b).toBe(true);
    expect(OPAC_HOME_DEFAULT.blocks).toEqual(OPAC_HOME_BLOCK_DEFAULTS);
  });
});

describe('the logo and the public contact', () => {
  const LOGO = '01JZFXQ0000000000000000009';

  it('a content saved before they existed reads them as none', () => {
    const old: Record<string, unknown> = { ...OPAC_HOME_DEFAULT };
    delete old['logo'];
    delete old['contact'];
    const parsed = OpacHomeContent.parse(old);
    expect(parsed.logo).toBeNull();
    expect(parsed.contact).toEqual({ phone: null, email: null });
  });

  it('the logo needs its alternative text, and is a file used once', () => {
    expect(issues(OpacHomeContent, { ...OPAC_HOME_DEFAULT, logo: { fileId: LOGO, alt: '  ' } })).toEqual([{ path: 'logo.alt', code: 'too_small' }]);
    expect(OpacHomeContent.parse({ ...OPAC_HOME_DEFAULT, logo: { fileId: LOGO, alt: ' Logo perpustakaan ' } }).logo).toEqual({ fileId: LOGO, alt: 'Logo perpustakaan' });
    const twice = { ...OPAC_HOME_DEFAULT, logo: { fileId: LOGO, alt: 'Logo' }, hero: { slides: [slide({ fileId: LOGO })] } };
    expect(issues(OpacHomeContent, twice)).toEqual([{ path: 'logo.fileId', code: 'duplicate' }]);
    expect(opacHomeFileIds({ ...OPAC_HOME_DEFAULT, logo: { fileId: LOGO, alt: 'Logo' } })).toEqual([LOGO]);
  });

  it('a telephone number of 6 to 15 digits with spaces, brackets, points or hyphens, a leading + for an international one', () => {
    for (const ok of ['(021) 555-0101', '+62 21 5550101', '0812.3456.7890', '021-5550101']) {
      expect(OpacHomeContact.parse({ phone: ` ${ok} `, email: null }).phone, ok).toBe(ok);
    }
    for (const bad of ['12345', '0812-3456-7890-1234-5', '62+21 555', 'telepon 021', '021 555 0101 ext 3', '++62215550101']) {
      expect(issues(OpacHomeContact, { phone: bad, email: null }), bad).toEqual([{ path: 'phone', code: 'invalid_format' }]);
    }
    expect(issues(OpacHomeContact, { phone: '0'.repeat(31), email: null }).map((i) => i.code)).toContain('too_big');
    expect(phoneHref('(021) 555-0101')).toBe('tel:0215550101');
    expect(phoneHref(' +62 21 5550101')).toBe('tel:+62215550101');
  });

  it('an e-mail address, trimmed; anything else is refused', () => {
    expect(OpacHomeContact.parse({ phone: null, email: ' perpustakaan@sekolah.example ' }).email).toBe('perpustakaan@sekolah.example');
    expect(issues(OpacHomeContact, { phone: null, email: 'perpustakaan' })).toEqual([{ path: 'email', code: 'invalid_format' }]);
    expect(issues(OpacHomeContact, { phone: null, email: `${'a'.repeat(185)}@x.example` }).map((i) => i.code)).toContain('too_big');
  });
});
