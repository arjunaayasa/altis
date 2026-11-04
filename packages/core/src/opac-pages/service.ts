import type { DB } from '@altis/db';
import { DomainError, isDomainError, isUlid, newId, type BodyFormat, type PageKind, type PageLocale, type PageStatus } from '@altis/shared';
import { TEXT_MAX_BYTES, utf8Length, type FieldWarning } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import {
  PageBody,
  PageListQuery,
  PagePatchBody,
  type PageListItem,
  type PageListResponse,
  type PageTranslationInput,
  type PageTranslationView,
  type PageView,
} from '@altis/shared/api/opac-pages';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { z } from 'zod';
import type { TxCtx } from '../context.js';
import { renderMarkdown } from '../html/markdown.js';
import { sanitizedHtml, type SafeHtml } from '../html/sanitize.js';

// Halaman & Berita, the admin side (Phase 2 spec §2.2 `pages`, §9.5, §12.2; plan Task 20): static pages (`page`,
// `/halaman/<slug>`) and news posts (`news`, `/berita/<slug>`), each with an Indonesian translation (required) and an
// English one (optional).
//
// - Bodies. A `markdown` body is stored as written (the OPAC renders it through `renderMarkdown`); an `html` body (what
//   the SLiMS migration brings) is stored as `sanitizedHtml(body)`. Both are sanitized again when rendered. The
//   sanitized form can be longer than its input (`"` → `&quot;`, implied list and table tags), so it is measured again:
//   past 60 000 UTF-8 bytes (MySQL TEXT holds 65 535) it is `{path: 'translations.<locale>.body', code: 'too_big'}`.
// - Slugs (`[a-z0-9-]`, the contract) are unique per kind over every row, archived ones included (the UNIQUE index):
//   `{path: 'slug', code: 'taken'}`, checked first and again when the write loses the race for the key (a
//   UNIQUE_VIOLATION, which ends the transaction on PostgreSQL, so it is thrown at once). The news slug `rss` is the
//   feed's URL (`/berita/rss`): `{path: 'slug', code: 'reserved'}`.
// - Publication. A page is shown when `status = 'published'` and `published_at <= now` (queries.ts); a future
//   `published_at` is a scheduled post, filtered when read (no job). A page published without a date is dated with the
//   time of the write; a draft keeps the date it was given (the planned one), or none.
// - Page images (`opac.page_image` uploads, §8). The cover and every image a body shows (`/files/<id>` in the rendered
//   HTML) claim their upload: `files.owner_type 'pages'`, `owner_id` the page, `access 'public'` (the OPAC shows them).
//   A claim takes only a row whose `owner_type` and `owner_id` are both null: the orphan step of `catalog.housekeeping`
//   marks an upload it is about to delete (`owner_type 'orphan'`), and such a row must never be taken back. A cover
//   that cannot be claimed (missing, another context, owned elsewhere or marked) is refused at `coverFileId`; a body
//   image that cannot be claimed is left as it is (a migrated body may show any public file). A claimed image stays the
//   page's when a later edit drops it (another page may still show it), so it is never deleted as an orphan.
// - Concurrency: an update or an archive first locks the page row with a write that changes nothing, then compares
//   `version` (CONFLICT_STALE) and bumps it in the UPDATE that writes the row; a translation change bumps it too.
// - Audit: one entry per write (`opac.page.create|update|archive`, entity `pages`) whose `meta` holds the kind, the
//   status, the locales or the changed field names, never a title or a body.

type Db = Kysely<DB> | Transaction<DB>;
type PageRow = Selectable<DB['pages']>;
type TranslationRow = Selectable<DB['page_translations']>;

/** The table and its audit entity. */
const ENTITY = 'pages';
/** The upload context of page images (§8). */
const IMAGE_CONTEXT = 'opac.page_image';
/** The slugs a kind may not take: `/berita/rss` is the news feed. */
const RESERVED_SLUGS: Readonly<Record<PageKind, readonly string[]>> = Object.freeze({ page: [], news: ['rss'] });
/** The `src` of an image the sanitizer kept: always exactly `/files/<ulid>` (sanitize.ts `safeSrc`). */
const IMAGE_SRC = /\ssrc="\/files\/([0-9A-HJKMNP-TV-Z]{26})"/g;
/** At most this many ids in one `IN (…)` list. */
const ID_BATCH = 200;

