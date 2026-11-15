import { legacyTarget, popularRecordIds, recordUrlPath } from '@altis/core';
import type { DbHandle } from '@altis/db';
import type { Locale } from '@altis/shared';
import { sourceNameField } from '@altis/shared/api/catalog/migration';

// The reads of the OPAC shell (Phase 2 Task 21; spec §9.1, §9.5, §9.7, §9.9): the menu pages, the home page's
// blocks, the sitemaps and the old SLiMS links. Plain dialect-neutral Kysely (no RETURNING, no JSON SQL, no OFFSET in
// the sitemap walk, M5); every timestamp and flag read back goes through Number() (BIGINT on PostgreSQL and MySQL).
//
// A record the OPAC shows is `opac_visible = 1`, not archived and not merged (the predicate search_doc.is_public is
// built from, Task 15). The home page's new titles come from search_doc through `ix_search_doc_public_created` (S14);
// everything else reads `records` and `pages` directly.

/** The Kysely instance of a DbHandle (apps/server reaches Kysely only through @altis/db). */
type Db = DbHandle['db'];

/** At most this many pages in the menu (§9.5). */
export const NAV_MAX = 8;

/** A link of the menu: a published page in its language, or in Indonesian (`lang: 'id'`) when it has no translation. */
export interface OpacNavLink {
  /** A local path. */
  href: string;
  label: string;
  /** The language of `label` when it is not the page's. */
  lang?: Locale;
}

/** One record as the home page shows it. */
export interface TitleCard {
  id: string;
  title: string;
  subtitle: string | null;
  /** CHAR(4). */
  year: string | null;
  coverFileId: string | null;
  /** The display name of the main agent (`is_main`), if any. */
  mainAgent: string | null;
}

/** One news post as the home page lists it. */
export interface NewsTeaser {
  slug: string;
  title: string;
  summary: string | null;
  publishedAt: number;
  /** `id` when the post has no translation in the page's language. */
  lang: Locale | null;
}

/** The records the OPAC shows, as the start of a query. */
function publicRecords(db: Db) {
  return db.selectFrom('records').where('opac_visible', '=', 1).where('archived_at', 'is', null).where('merged_into', 'is', null);
}

/** The pages (`kind`) published at `now`: status published, `published_at` reached, not archived (§9.5). */
function publishedPages(db: Db, kind: 'page' | 'news', now: number) {
  return db
    .selectFrom('pages')
    .where('kind', '=', kind)
    .where('status', '=', 'published')
    .where('published_at', '<=', now)
    .where('archived_at', 'is', null);
}

/** The translations of `ids` in `locale` and Indonesian, by page id. */
async function translations(
  db: Db,
  ids: readonly string[],
  locale: Locale,
): Promise<Map<string, { title: string; summary: string | null; lang: Locale | null }>> {
  const out = new Map<string, { title: string; summary: string | null; lang: Locale | null }>();
  if (ids.length === 0) return out;
  const locales = locale === 'id' ? ['id'] : [locale, 'id'];
  const rows = await db
    .selectFrom('page_translations')
    .select(['page_id', 'locale', 'title', 'summary'])
    .where('page_id', 'in', [...ids])
    .where('locale', 'in', locales)
    .execute();
  for (const id of ids) {
    const own = rows.find((r) => r.page_id === id && r.locale === locale);
    const fallback = rows.find((r) => r.page_id === id && r.locale === 'id');
    const chosen = own ?? fallback;
    if (chosen !== undefined) out.set(id, { title: chosen.title, summary: chosen.summary, lang: own === undefined ? 'id' : null });
  }
  return out;
}

/** The menu: the published pages with `show_in_nav`, by `sort_order` then id, at most {@link NAV_MAX}. */
export async function navPages(db: Db, now: number, locale: Locale): Promise<OpacNavLink[]> {
  const pages = await publishedPages(db, 'page', now)
    .select(['id', 'slug_key'])
    .where('show_in_nav', '=', 1)
    .orderBy('sort_order')
    .orderBy('id')
    .limit(NAV_MAX)
    .execute();
  const text = await translations(
    db,
    pages.map((p) => p.id),
    locale,
  );
  const out: OpacNavLink[] = [];
  for (const p of pages) {
    const tr = text.get(p.id);
    if (tr === undefined) continue;
    out.push({ href: `/halaman/${encodeURIComponent(p.slug_key)}`, label: tr.title, ...(tr.lang === null ? {} : { lang: tr.lang }) });
  }
  return out;
}

