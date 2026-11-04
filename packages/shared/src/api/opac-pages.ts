/**
 * The Halaman & Berita API vocabulary (Phase 2 spec §2.2 `pages`, §9.5; plan Task 20): static pages and news posts with
 * an Indonesian translation (required) and an English one (optional). Bodies are Markdown (the subset) or HTML, both
 * rendered through the sanitizer; the admin preview shows the server's HTML in a sandboxed iframe (S6).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/opac-pages`.
 */
import { z } from 'zod';
import { BODY_FORMATS, PAGE_KINDS, PAGE_STATUSES, type BodyFormat, type PageKind, type PageStatus } from '../catalog-vocab.js';
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

/** `POST opac/pages`. */
export const PageBody = z.strictObject({
  ...pageFields,
  translations: z.strictObject({ id: PageTranslationInput, en: PageTranslationInput.optional() }),
});

export type PageBody = z.infer<typeof PageBody>;

/** `PATCH opac/pages/:id`: only the fields sent change; a translation sent replaces it, `en: null` removes English. */
export const PagePatchBody = z.strictObject({
  version: versionField,
  kind: pageFields.kind.optional(),
  slug: pageFields.slug.optional(),
  status: pageFields.status.optional(),
  publishedAt: pageFields.publishedAt,
  showInNav: pageFields.showInNav.optional(),
  coverFileId: pageFields.coverFileId,
  sortOrder: pageFields.sortOrder.optional(),
  translations: z.strictObject({ id: PageTranslationInput.optional(), en: PageTranslationInput.nullable().optional() }).optional(),
});

export type PagePatchBody = z.infer<typeof PagePatchBody>;

/** `GET opac/pages?kind=&status=`. */
export const PageListQuery = z.strictObject({ kind: z.enum(PAGE_KINDS), status: z.enum(PAGE_STATUSES).optional(), ...cursorQuery });

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
  /** The Indonesian title. */
  title: string;
  hasEnglish: boolean;
  updatedAt: number | null;
  version: number;
}

/** `GET opac/pages`. */
export type PageListResponse = Paged<PageListItem>;
