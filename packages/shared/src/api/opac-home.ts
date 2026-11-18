/**
 * The OPAC home page as the library's profile site: what the admin screen OPAC › Halaman awal edits and the OPAC home
 * page shows. One setting (`opac.home`) holds the page's own content: the hero's slides (each a photo with its texts,
 * an optional button and the days it shows), the library colour, the heading, the "about" block with its photo and two
 * facts, the library's profile (its history and timeline, vision, mission and the people who run it), the services, up
 * to four facility photos, a gallery, the opening hours (each row with the weekdays it covers, so the page can mark
 * today's) and which blocks show. Photos are JPEG uploads of the context `opac.home_photo`, cropped in the browser (a
 * slide to 16:9, the others to 4:3) and claimed as public files of the setting when it is saved.
 *
 * Texts the visitor reads are written per language (Indonesian and English); a page in one language shows the other's
 * text when its own is blank. A content saved before a text was per language (one text) still reads: that text is the
 * Indonesian one, which the English page then shows as before. The services, facility captions and hours are the
 * library's own text in the library's language.
 *
 * A slide's text stands on a panel of the library colour beside its photo, never over the photo, so it needs no
 * darkening of the photo: its contrast is that of white on the library colour, which the colour's own field checks.
 * A slide without a title shows the page's heading, and without a subtitle the welcome text of the language
 * (`opac.welcome.id`, `opac.welcome.en`, edited on the same screen). A slide's button leads to a place of this site,
 * given as a kind and a reference (never a free URL).
 *
 * A content saved when the hero was one photo (`{fileId, alt, position, overlay}`) still reads: that photo is the one
 * slide, shown always, with no texts of its own (so the page's heading and the welcome text, as before); the darkness
 * of the old overlay is dropped.
 *
 * The library's logo (shown with its name in the site's header and footer) is an upload of the same context, fitted in
 * the browser onto a white tile, with its alternative text. The public contact (a telephone number and an e-mail
 * address the library publishes) is part of the content too; the address may not be any user's or member's own. The
 * people of the profile are names and roles the staff type in for publication; they are never read from member or
 * user records.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/opac-home`.
 */
import { z } from 'zod';
import { isCalendarDate, localDate } from '../dates.js';
import { ulidField } from './common.js';
import { pageSlugField } from './opac-pages.js';
import type { OpacAccent } from './settings.js';

/** The blocks of the home page an admin can switch off, in the order the page shows them. */
export const OPAC_HOME_BLOCKS = Object.freeze(['classes', 'popular', 'newTitles', 'promoted', 'about', 'services', 'readingClasses', 'news', 'visit'] as const);

export type OpacHomeBlock = (typeof OPAC_HOME_BLOCKS)[number];

/**
 * Whether each block shows on a page that has not said: all of them, except the loans per class (a library switches
 * that one on itself). A content saved before a block existed reads as this for it.
 */
export const OPAC_HOME_BLOCK_DEFAULTS: Readonly<Record<OpacHomeBlock, boolean>> = Object.freeze(
  Object.fromEntries(OPAC_HOME_BLOCKS.map((b) => [b, b !== 'readingClasses'])) as Record<OpacHomeBlock, boolean>,
);

/** The languages the page's heading and "about" paragraph are written in. */
export const OPAC_HOME_LANGS = Object.freeze(['id', 'en'] as const);

export type OpacHomeLang = (typeof OPAC_HOME_LANGS)[number];

/** The widths of the texts and the sizes of the lists (Zod counts code points, as the admin's counters do). */
export const OPAC_HOME_LIMITS = Object.freeze({
  title: 90,
  alt: 160,
  caption: 120,
  aboutText: 600,
  serviceTitle: 60,
  serviceText: 160,
  services: 8,
  facilities: 4,
  hours: 7,
  hoursDays: 40,
  hoursTime: 40,
  /** The welcome texts keep the width of their settings. */
  welcome: 1000,
  // The hero's slides.
  slides: 6,
  slideNote: 60,
  slideTitle: 80,
  slideSubtitle: 200,
  ctaLabel: 40,
  targetPath: 200,
  // The library's profile.
  history: 4000,
  timeline: 12,
  timelineText: 240,
  vision: 400,
  mission: 8,
  missionText: 240,
  staff: 24,
  staffName: 80,
  staffRole: 80,
  gallery: 8,
});

