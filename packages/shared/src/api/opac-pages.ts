/**
 * The Halaman & Berita API vocabulary (Phase 2 spec §2.2 `pages`, §9.5; plan Task 20): static pages and news posts with
 * an Indonesian translation (required) and an English one (optional). Bodies are Markdown (the subset) or HTML, both
 * rendered through the sanitizer; the admin preview shows the server's HTML in a sandboxed iframe (S6).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/opac-pages`.
 */
import { z } from 'zod';
import {
  BODY_FORMATS,
  EVENT_PLACE_MAX,
  NEWS_CATEGORIES,
  PAGE_KINDS,
  PAGE_STATUSES,
  type BodyFormat,
  type NewsCategory,
  type PageKind,
  type PageStatus,
} from '../catalog-vocab.js';
import { cursorQuery, epochMsField, longText, shortText, sortOrderField, type Paged } from './catalog/common.js';
import { ulidField, versionField } from './common.js';

/** One translation of a page. */
export const PageTranslationInput = z.strictObject({
  title: shortText(191).min(1),
  summary: longText.nullable().optional(),
  bodyFormat: z.enum(BODY_FORMATS),
  body: longText,
});

export type PageTranslationInput = z.infer<typeof PageTranslationInput>;

/** A page's address: `/halaman/<slug>` or `/berita/<slug>` (unique per kind; the news slug `rss` is reserved). */
export const pageSlugField = z.string().regex(/^[a-z0-9-]{1,191}$/);

const pageFields = {
  kind: z.enum(PAGE_KINDS),
  slug: pageSlugField,
  status: z.enum(PAGE_STATUSES),
  /** Epoch ms; a published page with a future `publishedAt` is scheduled (filtered when read, no job). */
  publishedAt: epochMsField.nullable().optional(),
  /** Listed in the OPAC menu (≤ 8 shown). */
  showInNav: z.boolean(),
  /** An `opac.page_image` upload. */
  coverFileId: ulidField.nullable().optional(),
  sortOrder: sortOrderField,
};

/**
 * The agenda of a news post: its category and the event it announces. All four are for `kind = news` only and may be
 * null (or left out); see {@link newsAgendaErrors} for the rules between them.
 */
const agendaFields = {
  category: z.enum(NEWS_CATEGORIES).nullable().optional(),
  /** Epoch ms: when the event starts. */
  eventStartsAt: epochMsField.nullable().optional(),
  /** Epoch ms: when it ends; never without a start, never before it. */
  eventEndsAt: epochMsField.nullable().optional(),
  /** Where it is held; a blank place is none. */
  eventPlace: shortText(EVENT_PLACE_MAX).nullable().optional(),
};

/** The agenda of a page as it is stored or about to be. */
export interface NewsAgenda {
  category: NewsCategory | null;
  eventStartsAt: number | null;
  eventEndsAt: number | null;
  eventPlace: string | null;
}

/** The names of the agenda fields, in the order they are reported. */
export const NEWS_AGENDA_FIELDS = Object.freeze(['category', 'eventStartsAt', 'eventEndsAt', 'eventPlace'] as const);

/**
 * The field errors of `agenda` on a page of `kind`: a page that is not news has no agenda (`invalid` at each field
 * that is set); an event's end needs its start and is not before it (`invalid` at `eventEndsAt`), and so does its
 * place (`invalid` at `eventPlace`).
 */
export function newsAgendaErrors(kind: PageKind, agenda: NewsAgenda): { path: (typeof NEWS_AGENDA_FIELDS)[number]; code: 'invalid' }[] {
  if (kind !== 'news') return NEWS_AGENDA_FIELDS.filter((name) => agenda[name] !== null).map((path) => ({ path, code: 'invalid' as const }));
  const errors: { path: (typeof NEWS_AGENDA_FIELDS)[number]; code: 'invalid' }[] = [];
  if (agenda.eventEndsAt !== null && (agenda.eventStartsAt === null || agenda.eventEndsAt < agenda.eventStartsAt)) errors.push({ path: 'eventEndsAt', code: 'invalid' });
  if (agenda.eventPlace !== null && agenda.eventStartsAt === null) errors.push({ path: 'eventPlace', code: 'invalid' });
  return errors;
}

