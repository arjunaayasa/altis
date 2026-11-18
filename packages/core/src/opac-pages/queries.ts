import type { DB } from '@altis/db';
import type { BodyFormat, NewsCategory, PageKind } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';

// Halaman & Berita, the OPAC's reads (Phase 2 spec §9.1, §9.5, §9.6, K14; plan Task 20). A page is shown when it is
// published (`status = 'published'`), its `published_at` has come (`<= now`: a future date is a scheduled post, left
// out until the clock passes it; no job publishes it) and it is not archived. `now` is the time of the request.
// Plain dialect-neutral Kysely; timestamps and flags read back go through Number() (BIGINT on PostgreSQL and MySQL).

type Db = Kysely<DB> | Transaction<DB>;

/** News posts per page of `/berita` (§9.1). */
export const OPAC_NEWS_PER_PAGE = 10;

/** One translation of a published page, its body as stored (the OPAC renders and sanitizes it again). */
export interface OpacPageTranslation {
  title: string;
  summary: string | null;
  bodyFormat: BodyFormat;
  body: string;
}

/** The agenda of a news post: its category and the event it announces (all null on a page). */
export interface OpacNewsAgenda {
  category: NewsCategory | null;
  eventStartsAt: number | null;
  eventEndsAt: number | null;
  eventPlace: string | null;
}

/** A page or a news post the OPAC shows. */
export interface OpacPublishedPage extends OpacNewsAgenda {
  id: string;
  kind: PageKind;
  slug: string;
  publishedAt: number;
  updatedAt: number;
  coverFileId: string | null;
  /** Indonesian is always there (§9.5); English may not be. */
  translations: { id: OpacPageTranslation; en: OpacPageTranslation | null };
}

/** The title and summary of one translation of a news post (what a list and a feed show). */
export interface OpacNewsText {
  title: string;
  summary: string | null;
}

/** A news post in a list or a feed. */
export interface OpacNewsItem extends OpacNewsAgenda {
  id: string;
  slug: string;
  publishedAt: number;
  coverFileId: string | null;
  translations: { id: OpacNewsText; en: OpacNewsText | null };
}

/** One page of `/berita`: its posts, its number, how many pages there are and how many posts. */
export interface OpacNewsPage {
  items: OpacNewsItem[];
  page: number;
  pages: number;
  total: number;
}

/** The columns of a post in a list. */
const POST_COLUMNS = ['id', 'slug_key', 'published_at', 'cover_file_id', 'category', 'event_starts_at', 'event_ends_at', 'event_place'] as const;

interface AgendaColumns {
  category: string | null;
  event_starts_at: number | null;
  event_ends_at: number | null;
  event_place: string | null;
}

function agendaOf(p: AgendaColumns): OpacNewsAgenda {
  return {
    category: p.category as NewsCategory | null,
    eventStartsAt: p.event_starts_at === null ? null : Number(p.event_starts_at),
    eventEndsAt: p.event_ends_at === null ? null : Number(p.event_ends_at),
    eventPlace: p.event_place,
  };
}

/** The pages of `kind` shown at `now` (see the top of this file), as the start of a query. */
function shown(db: Db, kind: PageKind, now: number) {
  return db
    .selectFrom('pages')
    .where('kind', '=', kind)
    .where('status', '=', 'published')
    .where('published_at', '<=', now)
    .where('archived_at', 'is', null);
}

/**
 * The page or news post `slug` of `kind` as the OPAC shows it at `now`, or null: unknown, a draft, scheduled later,
 * archived, or without its Indonesian translation.
 */
export async function publishedPage(db: Db, kind: PageKind, slug: string, now: number): Promise<OpacPublishedPage | null> {
  const page = await shown(db, kind, now)
    .select(['id', 'kind', 'slug_key', 'published_at', 'updated_at', 'cover_file_id', 'category', 'event_starts_at', 'event_ends_at', 'event_place'])
    .where('slug_key', '=', slug)
    .executeTakeFirst();
  if (page === undefined) return null;
  const rows = await db.selectFrom('page_translations').select(['locale', 'title', 'summary', 'body_format', 'body']).where('page_id', '=', page.id).execute();
  const text = (locale: string): OpacPageTranslation | null => {
    const r = rows.find((t) => t.locale === locale);
    return r === undefined ? null : { title: r.title, summary: r.summary, bodyFormat: r.body_format as BodyFormat, body: r.body };
  };
  const id = text('id');
  if (id === null) return null;
  return {
    id: page.id,
    kind: page.kind as PageKind,
    slug: page.slug_key,
    publishedAt: Number(page.published_at),
    updatedAt: Number(page.updated_at),
    coverFileId: page.cover_file_id,
    ...agendaOf(page),
    translations: { id, en: text('en') },
  };
}