/** A slide's photo is cropped in the browser to this 16:9 size. */
export const OPAC_HOME_HERO_SIZE = Object.freeze({ width: 1600, height: 900 });
/** The "about" and facility photos are cropped in the browser to this 4:3 size. */
export const OPAC_HOME_PHOTO_SIZE = Object.freeze({ width: 1200, height: 900 });
/** The largest photo upload after the crop (the upload context's limit). */
export const OPAC_HOME_PHOTO_MAX_BYTES = 500 * 1024;
/** The smallest and largest side of a photo the server accepts (its dimensions are read from the JPEG itself). */
export const OPAC_HOME_PHOTO_SIDES = Object.freeze({ min: 240, max: 2400 });
/** A slide photo's vertical position (`object-position`), in steps of 10 from the top (0) to the bottom (100). */
export const OPAC_HOME_POSITION_STEP = 10;

/** The contrast white text must keep on the library colour (the header bar and the panel of a slide's text). */
export const OPAC_HOME_MIN_CONTRAST = 4.5;

/** The relative luminance (WCAG 2) of an sRGB colour of 0-255 channels. */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of white text on an sRGB colour (1 to 21). */
export function contrastWithWhite(rgb: readonly [number, number, number]): number {
  return 1.05 / (relativeLuminance(rgb) + 0.05);
}

/** A library colour as the setting holds it: `#` and six lower-case hex digits. */
export const OPAC_HOME_BRAND_PATTERN = /^#[0-9a-f]{6}$/;

