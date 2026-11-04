import { recordUrlPath, searchCatalog, type CatalogSearchResult } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { resolveLocale, type Locale } from '@altis/shared';
import { route, type RouteDecl } from '../../http/route.js';
import { loadFacetNames } from './facets-view.js';
import { FEED_CACHE, FEED_ITEMS, rssXml, type FeedItem } from './feeds.js';
import { opacText } from './messages.js';
import { opacContext, opacPage, requestLang, type OpacContextSource } from './page.js';
import { xmlResponse } from './respond.js';
import { cardTitle, resultCards, type ResultCardData } from './result-card.js';
import { parseOpacSearchParams, searchLookups, searchMasters, searchPath, type ParsedOpacSearch } from './search-params.js';
import { SearchView, searchTitle } from './search-view.js';
import { absoluteUrl, withLang } from './urls.js';

// The OPAC routes of the search (Phase 2 Task 33; spec §4, §9.1, §9.6):
//
//   GET /cari      opac.search      the results page: cards, facets, paging, the spelling line (`noindex, follow`)
//   GET /cari/rss  opac.search.rss  the top 50 of the same search as RSS 2.0
//   GET /rss       opac.rss         the 50 newest public records (S14: from search_doc) as RSS 2.0
//
// Like every OPAC route (§9.1): public, `session: 'none'`, mode read, `maintenance: allow`, `idempotency: none`,
// `audit: null`, no `query` schema (search-params.ts checks every value by hand and ignores what it cannot use, never a
// 4xx). `/cari` and `/cari/rss` share the per-IP bucket `opac_search` (120 a minute); over it, a browser gets the OPAC
// 429 page from app.ts failure() (S17): nothing here handles it. Every absolute URL comes from config.baseUrl. The
// routes only read: no state in the process, nothing a restart or a second process could change.

type Db = DbHandle['db'];

/** The declaration fields every route of this file shares. */
const OPAC = { method: 'GET', public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null } as const;

/** The page size when `opac.resultsPerPage` is not a usable number (its default). */
const PAGE_SIZE_DEFAULT = 20;

/** `opac.resultsPerPage` (10-50 by its schema), bounded again. */
function pageSizeOf(setting: unknown): number {
  return typeof setting === 'number' && Number.isInteger(setting) ? Math.min(50, Math.max(10, setting)) : PAGE_SIZE_DEFAULT;
}

/** The live form of an authority id: itself, the record it was merged into (one hop, P2-20), or null (archived, unknown). */
async function liveSubject(db: Db, id: string): Promise<{ id: string; name: string } | null> {
  const row = await db.selectFrom('subjects').select(['id', 'term_display', 'merged_into', 'archived_at']).where('id', '=', id).executeTakeFirst();
  if (row === undefined) return null;
  if (row.merged_into !== null) {
    const into = await db
      .selectFrom('subjects')
      .select(['id', 'term_display'])
      .where('id', '=', row.merged_into)
      .where('merged_into', 'is', null)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return into === undefined ? null : { id: into.id, name: into.term_display };
  }
  return row.archived_at === null ? { id: row.id, name: row.term_display } : null;
}

async function liveAgent(db: Db, id: string): Promise<{ id: string; name: string } | null> {
  const row = await db.selectFrom('agents').select(['id', 'name_display', 'merged_into', 'archived_at']).where('id', '=', id).executeTakeFirst();
  if (row === undefined) return null;
  if (row.merged_into !== null) {
    const into = await db
      .selectFrom('agents')
      .select(['id', 'name_display'])
      .where('id', '=', row.merged_into)
      .where('merged_into', 'is', null)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return into === undefined ? null : { id: into.id, name: into.name_display };
  }
  return row.archived_at === null ? { id: row.id, name: row.name_display } : null;
}

/**
 * The ids of `parsed` checked against what the OPAC shows (in place): `lokasi` must be a public, unarchived location;
 * `subjek` and `pengarang` an unarchived authority, or one merged into another (then the live one is searched and
 * linked). An id that is none of these is dropped from the search and the echo, as an unknown code is.
 *
 * @returns the names of the selected agent (the page shows it among the active filters)
 */
