import { issueCode } from '@altis/shared/api/common';
import {
  OpacHomePutBody,
  OpacHomeSlide,
  type OpacHomeBlocks,
  type OpacHomeContent,
  type OpacHomeInterval,
  type OpacHomeTargetKind,
  type OpacHomeText,
  type OpacHomeView,
} from '@altis/shared/api/opac-home';
import { OPAC_HOME_TABS, type OpacHomeTab } from './tabs';

export { OPAC_HOME_TABS, type OpacHomeTab };

/**
 * The form state of OPAC › Halaman awal and the PUT body it becomes. One draft holds the whole content (the hero's
 * slides, the profile, the services, the gallery, the hours and contact, the blocks) and both welcome texts; the tabs
 * of the screen each edit a part of it. The draft holds texts as typed (numbers and dates too); a blank text is null
 * in the body, numbers must be whole, and the body is checked with the server's own schema before it is sent, so a
 * field shows the same error the server would answer (`{path → code}`, paths as the body's). The logo is not edited
 * here: the one loaded is sent back as it was.
 */

/** A text of the form in each language, as typed. */
export interface TextDraft {
  id: string;
  en: string;
}

/** A photo of the form: an uploaded file, its alternative text and caption as typed. */
export interface PhotoDraft {
  fileId: string;
  alt: string;
  caption: string;
}

/** List rows carry a key of their own, so that moving one moves its inputs with it. */
export interface ServiceDraft {
  key: number;
  title: string;
  text: string;
}

export interface FacilityDraft extends PhotoDraft {
  key: number;
}

export interface HoursDraft {
  key: number;
  days: string;
  time: string;
  /** ISO weekdays (1 Monday to 7 Sunday), in that order. */
  weekdays: number[];
}

/** One slide of the hero as the form holds it. */
export interface SlideDraft {
  key: number;
  /** The slide's name within the hero (kept from what was loaded; a new slide gets a free one). */
  id: string;
  /** The uploaded photo; blank while a new slide has none yet. */
  fileId: string;
  alt: string;
  position: number;
  note: TextDraft;
  title: TextDraft;
  subtitle: TextDraft;
  /** Whether the slide has a button; its label and target are kept as typed while it has none. */
  button: boolean;
  label: TextDraft;
  targetKind: OpacHomeTargetKind;
  /** The news post's slug or the path of this site, as typed (the other kinds take none). */
  targetRef: string;
  active: boolean;
  /** `YYYY-MM-DD`, blank: no limit. */
  from: string;
  until: string;
}

export interface TimelineDraft {
  key: number;
  year: string;
  text: TextDraft;
}

export interface MissionDraft {
  key: number;
  text: TextDraft;
}

export interface StaffDraft {
  key: number;
  name: string;
  role: TextDraft;
}

export interface GalleryDraft {
  key: number;
  fileId: string;
  alt: string;
  caption: TextDraft;
}

export interface HomeDraft {
  title: TextDraft;
  lead: TextDraft;
  slides: SlideDraft[];
  autoplay: boolean;
  intervalSec: OpacHomeInterval;
  /** The library colour as typed (`#rrggbb`); blank: the accent's. */
  brand: string;
  about: { text: TextDraft; photo: PhotoDraft | null; founded: string; librarians: string; history: TextDraft };
  timeline: TimelineDraft[];
  vision: TextDraft;
  mission: MissionDraft[];
  staff: StaffDraft[];
  gallery: GalleryDraft[];
  services: ServiceDraft[];
  facilities: FacilityDraft[];
  hours: HoursDraft[];
  blocks: OpacHomeBlocks;
  /** The logo as loaded (it is set on the site identity's screen). */
  logo: OpacHomeContent['logo'];
  /** The published telephone number and e-mail address as typed (blank: none). */
  phone: string;
  email: string;
}

let lastKey = 0;

/** A key for a new list row. */
export function newRowKey(): number {
  lastKey += 1;
  return lastKey;
}

const text = (value: string | null | undefined): string => value ?? '';

/** The texts of both languages as typed. */
const texts = (value: OpacHomeText): TextDraft => ({ id: text(value.id), en: text(value.en) });

const NO_TEXTS: TextDraft = Object.freeze({ id: '', en: '' });

/** The form state of one loaded slide. */
function slideDraftOf(slide: OpacHomeSlide): SlideDraft {
  const target = slide.cta?.target;
  return {
    key: newRowKey(),
    id: slide.id,
    fileId: slide.fileId,
    alt: slide.alt,
    position: slide.position,
    note: texts(slide.note),
    title: texts(slide.title),
    subtitle: texts(slide.subtitle),
    button: slide.cta !== null,
    label: slide.cta === null ? { ...NO_TEXTS } : texts(slide.cta.label),
    targetKind: target?.kind ?? 'catalog',
    targetRef: target !== undefined && 'ref' in target ? text(target.ref) : '',
    active: slide.active,
    from: text(slide.from),
    until: text(slide.until),
  };
}

