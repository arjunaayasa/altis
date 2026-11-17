import { describe, expect, it } from 'vitest';
import { issueCode } from '../src/api/common.js';
import {
  OPAC_HOME_BLOCK_DEFAULTS,
  OPAC_HOME_BLOCKS,
  OPAC_HOME_DEFAULT,
  OPAC_HOME_MIN_CONTRAST,
  OPAC_HOME_OVERLAY,
  OpacHomeContact,
  OpacHomeContent,
  OpacHomePutBody,
  brandRgb,
  contrastWithWhite,
  opacHomeBrandField,
  opacHomeFileIds,
  opacHomeTextIn,
  overlayOnWhite,
  phoneHref,
} from '../src/api/opac-home.js';

// The content of the OPAC home page (`opac.home`): the overlay's floor that keeps white text at WCAG AA over any photo,
// the library colour taken only as a dark enough `#rrggbb`, the heading and "about" paragraph per language with the
// other language as fallback (a content saved with one text each still reads, as the Indonesian texts), the weekdays
// of an opening hours row, and the loans per class off unless a library switches them on.

const FILE = '01JZFXQ0000000000000000007';

/** The codes of the issues `value` raises under `schema`, by path. */
function issues(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; params?: Record<string, unknown> }[] } } }, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error!.issues.map((i) => ({ path: i.path.map(String).join('.'), code: issueCode(i) }));
}

describe('the hero overlay', () => {
  it('its floor keeps white text at 4.5:1 or more over a pure white photo; one step lighter would not', () => {
    expect(OPAC_HOME_OVERLAY).toEqual({ min: 60, max: 80, step: 5, default: 60 });
    expect(contrastWithWhite(overlayOnWhite(OPAC_HOME_OVERLAY.min))).toBeGreaterThanOrEqual(OPAC_HOME_MIN_CONTRAST);
    expect(contrastWithWhite(overlayOnWhite(OPAC_HOME_OVERLAY.min - OPAC_HOME_OVERLAY.step))).toBeLessThan(OPAC_HOME_MIN_CONTRAST);
    for (let p = OPAC_HOME_OVERLAY.min; p <= OPAC_HOME_OVERLAY.max; p += OPAC_HOME_OVERLAY.step) {
      expect(contrastWithWhite(overlayOnWhite(p))).toBeGreaterThanOrEqual(OPAC_HOME_MIN_CONTRAST);
    }
  });

  it('takes 60-80 in steps of 5, 60 when not given (a hero saved before it existed)', () => {
    const hero = (overlay?: unknown) => ({ ...OPAC_HOME_DEFAULT, hero: { fileId: FILE, alt: 'Gedung', position: 50, ...(overlay === undefined ? {} : { overlay }) } });
    expect(OpacHomeContent.parse(hero()).hero?.overlay).toBe(60);
    expect(OpacHomeContent.parse(hero(75)).hero?.overlay).toBe(75);
    expect(issues(OpacHomeContent, hero(55))).toEqual([{ path: 'hero.overlay', code: 'too_small' }]);
    expect(issues(OpacHomeContent, hero(85))).toEqual([{ path: 'hero.overlay', code: 'too_big' }]);
    expect(issues(OpacHomeContent, hero(62))).toEqual([{ path: 'hero.overlay', code: 'not_multiple_of' }]);
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
    expect(read.hero).toEqual({ fileId: FILE, alt: 'Gedung', position: 40, overlay: 60 });
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
    const twice = { ...OPAC_HOME_DEFAULT, logo: { fileId: LOGO, alt: 'Logo' }, hero: { fileId: LOGO, alt: 'Gedung', position: 50, overlay: 60 } };
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
