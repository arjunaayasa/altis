import { PAGE_KINDS, type PageKind } from '@altis/shared';

// What the two screens of Halaman & Berita share (Phase 2 Task 20): the `?kind=` of the list and of a new page, the
// query keys, the OPAC address of a page, the slug suggested from a title, and the `datetime-local` conversions of the
// publication time. No React here: routes/catalog/pages.tsx imports the search check without loading a screen.

/** The search of `/admin/opac/pages` and `/admin/opac/pages/new`: which kind (a static page when absent). */
export interface PagesSearch {
  kind?: PageKind;
}

/** The routes' `validateSearch`: `kind` when it is a page kind; anything else in the query is dropped. */
export function validatePagesSearch(search: Record<string, unknown>): PagesSearch {
  const { kind } = search;
  return typeof kind === 'string' && (PAGE_KINDS as readonly string[]).includes(kind) ? { kind: kind as PageKind } : {};
}

/** The kind a search names, a static page by default. */
export function kindOf(search: Record<string, unknown>): PageKind {
  return validatePagesSearch(search).kind ?? 'page';
}

/** Where a `<Link>` goes: a path, and the `?kind=` of news (a static page needs none). */
export interface PagesTarget {
  to: string;
  search?: PagesSearch;
}

const withKind = (to: string, kind: PageKind): PagesTarget => (kind === 'page' ? { to } : { to, search: { kind } });

/** The list of one kind, as a link target. */
export function pagesListTarget(kind: PageKind): PagesTarget {
  return withKind('/admin/opac/pages', kind);
}

/** A new page of `kind`, as a link target. */
export function newPageTarget(kind: PageKind): PagesTarget {
  return withKind('/admin/opac/pages/new', kind);
}

/** The list of one kind, as an address (for `navigate({href})`). */
export function pagesListHref(kind: PageKind): string {
  return kind === 'page' ? '/admin/opac/pages' : `/admin/opac/pages?kind=${kind}`;
}

/** The editor of page `id`. */
export function pageHref(id: string): string {
  return `/admin/opac/pages/${encodeURIComponent(id)}`;
}

/** Every query of Halaman & Berita starts with this key (a write invalidates them all). */
export const PAGES_KEY = ['opac', 'pages'] as const;

/** Where the OPAC shows a page of `kind` (spec §9.1: `/halaman/<slug>`, `/berita/<slug>`). */
export function opacPath(kind: PageKind, slug: string): string {
  return `${kind === 'page' ? '/halaman' : '/berita'}/${slug}`;
}

/** The longest slug (the contract's `[a-z0-9-]{1,191}`). */
const SLUG_MAX = 191;

/**
 * The address suggested for a title: letters without their accents, lower case, every run of other characters one
 * hyphen, no hyphen at either end, at most 191 characters (`Jam Buka & Layanan` → `jam-buka-layanan`).
 */
export function slugify(title: string): string {
  const plain = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return plain.slice(0, SLUG_MAX).replace(/-+$/, '');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Epoch ms as the value of an `<input type="datetime-local">` (the browser's time zone, to the minute); '' for none. */
export function toLocalInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value: `YYYY-MM-DDTHH:mm`, optionally with seconds (which some browsers add). */
const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * The epoch ms of a `datetime-local` value, read in the browser's time zone; null for an empty one, and 'invalid' for
 * anything else (a browser without the date picker leaves a text field).
 */
export function fromLocalInput(value: string): number | null | 'invalid' {
  const text = value.trim();
  if (text === '') return null;
  if (!LOCAL_INPUT.test(text)) return 'invalid';
  const ms = new Date(text).getTime();
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : 'invalid';
}