/** The channels of a library colour (`#rrggbb`); null when it is not one. */
export function brandRgb(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string' || !OPAC_HOME_BRAND_PATTERN.test(value)) return null;
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The library colour: a hex colour (`#0f766e`, any case, stored lower case) dark enough for white text on it
 * (`low_contrast` otherwise). Only a value of this form ever reaches the page's style, rebuilt from its digits.
 */
export const opacHomeBrandField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(OPAC_HOME_BRAND_PATTERN)
  .superRefine((value, ctx) => {
    const rgb = brandRgb(value);
    if (rgb !== null && contrastWithWhite(rgb) < OPAC_HOME_MIN_CONTRAST) {
      ctx.addIssue({ code: 'custom', message: 'low_contrast', params: { code: 'low_contrast' } });
    }
  });

/** The year the library was founded: four digits, not in the far future. */
export const OPAC_HOME_FOUNDED = Object.freeze({ min: 1000, max: 2100 });
/** How many librarians the library has. */
export const OPAC_HOME_LIBRARIANS_MAX = 999;

/** A trimmed text of at most `max` code points. */
const text = (max: number) => z.string().trim().max(max);
/** A trimmed text of 1 to `max` code points. */
const required = (max: number) => z.string().trim().min(1).max(max);

/** A photo of the page: an `opac.home_photo` upload, its alternative text (required) and an optional caption. */
export const OpacHomePhoto = z.strictObject({
  fileId: ulidField,
  alt: required(OPAC_HOME_LIMITS.alt),
  caption: text(OPAC_HOME_LIMITS.caption).nullable(),
});

export type OpacHomePhoto = z.infer<typeof OpacHomePhoto>;

/** A text of the page in each language; null or blank: none there (the other language's shows instead). */
export interface OpacHomeText {
  id: string | null;
  en: string | null;
}

/** The value a text saved before it was written per language reads as: that text, as the Indonesian one. */
function perLanguage(value: unknown): unknown {
  if (value === null || value === undefined) return { id: null, en: null };
  if (typeof value === 'string') return { id: value, en: null };
  return value;
}

/** A text of at most `max` code points in each language (see {@link OpacHomeText}). */
const localized = (max: number) => z.preprocess(perLanguage, z.strictObject({ id: text(max).nullable(), en: text(max).nullable() }));

/** As {@link localized}, with a text in one language at least (`required` otherwise). */
const requiredLocalized = (max: number) =>
  localized(max).superRefine((value, ctx) => {
    if (opacHomeTextIn(value, 'id') === null) ctx.addIssue({ code: 'custom', message: 'required', params: { code: 'required' } });
  });

/**
 * The text of `value` a page in `lang` shows: its own when it is not blank, else the other language's, with the
 * language it is in; null when both are blank.
 */
export function opacHomeTextIn(value: OpacHomeText, lang: OpacHomeLang): { text: string; lang: OpacHomeLang } | null {
  const other: OpacHomeLang = lang === 'id' ? 'en' : 'id';
  for (const l of [lang, other]) {
    const t = value[l];
    if (t !== null && t.trim() !== '') return { text: t, lang: l };
  }
  return null;
}

// ---- Komunitas (OPAC look): the logo and the public contact ----
/**
 * The logo is fitted in the browser into a white tile this high, its width following the logo's proportions between a
 * square and four times the height (a taller logo is centred on a square tile).
 */
export const OPAC_HOME_LOGO_SIZE = Object.freeze({ height: 240, minWidth: 240, maxWidth: 960 });

/** The library's logo: an `opac.home_photo` upload and its alternative text (required). */
export const OpacHomeLogo = z.strictObject({
  fileId: ulidField,
  alt: required(OPAC_HOME_LIMITS.alt),
});

export type OpacHomeLogo = z.infer<typeof OpacHomeLogo>;

/** The longest telephone number and e-mail address the page publishes. */
export const OPAC_HOME_CONTACT_LIMITS = Object.freeze({ phone: 30, email: 191 });

/**
 * A telephone number as the library writes it: 6 to 15 digits with spaces, brackets, points or hyphens between them, and
 * a leading `+` for an international number (`(021) 555-0101`, `+62 21 5550101`).
 */
export const OPAC_HOME_PHONE_PATTERN = /^\+?(?:[ ().-]*[0-9]){6,15}[ ().-]*$/;

/** The `tel:` link of a telephone number: its digits, with the leading `+` it was written with. */
export function phoneHref(phone: string): string {
  const v = phone.trim();
  return `tel:${v.startsWith('+') ? '+' : ''}${v.replace(/[^0-9]/g, '')}`;
}

/** The public contact: each null when the library publishes none. */
export const OpacHomeContact = z.strictObject({
  phone: z.string().trim().max(OPAC_HOME_CONTACT_LIMITS.phone).regex(OPAC_HOME_PHONE_PATTERN).nullable(),
  email: z.string().trim().max(OPAC_HOME_CONTACT_LIMITS.email).pipe(z.email()).nullable(),
});

export type OpacHomeContact = z.infer<typeof OpacHomeContact>;

// ---- The hero's slides ----
/** How long a slide stays before the next one, in seconds. */
export const OPAC_HOME_INTERVALS = Object.freeze([5, 7, 10] as const);

export type OpacHomeInterval = (typeof OPAC_HOME_INTERVALS)[number];

export const OPAC_HOME_INTERVAL_DEFAULT: OpacHomeInterval = 7;

/** Where a slide's button leads: the catalogue's search, the library's profile, the news (or one post), or a path of this site. */
export const OPAC_HOME_TARGET_KINDS = Object.freeze(['catalog', 'profile', 'news', 'path'] as const);

export type OpacHomeTargetKind = (typeof OPAC_HOME_TARGET_KINDS)[number];

/** A character a path of this site may not hold: a control character, a space, a backslash, a line or paragraph separator. */
function unsafePathChar(code: number): boolean {
  return code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c || code === 0x2028 || code === 0x2029;
}

/**
 * Whether `value` is a path of this site a button may lead to: it starts with one `/`, holds no `//` (so it is never
 * read as another host), no backslash (which a browser reads as `/`), no space and no control character, and is at
 * most {@link OPAC_HOME_LIMITS}.targetPath characters long. `/berita/rss`, `/cari?q=sejarah#hasil`; never
 * `https://…`, `//host`, `/\\host`, `javascript:…`.
 */
export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > OPAC_HOME_LIMITS.targetPath) return false;
  if (!value.startsWith('/') || value.includes('//')) return false;
  for (let i = 0; i < value.length; i++) if (unsafePathChar(value.charCodeAt(i))) return false;
  return true;
}