/** The agenda a body states: a field left out is null, a blank place is none. */
export function newsAgendaOf(input: { category?: NewsCategory | null | undefined; eventStartsAt?: number | null | undefined; eventEndsAt?: number | null | undefined; eventPlace?: string | null | undefined }): NewsAgenda {
  const place = input.eventPlace ?? null;
  return { category: input.category ?? null, eventStartsAt: input.eventStartsAt ?? null, eventEndsAt: input.eventEndsAt ?? null, eventPlace: place === null || place.trim() === '' ? null : place };
}

/** `POST opac/pages`. */
export const PageBody = z
  .strictObject({
    ...pageFields,
    ...agendaFields,
    translations: z.strictObject({ id: PageTranslationInput, en: PageTranslationInput.optional() }),
  })
  .check((ctx) => {
    for (const e of newsAgendaErrors(ctx.value.kind, newsAgendaOf(ctx.value))) ctx.issues.push({ code: 'custom', input: ctx.value[e.path], path: [e.path], params: { code: e.code } });
  });

export type PageBody = z.infer<typeof PageBody>;

/**
 * `PATCH opac/pages/:id`: only the fields sent change; a translation sent replaces it, `en: null` removes English.
 * The agenda is checked against the page as the patch leaves it ({@link newsAgendaErrors}); a news post that becomes a
 * page loses its agenda.
 */
export const PagePatchBody = z.strictObject({
  version: versionField,
  kind: pageFields.kind.optional(),
  slug: pageFields.slug.optional(),
  status: pageFields.status.optional(),
  publishedAt: pageFields.publishedAt,
  showInNav: pageFields.showInNav.optional(),
  coverFileId: pageFields.coverFileId,
  sortOrder: pageFields.sortOrder.optional(),
  ...agendaFields,
  translations: z.strictObject({ id: PageTranslationInput.optional(), en: PageTranslationInput.nullable().optional() }).optional(),
});

export type PagePatchBody = z.infer<typeof PagePatchBody>;

/** `GET opac/pages?kind=&status=`. */
export const PageListQuery = z.strictObject({
  kind: z.enum(PAGE_KINDS),
  status: z.enum(PAGE_STATUSES).optional(),
  /** Only the news of this category. */
  category: z.enum(NEWS_CATEGORIES).optional(),
  ...cursorQuery,
});

export type PageListQuery = z.infer<typeof PageListQuery>;

/** `POST opac/pages/preview` (a read): the body rendered and sanitized as the OPAC would show it. */
export const PagePreviewBody = z.strictObject({ bodyFormat: z.enum(BODY_FORMATS), body: longText });

export type PagePreviewBody = z.infer<typeof PagePreviewBody>;

/** The preview's HTML, for `<iframe sandbox="" srcDoc>` only (S6). */
export interface PagePreviewResponse {
  html: string;
}

/** One translation as stored (an `html` body is stored sanitized). */
export interface PageTranslationView {
  title: string;
  summary: string | null;
  bodyFormat: BodyFormat;
  body: string;
  updatedAt: number;
}

/** One page as the admin edits it. */
export interface PageView {
  id: string;
  kind: PageKind;
  slug: string;
  status: PageStatus;
  publishedAt: number | null;
  showInNav: boolean;
  coverFileId: string | null;
  sortOrder: number;
  /** News only (null on a page): its category and the event it announces. */
  category: NewsCategory | null;
  eventStartsAt: number | null;
  eventEndsAt: number | null;
  eventPlace: string | null;
  translations: { id: PageTranslationView; en: PageTranslationView | null };
  archived: boolean;
  createdAt: number;
  updatedAt: number | null;
  version: number;
}

/** One row of the pages list. */
export interface PageListItem {
  id: string;
  kind: PageKind;
  slug: string;
  status: PageStatus;
  publishedAt: number | null;
  showInNav: boolean;
  /** News only: its category and the start of its event. */
  category: NewsCategory | null;
  eventStartsAt: number | null;
  /** The Indonesian title. */
  title: string;
  hasEnglish: boolean;
  updatedAt: number | null;
  version: number;
}

/** `GET opac/pages`. */
export type PageListResponse = Paged<PageListItem>;
