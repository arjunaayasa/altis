import { createHash } from 'node:crypto';
import { withTx, type DB } from '@altis/db';
import { newId } from '@altis/shared';
import type { Insertable, Kysely, Transaction } from 'kysely';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { detectType } from '../../../files/magic.js';
import { stripImageMetadata, type StrippableImage } from '../../../files/strip-metadata.js';
import { sanitizedHtml } from '../../../html/sanitize.js';
import { cleanDate } from '../source/clean-text.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  Ledger,
  TEXT_MAX_BYTES,
  againOnRace,
  cachedForRun,
  cutBytes,
  cutChars,
  fitChars,
  keyFits,
  keyOf,
  mappedRows,
  nextPhase,
  oneLine,
  readCursor,
  readSourceFile,
  scanAll,
  sha256Of,
  sourceCursor,
  stageBBatch,
  stateOf,
  storeBlob,
  tableOf,
  targetsOf,
  textOf,
  writeCursor,
  endOfStage,
} from './stage-b-kit.js';

// Content → Halaman & Berita (Phase 2 spec §11.3 step 8, §11.4 row `content`, §9.5; D2-27; plan Task 38). Each
// `content` row becomes a page (`is_news` → kind `news`, else `page`) or a translation of one:
//
// - `content_path` → the slug (lower case `a-z 0-9 -`); a suffix `_id` or `_en` makes the row that language's
//   translation of the page of the path without it (`profil_id` + `profil_en` → page `profil`, two translations). The
//   first row of a page and language in source order is the one kept: another `id` row of the same path becomes a page
//   of its own (`profil-2`), another `en` row is skipped (`translation_duplicate`). An `en` row without its `id` row
//   makes a page whose `id` translation is a copy of the English one (`translation_id_missing`; Indonesian is required,
//   §9.5). The rows of one language go first (pass 1: `id`, pass 2: `en`), so the order of the source never matters. A
//   slug that another page holds gets `-2`, `-3`, … (`slug_changed`).
// - The body (`content_desc`) as HTML (`body_format 'html'`), through `sanitizedHtml` (§9.5), at most 60 000 bytes
//   (`body_truncated`); the tags the sanitizer drops are reported by name (`html_tags_dropped`). Images under
//   `images/content/` are uploaded again (context `opac.page_image`, at most 2 MiB, JPEG/PNG/WebP stripped of their
//   metadata, GIF as it is; owned by the page; entity `content_image`) and their `src` rewritten to `/files/<id>`; an
//   image the source lacks, or that is no such image, is dropped (`missing_file`, `file_too_large`, `image_invalid`).
// - News keeps its state: published at `publish_date` (else its `input_date`, else now) unless `is_draft`; **every other
//   page arrives as a draft** (D2-27: SLiMS ships default pages that should not be published unread).
//
// One row per transaction (its images stored before it). A dry run reads, checks and reports alike, and writes nothing.

const TC = 'content';
const TITLE_MAX = 191;
const SLUG_MAX = 191;
/** The `opac.page_image` context's limit (§8). */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_KINDS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp', 'gif']);
/** News slugs a route takes (`/berita/rss`). */
const RESERVED: Readonly<Record<'page' | 'news', readonly string[]>> = { page: [], news: ['rss'] };

/**
 * The tags `sanitizedHtml` keeps or writes as another (§9.5 and its aliases, html/sanitize.ts): any other tag in a body
 * is reported as dropped.
 */
const KEPT_TAGS: ReadonlySet<string> = new Set([
  'p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'img', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre', 'figure', 'figcaption',
  'b', 'i', 'strike', 'del', 'ins', 'h1', 'h5', 'h6', 'tfoot', 'div', 'section', 'article', 'header', 'footer', 'main',
  'aside', 'nav', 'address', 'center', 'dt', 'dd',
]);

type Kind = 'page' | 'news';
type Lang = 'id' | 'en';

/** Where a `content` row goes, from the whole table (cached for the run). */
interface Placement {
  kind: Kind;
  base: string;
  lang: Lang;
  /** The rows of the same kind, base and language before it in source order. */
  rank: number;
}

