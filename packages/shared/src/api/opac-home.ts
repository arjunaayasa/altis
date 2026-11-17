/**
 * The OPAC home page as the library's profile site: what the admin screen OPAC › Halaman awal edits and the OPAC home
 * page shows. One setting (`opac.home`) holds the page's own content: the hero photo (with its position and the
 * darkness of the overlay over it), the library colour of a hero without a photo, the heading, the "about" block with
 * its photo and two facts, the services, up to four facility photos, the opening hours (each row with the weekdays it
 * covers, so the page can mark today's) and which blocks show. The hero's lead sentence is the welcome text of each
 * language (`opac.welcome.id`, `opac.welcome.en`), edited on the same screen. Photos are JPEG uploads of the context
 * `opac.home_photo`, cropped in the browser (the hero to 16:9, the others to 4:3) and claimed as public files of the
 * setting when it is saved.
 *
 * The heading and the "about" paragraph are written per language (Indonesian and English); a page in one language
 * shows the other's text when its own is blank. A content saved before they were (one text each) still reads: that
 * text is the Indonesian one, which the English page then shows as before. The services, captions and hours are the
 * library's own text in the library's language.
 *
 * The library's logo (shown with its name in the site's header and footer) is an upload of the same context, fitted in
 * the browser onto a white tile, with its alternative text. The public contact (a telephone number and an e-mail
 * address the library publishes) is part of the content too; the address may not be any user's or member's own.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/opac-home`.
 */
import { z } from 'zod';
import { ulidField } from './common.js';
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
});

/** The hero photo is cropped in the browser to this 16:9 size. */
export const OPAC_HOME_HERO_SIZE = Object.freeze({ width: 1600, height: 900 });
/** The "about" and facility photos are cropped in the browser to this 4:3 size. */
export const OPAC_HOME_PHOTO_SIZE = Object.freeze({ width: 1200, height: 900 });
/** The largest photo upload after the crop (the upload context's limit). */
export const OPAC_HOME_PHOTO_MAX_BYTES = 500 * 1024;
/** The smallest and largest side of a photo the server accepts (its dimensions are read from the JPEG itself). */
export const OPAC_HOME_PHOTO_SIDES = Object.freeze({ min: 240, max: 2400 });
/** The hero photo's vertical position (`object-position`), in steps of 10 from the top (0) to the bottom (100). */
export const OPAC_HOME_POSITION_STEP = 10;

/**
 * The darkness of the even overlay over the hero photo, in percent. Its floor keeps the band's white text at 4.5:1 or
 * more (WCAG AA for normal text) over any photo, a pure white one included: the overlay colour is
 * {@link OPAC_HOME_OVERLAY_RGB}, and one step lighter than the floor would fall under 4.5:1.
 */
export const OPAC_HOME_OVERLAY = Object.freeze({ min: 60, max: 80, step: 5, default: 60 });
/** The overlay's colour (a blue-tinted near black), as the OPAC theme paints it. */
export const OPAC_HOME_OVERLAY_RGB: readonly [number, number, number] = Object.freeze([8, 12, 20]) as readonly [number, number, number];
/** The contrast white text must keep on the library colour (and over the photo under its overlay). */
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

/** The colour of a white pixel under the overlay at `percent` darkness. */
export function overlayOnWhite(percent: number): [number, number, number] {
  const a = percent / 100;
  return OPAC_HOME_OVERLAY_RGB.map((c) => 255 * (1 - a) + c * a) as [number, number, number];
}

/** A library colour as the setting holds it: `#` and six lower-case hex digits. */
export const OPAC_HOME_BRAND_PATTERN = /^#[0-9a-f]{6}$/;