/** A path of this site (see {@link isSafeInternalPath}); `invalid` otherwise. */
export const opacHomePathField = z.string().superRefine((value, ctx) => {
  if (!isSafeInternalPath(value)) ctx.addIssue({ code: 'custom', message: 'invalid', params: { code: 'invalid' } });
});

/**
 * Where a slide's button leads, as a kind and a reference, never a free URL: the catalogue's search, the library's
 * profile, the news list (or, with `ref`, the news post of that slug), or a path of this site.
 */
export const OpacHomeTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('catalog') }),
  z.strictObject({ kind: z.literal('profile') }),
  z.strictObject({ kind: z.literal('news'), ref: pageSlugField.optional() }),
  z.strictObject({ kind: z.literal('path'), ref: opacHomePathField }),
]);

export type OpacHomeTarget = z.infer<typeof OpacHomeTarget>;

/** A calendar date `YYYY-MM-DD`. */
const dateField = z.string().check((ctx) => {
  if (!isCalendarDate(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'date', input: ctx.value });
});

/** What names a slide within the hero: 1 to 32 of `A-Z a-z 0-9 _ -` (the editor gives each slide one when it is added). */
export const opacHomeSlideIdField = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

/** A slide's button: its label (in one language at least) and where it leads. */
export const OpacHomeCta = z.strictObject({
  label: requiredLocalized(OPAC_HOME_LIMITS.ctaLabel),
  target: OpacHomeTarget,
});

export type OpacHomeCta = z.infer<typeof OpacHomeCta>;

/**
 * One slide of the hero: its photo (an `opac.home_photo` upload with its alternative text and vertical position), a
 * short note above the title, the title and the subtitle per language, an optional button, whether it shows at all,
 * and the first and last day it shows (each null: no limit; the days are the library's, see {@link opacHomeSlideShown}).
 */
export const OpacHomeSlide = z
  .strictObject({
    id: opacHomeSlideIdField,
    fileId: ulidField,
    alt: required(OPAC_HOME_LIMITS.alt),
    position: z.int().min(0).max(100).multipleOf(OPAC_HOME_POSITION_STEP),
    note: localized(OPAC_HOME_LIMITS.slideNote),
    title: localized(OPAC_HOME_LIMITS.slideTitle),
    subtitle: localized(OPAC_HOME_LIMITS.slideSubtitle),
    cta: OpacHomeCta.nullable(),
    active: z.boolean(),
    from: dateField.nullable(),
    until: dateField.nullable(),
  })
  .superRefine((slide, ctx) => {
    if (slide.from !== null && slide.until !== null && slide.from > slide.until) {
      ctx.addIssue({ code: 'custom', path: ['until'], message: 'invalid', params: { code: 'invalid' } });
    }
  });

export type OpacHomeSlide = z.infer<typeof OpacHomeSlide>;

/** The id of the slide a hero saved as one photo reads as. */
export const OPAC_HOME_LEGACY_SLIDE_ID = 'slide-1';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The value a hero saved before it had slides reads as: no hero (null, or none at all) is a hero without slides; one
 * photo (`{fileId, alt, position}`, with or without the darkness of its old overlay, which is dropped) is its one
 * slide, shown always, without texts or a button of its own.
 */
function heroWithSlides(value: unknown): unknown {
  if (value === null || value === undefined) return { slides: [], autoplay: true, intervalSec: OPAC_HOME_INTERVAL_DEFAULT };
  if (isRecord(value) && !('slides' in value) && 'fileId' in value) {
    const none = { id: null, en: null };
    return {
      slides: [
        {
          id: OPAC_HOME_LEGACY_SLIDE_ID,
          fileId: value['fileId'],
          alt: value['alt'],
          position: value['position'],
          note: none,
          title: none,
          subtitle: none,
          cta: null,
          active: true,
          from: null,
          until: null,
        },
      ],
      autoplay: true,
      intervalSec: OPAC_HOME_INTERVAL_DEFAULT,
    };
  }
  return value;
}