// ---- errors ----------------------------------------------------------------------------------------------------------

function validationFailed(errors: readonly FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data halaman belum benar / The page data is not valid',
    meta: { errors: errors.map((e) => ({ path: e.path, code: e.code })) },
  });
}

function pageNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Halaman tidak ditemukan / Page not found' });
}

function pageStale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Halaman sudah diubah orang lain; muat ulang / The page was changed by someone else; reload it',
  });
}

/** `body` parsed with the strict API contract `schema` (a caller other than the API meets the same rules). */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw validationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
}

/** Runs a write that may lose the race for `(kind, slug_key)`: that UNIQUE_VIOLATION is a taken slug. */
async function takingSlug<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw validationFailed([{ path: 'slug', code: 'taken' }]);
    throw error;
  }
}

// ---- bodies ----------------------------------------------------------------------------------------------------------

/**
 * A body as the OPAC shows it, and as the editor's preview (`POST opac/pages/preview`) shows it: Markdown rendered
 * through `renderMarkdown` (which ends in the sanitizer), HTML through `sanitizedHtml`.
 */
export function previewBody(format: BodyFormat, body: string): SafeHtml {
  return format === 'html' ? sanitizedHtml(body) : renderMarkdown(body);
}

/** One translation as it is stored: an `html` body sanitized, a blank summary as null. */
interface StoredTranslation {
  title: string;
  summary: string | null;
  bodyFormat: BodyFormat;
  body: string;
}

function storedTranslation(t: PageTranslationInput): StoredTranslation {
  const summary = t.summary === undefined || t.summary === null || t.summary.trim() === '' ? null : t.summary;
  return { title: t.title, summary, bodyFormat: t.bodyFormat, body: t.bodyFormat === 'html' ? sanitizedHtml(t.body) : t.body };
}

/** The field error of a stored body that no longer fits TEXT once sanitized, if any. */
function bodyTooBig(locale: PageLocale, t: StoredTranslation): FieldWarning | null {
  return utf8Length(t.body) > TEXT_MAX_BYTES ? { path: `translations.${locale}.body`, code: 'too_big' } : null;
}

/** The ids of the `/files/<id>` images the rendered `bodies` show. */
function imageIds(bodies: readonly StoredTranslation[]): string[] {
  const ids = new Set<string>();
  for (const t of bodies) for (const m of previewBody(t.bodyFormat, t.body).matchAll(IMAGE_SRC)) ids.add(m[1]!);
  return [...ids];
}

// ---- page images -----------------------------------------------------------------------------------------------------

/** Which `fileId` can be a cover of page `pageId`: claimable (no owner at all), already the page's, or why not. */
async function coverState(trx: Transaction<DB>, pageId: string, fileId: string): Promise<'claim' | 'own' | FieldWarning> {
  const file = await trx.selectFrom('files').select(['context', 'owner_type', 'owner_id', 'status']).where('id', '=', fileId).executeTakeFirst();
  if (file === undefined) return { path: 'coverFileId', code: 'not_found' };
  if (file.context !== IMAGE_CONTEXT || file.status !== 'ok') return { path: 'coverFileId', code: 'invalid' };
  if (file.owner_type === ENTITY && file.owner_id === pageId) return 'own';
  if (file.owner_type === null && file.owner_id === null) return 'claim';
  return { path: 'coverFileId', code: 'invalid' };
}

/**
 * Makes the unowned page-image uploads among `ids` page `pageId`'s (public). The UPDATE itself re-checks that both owner
 * columns are null, so a claim never takes a row another claim or the orphan step got first. Answers how many it took.
 */
async function claimImages(trx: Transaction<DB>, pageId: string, ids: readonly string[]): Promise<number> {
  let claimed = 0;
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    const r = await trx
      .updateTable('files')
      .set({ owner_type: ENTITY, owner_id: pageId, access: 'public' })
      .where('id', 'in', batch)
      .where('context', '=', IMAGE_CONTEXT)
      .where('status', '=', 'ok')
      .where('owner_type', 'is', null)
      .where('owner_id', 'is', null)
      .executeTakeFirst();
    claimed += Number(r.numUpdatedRows);
  }
  return claimed;
}