/** The channels of a library colour (`#rrggbb`); null when it is not one. */
export function brandRgb(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string' || !OPAC_HOME_BRAND_PATTERN.test(value)) return null;
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The library colour: a hex colour (`#0f766e`, any case, stored lower case) dark enough for the band's white text
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

/** The hero photo: as a photo, without a caption, with its vertical position and the darkness of its overlay. */
export const OpacHomeHero = z.strictObject({
  fileId: ulidField,
  alt: required(OPAC_HOME_LIMITS.alt),
  position: z.int().min(0).max(100).multipleOf(OPAC_HOME_POSITION_STEP),
  overlay: z.int().min(OPAC_HOME_OVERLAY.min).max(OPAC_HOME_OVERLAY.max).multipleOf(OPAC_HOME_OVERLAY.step).default(OPAC_HOME_OVERLAY.default),
});

export type OpacHomeHero = z.infer<typeof OpacHomeHero>;

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

/** The file ids a content names: the hero, the "about" photo and the facility photos. */
export function opacHomeFileIds(home: Pick<OpacHomeContent, 'hero' | 'logo' | 'about' | 'facilities'>): string[] {
  const ids: string[] = [];
  if (home.hero !== null) ids.push(home.hero.fileId);
  if (home.logo !== null) ids.push(home.logo.fileId);
  if (home.about.photo !== null) ids.push(home.about.photo.fileId);
  for (const f of home.facilities) ids.push(f.fileId);
  return ids;
}

/** The value of the setting `opac.home`. A photo is used once at most. */
export const OpacHomeContent = z
  .strictObject({
    /** The hero's heading in each language; none in either: the library's name. */
    title: localized(OPAC_HOME_LIMITS.title),
    hero: OpacHomeHero.nullable(),
    /** The band's colour without a photo; null: the colour of the OPAC's accent. */
    brand: opacHomeBrandField.nullable().default(null),
    about: z.strictObject({
      text: localized(OPAC_HOME_LIMITS.aboutText),
      photo: OpacHomePhoto.nullable(),
      founded: z.int().min(OPAC_HOME_FOUNDED.min).max(OPAC_HOME_FOUNDED.max).nullable(),
      librarians: z.int().min(0).max(OPAC_HOME_LIBRARIANS_MAX).nullable(),
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
  })
  .superRefine((home, ctx) => {
    const seen = new Set<string>();
    const paths: [string, (string | number)[]][] = [];
    if (home.hero !== null) paths.push([home.hero.fileId, ['hero', 'fileId']]);
    if (home.logo !== null) paths.push([home.logo.fileId, ['logo', 'fileId']]);
    if (home.about.photo !== null) paths.push([home.about.photo.fileId, ['about', 'photo', 'fileId']]);
    home.facilities.forEach((f, i) => paths.push([f.fileId, ['facilities', i, 'fileId']]));
    for (const [id, path] of paths) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path, message: 'duplicate', params: { code: 'duplicate' } });
      seen.add(id);
    }
  });

export type OpacHomeContent = z.infer<typeof OpacHomeContent>;

/** What a library that has not set up its home page shows: no photo or profile, the blocks at their defaults. */
export const OPAC_HOME_DEFAULT: OpacHomeContent = Object.freeze({
  title: Object.freeze({ id: null, en: null }),
  hero: null,
  brand: null,
  about: Object.freeze({ text: Object.freeze({ id: null, en: null }), photo: null, founded: null, librarians: null }),
  services: Object.freeze([]) as unknown as OpacHomeService[],
  facilities: Object.freeze([]) as unknown as OpacHomePhoto[],
  hours: Object.freeze([]) as unknown as OpacHomeHours[],
  blocks: Object.freeze({ ...OPAC_HOME_BLOCK_DEFAULTS }),
  logo: null,
  contact: Object.freeze({ phone: null, email: null }),
}) as OpacHomeContent;

/** A welcome text (the hero's lead sentence) of one language; null or blank: none. */
export const opacHomeWelcomeField = z.string().max(OPAC_HOME_LIMITS.welcome).nullable();

/** The revision of what the screen loaded: 16 lower-case hex digits. */
export const opacHomeRevisionField = z.string().regex(/^[0-9a-f]{16}$/);

/** `GET opac/home`. */
export interface OpacHomeView {
  home: OpacHomeContent;
  welcome: { id: string | null; en: string | null };
  /** Changes whenever the content or a welcome text changes; a save names the one it started from. */
  revision: string;
  /** For the preview: the hero's heading without a title of its own, and its colour without a photo. */
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