/** The `n` latest published news posts at `now`, newest first. */
export async function latestNews(db: Db, now: number, locale: Locale, n: number): Promise<NewsTeaser[]> {
  if (n <= 0) return [];
  const posts = await publishedPages(db, 'news', now)
    .select(['id', 'slug_key', 'published_at'])
    .orderBy('published_at', 'desc')
    .orderBy('id', 'desc')
    .limit(n)
    .execute();
  const text = await translations(
    db,
    posts.map((p) => p.id),
    locale,
  );
  const out: NewsTeaser[] = [];
  for (const p of posts) {
    const tr = text.get(p.id);
    if (tr === undefined) continue;
    out.push({ slug: p.slug_key, title: tr.title, summary: tr.summary, publishedAt: Number(p.published_at), lang: tr.lang });
  }
  return out;
}

/** The main agent's name of each of `ids` that has one (the first by `sort_order`). */
async function mainAgents(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom('record_agents as ra')
    .innerJoin('agents as a', 'a.id', 'ra.agent_id')
    .select(['ra.record_id', 'a.name_display'])
    .where('ra.record_id', 'in', [...ids])
    .where('ra.is_main', '=', 1)
    .orderBy('ra.record_id')
    .orderBy('ra.sort_order')
    .execute();
  for (const r of rows) if (!out.has(r.record_id)) out.set(r.record_id, r.name_display);
  return out;
}

const CARD_COLUMNS = ['id', 'title', 'subtitle', 'publication_year', 'cover_file_id'] as const;

type CardRow = { id: string; title: string; subtitle: string | null; publication_year: string | null; cover_file_id: string | null };

async function cards(db: Db, rows: readonly CardRow[]): Promise<TitleCard[]> {
  const agents = await mainAgents(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    year: r.publication_year,
    coverFileId: r.cover_file_id,
    mainAgent: agents.get(r.id) ?? null,
  }));
}

/**
 * The `n` newest public records (S14): search_doc's `is_public` rows by `created_at` (the record's), newest first,
 * through `ix_search_doc_public_created`; each checked against `records` again, in that order.
 */
export async function newTitles(db: Db, n: number): Promise<TitleCard[]> {
  if (n <= 0) return [];
  const docs = await db
    .selectFrom('search_doc')
    .select('record_id')
    .where('is_public', '=', 1)
    .orderBy('created_at', 'desc')
    .orderBy('doc_no', 'desc')
    .limit(n)
    .execute();
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d.record_id);
  const rows = await publicRecords(db)
    .select([...CARD_COLUMNS])
    .where('id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return cards(
    db,
    ids.flatMap((id) => {
      const r = byId.get(id);
      return r === undefined ? [] : [r];
    }),
  );
}

/** The `n` public promoted records, the latest changed first. */
export async function promotedTitles(db: Db, n: number): Promise<TitleCard[]> {
  if (n <= 0) return [];
  const rows = await publicRecords(db)
    .select([...CARD_COLUMNS])
    .where('promoted', '=', 1)
    .orderBy('changed_at', 'desc')
    .orderBy('id', 'desc')
    .limit(n)
    .execute();
  return cards(db, rows);
}

// ---- Komunitas (OPAC home page) ----
/**
 * The `n` popular titles the OPAC shows, the most lent first: the ids of the popular titles' aggregate (loan counts per
 * title, no borrower), checked against the public records again.
 */
export async function popularTitles(db: Db, n: number): Promise<TitleCard[]> {
  const ids = await popularRecordIds(db, n);
  if (ids.length === 0) return [];
  const rows = await publicRecords(db)
    .select([...CARD_COLUMNS])
    .where('id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return cards(
    db,
    ids.flatMap((id) => {
      const r = byId.get(id);
      return r === undefined ? [] : [r];
    }),
  );
}

/**
 * How many members are active on `today` (`YYYY-MM-DD`): neither archived nor anonymised, not suspended, and not
 * expired. A count only: the home page's facts.
 */