/** A slide the form adds: no photo or texts yet, shown always, with a name no other slide has. */
export function newSlideDraft(others: readonly Pick<SlideDraft, 'id'>[]): SlideDraft {
  const taken = new Set(others.map((s) => s.id));
  let n = 1;
  while (taken.has(`slide-${n}`)) n += 1;
  return {
    key: newRowKey(),
    id: `slide-${n}`,
    fileId: '',
    alt: '',
    position: 50,
    note: { ...NO_TEXTS },
    title: { ...NO_TEXTS },
    subtitle: { ...NO_TEXTS },
    button: false,
    label: { ...NO_TEXTS },
    targetKind: 'catalog',
    targetRef: '',
    active: true,
    from: '',
    until: '',
  };
}

/** The form state of a loaded home page. */
export function draftOf(view: Pick<OpacHomeView, 'home' | 'welcome'>): HomeDraft {
  const { home } = view;
  return {
    title: texts(home.title),
    lead: texts(view.welcome),
    slides: home.hero.slides.map(slideDraftOf),
    autoplay: home.hero.autoplay,
    intervalSec: home.hero.intervalSec,
    brand: text(home.brand),
    about: {
      text: texts(home.about.text),
      photo: home.about.photo === null ? null : { fileId: home.about.photo.fileId, alt: home.about.photo.alt, caption: text(home.about.photo.caption) },
      founded: home.about.founded === null ? '' : String(home.about.founded),
      librarians: home.about.librarians === null ? '' : String(home.about.librarians),
      history: texts(home.about.history),
    },
    timeline: home.timeline.map((e) => ({ key: newRowKey(), year: String(e.year), text: texts(e.text) })),
    vision: texts(home.vision),
    mission: home.mission.map((m) => ({ key: newRowKey(), text: texts(m) })),
    staff: home.staff.map((s) => ({ key: newRowKey(), name: s.name, role: texts(s.role) })),
    gallery: home.gallery.map((g) => ({ key: newRowKey(), fileId: g.fileId, alt: g.alt, caption: texts(g.caption) })),
    services: home.services.map((s) => ({ key: newRowKey(), title: s.title, text: text(s.text) })),
    facilities: home.facilities.map((f) => ({ key: newRowKey(), fileId: f.fileId, alt: f.alt, caption: text(f.caption) })),
    hours: home.hours.map((h) => ({ key: newRowKey(), days: h.days, time: h.time, weekdays: [...h.weekdays].sort((a, b) => a - b) })),
    blocks: { ...home.blocks },
    logo: home.logo === null ? null : { ...home.logo },
    phone: text(home.contact.phone),
    email: text(home.contact.email),
  };
}

/** The draft without its row keys: what "changed" compares. */
export function comparable(draft: HomeDraft | SlideDraft): string {
  return JSON.stringify(draft, (name, value: unknown) => (name === 'key' ? undefined : value));
}

/** A blank text is none; any other is kept as typed (the schema trims it). */
const orNull = (value: string): string | null => (value.trim() === '' ? null : value);

/** A whole number as typed, null when blank, NaN when it is not one (the schema then refuses it). */
function wholeNumber(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  return /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
}

/** Both languages' texts, a blank one as none. */
const textsOrNull = (value: TextDraft): OpacHomeText => ({ id: orNull(value.id), en: orNull(value.en) });

/** The slide of `draft` as the content holds it (not yet checked). */
export function slideOf(draft: SlideDraft): OpacHomeSlide {
  const ref = draft.targetRef.trim();
  let target: NonNullable<OpacHomeSlide['cta']>['target'];
  if (draft.targetKind === 'news') target = ref === '' ? { kind: 'news' } : { kind: 'news', ref };
  else if (draft.targetKind === 'path') target = { kind: 'path', ref };
  else target = { kind: draft.targetKind };
  return {
    id: draft.id,
    fileId: draft.fileId,
    alt: draft.alt,
    position: draft.position,
    note: textsOrNull(draft.note),
    title: textsOrNull(draft.title),
    subtitle: textsOrNull(draft.subtitle),
    cta: draft.button ? { label: textsOrNull(draft.label), target } : null,
    active: draft.active,
    from: orNull(draft.from),
    until: orNull(draft.until),
  };
}

/** The home page content of `draft` (not yet checked). */
function contentOf(draft: HomeDraft): OpacHomeContent {
  return {
    title: textsOrNull(draft.title),
    hero: { slides: draft.slides.map(slideOf), autoplay: draft.autoplay, intervalSec: draft.intervalSec },
    brand: orNull(draft.brand),
    about: {
      text: textsOrNull(draft.about.text),
      photo: draft.about.photo === null ? null : { fileId: draft.about.photo.fileId, alt: draft.about.photo.alt, caption: orNull(draft.about.photo.caption) },
      founded: wholeNumber(draft.about.founded),
      librarians: wholeNumber(draft.about.librarians),
      history: textsOrNull(draft.about.history),
    },
    services: draft.services.map((s) => ({ title: s.title, text: orNull(s.text) })),
    facilities: draft.facilities.map((f) => ({ fileId: f.fileId, alt: f.alt, caption: orNull(f.caption) })),
    hours: draft.hours.map((h) => ({ days: h.days, time: h.time, weekdays: [...h.weekdays] })),
    blocks: { ...draft.blocks },
    logo: draft.logo === null ? null : { ...draft.logo },
    contact: { phone: orNull(draft.phone), email: orNull(draft.email) },
    // A blank year is refused by the schema as not a number.
    timeline: draft.timeline.map((e) => ({ year: wholeNumber(e.year) ?? Number.NaN, text: textsOrNull(e.text) })),
    vision: textsOrNull(draft.vision),
    mission: draft.mission.map((m) => textsOrNull(m.text)),
    staff: draft.staff.map((s) => ({ name: s.name, role: textsOrNull(s.role) })),
    gallery: draft.gallery.map((g) => ({ fileId: g.fileId, alt: g.alt, caption: textsOrNull(g.caption) })),
  };
}

