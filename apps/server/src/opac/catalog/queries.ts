import { legacyTarget, pickPolicy, popularRecordIds, recordUrlPath } from '@altis/core';
import { countGrouped, type DbHandle } from '@altis/db';
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
  /** The record's call number and classification: the substitute cover's spine label and cloth colour. */
  callNumber: string | null;
  classification: string | null;
  // ---- Komunitas (OPAC home page) ----
  /**
   * From the search index's facets: `available` when a copy is on an open shelf now (`av`), `unavailable` when the
   * title has copies but none is (`br` without `av`), null when it has no copy at all.
   */
  availability: 'available' | 'unavailable' | null;
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

const CARD_COLUMNS = ['id', 'title', 'subtitle', 'publication_year', 'cover_file_id', 'call_number', 'classification'] as const;

type CardRow = {
  id: string;
  title: string;
  subtitle: string | null;
  publication_year: string | null;
  cover_file_id: string | null;
  call_number: string | null;
  classification: string | null;
};

/**
 * The availability of each of `ids` the search index knows (see TitleCard): one read of the facets `av` and `br` for
 * all of them.
 */
async function availabilities(db: Db, ids: readonly string[]): Promise<Map<string, 'available' | 'unavailable'>> {
  const out = new Map<string, 'available' | 'unavailable'>();
  if (ids.length === 0) return out;
  const rows = await db.selectFrom('search_facet').select(['record_id', 'facet']).where('facet', 'in', ['av', 'br']).where('record_id', 'in', [...ids]).execute();
  for (const r of rows) {
    if (r.facet === 'av') out.set(r.record_id, 'available');
    else if (!out.has(r.record_id)) out.set(r.record_id, 'unavailable');
  }
  return out;
}