export async function activeMemberCount(db: Db, today: string): Promise<number> {
  const row = await db
    .selectFrom('members')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('archived_at', 'is', null)
    .where('anonymized_at', 'is', null)
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('expires_on', 'is', null), eb('expires_on', '>=', today)]))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** How many records the OPAC shows. */
export async function publicRecordCount(db: Db): Promise<number> {
  const row = await publicRecords(db)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** One URL of a catalog sitemap. */
export interface SitemapRecord {
  id: string;
  title: string;
  changedAt: number;
}

/**
 * Page `page` (1-based) of the public records by id, `size` per page, by keyset (M5): the page's lower bound is found by
 * a walk over the public ids, one step of `size` per earlier page (ids only, `id > boundary ORDER BY id`, counted and
 * reduced to their largest id by the database), then the page is `id > boundary ORDER BY id LIMIT size`.
 *
 * @returns the page's records, or null when the page is past the last one (page 1 always exists, possibly empty)
 */
export async function sitemapRecords(db: Db, page: number, size: number): Promise<SitemapRecord[] | null> {
  if (!Number.isSafeInteger(page) || page < 1) return null;
  let boundary: string | null = null;
  for (let step = 1; step < page; step += 1) {
    let ids = publicRecords(db).select('id').orderBy('id').limit(size);
    if (boundary !== null) ids = ids.where('id', '>', boundary);
    const walked = await db
      .selectFrom(ids.as('s'))
      .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.max('s.id').as('last')])
      .executeTakeFirst();
    // Fewer than a whole page before `page`: it is past the last one.
    if (walked === undefined || Number(walked.n) < size || walked.last === null) return null;
    boundary = walked.last;
  }
  let q = publicRecords(db).select(['id', 'title', 'changed_at']).orderBy('id').limit(size);
  if (boundary !== null) q = q.where('id', '>', boundary);
  const rows = await q.execute();
  if (page > 1 && rows.length === 0) return null;
  return rows.map((r) => ({ id: r.id, title: r.title, changedAt: Number(r.changed_at) }));
}

/** One URL of the pages sitemap. */
export interface SitemapPage {
  kind: 'page' | 'news';
  slug: string;
  /** The later of the last update and the publication. */
  lastmod: number;
}

/**
 * The published pages (by `sort_order`, then slug) and news posts (newest first) at `now`, at most `max` in all,
 * pages first.
 */
export async function sitemapPages(db: Db, now: number, max: number): Promise<SitemapPage[]> {
  const out: SitemapPage[] = [];
  const pages = await publishedPages(db, 'page', now)
    .select(['slug_key', 'updated_at', 'published_at'])
    .orderBy('sort_order')
    .orderBy('slug_key')
    .limit(max)
    .execute();
  const lastmod = (r: { updated_at: number; published_at: number | null }) => Math.max(Number(r.updated_at), Number(r.published_at ?? 0));
  for (const p of pages) out.push({ kind: 'page', slug: p.slug_key, lastmod: lastmod(p) });
  if (out.length >= max) return out;
  const news = await publishedPages(db, 'news', now)
    .select(['slug_key', 'updated_at', 'published_at'])
    .orderBy('published_at', 'desc')
    .orderBy('id', 'desc')
    .limit(max - out.length)
    .execute();
  for (const p of news) out.push({ kind: 'news', slug: p.slug_key, lastmod: lastmod(p) });
  return out;
}

/** The legacy-map source of old SLiMS links when no migration has succeeded (spec §9.9). */
export const DEFAULT_LEGACY_SOURCE = 'slims';

/**
 * The `migration_map` source of old SLiMS links (S13): the `options.sourceName` of the latest succeeded migration run
 * that was not a dry run, else `slims`. A run whose options do not carry a valid name counts as `slims`.
 */
export async function legacySource(db: Db): Promise<string> {
  const run = await db
    .selectFrom('catalog_runs')
    .select('options')
    .where('kind', '=', 'migration')
    .where('status', '=', 'succeeded')
    .where('dry_run', '=', 0)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (run === undefined) return DEFAULT_LEGACY_SOURCE;
  let options: unknown;
  try {
    options = JSON.parse(run.options);
  } catch {
    return DEFAULT_LEGACY_SOURCE;
  }
  const name = typeof options === 'object' && options !== null ? (options as { sourceName?: unknown }).sourceName : undefined;
  const parsed = sourceNameField.safeParse(name);
  return parsed.success ? parsed.data : DEFAULT_LEGACY_SOURCE;
}

/**
 * The OPAC path of the record SLiMS biblio `legacyKey` became under `source`: `/katalog/<id>/<slug>` when that record
 * is public, the record it was merged into when it was merged (one hop: chains are flattened at merge time, P2-20),
 * null otherwise (unmapped, hidden, archived).
 */
export async function legacyRecordPath(db: Db, source: string, legacyKey: string): Promise<string | null> {
  const target = await legacyTarget(db, source, 'biblio', legacyKey);
  if (target === null) return null;
  const record = await db
    .selectFrom('records')
    .select(['id', 'title', 'opac_visible', 'archived_at', 'merged_into'])
    .where('id', '=', target)
    .executeTakeFirst();
  if (record === undefined) return null;
  if (record.merged_into !== null) {
    const into = await publicRecords(db).select(['id', 'title']).where('id', '=', record.merged_into).executeTakeFirst();
    return into === undefined ? null : recordUrlPath(into.id, into.title);
  }
  if (Number(record.opac_visible) !== 1 || record.archived_at !== null) return null;
  return recordUrlPath(record.id, record.title);
}