/** The hero: its slides in order (each id once), whether they advance by themselves, and how long each stays. */
export const OpacHomeHero = z.preprocess(
  heroWithSlides,
  z.strictObject({
    slides: z
      .array(OpacHomeSlide)
      .max(OPAC_HOME_LIMITS.slides)
      .superRefine((slides, ctx) => {
        const seen = new Set<string>();
        slides.forEach((slide, i) => {
          if (seen.has(slide.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'duplicate', params: { code: 'duplicate' } });
          seen.add(slide.id);
        });
      }),
    autoplay: z.boolean().default(true),
    intervalSec: z.literal([...OPAC_HOME_INTERVALS]).default(OPAC_HOME_INTERVAL_DEFAULT),
  }),
);

export type OpacHomeHero = z.infer<typeof OpacHomeHero>;

/**
 * Whether `slide` shows on the calendar day `today` (`YYYY-MM-DD`): it is switched on, and the day is neither before
 * its first day nor after its last.
 */
export function opacHomeSlideShown(slide: Pick<OpacHomeSlide, 'active' | 'from' | 'until'>, today: string): boolean {
  if (!slide.active) return false;
  if (slide.from !== null && today < slide.from) return false;
  return slide.until === null || today <= slide.until;
}

/**
 * The slides of `hero` that show at the instant `epochMs`, in their order: a slide's days are calendar days of the
 * library's time zone (`library.timezone`), so a slide whose last day is today shows until the library's midnight.
 *
 * @throws RangeError for a time zone `Intl` does not know
 */
export function opacHomeSlidesAt(hero: Pick<OpacHomeHero, 'slides'>, timeZone: string, epochMs: number): OpacHomeSlide[] {
  const today = localDate(timeZone, epochMs);
  return hero.slides.filter((slide) => opacHomeSlideShown(slide, today));
}

// ---- The library's profile ----
/** A photo of the gallery: an `opac.home_photo` upload, its alternative text (required) and a caption per language. */
export const OpacHomeGalleryPhoto = z.strictObject({
  fileId: ulidField,
  alt: required(OPAC_HOME_LIMITS.alt),
  caption: localized(OPAC_HOME_LIMITS.caption),
});

export type OpacHomeGalleryPhoto = z.infer<typeof OpacHomeGalleryPhoto>;

/** One entry of the library's timeline: a year and what happened. */
export const OpacHomeTimelineEntry = z.strictObject({
  year: z.int().min(OPAC_HOME_FOUNDED.min).max(OPAC_HOME_FOUNDED.max),
  text: requiredLocalized(OPAC_HOME_LIMITS.timelineText),
});

export type OpacHomeTimelineEntry = z.infer<typeof OpacHomeTimelineEntry>;

/**
 * One of the people who run the library, as the profile names them: a name and a role, typed in for publication by
 * the staff. Never a member's or a user's record.
 */
export const OpacHomeStaff = z.strictObject({
  name: required(OPAC_HOME_LIMITS.staffName),
  role: localized(OPAC_HOME_LIMITS.staffRole),
});

export type OpacHomeStaff = z.infer<typeof OpacHomeStaff>;

/** One service of the library: a name and a short explanation. */
export const OpacHomeService = z.strictObject({
  title: required(OPAC_HOME_LIMITS.serviceTitle),
  text: text(OPAC_HOME_LIMITS.serviceText).nullable(),
});

export type OpacHomeService = z.infer<typeof OpacHomeService>;

/** The days of the week by ISO number: 1 Monday to 7 Sunday. */
export const OPAC_HOME_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7] as const);

/**
 * One row of the opening hours: the days ("Senin–Kamis") and the time ("07.00–15.30", "Tutup"), as the library writes
 * them, and the weekdays the row covers (ISO numbers, each once), by which the page marks today's row; none: the row is
 * never marked.
 */