/** Claims the cover (refused at `coverFileId` when it cannot be) and the body images of page `pageId`. */
async function claimPageImages(trx: Transaction<DB>, pageId: string, coverFileId: string | null, bodies: readonly StoredTranslation[]): Promise<void> {
  if (coverFileId !== null) {
    const state = await coverState(trx, pageId, coverFileId);
    if (typeof state === 'object') throw validationFailed([state]);
    // Claimed meanwhile by another page, or marked by the orphan cleanup.
    if (state === 'claim' && (await claimImages(trx, pageId, [coverFileId])) !== 1) throw validationFailed([{ path: 'coverFileId', code: 'invalid' }]);
  }
  const images = imageIds(bodies).filter((id) => id !== coverFileId);
  if (images.length > 0) await claimImages(trx, pageId, images);
}

// ---- reading ---------------------------------------------------------------------------------------------------------

function translationView(r: TranslationRow): PageTranslationView {
  return { title: r.title, summary: r.summary, bodyFormat: r.body_format as BodyFormat, body: r.body, updatedAt: Number(r.updated_at) };
}

function viewOf(p: PageRow, translations: readonly TranslationRow[]): PageView {
  const id = translations.find((t) => t.locale === 'id');
  const en = translations.find((t) => t.locale === 'en');
  // Every writer stores the Indonesian translation with its page (§9.5); a page without one has an empty one here.
  const idView: PageTranslationView =
    id === undefined ? { title: '', summary: null, bodyFormat: 'markdown', body: '', updatedAt: Number(p.updated_at) } : translationView(id);
  return {
    id: p.id,
    kind: p.kind as PageKind,
    slug: p.slug_key,
    status: p.status as PageStatus,
    publishedAt: p.published_at === null ? null : Number(p.published_at),
    showInNav: Number(p.show_in_nav) === 1,
    coverFileId: p.cover_file_id,
    sortOrder: Number(p.sort_order),
    translations: { id: idView, en: en === undefined ? null : translationView(en) },
    archived: p.archived_at !== null,
    createdAt: Number(p.created_at),
    updatedAt: Number(p.updated_at),
    version: Number(p.version),
  };
}

async function readView(db: Db, id: string): Promise<PageView | null> {
  const page = await db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirst();
  if (page === undefined) return null;
  const translations = await db.selectFrom('page_translations').selectAll().where('page_id', '=', id).execute();
  return viewOf(page, translations);
}

/**
 * Page `id` as the admin edits it (archived ones included, `archived: true`).
 *
 * @throws DomainError NOT_FOUND for an unknown id
 */
export async function getPage(db: Db, id: string): Promise<PageView> {
  if (!isUlid(id)) throw pageNotFound();
  const view = await readView(db, id);
  if (view === null) throw pageNotFound();
  return view;
}

/**
 * The live pages of one kind (`q.status` narrows them), newest first, by keyset: `nextCursor` is the last id of a full
 * page, which the next call sends as `cursor`. Each row carries its Indonesian title and whether English exists.
 *
 * @throws DomainError VALIDATION_FAILED for a query the contract refuses, or at `cursor` (`invalid`)
 */
export async function listPages(db: Db, q: z.input<typeof PageListQuery>): Promise<PageListResponse> {
  const query = parseBody(PageListQuery, q);
  if (query.cursor !== undefined && !isUlid(query.cursor)) throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
  let select = db.selectFrom('pages').selectAll().where('kind', '=', query.kind).where('archived_at', 'is', null);
  if (query.status !== undefined) select = select.where('status', '=', query.status);
  if (query.cursor !== undefined) select = select.where('id', '<', query.cursor);
  const rows = await select.orderBy('id', 'desc').limit(query.limit + 1).execute();
  const pageRows = rows.slice(0, query.limit);
  const ids = pageRows.map((p) => p.id);
  const translations =
    ids.length === 0
      ? []
      : await db.selectFrom('page_translations').select(['page_id', 'locale', 'title']).where('page_id', 'in', ids).execute();
  const items: PageListItem[] = pageRows.map((p) => {
    const own = translations.filter((t) => t.page_id === p.id);
    return {
      id: p.id,
      kind: p.kind as PageKind,
      slug: p.slug_key,
      status: p.status as PageStatus,
      publishedAt: p.published_at === null ? null : Number(p.published_at),
      showInNav: Number(p.show_in_nav) === 1,
      title: own.find((t) => t.locale === 'id')?.title ?? '',
      hasEnglish: own.some((t) => t.locale === 'en'),
      updatedAt: Number(p.updated_at),
      version: Number(p.version),
    };
  });
  return { items, nextCursor: rows.length > query.limit ? (pageRows[pageRows.length - 1]?.id ?? null) : null };
}