/** The first issue of each path, as `{path → code}`. */
function errorsOf(issues: readonly { path: PropertyKey[]; code: string; params?: Record<string, unknown> | undefined }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map((p) => String(p)).join('.');
    if (!(path in errors)) errors[path] = issueCode(issue);
  }
  return errors;
}

/** The PUT body of `draft` loaded at `revision`, or the field errors that keep it from being sent (path → code). */
export function bodyOf(draft: HomeDraft, revision: string): { body: OpacHomePutBody } | { errors: Record<string, string> } {
  const parsed = OpacHomePutBody.safeParse({ revision, home: contentOf(draft), welcome: textsOrNull(draft.lead) });
  return parsed.success ? { body: parsed.data } : { errors: errorsOf(parsed.error.issues) };
}

/**
 * What keeps one slide from being applied to the draft, by the slide's own paths (`alt`, `title.id`,
 * `cta.target.ref`, `until`, `fileId` while it has no photo): the server's schema of a slide.
 */
export function slideErrors(draft: SlideDraft): Record<string, string> {
  const parsed = OpacHomeSlide.safeParse(slideOf(draft));
  return parsed.success ? {} : errorsOf(parsed.error.issues);
}

/** The body path of slide `index`'s fields (`home.hero.slides.2.`). */
export const slidePath = (index: number): string => `home.hero.slides.${index}.`;

/** The errors of slide `index` out of the page's, by the slide's own paths. */
export function slideErrorsAt(errors: Readonly<Record<string, string>>, index: number): Record<string, string> {
  const prefix = slidePath(index);
  return Object.fromEntries(
    Object.entries(errors)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, code]) => [path.slice(prefix.length), code]),
  );
}

/** `errors` without those at or under one of `prefixes` (a list whose rows moved, a field typed in again). */
export function withoutErrors(errors: Readonly<Record<string, string>>, prefixes: readonly string[]): Record<string, string> {
  const kept = Object.entries(errors).filter(([path]) => !prefixes.some((p) => path === p || path.startsWith(p.endsWith('.') ? p : `${p}.`)));
  return kept.length === Object.keys(errors).length ? (errors as Record<string, string>) : Object.fromEntries(kept);
}

/** The parts of the body each tab edits, by the start of their paths. */
const TAB_PATHS: readonly (readonly [string, OpacHomeTab])[] = [
  ['home.hero', 'slider'],
  ['home.title', 'profil'],
  ['welcome', 'profil'],
  ['home.about', 'profil'],
  ['home.timeline', 'profil'],
  ['home.vision', 'profil'],
  ['home.mission', 'profil'],
  ['home.staff', 'profil'],
  ['home.services', 'layanan'],
  ['home.facilities', 'layanan'],
  ['home.gallery', 'galeri'],
  ['home.hours', 'jam'],
  ['home.contact', 'jam'],
  ['home.blocks', 'blok'],
  ['home.brand', 'blok'],
];

/** The tab that shows the field at `path` of the body; null for a part no tab edits. */
export function tabOfPath(path: string): OpacHomeTab | null {
  for (const [start, tab] of TAB_PATHS) if (path === start || path.startsWith(`${start}.`)) return tab;
  return null;
}

/** The tabs that hold a refused field, in the tabs' order. */
export function tabsWithErrors(errors: Readonly<Record<string, string>>): OpacHomeTab[] {
  const found = new Set(Object.keys(errors).map(tabOfPath));
  return OPAC_HOME_TABS.filter((tab) => found.has(tab));
}

/** Moves the row at `from` to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [row] = next.splice(from, 1);
  if (row !== undefined) next.splice(to, 0, row);
  return next;
}

/** The text of `draft` a page in `lang` shows: its own, else the other language's (blank: none). */
export function textIn(draft: TextDraft, lang: 'id' | 'en'): string {
  const own = draft[lang];
  if (own.trim() !== '') return own;
  const other = draft[lang === 'id' ? 'en' : 'id'];
  return other.trim() === '' ? '' : other;
}

/** Whether a slide has Indonesian text whose English is missing (its title, subtitle, note or button label). */
export function englishMissing(slide: SlideDraft): boolean {
  const pairs = [slide.title, slide.subtitle, slide.note, ...(slide.button ? [slide.label] : [])];
  return pairs.some((p) => p.id.trim() !== '' && p.en.trim() === '');
}