export const OpacHomeHours = z.strictObject({
  days: required(OPAC_HOME_LIMITS.hoursDays),
  time: required(OPAC_HOME_LIMITS.hoursTime),
  weekdays: z
    .array(z.int().min(1).max(7))
    .max(7)
    .superRefine((list, ctx) => {
      if (new Set(list).size !== list.length) ctx.addIssue({ code: 'custom', message: 'duplicate', params: { code: 'duplicate' } });
    })
    .default([]),
});

export type OpacHomeHours = z.infer<typeof OpacHomeHours>;

/** Which blocks show (a block without content is hidden whatever it says); a block not named reads as its default. */
export const OpacHomeBlocks = z.strictObject(
  Object.fromEntries(OPAC_HOME_BLOCKS.map((b) => [b, z.boolean().default(OPAC_HOME_BLOCK_DEFAULTS[b])])) as Record<
    OpacHomeBlock,
    z.ZodDefault<z.ZodBoolean>
  >,
);

export type OpacHomeBlocks = z.infer<typeof OpacHomeBlocks>;

/** Each photo a content names, by its place in the content: the slides, the logo, the "about" photo, the facilities, the gallery. */
export function opacHomeFilePaths(home: Pick<OpacHomeContent, 'hero' | 'logo' | 'about' | 'facilities' | 'gallery'>): { fileId: string; path: (string | number)[] }[] {
  const found: { fileId: string; path: (string | number)[] }[] = [];
  home.hero.slides.forEach((slide, i) => found.push({ fileId: slide.fileId, path: ['hero', 'slides', i, 'fileId'] }));
  if (home.logo !== null) found.push({ fileId: home.logo.fileId, path: ['logo', 'fileId'] });
  if (home.about.photo !== null) found.push({ fileId: home.about.photo.fileId, path: ['about', 'photo', 'fileId'] });
  home.facilities.forEach((f, i) => found.push({ fileId: f.fileId, path: ['facilities', i, 'fileId'] }));
  home.gallery.forEach((g, i) => found.push({ fileId: g.fileId, path: ['gallery', i, 'fileId'] }));
  return found;
}

/** The file ids a content names: every slide's photo, the logo, the "about" photo, the facility and the gallery photos. */
export function opacHomeFileIds(home: Pick<OpacHomeContent, 'hero' | 'logo' | 'about' | 'facilities' | 'gallery'>): string[] {
  return opacHomeFilePaths(home).map((f) => f.fileId);
}

const NO_TEXT = Object.freeze({ id: null, en: null });

/** The value of the setting `opac.home`. A photo is used once at most. */
export const OpacHomeContent = z
  .strictObject({
    /** The page's heading in each language (a slide without a title of its own shows it); none in either: the library's name. */
    title: localized(OPAC_HOME_LIMITS.title),
    hero: OpacHomeHero,
    /** The library colour (the header bar, the panel of a slide's text); null: the colour of the OPAC's accent. */
    brand: opacHomeBrandField.nullable().default(null),
    about: z.strictObject({
      text: localized(OPAC_HOME_LIMITS.aboutText),
      photo: OpacHomePhoto.nullable(),
      founded: z.int().min(OPAC_HOME_FOUNDED.min).max(OPAC_HOME_FOUNDED.max).nullable(),
      librarians: z.int().min(0).max(OPAC_HOME_LIBRARIANS_MAX).nullable(),
      /** The library's history, for its profile (paragraphs apart by a blank line). */
      history: localized(OPAC_HOME_LIMITS.history),
    }),
    services: z.array(OpacHomeService).max(OPAC_HOME_LIMITS.services),
    facilities: z.array(OpacHomePhoto).max(OPAC_HOME_LIMITS.facilities),
    hours: z.array(OpacHomeHours).max(OPAC_HOME_LIMITS.hours),
    blocks: OpacHomeBlocks,
    // ---- Komunitas (OPAC look) ----
    /** The library's logo beside its name in the header and the footer; null: the name alone. */
    logo: OpacHomeLogo.nullable().default(null),
    /** The telephone number and e-mail address the site publishes. */
    contact: OpacHomeContact.default({ phone: null, email: null }),
    // ---- The library's profile (a content saved before it reads each as none) ----
    /** The library's timeline, in the order the profile lists it. */
    timeline: z.array(OpacHomeTimelineEntry).max(OPAC_HOME_LIMITS.timeline).default([]),
    vision: localized(OPAC_HOME_LIMITS.vision),
    mission: z.array(requiredLocalized(OPAC_HOME_LIMITS.missionText)).max(OPAC_HOME_LIMITS.mission).default([]),
    /** The people who run the library, as typed in for publication. */
    staff: z.array(OpacHomeStaff).max(OPAC_HOME_LIMITS.staff).default([]),
    gallery: z.array(OpacHomeGalleryPhoto).max(OPAC_HOME_LIMITS.gallery).default([]),
  })
  .superRefine((home, ctx) => {
    const seen = new Set<string>();
    for (const { fileId, path } of opacHomeFilePaths(home)) {
      if (seen.has(fileId)) ctx.addIssue({ code: 'custom', path, message: 'duplicate', params: { code: 'duplicate' } });
      seen.add(fileId);
    }
  });

