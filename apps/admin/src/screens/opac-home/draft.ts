import { issueCode } from '@altis/shared/api/common';
import { OpacHomePutBody, type OpacHomeBlocks, type OpacHomeContent, type OpacHomeView } from '@altis/shared/api/opac-home';

/**
 * The form state of OPAC › Halaman awal and the PUT body it becomes. The form holds texts as typed (numbers too); a
 * blank text is null in the body, numbers must be whole, and the body is checked with the server's own schema before
 * it is sent, so a field shows the same error the server would answer (`{path → code}`, paths as the body's).
 */

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
}

export interface HomeDraft {
  title: string;
  lead: { id: string; en: string };
  hero: { fileId: string; alt: string; position: number } | null;
  about: { text: string; photo: PhotoDraft | null; founded: string; librarians: string };
  services: ServiceDraft[];
  facilities: FacilityDraft[];
  hours: HoursDraft[];
  blocks: OpacHomeBlocks;
}

let lastKey = 0;

/** A key for a new list row. */
export function newRowKey(): number {
  lastKey += 1;
  return lastKey;
}

const text = (value: string | null): string => value ?? '';

/** The form state of a loaded home page. */
export function draftOf(view: Pick<OpacHomeView, 'home' | 'welcome'>): HomeDraft {
  const { home } = view;
  return {
    title: text(home.title),
    lead: { id: text(view.welcome.id), en: text(view.welcome.en) },
    hero: home.hero === null ? null : { ...home.hero },
    about: {
      text: text(home.about.text),
      photo: home.about.photo === null ? null : { fileId: home.about.photo.fileId, alt: home.about.photo.alt, caption: text(home.about.photo.caption) },
      founded: home.about.founded === null ? '' : String(home.about.founded),
      librarians: home.about.librarians === null ? '' : String(home.about.librarians),
    },
    services: home.services.map((s) => ({ key: newRowKey(), title: s.title, text: text(s.text) })),
    facilities: home.facilities.map((f) => ({ key: newRowKey(), fileId: f.fileId, alt: f.alt, caption: text(f.caption) })),
    hours: home.hours.map((h) => ({ key: newRowKey(), days: h.days, time: h.time })),
    blocks: { ...home.blocks },
  };
}

/** The draft without its row keys: what "changed" compares. */
export function comparable(draft: HomeDraft): string {
  return JSON.stringify({
    ...draft,
    services: draft.services.map(({ title, text: t }) => ({ title, text: t })),
    facilities: draft.facilities.map(({ fileId, alt, caption }) => ({ fileId, alt, caption })),
    hours: draft.hours.map(({ days, time }) => ({ days, time })),
  });
}

/** A blank text is none; any other is kept as typed (the schema trims it). */
const orNull = (value: string): string | null => (value.trim() === '' ? null : value);

/** A whole number as typed, null when blank, NaN when it is not one (the schema then refuses it). */
function wholeNumber(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  return /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
}

/** The home page content of `draft` (not yet checked). */
function contentOf(draft: HomeDraft): OpacHomeContent {
  return {
    title: orNull(draft.title),
    hero: draft.hero === null ? null : { ...draft.hero },
    about: {
      text: orNull(draft.about.text),
      photo: draft.about.photo === null ? null : { fileId: draft.about.photo.fileId, alt: draft.about.photo.alt, caption: orNull(draft.about.photo.caption) },
      founded: wholeNumber(draft.about.founded),
      librarians: wholeNumber(draft.about.librarians),
    },
    services: draft.services.map((s) => ({ title: s.title, text: orNull(s.text) })),
    facilities: draft.facilities.map((f) => ({ fileId: f.fileId, alt: f.alt, caption: orNull(f.caption) })),
    hours: draft.hours.map((h) => ({ days: h.days, time: h.time })),
    blocks: { ...draft.blocks },
  };
}

/** The PUT body of `draft` loaded at `revision`, or the field errors that keep it from being sent (path → code). */
export function bodyOf(draft: HomeDraft, revision: string): { body: OpacHomePutBody } | { errors: Record<string, string> } {
  const parsed = OpacHomePutBody.safeParse({
    revision,
    home: contentOf(draft),
    welcome: { id: orNull(draft.lead.id), en: orNull(draft.lead.en) },
  });
  if (parsed.success) return { body: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.map((p) => String(p)).join('.');
    if (!(path in errors)) errors[path] = issueCode(issue);
  }
  return { errors };
}