// ---- writing ---------------------------------------------------------------------------------------------------------

/** The field errors of a page's address: the kind's reserved slugs, and a slug another page of the kind holds. */
async function slugErrors(trx: Transaction<DB>, kind: PageKind, slug: string, exceptId: string | null): Promise<FieldWarning[]> {
  if (RESERVED_SLUGS[kind].includes(slug)) return [{ path: 'slug', code: 'reserved' }];
  let q = trx.selectFrom('pages').select('id').where('kind', '=', kind).where('slug_key', '=', slug);
  if (exceptId !== null) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) === undefined ? [] : [{ path: 'slug', code: 'taken' }];
}

/** Inserts or replaces the `locale` translation of `pageId`. */
async function putTranslation(trx: Transaction<DB>, pageId: string, locale: PageLocale, t: StoredTranslation, now: number): Promise<void> {
  const values = { title: t.title, summary: t.summary, body_format: t.bodyFormat, body: t.body, updated_at: now };
  const updated = await trx.updateTable('page_translations').set(values).where('page_id', '=', pageId).where('locale', '=', locale).executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) await trx.insertInto('page_translations').values({ page_id: pageId, locale, ...values }).execute();
}

/** The publication date a page is written with: a published page without one is published now (see the top). */
function publicationDate(status: PageStatus, publishedAt: number | null, now: number): number | null {
  return status === 'published' && publishedAt === null ? now : publishedAt;
}

/**
 * Creates a page or a news post (see the top of this file).
 *
 * @throws DomainError VALIDATION_FAILED for a body the contract refuses; at `slug` (`taken`, `reserved`), at
 *   `translations.<locale>.body` (`too_big`: the sanitized HTML passes 60 000 bytes), at `coverFileId` (`not_found`,
 *   `invalid`)
 */