/** The list texts of `ids`, by page id; a post without its Indonesian translation is left out. */
async function newsItems(
  db: Db,
  posts: readonly ({ id: string; slug_key: string; published_at: number | null; cover_file_id: string | null } & AgendaColumns)[],
): Promise<OpacNewsItem[]> {
  if (posts.length === 0) return [];
  const rows = await db
    .selectFrom('page_translations')
    .select(['page_id', 'locale', 'title', 'summary'])
    .where(
      'page_id',
      'in',
      posts.map((p) => p.id),
    )
    .execute();
  const out: OpacNewsItem[] = [];
  for (const p of posts) {
    const own = (locale: string): OpacNewsText | null => {
      const r = rows.find((t) => t.page_id === p.id && t.locale === locale);
      return r === undefined ? null : { title: r.title, summary: r.summary };
    };
    const id = own('id');
    if (id === null) continue;
    out.push({ id: p.id, slug: p.slug_key, publishedAt: Number(p.published_at), coverFileId: p.cover_file_id, ...agendaOf(p), translations: { id, en: own('en') } });
  }
  return out;
}

/** The news posts shown at `now`, of `category` when one is given. */
function shownNews(db: Db, now: number, category: NewsCategory | undefined) {
  const news = shown(db, 'news', now);
  return category === undefined ? news : news.where('category', '=', category);
}

/** The news posts shown at `now`, newest first (by publication, then id); only those of `category` when one is given. */
function newsInOrder(db: Db, now: number, category?: NewsCategory) {
  return shownNews(db, now, category).select(POST_COLUMNS).orderBy('published_at', 'desc').orderBy('id', 'desc');
}

/**
 * Page `page` (1-based) of the news shown at `now`, {@link OPAC_NEWS_PER_PAGE} per page, newest first; only the posts
 * of `category` when one is given. A page past the last has no items (the route answers it with 404).
 *
 * @throws RangeError for a page that is not a positive safe integer
 */
export async function newsPage(db: Db, page: number, now: number, category?: NewsCategory): Promise<OpacNewsPage> {
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError('newsPage: the page must be a positive integer');
  const counted = await shownNews(db, now, category)
    .select((eb) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow();
  const total = Number(counted.n);
  const pages = Math.max(1, Math.ceil(total / OPAC_NEWS_PER_PAGE));
  const offset = (page - 1) * OPAC_NEWS_PER_PAGE;
  const posts = offset >= total ? [] : await newsInOrder(db, now, category).limit(OPAC_NEWS_PER_PAGE).offset(offset).execute();
  return { items: await newsItems(db, posts), page, pages, total };
}

/** The `n` newest news posts shown at `now` (the feed's 20, §9.1); only those of `category` when one is given. */
export async function latestNews(db: Db, n: number, now: number, category?: NewsCategory): Promise<OpacNewsItem[]> {
  if (!Number.isSafeInteger(n) || n <= 0) return [];
  return newsItems(db, await newsInOrder(db, now, category).limit(n).execute());
}

/**
 * The `n` next events among the news shown at `now`: the posts with an event that has not started yet, or that started
 * and whose end has not passed, the soonest start first (then id). An event without an end is over once it started.
 */
export async function upcomingEvents(db: Db, n: number, now: number): Promise<OpacNewsItem[]> {
  if (!Number.isSafeInteger(n) || n <= 0) return [];
  const posts = await shown(db, 'news', now)
    .select(POST_COLUMNS)
    .where('event_starts_at', 'is not', null)
    .where((eb) => eb.or([eb('event_starts_at', '>=', now), eb('event_ends_at', '>=', now)]))
    .orderBy('event_starts_at', 'asc')
    .orderBy('id', 'asc')
    .limit(n)
    .execute();
  return newsItems(db, posts);
}