async function checkIds(db: Db, parsed: ParsedOpacSearch): Promise<Map<string, string>> {
  const { echo } = parsed;
  const filters = parsed.query.filters;
  const agents = new Map<string, string>();
  const [room, subject, agent] = await Promise.all([
    echo.lokasi === undefined
      ? Promise.resolve(null)
      : db
          .selectFrom('locations')
          .select('id')
          .where('id', '=', echo.lokasi)
          .where('is_public', '=', 1)
          .where('archived_at', 'is', null)
          .executeTakeFirst()
          .then((r) => r ?? null),
    echo.subjek === undefined ? Promise.resolve(null) : liveSubject(db, echo.subjek),
    echo.pengarang === undefined ? Promise.resolve(null) : liveAgent(db, echo.pengarang),
  ]);
  if (echo.lokasi !== undefined && room === null) {
    delete echo.lokasi;
    delete filters.locationIds;
  }
  if (echo.subjek !== undefined) {
    if (subject === null) {
      delete echo.subjek;
      delete filters.subjectIds;
    } else {
      echo.subjek = subject.id;
      filters.subjectIds = [subject.id];
    }
  }
  if (echo.pengarang !== undefined) {
    if (agent === null) {
      delete echo.pengarang;
      delete filters.agentIds;
    } else {
      echo.pengarang = agent.id;
      filters.agentIds = [agent.id];
      agents.set(agent.id, agent.name);
    }
  }
  return agents;
}

/**
 * Runs the search of `parsed`. With `persis=1` and a correction the search applied, the query as typed is what was
 * asked: the search applies a correction only when the query as typed found nothing (§4.7), so that is the answer, with
 * the correction offered instead.
 */
async function runSearch(db: Db, parsed: ParsedOpacSearch, o: { page: number; pageSize: number; facets: boolean; now: number }): Promise<CatalogSearchResult> {
  const result = await searchCatalog(db, { ...parsed.query, page: o.page, pageSize: o.pageSize, facets: o.facets }, { now: o.now });
  if (parsed.echo.persis !== '1' || result.correction === null || !result.correction.applied) return result;
  return {
    ...result,
    recordIds: [],
    total: 0,
    totalCapped: false,
    facets: o.facets ? {} : null,
    facetsApproximate: false,
    correction: { ...result.correction, applied: false },
  };
}

/** The search of a request: its query string parsed with the masters' codes, its ids checked. */
async function requestSearch(rc: { c: OpacContextSource['c']; db: DbHandle }) {
  const db = rc.db.db;
  const masters = await searchMasters(db);
  const parsed = parseOpacSearchParams(new URL(rc.c.req.url).searchParams, searchLookups(masters));
  const agents = await checkIds(db, parsed);
  return { db, masters, parsed, agents };
}

const search = route({
  ...OPAC,
  id: 'opac.search',
  path: '/cari',
  ipLimits: ['opac_search'],
  handler: async (rc) => {
    const ctx = await opacContext(rc);
    const { db, masters, parsed, agents } = await requestSearch(rc);
    const pageSize = pageSizeOf(await rc.services.settings.get<number>(db, 'opac.resultsPerPage'));
    const { text, page } = parsed.query;
    const { echo } = parsed;
    const result = await runSearch(db, parsed, { page, pageSize, facets: true, now: rc.now });
    const values = (facet: 'lc' | 'sb', selected: string | undefined): string[] => [
      ...(result.facets?.[facet] ?? []).map((v) => v.value),
      ...(selected === undefined ? [] : [selected]),
    ];
    const [cards, names] = await Promise.all([
      resultCards(db, result.recordIds),
      loadFacetNames(db, { rooms: values('lc', echo.lokasi), subjects: values('sb', echo.subjek) }, masters, agents),
    ]);
    const lang = requestLang(rc.c);
    const title = searchTitle(ctx.locale, text);
    const feedTitle = text === '' ? opacText(ctx.locale, 'search.feed.title', { library: ctx.libraryName }) : opacText(ctx.locale, 'search.feed.title_query', { q: text, library: ctx.libraryName });
    return opacPage(rc, ctx, {
      title: `${title} · ${ctx.libraryName}`,
      description: opacText(ctx.locale, 'search.description', { library: ctx.libraryName }),
      // The accepted parameters only, in their order (the page keeps `hal`; opacPage adds the request's `lang`).
      canonicalPath: searchPath(echo, { hal: echo.hal ?? null }, null),
      robots: 'noindex-follow',
      headerSearch: false,
      head: () => <link rel="alternate" type="application/rss+xml" title={feedTitle} href={searchPath(echo, {}, lang, '/cari/rss')} />,
      body: () => (
        <SearchView
          locale={ctx.locale}
          lang={lang}
          echo={echo}
          text={text}
          page={page}
          pageSize={pageSize}
          result={result}
          cards={cards}
          masters={masters}
          names={names}
        />
      ),
    });
  },
});