export type OpacHomeContent = z.infer<typeof OpacHomeContent>;

/** What a library that has not set up its home page shows: no photo or profile, the blocks at their defaults. */
export const OPAC_HOME_DEFAULT: OpacHomeContent = Object.freeze({
  title: Object.freeze({ id: null, en: null }),
  hero: Object.freeze({ slides: Object.freeze([]) as unknown as OpacHomeSlide[], autoplay: true, intervalSec: OPAC_HOME_INTERVAL_DEFAULT }),
  brand: null,
  about: Object.freeze({ text: NO_TEXT, photo: null, founded: null, librarians: null, history: NO_TEXT }),
  services: Object.freeze([]) as unknown as OpacHomeService[],
  facilities: Object.freeze([]) as unknown as OpacHomePhoto[],
  hours: Object.freeze([]) as unknown as OpacHomeHours[],
  blocks: Object.freeze({ ...OPAC_HOME_BLOCK_DEFAULTS }),
  logo: null,
  contact: Object.freeze({ phone: null, email: null }),
  timeline: Object.freeze([]) as unknown as OpacHomeTimelineEntry[],
  vision: NO_TEXT,
  mission: Object.freeze([]) as unknown as OpacHomeText[],
  staff: Object.freeze([]) as unknown as OpacHomeStaff[],
  gallery: Object.freeze([]) as unknown as OpacHomeGalleryPhoto[],
}) as OpacHomeContent;

/** A welcome text (the subtitle of a slide without one of its own) of one language; null or blank: none. */
export const opacHomeWelcomeField = z.string().max(OPAC_HOME_LIMITS.welcome).nullable();

/** The revision of what the screen loaded: 16 lower-case hex digits. */
export const opacHomeRevisionField = z.string().regex(/^[0-9a-f]{16}$/);

/** `GET opac/home`. */
export interface OpacHomeView {
  home: OpacHomeContent;
  welcome: { id: string | null; en: string | null };
  /** Changes whenever the content or a welcome text changes; a save names the one it started from. */
  revision: string;
  /** For the preview: the heading of a page without a title of its own, and the colour without a library colour. */
  libraryName: string;
  accent: OpacAccent;
}

/** `PUT opac/home`: the whole content and both welcome texts, with the revision they were loaded at. */
export const OpacHomePutBody = z.strictObject({
  revision: opacHomeRevisionField,
  home: OpacHomeContent,
  welcome: z.strictObject({ id: opacHomeWelcomeField, en: opacHomeWelcomeField }),
});

export type OpacHomePutBody = z.infer<typeof OpacHomePutBody>;

/** The answer of `PUT opac/home`: the new revision and the settings that changed. */
export interface OpacHomePutResponse {
  revision: string;
  changed: string[];
}