export async function createPage(tx: TxCtx, body: PageBody): Promise<PageView> {
  const input = parseBody(PageBody, body);
  const { trx } = tx;
  const translations: [PageLocale, StoredTranslation][] = [['id', storedTranslation(input.translations.id)]];
  if (input.translations.en !== undefined) translations.push(['en', storedTranslation(input.translations.en)]);
  const errors = [
    ...(await slugErrors(trx, input.kind, input.slug, null)),
    ...translations.flatMap(([locale, t]) => bodyTooBig(locale, t) ?? []),
  ];
  if (errors.length > 0) throw validationFailed(errors);

  const id = newId(tx.now);
  const coverFileId = input.coverFileId ?? null;
  await takingSlug(() =>
    trx
      .insertInto('pages')
      .values({
        id,
        kind: input.kind,
        slug_key: input.slug,
        status: input.status,
        published_at: publicationDate(input.status, input.publishedAt ?? null, tx.now),
        show_in_nav: input.showInNav ? 1 : 0,
        cover_file_id: coverFileId,
        sort_order: input.sortOrder,
        archived_at: null,
        version: 0,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  for (const [locale, t] of translations) await putTranslation(trx, id, locale, t, tx.now);
  await claimPageImages(
    trx,
    id,
    coverFileId,
    translations.map(([, t]) => t),
  );
  await tx.audit({ action: 'opac.page.create', entity: ENTITY, entityId: id, meta: { kind: input.kind, status: input.status, locales: translations.map(([l]) => l) } });
  return (await readView(trx, id))!;
}

/** Locks page `id` (a write that changes nothing) and reads it; NOT_FOUND for an unknown id. */
async function lockedPage(trx: Transaction<DB>, id: string): Promise<PageRow> {
  if (!isUlid(id)) throw pageNotFound();
  await trx
    .updateTable('pages')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
  const row = await trx.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw pageNotFound();
  return row;
}

/**
 * Changes what `patch` sends; `patch.version` is the page's. A translation sent replaces that language's; `en: null`
 * removes English. Archived pages cannot be edited.
 *
 * @throws DomainError NOT_FOUND (unknown or archived); CONFLICT_STALE; VALIDATION_FAILED as {@link createPage}
 */
export async function updatePage(tx: TxCtx, id: string, patch: PagePatchBody): Promise<PageView> {
  const input = parseBody(PagePatchBody, patch);
  const { trx } = tx;
  const row = await lockedPage(trx, id);
  if (row.archived_at !== null) throw pageNotFound();
  if (Number(row.version) !== input.version) throw pageStale();

  const kind = input.kind ?? (row.kind as PageKind);
  const slug = input.slug ?? row.slug_key;
  const status = input.status ?? (row.status as PageStatus);
  const given = input.publishedAt === undefined ? (row.published_at === null ? null : Number(row.published_at)) : input.publishedAt;
  const publishedAt = publicationDate(status, given, tx.now);
  const showInNav = input.showInNav === undefined ? Number(row.show_in_nav) === 1 : input.showInNav;
  const coverFileId = input.coverFileId === undefined ? row.cover_file_id : input.coverFileId;
  const sortOrder = input.sortOrder ?? Number(row.sort_order);

  const puts: [PageLocale, StoredTranslation][] = [];
  if (input.translations?.id !== undefined) puts.push(['id', storedTranslation(input.translations.id)]);
  if (input.translations?.en !== undefined && input.translations.en !== null) puts.push(['en', storedTranslation(input.translations.en)]);
  const dropEnglish = input.translations?.en === null;

  const errors = [
    ...(kind !== row.kind || slug !== row.slug_key ? await slugErrors(trx, kind, slug, id) : []),
    ...puts.flatMap(([locale, t]) => bodyTooBig(locale, t) ?? []),
  ];
  if (errors.length > 0) throw validationFailed(errors);

  const fields = [
    ...(
      [
        ['kind', kind !== row.kind],
        ['slug', slug !== row.slug_key],
        ['status', status !== row.status],
        ['publishedAt', publishedAt !== (row.published_at === null ? null : Number(row.published_at))],
        ['showInNav', showInNav !== (Number(row.show_in_nav) === 1)],
        ['coverFileId', coverFileId !== row.cover_file_id],
        ['sortOrder', sortOrder !== Number(row.sort_order)],
      ] as const
    )
      .filter(([, changed]) => changed)
      .map(([name]) => name),
    ...puts.map(([locale]) => `translations.${locale}`),
    ...(dropEnglish ? ['translations.en'] : []),
  ];

  const updated = await takingSlug(() =>
    trx
      .updateTable('pages')
      .set((eb) => ({
        kind,
        slug_key: slug,
        status,
        published_at: publishedAt,
        show_in_nav: showInNav ? 1 : 0,
        cover_file_id: coverFileId,
        sort_order: sortOrder,
        updated_at: tx.now,
        updated_by: tx.actor.id,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', id)
      .where('version', '=', input.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw pageStale();
  for (const [locale, t] of puts) await putTranslation(trx, id, locale, t, tx.now);
  if (dropEnglish) await trx.deleteFrom('page_translations').where('page_id', '=', id).where('locale', '=', 'en').execute();
  await claimPageImages(
    trx,
    id,
    input.coverFileId === undefined ? null : coverFileId,
    puts.map(([, t]) => t),
  );
  await tx.audit({ action: 'opac.page.update', entity: ENTITY, entityId: id, meta: { fields } });
  return (await readView(trx, id))!;
}

/**
 * Archives page `id` (`archived_at`; gone from the OPAC and the admin list; its slug stays taken). An archived page
 * asked again with its current version is answered as it is, with one entry marked `alreadyArchived`.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE
 */
export async function archivePage(tx: TxCtx, id: string, version: number): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  const row = await lockedPage(trx, id);
  if (Number(row.version) !== version) throw pageStale();
  if (row.archived_at !== null) {
    await tx.audit({ action: 'opac.page.archive', entity: ENTITY, entityId: id, meta: { alreadyArchived: true } });
    return { id, version };
  }
  const updated = await trx
    .updateTable('pages')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw pageStale();
  await tx.audit({ action: 'opac.page.archive', entity: ENTITY, entityId: id, meta: {} });
  return { id, version: version + 1 };
}
