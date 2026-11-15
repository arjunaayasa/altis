/**
 * The OPAC home page as the library's profile site: what the admin screen OPAC › Halaman awal edits and the OPAC home
 * page shows. One setting (`opac.home`) holds the page's own content: the hero photo and its title, the "about" block
 * with its photo and two facts, the services, up to four facility photos, the opening hours and which blocks show. The
 * hero's lead sentence is the welcome text of each language (`opac.welcome.id`, `opac.welcome.en`), edited on the same
 * screen. Photos are JPEG uploads of the context `opac.home_photo`, cropped in the browser (the hero to 16:9, the
 * others to 4:3) and claimed as public files of the setting when it is saved.
 *
 * The content is the library's own text in the library's language (one language, not a translation per locale).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/opac-home`.
 */
import { z } from 'zod';
import { ulidField } from './common.js';
import type { OpacAccent } from './settings.js';

/** The blocks of the home page an admin can switch off, in the order the page shows them. */
export const OPAC_HOME_BLOCKS = Object.freeze(['classes', 'popular', 'newTitles', 'promoted', 'about', 'services', 'news', 'visit'] as const);

export type OpacHomeBlock = (typeof OPAC_HOME_BLOCKS)[number];

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

/** The hero photo: as a photo, without a caption, with its vertical position. */
export const OpacHomeHero = z.strictObject({
  fileId: ulidField,
  alt: required(OPAC_HOME_LIMITS.alt),
  position: z.int().min(0).max(100).multipleOf(OPAC_HOME_POSITION_STEP),
});

export type OpacHomeHero = z.infer<typeof OpacHomeHero>;

/** One service of the library: a name and a short explanation. */
export const OpacHomeService = z.strictObject({
  title: required(OPAC_HOME_LIMITS.serviceTitle),
  text: text(OPAC_HOME_LIMITS.serviceText).nullable(),
});

export type OpacHomeService = z.infer<typeof OpacHomeService>;

/** One row of the opening hours: the days ("Senin–Kamis") and the time ("07.00–15.30", "Tutup"), as the library writes them. */
export const OpacHomeHours = z.strictObject({
  days: required(OPAC_HOME_LIMITS.hoursDays),
  time: required(OPAC_HOME_LIMITS.hoursTime),
});

export type OpacHomeHours = z.infer<typeof OpacHomeHours>;

/** Which blocks show (a block without content is hidden whatever it says). */
export const OpacHomeBlocks = z.strictObject(
  Object.fromEntries(OPAC_HOME_BLOCKS.map((b) => [b, z.boolean()])) as Record<OpacHomeBlock, z.ZodBoolean>,
);

export type OpacHomeBlocks = z.infer<typeof OpacHomeBlocks>;

/** The file ids a content names: the hero, the "about" photo and the facility photos. */
export function opacHomeFileIds(home: Pick<OpacHomeContent, 'hero' | 'about' | 'facilities'>): string[] {
  const ids: string[] = [];
  if (home.hero !== null) ids.push(home.hero.fileId);
  if (home.about.photo !== null) ids.push(home.about.photo.fileId);
  for (const f of home.facilities) ids.push(f.fileId);
  return ids;
}

/** The value of the setting `opac.home`. A photo is used once at most. */
export const OpacHomeContent = z
  .strictObject({
    /** The hero's heading; null: the library's name. */
    title: text(OPAC_HOME_LIMITS.title).nullable(),
    hero: OpacHomeHero.nullable(),
    about: z.strictObject({
      text: text(OPAC_HOME_LIMITS.aboutText).nullable(),
      photo: OpacHomePhoto.nullable(),
      founded: z.int().min(OPAC_HOME_FOUNDED.min).max(OPAC_HOME_FOUNDED.max).nullable(),
      librarians: z.int().min(0).max(OPAC_HOME_LIBRARIANS_MAX).nullable(),
    }),
    services: z.array(OpacHomeService).max(OPAC_HOME_LIMITS.services),
    facilities: z.array(OpacHomePhoto).max(OPAC_HOME_LIMITS.facilities),
    hours: z.array(OpacHomeHours).max(OPAC_HOME_LIMITS.hours),
    blocks: OpacHomeBlocks,
  })
  .superRefine((home, ctx) => {
    const seen = new Set<string>();
    const paths: [string, (string | number)[]][] = [];
    if (home.hero !== null) paths.push([home.hero.fileId, ['hero', 'fileId']]);
    if (home.about.photo !== null) paths.push([home.about.photo.fileId, ['about', 'photo', 'fileId']]);
    home.facilities.forEach((f, i) => paths.push([f.fileId, ['facilities', i, 'fileId']]));
    for (const [id, path] of paths) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path, message: 'duplicate', params: { code: 'duplicate' } });
      seen.add(id);
    }
  });

export type OpacHomeContent = z.infer<typeof OpacHomeContent>;

/** What a library that has not set up its home page shows: no photo or profile, every block on. */
export const OPAC_HOME_DEFAULT: OpacHomeContent = Object.freeze({
  title: null,
  hero: null,
  about: Object.freeze({ text: null, photo: null, founded: null, librarians: null }),
  services: Object.freeze([]) as unknown as OpacHomeService[],
  facilities: Object.freeze([]) as unknown as OpacHomePhoto[],
  hours: Object.freeze([]) as unknown as OpacHomeHours[],
  blocks: Object.freeze(Object.fromEntries(OPAC_HOME_BLOCKS.map((b) => [b, true])) as OpacHomeBlocks),
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