async function cards(db: Db, rows: readonly CardRow[]): Promise<TitleCard[]> {
  const ids = rows.map((r) => r.id);
  const [agents, available] = await Promise.all([mainAgents(db, ids), availabilities(db, ids)]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    year: r.publication_year,
    coverFileId: r.cover_file_id,
    mainAgent: agents.get(r.id) ?? null,
    callNumber: r.call_number,
    classification: r.classification,
    availability: available.get(r.id) ?? null,
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

/** A subject as a pill above a list of titles: its id (the search's `subjek`), its term, and its public titles. */
export interface SubjectPill {
  id: string;
  term: string;
  /** How many titles the OPAC shows carry it (what the pill's search finds). */
  titles: number;
}

/**
 * The subject pills of each list of titles: the subjects its titles carry most (at most `max`; ties by their number of
 * titles in the catalogue, then by term), each with its number of public titles. Three reads for all the lists
 * together, from the search index (the `sb` facet and `search_doc.is_public`) and the subjects' terms; a subject
 * archived or merged is left out.
 */
export async function subjectPills(db: Db, lists: readonly (readonly string[])[], max: number): Promise<SubjectPill[][]> {
  const all = [...new Set(lists.flat())];
  if (all.length === 0 || max <= 0) return lists.map(() => []);
  const facets = await db.selectFrom('search_facet').select(['record_id', 'value_key']).where('facet', '=', 'sb').where('record_id', 'in', all).execute();
  const subjectsOf = new Map<string, string[]>();
  for (const f of facets) subjectsOf.set(f.record_id, [...(subjectsOf.get(f.record_id) ?? []), f.value_key]);
  const subjectIds = [...new Set(facets.map((f) => f.value_key))];
  if (subjectIds.length === 0) return lists.map(() => []);
  const [counts, terms] = await Promise.all([
    countGrouped(
      db
        .selectFrom('search_facet as f')
        .innerJoin('search_doc as d', 'd.record_id', 'f.record_id')
        .where('f.facet', '=', 'sb')
        .where('d.is_public', '=', 1)
        .where('f.value_key', 'in', subjectIds),
      { subjectId: 'f.value_key' },
    ),
    db.selectFrom('subjects').select(['id', 'term_display']).where('id', 'in', subjectIds).where('archived_at', 'is', null).where('merged_into', 'is', null).execute(),
  ]);
  const titlesOf = new Map(counts.map((c) => [String(c.subjectId), c.count]));
  const termOf = new Map(terms.map((t) => [t.id, t.term_display]));
  return lists.map((ids) => {
    const seen = new Map<string, number>();
    for (const id of new Set(ids)) for (const s of subjectsOf.get(id) ?? []) seen.set(s, (seen.get(s) ?? 0) + 1);
    return [...seen.entries()]
      .flatMap(([id, n]) => {
        const term = termOf.get(id);
        const titles = titlesOf.get(id) ?? 0;
        return term === undefined || titles === 0 ? [] : [{ id, term, titles, n }];
      })
      .sort((a, b) => b.n - a.n || b.titles - a.titles || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
      .slice(0, max)
      .map(({ id, term, titles }) => ({ id, term, titles }));
  });
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

/** Whether a news post is published at `now`: the site menu's "Berita" entry. */
export async function hasPublishedNews(db: Db, now: number): Promise<boolean> {
  const rows = await publishedPages(db, 'news', now).select('id').limit(1).execute();
  return rows.length > 0;
}

/** The ten DDC main classes as the search index writes them (the `cl` facet). */
export const CLASS_DIGITS = Object.freeze(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const);

/** The collection's facts the home page shows from the search index. */
export interface CatalogueFacts {
  /** The public titles of each DDC main class (the `cl` facet), 0 for a class without one. */
  classes: Readonly<Record<(typeof CLASS_DIGITS)[number], number>>;
  /** The public titles with a copy on an open shelf now (the `av` facet). */
  available: number;
}

/**
 * The collection's facts from the search index in one read: the public documents (`search_doc.is_public`) counted per
 * value of the `cl` and `av` facets. The counts are what the search finds for `/cari?kelas=N` and `/cari?tersedia=1`.
 */
export async function catalogueFacts(db: Db): Promise<CatalogueFacts> {
  const rows = await countGrouped(
    db
      .selectFrom('search_facet as f')
      .innerJoin('search_doc as d', 'd.record_id', 'f.record_id')
      .where('d.is_public', '=', 1)
      .where('f.facet', 'in', ['cl', 'av']),
    { facet: 'f.facet', value: 'f.value_key' },
  );
  const classes = Object.fromEntries(CLASS_DIGITS.map((d) => [d, 0])) as Record<(typeof CLASS_DIGITS)[number], number>;
  let available = 0;
  for (const r of rows) {
    const value = String(r.value);
    if (r.facet === 'av' && value === '1') available += r.count;
    else if (r.facet === 'cl' && (CLASS_DIGITS as readonly string[]).includes(value)) classes[value as (typeof CLASS_DIGITS)[number]] += r.count;
  }
  return { classes, available };
}

/** How long the home page keeps the collection's facts before it reads them again. */
export const CATALOGUE_FACTS_TTL_MS = 60_000;

/** The facts read per database, with the time (a monotonic clock) they were read at; a pending read is shared. */
const factsCache = new WeakMap<object, { at: number; value: Promise<CatalogueFacts> }>();

/**
 * {@link catalogueFacts}, kept for {@link CATALOGUE_FACTS_TTL_MS} per database with the rest of the home page's data:
 * the counts change with the catalogue, and a minute late is fine for a home page that every visitor opens. A failed
 * read is not kept.
 */
export function cachedCatalogueFacts(db: Db, clock: () => number = () => performance.now()): Promise<CatalogueFacts> {
  const now = clock();
  const hit = factsCache.get(db);
  if (hit !== undefined && now - hit.at < CATALOGUE_FACTS_TTL_MS) return hit.value;
  const value = catalogueFacts(db);
  factsCache.set(db, { at: now, value });
  value.catch(() => {
    if (factsCache.get(db)?.value === value) factsCache.delete(db);
  });
  return value;
}

/** The loan terms of one member type as the public may read them. */
export interface PublicLoanRule {
  /** The member type's name in the page's language (else the Indonesian one, `lang: 'id'`). */
  name: string;
  lang?: Locale;
  /** The most open loans a member of the type may hold; null: no limit. */
  limit: number | null;
  /** The loan period in days of the type's general rule (0: due the same day). */
  days: number;
}

/**
 * The loan terms per member type: each live member type that may borrow (its limit is not 0), with its limit and the
 * loan period of the rule that applies to its members' loans of any collection and material (the rule resolution of
 * the desk: the most specific live rule for the type alone, else the general one). A type whose rule refuses loans, or
 * that no rule covers, is left out. No member is read: only the member types and the rules.
 */
export async function publicLoanRules(db: Db, locale: Locale): Promise<PublicLoanRule[]> {
  const [types, rules] = await Promise.all([
    db
      .selectFrom('member_types')
      .select(['id', 'name_id', 'name_en', 'loan_limit'])
      .where('archived_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('code_key')
      .execute(),
    db
      .selectFrom('policies')
      .select(['member_type_id', 'collection_type_id', 'material_type_id', 'branch_id', 'loanable', 'loan_days'])
      .where('archived_at', 'is', null)
      .execute(),
  ]);
  const out: PublicLoanRule[] = [];
  for (const type of types) {
    const limit = type.loan_limit === null ? null : Number(type.loan_limit);
    if (limit === 0) continue;
    const rule = pickPolicy(rules, { memberTypeId: type.id, collectionTypeId: null, materialTypeId: null, branchId: null });
    if (rule === null || Number(rule.loanable) !== 1) continue;
    const english = locale === 'en' && type.name_en !== null && type.name_en.trim() !== '' ? type.name_en : null;
    out.push({ name: english ?? type.name_id, ...(locale === 'en' && english === null ? { lang: 'id' as const } : {}), limit, days: Number(rule.loan_days) });
  }
  return out;
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