/** What a feed reads besides the search: its language and the library's name. */
async function feedContext(rc: OpacContextSource): Promise<{ locale: Locale; lang: Locale | null; libraryName: string; baseUrl: string }> {
  const db = rc.db.db;
  const [libraryName, libraryLocale] = await Promise.all([
    rc.services.settings.get<string>(db, 'library.name'),
    rc.services.settings.get<string>(db, 'library.locale'),
  ]);
  return { locale: resolveLocale(rc.c.req.query('lang'), libraryLocale), lang: requestLang(rc.c), libraryName, baseUrl: rc.config.baseUrl };
}

/**
 * A card as a feed item: the record's absolute URL (with the `?lang=` the feed was asked with, as the channel link and
 * /berita/rss keep it), its `created_at`, its main agent and year as the description.
 */
function feedItem(baseUrl: string, lang: Locale | null, card: ResultCardData): FeedItem {
  const about = [card.mainAgent, card.year].filter((x): x is string => x !== null && x.trim() !== '').join(' · ');
  const path = recordUrlPath(card.id, card.title);
  return {
    title: cardTitle(card),
    link: absoluteUrl(baseUrl, lang === null ? path : withLang(path, lang)),
    pubDate: card.createdAt,
    description: about === '' ? null : about,
  };
}

const searchRss = route({
  ...OPAC,
  id: 'opac.search.rss',
  path: '/cari/rss',
  ipLimits: ['opac_search'],
  handler: async (rc) => {
    const feed = await feedContext(rc);
    const { db, parsed } = await requestSearch(rc);
    // The top 50 of the search, whatever page `hal` names.
    const result = await runSearch(db, parsed, { page: 1, pageSize: FEED_ITEMS, facets: false, now: rc.now });
    const cards = await resultCards(db, result.recordIds);
    const { echo } = parsed;
    const text = parsed.query.text;
    const xml = rssXml(
      {
        title:
          text === ''
            ? opacText(feed.locale, 'search.feed.title', { library: feed.libraryName })
            : opacText(feed.locale, 'search.feed.title_query', { q: text, library: feed.libraryName }),
        link: absoluteUrl(feed.baseUrl, searchPath(echo, {}, feed.lang)),
        description: opacText(feed.locale, 'search.feed.description', { library: feed.libraryName }),
        self: absoluteUrl(feed.baseUrl, searchPath(echo, {}, feed.lang, '/cari/rss')),
        language: feed.locale,
      },
      cards.map((card) => feedItem(feed.baseUrl, feed.lang, card)),
    );
    return xmlResponse(rc.c, 200, xml, FEED_CACHE);
  },
});

const rss = route({
  ...OPAC,
  id: 'opac.rss',
  path: '/rss',
  handler: async (rc) => {
    const feed = await feedContext(rc);
    const db = rc.db.db;
    // S14: the newest public documents through ix_search_doc_public_created; each record checked again by the cards.
    const docs = await db
      .selectFrom('search_doc')
      .select('record_id')
      .where('is_public', '=', 1)
      .orderBy('created_at', 'desc')
      .orderBy('doc_no', 'desc')
      .limit(FEED_ITEMS)
      .execute();
    const cards = await resultCards(
      db,
      docs.map((d) => d.record_id),
    );
    const xml = rssXml(
      {
        title: opacText(feed.locale, 'search.feed.new_title', { library: feed.libraryName }),
        link: absoluteUrl(feed.baseUrl, feed.lang === null ? '/' : `/?lang=${feed.lang}`),
        description: opacText(feed.locale, 'search.feed.new_description', { library: feed.libraryName }),
        self: absoluteUrl(feed.baseUrl, feed.lang === null ? '/rss' : `/rss?lang=${feed.lang}`),
        language: feed.locale,
      },
      cards.map((card) => feedItem(feed.baseUrl, feed.lang, card)),
    );
    return xmlResponse(rc.c, 200, xml, FEED_CACHE);
  },
});

/** The OPAC search and its feeds. */
export const OPAC_SEARCH_ROUTES: RouteDecl[] = [search, searchRss, rss];