/** `s` as a slug: ASCII letters (accents dropped), digits and `-`, lower case, ≤ 191. */
export function slugOf(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/** `slug` with the suffix `-<n>` (n ≥ 2), within 191 characters. */
function slugWith(slug: string, n: number): string {
  const suffix = `-${n}`;
  return `${slug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function placementOf(row: SlimsRow, key: string): Omit<Placement, 'rank'> {
  const kind: Kind = keyOf(row['is_news']) === '1' ? 'news' : 'page';
  const path = keyOf(row['content_path']).toLowerCase();
  const m = /^(.+)_(id|en)$/.exec(path);
  const base = slugOf(m === null ? path : m[1]!) || `konten-${slugOf(key) || 'x'}`;
  return { kind, base, lang: m === null ? 'id' : (m[2] as Lang) };
}

function placements(c: SlimsStageContext): Promise<ReadonlyMap<string, Placement>> {
  return cachedForRun(c, 'content:placements', async () => {
    const out = new Map<string, Placement>();
    const seen = new Map<string, number>();
    await scanAll(c, TC, (row) => {
      const key = keyOf(row['content_id']);
      if (!keyFits(key) || out.has(key)) return;
      const p = placementOf(row, key);
      const group = `${p.kind}:${p.base}:${p.lang}`;
      const rank = seen.get(group) ?? 0;
      seen.set(group, rank + 1);
      out.set(key, { ...p, rank });
    });
    return out;
  });
}

/** The `kind:base` groups that have an `id` row (cached for the run). */
function idGroups(c: SlimsStageContext): Promise<ReadonlySet<string>> {
  return cachedForRun(c, 'content:id', async () => {
    const out = new Set<string>();
    for (const p of (await placements(c)).values()) if (p.lang === 'id') out.add(`${p.kind}:${p.base}`);
    return out;
  });
}

// ---- the body ---------------------------------------------------------------------------------------------------------

/** The tag names of `html` that the sanitizer drops (sorted, unique). */
export function droppedTags(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9:-]*)/g)) {
    const name = m[1]!.toLowerCase();
    if (!KEPT_TAGS.has(name)) names.add(name);
  }
  return [...names].sort();
}

const IMG = /<img\b[^>]*>/gi;
const SRC = /(\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** The `images/content/…` path an `img` `src` names (relative or absolute), or null. */
function contentImage(src: string): string | null {
  let value = src.replace(/&amp;/gi, '&').trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // kept as it is
  }
  const m = /(?:^|\/)(images\/content\/[^?#]+)/.exec(value);
  if (m === null) return null;
  const rel = m[1]!;
  return rel.split('/').some((part) => part === '..' || part === '.') ? null : rel;
}

/** The content images `html` names, in order, once each. */
function imagesOf(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(IMG) ?? []) {
    const m = SRC.exec(tag);
    const rel = m === null ? null : contentImage(m[2] ?? m[3] ?? m[4] ?? '');
    if (rel !== null && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/** `html` with the `src` of each image of `files` (by its path) rewritten to `/files/<id>`; the others are left as
 * they are, for the sanitizer to drop (an `img` whose `src` is not `/files/<id>` never survives it). */
function rewriteImages(html: string, files: ReadonlyMap<string, string>): string {
  return html.replace(IMG, (tag) =>
    tag.replace(SRC, (whole, prefix: string, a?: string, b?: string, bare?: string) => {
      const rel = contentImage(a ?? b ?? bare ?? '');
      const id = rel === null ? undefined : files.get(rel);
      return id === undefined ? whole : `${prefix}"/files/${id}"`;
    }),
  );
}

/** `html` sanitized within {@link TEXT_MAX_BYTES} (cut, then sanitized again until it fits), and whether it was cut. */
function sanitizedBody(html: string): { body: string; cut: boolean } {
  let body: string = sanitizedHtml(html);
  if (Buffer.byteLength(body, 'utf8') <= TEXT_MAX_BYTES) return { body, cut: false };
  for (let limit = TEXT_MAX_BYTES; limit > 0; limit -= 2_000) {
    body = sanitizedHtml(cutBytes(body, limit));
    if (Buffer.byteLength(body, 'utf8') <= TEXT_MAX_BYTES) return { body, cut: true };
  }
  return { body: '', cut: true };
}

/** An image read for a page: its bytes as stored (stripped), type and digest. */
interface PageImage {
  rel: string;
  bytes: Uint8Array;
  mime: string;
  sha256: string;
}

/**
 * The legacy key of image `rel` of the page whose legacy name is `page` (entity `content_image`: the page's group
 * `<kind>:<base>`, or `content:<id>` for a page of its own), within 191 characters.
 */
function imageKey(page: string, rel: string): string {
  const plain = `${page}|${rel}`;
  if (Array.from(plain).length <= 191 && plain.trim() === plain) return plain;
  return `${cutChars(page, 140)}|#${createHash('sha256').update(rel, 'utf8').digest('hex').slice(0, 40)}`;
}

/**
 * The images of a body: the ones the page has already (`stored`, by path), and the others read from the files source
 * and checked (reported when missing, too large or no image).
 */
async function readImages(c: SlimsStageContext, l: Ledger, key: string, rels: readonly string[], stored: ReadonlyMap<string, string>): Promise<PageImage[]> {
  const out: PageImage[] = [];
  for (const rel of rels) {
    if (stored.has(rel)) continue;
    const file = await readSourceFile(c, rel, IMAGE_MAX_BYTES, { keep: true });
    if (file.kind === 'missing') {
      l.report(TC, key, 'missing_file', cutChars(rel, 200));
      continue;
    }
    if (file.kind === 'too_large') {
      l.report(TC, key, 'file_too_large', `${cutChars(rel, 200)} > 2 MB`);
      continue;
    }
    const type = detectType(file.head);
    if (!IMAGE_KINDS.has(type.kind)) {
      l.report(TC, key, 'image_invalid', `${cutChars(rel, 200)}: ${type.kind}`);
      continue;
    }
    let bytes: Uint8Array = file.bytes!;
    if (type.kind !== 'gif') {
      try {
        bytes = stripImageMetadata(bytes, type.kind as StrippableImage);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        l.report(TC, key, 'image_invalid', `${cutChars(rel, 200)}: rusak / damaged`);
        continue;
      }
    }
    out.push({ rel, bytes, mime: type.mime, sha256: sha256Of(bytes) });
  }
  return out;
}

// ---- one row --------------------------------------------------------------------------------------------------------

/** The page of `kind`/`slug`, or undefined. */
async function pageBySlug(db: Kysely<DB> | Transaction<DB>, kind: Kind, slug: string): Promise<{ id: string } | undefined> {
  return db.selectFrom('pages').select('id').where('kind', '=', kind).where('slug_key', '=', slug).executeTakeFirst();
}

/** `planned`, or with the first suffix that no page of `kind` holds and no route takes. */
async function freeSlug(db: Kysely<DB> | Transaction<DB>, kind: Kind, planned: string): Promise<string> {
  let slug = planned;
  for (let n = 2; RESERVED[kind].includes(slug) || (await pageBySlug(db, kind, slug)) !== undefined; n += 1) slug = slugWith(planned, n);
  return slug;
}

/** Writes translation `lang` of page `pageId` (replacing one there). */
async function putTranslation(trx: Transaction<DB>, pageId: string, lang: Lang, title: string, body: string, now: number): Promise<void> {
  const there = await trx.selectFrom('page_translations').select('locale').where('page_id', '=', pageId).where('locale', '=', lang).executeTakeFirst();
  const values = { title, summary: null, body_format: 'html', body, updated_at: now };
  if (there === undefined) await trx.insertInto('page_translations').values({ page_id: pageId, locale: lang, ...values }).execute();
  else await trx.updateTable('page_translations').set(values).where('page_id', '=', pageId).where('locale', '=', lang).execute();
}

/** When a news item was published: `publish_date`, else `input_date`, else now (UTC midnight of a date). */
function publishedAt(row: SlimsRow, now: number): number {
  for (const column of ['publish_date', 'input_date']) {
    const date = cleanDate(keyOf(row[column]));
    if (date === null) continue;
    const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  }
  return now;
}

async function contentUnit(c: SlimsStageContext, row: SlimsRow, pass: Lang, l: Ledger): Promise<boolean> {
  const key = keyOf(row['content_id']);
  if (!keyFits(key)) {
    if (pass === 'id') {
      l.skipped(TC, 'empty_key');
      l.report(TC, null, 'empty_key', 'content_id kosong / empty');
    }
    return pass === 'id';
  }
  const place = (await placements(c)).get(key);
  if (place === undefined || place.lang !== pass) return false; // the other pass's row (or a repeated key)
  const state = stateOf(c, (await mappedRows(c, c.h.db, TC, [key])).get(key));
  if (state === 'done') {
    l.skipped(TC, 'already_migrated');
    return true;
  }
  if (place.lang === 'en' && place.rank > 0) {
    l.skipped(TC, 'duplicate_translation');
    l.report(TC, key, 'translation_duplicate', `${place.kind}/${place.base}_en`);
    return true;
  }
  const group = `${place.kind}:${place.base}`;
  // The page: the group's (found through its map row), or a new one.
  const main = place.rank === 0 ? ((await targetsOf(c, c.h.db, 'content_slug', [group])).get(group) ?? null) : null;
  const creates = main === null;
  const planned = place.lang === 'id' && place.rank > 0 ? slugWith(place.base, place.rank + 1) : place.base;
  // An English row whose group has no Indonesian row makes the page itself (or found it made by an earlier run).
  const ownPage = place.lang === 'id' || !(await idGroups(c)).has(group);
  if (place.lang === 'en' && ownPage) l.report(TC, key, 'translation_id_missing', `${place.kind}/${place.base}`);
  const title = fitChars(l, TC, key, 'content_title', oneLine(textOf(l, TC, 'content_title', row['content_title']) ?? ''), TITLE_MAX) ?? place.base;
  const html = textOf(l, TC, 'content_desc', row['content_desc']) ?? '';
  const dropped = droppedTags(html);
  if (dropped.length > 0) l.report(TC, key, 'html_tags_dropped', cutChars(dropped.join(', '), 200));

  const pageId = state === 'replay' ? (await mappedRows(c, c.h.db, TC, [key])).get(key)!.targetId : (main ?? (c.dryRun ? null : newId(c.now)));
  const rels = imagesOf(html);
  const pageLegacy = place.rank === 0 ? group : `content:${key}`;
  const stored = rels.length === 0 ? new Map<string, string>() : await imagesStored(c, pageLegacy, rels);
  const images = await readImages(c, l, key, rels, stored);
  if (state === 'replay') {
    // The slug the page got (when the row made it, its slug may have been taken).
    const page = await c.h.db.selectFrom('pages').select('slug_key').where('id', '=', pageId!).executeTakeFirst();
    if (page !== undefined && ownPage && page.slug_key !== planned) l.report(TC, key, 'slug_changed', `${planned} -> ${page.slug_key}`);
    if (bodyCut(html, stored)) l.report(TC, key, 'body_truncated', `> ${TEXT_MAX_BYTES} bytes`);
    l.migrated(TC);
    return true;
  }
  if (c.dryRun || pageId === null) {
    const slug = creates ? await freeSlug(c.h.db, place.kind, planned) : planned;
    if (slug !== planned) l.report(TC, key, 'slug_changed', `${planned} -> ${slug}`);
    if (sanitizedBody(rewriteImages(html, new Map(images.map((im) => [im.rel, '0'.repeat(26)])))).cut) l.report(TC, key, 'body_truncated', `> ${TEXT_MAX_BYTES} bytes`);
    l.migrated(TC);
    return true;
  }

  // A real run: the images' bytes first, then the page, its translation(s), the images' rows and the map rows.
  const made = new Map<string, string>(stored);
  const fresh: (PageImage & { id: string })[] = [];
  for (const im of images) {
    const id = newId(c.now);
    await storeBlob(c, id, im.bytes, { size: im.bytes.byteLength, sha256: im.sha256 });
    fresh.push({ ...im, id });
    made.set(im.rel, id);
  }
  const { body, cut } = sanitizedBody(rewriteImages(html, made));
  try {
    const slug = await withTx(c.h, async (trx) => {
      let slugNow = planned;
      if (creates) {
        slugNow = await freeSlug(trx, place.kind, planned);
        const published = place.kind === 'news' && keyOf(row['is_draft']) !== '1';
        const page: Insertable<DB['pages']> = {
          id: pageId,
          kind: place.kind,
          slug_key: slugNow,
          status: published ? 'published' : 'draft',
          published_at: published ? publishedAt(row, c.now) : null,
          show_in_nav: 0,
          cover_file_id: null,
          sort_order: 0,
          archived_at: null,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        };
        await againOnRace(() => trx.insertInto('pages').values(page).execute());
        // Indonesian is required (§9.5): a page made from its English row gets that text as its `id` translation too.
        if (place.lang === 'en') await putTranslation(trx, pageId, 'id', title, body, c.now);
      }
      await putTranslation(trx, pageId, place.lang, title, body, c.now);
      for (const im of fresh) {
        await trx
          .insertInto('files')
          .values({
            id: im.id,
            original_name: cutChars(im.rel.split('/').pop() ?? im.rel, TITLE_MAX),
            mime: im.mime,
            size: im.bytes.byteLength,
            sha256: im.sha256,
            context: 'opac.page_image',
            owner_type: 'pages',
            owner_id: pageId,
            access: 'public',
            status: 'ok',
            created_at: c.now,
            created_by: null,
          })
          .execute();
      }
      const maps: LegacyMapping[] = [{ source: c.options.sourceName, entity: TC, legacyKey: key, targetId: pageId, runId: c.runId }];
      if (creates && place.rank === 0) maps.push({ source: c.options.sourceName, entity: 'content_slug', legacyKey: group, targetId: pageId, runId: c.runId });
      for (const im of fresh) maps.push({ source: c.options.sourceName, entity: 'content_image', legacyKey: imageKey(pageLegacy, im.rel), targetId: im.id, runId: c.runId });
      await mapLegacy(trx, maps);
      return slugNow;
    });
    if (slug !== planned) l.report(TC, key, 'slug_changed', `${planned} -> ${slug}`);
  } catch (error) {
    for (const im of fresh) await c.storage.delete(im.id).catch(() => undefined);
    throw error;
  }
  if (cut) l.report(TC, key, 'body_truncated', `> ${TEXT_MAX_BYTES} bytes`);
  l.migrated(TC);
  return true;
}

/** The images of the page whose legacy name is `page` stored already, by path. */
async function imagesStored(c: SlimsStageContext, page: string, rels: readonly string[]): Promise<Map<string, string>> {
  const keys = new Map(rels.map((rel) => [imageKey(page, rel), rel]));
  const found = await targetsOf(c, c.h.db, 'content_image', [...keys.keys()]);
  return new Map([...found].map(([k, id]) => [keys.get(k)!, id]));
}

/** Whether the body of a row this run wrote was cut (from its stored images). */
function bodyCut(html: string, stored: ReadonlyMap<string, string>): boolean {
  return sanitizedBody(rewriteImages(html, stored)).cut;
}

// ---- the stage ------------------------------------------------------------------------------------------------------

/** The passes: the Indonesian rows (pages), then the English ones (translations). */
const PASSES: readonly Lang[] = ['id', 'en'];

/** Content (§11.3 step 8, §11.4): see the top of this file. */
export const contentStage: SlimsStage = Object.freeze({
  name: 'content' as const,
  reads: Object.freeze([TC]) as readonly string[],
  async run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
    let at = readCursor('content', cursor);
    let units = 0;
    while (at.p < PASSES.length) {
      if (units > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
      if ((await tableOf(c, TC)) === null) {
        at = nextPhase(at);
        continue;
      }
      const batch = await c.source.rows(TC, at.c, stageBBatch());
      const next = sourceCursor('content', batch.rows.length === 0 ? null : batch.next);
      let i = at.i;
      for (; i < batch.rows.length; i += 1) {
        if (units > 0 && c.budgetLeftMs() <= 0) break;
        const l = Ledger.of(at);
        if (await contentUnit(c, batch.rows[i]!, PASSES[at.p]!, l)) units += 1;
        l.apply(c);
        at = { ...at, i: i + 1, ...l.state() };
      }
      if (i < batch.rows.length) return { done: false, cursor: writeCursor(at) };
      units += 1;
      at = next === null ? nextPhase(at) : { ...at, c: next, i: 0, n: at.n + batch.rows.length };
    }
    return endOfStage(c, 'content', at);
  },
});
