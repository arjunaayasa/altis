import type { CatalogSearchResult } from '@altis/core';
import type { Locale } from '@altis/shared';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { FILTER_PARAMS, FacetsAside, HiddenParams, formatCount, type FacetNames } from './facets-view.js';
import { opacText, type OpacKey } from './messages.js';
import { ResultCard, type ResultCardData } from './result-card.js';
import {
  OPAC_SEARCH_SCOPES,
  OPAC_SEARCH_TEXT_MAX,
  OPAC_SORTS,
  masterName,
  searchPath,
  type OpacSearchEcho,
  type OpacSort,
  type SearchMasters,
} from './search-params.js';

// The OPAC search page (Phase 2 Task 33; spec §4.4–§4.7, §9.1), `GET /cari`, inside opacPage's frame: the search box in
// the header's search band (the field, the text, the filters and the order kept as hidden inputs), the notices (the
// index being rebuilt, the spelling correction), the heading with the order form, the count ("lebih dari 10.000" past
// the cap), the results as a list with thin lines between them, the empty state, the page cap message,
// the pager (at most 50 pages, §4.5), the link to the results' feed, and the facets aside (facets-view.tsx). Every
// control is a link or a GET form, so all of it works without JavaScript; the page writes no script.

/** The deepest page the search serves (§4.5; the search reports `pageLimitReached` past it). */
export const OPAC_PAGE_MAX = 50;
/** The facet counts' sample (§4.6; the search reports `facetsApproximate` past it). */
const FACET_SAMPLE = 5000;
/** The pages either side of the current one the pager links. */
const PAGER_SPAN = 2;

/** What the page is drawn from. */
export interface SearchViewProps {
  locale: Locale;
  /** The `lang` every link keeps (the request named it), or null. */
  lang: Locale | null;
  echo: OpacSearchEcho;
  /** The query text as searched ('' for none). */
  text: string;
  page: number;
  pageSize: number;
  result: CatalogSearchResult;
  cards: readonly ResultCardData[];
  masters: SearchMasters;
  names: FacetNames;
}

/** The page's title and heading: the query in quotes, or "Pencarian katalog". */
export function searchTitle(locale: Locale, text: string): string {
  return text === '' ? opacText(locale, 'search.title') : opacText(locale, 'search.title_query', { q: text });
}

/** `template` with its `{name}` replaced by `node` (the copy keeps the placeholder where the language puts it). */
function slot(template: string, name: string, node: JSX.Element): (string | JSX.Element)[] {
  const at = template.indexOf(`{${name}}`);
  if (at === -1) return [template, ' ', node];
  return [template.slice(0, at), node, template.slice(at + name.length + 2)];
}

/** The order in use: `urut`, else relevance with a text and newest without. */
function sortOf(echo: OpacSearchEcho, text: string): OpacSort {
  return (echo.urut as OpacSort | undefined) ?? (text === '' ? 'terbaru' : 'relevansi');
}

/** The search box of the results page (the header's search band): the field, the text, the other parameters kept. */
export function SearchBox(props: { locale: Locale; lang: Locale | null; echo: OpacSearchEcho; text: string }) {
  const { locale, lang, echo, text } = props;
  const scope = echo.ruas ?? 'semua';
  return (
    <form class="search-box search-main" role="search" method="get" action="/cari">
      <label for="cari-q" class="visually-hidden">
        {opacText(locale, 'shell.search.label')}
      </label>
      <span class="search-row">
        <label for="cari-ruas" class="visually-hidden">
          {opacText(locale, 'search.scope.label')}
        </label>
        <select id="cari-ruas" name="ruas">
          {OPAC_SEARCH_SCOPES.map((s) => (
            <option value={s} selected={s === scope}>
              {opacText(locale, `search.scope.${s}`)}
            </option>
          ))}
        </select>
        <input id="cari-q" type="search" name="q" value={text} maxlength={OPAC_SEARCH_TEXT_MAX} placeholder={opacText(locale, 'shell.search.placeholder')} />
        <button type="submit">{opacText(locale, 'shell.search.submit')}</button>
      </span>
      <HiddenParams echo={echo} omit={['q', 'persis', 'ruas']} lang={lang} />
    </form>
  );
}

function SortForm(props: { locale: Locale; lang: Locale | null; echo: OpacSearchEcho; text: string }) {
  const { locale, lang, echo, text } = props;
  const current = sortOf(echo, text);
  const options = (Object.keys(OPAC_SORTS) as OpacSort[]).filter((s) => s !== 'relevansi' || text !== '');
  return (
    <form class="sort-form" method="get" action="/cari">
      <label for="cari-urut">{opacText(locale, 'search.sort.label')}</label>
      <select id="cari-urut" name="urut">
        {options.map((s) => (
          <option value={s} selected={s === current}>
            {opacText(locale, `search.sort.${s}` as OpacKey)}
          </option>
        ))}
      </select>
      <HiddenParams echo={echo} omit={['urut']} lang={lang} />
      <button type="submit">{opacText(locale, 'search.sort.submit')}</button>
    </form>
  );
}

/** The spelling line (§4.7): applied ("Menampilkan hasil untuk X. Cari Y saja?") or offered ("Mungkin maksud Anda X?"). */
function Correction(props: { locale: Locale; lang: Locale | null; echo: OpacSearchEcho; correction: NonNullable<CatalogSearchResult['correction']> }) {
  const { locale, lang, echo, correction } = props;
  const corrected = searchPath(echo, { q: correction.to, persis: null }, lang);
  if (correction.applied) {
    const original = searchPath(echo, { q: correction.from, persis: '1' }, lang);
    return (
      <p class="notice notice-correction">
        {slot(opacText(locale, 'search.correction.applied'), 'to', <em>{correction.to}</em>)}{' '}
        <a href={original}>{slot(opacText(locale, 'search.correction.original'), 'from', <em>{correction.from}</em>)}</a>
      </p>
    );
  }
  return (
    <p class="notice notice-correction">
      {slot(
        opacText(locale, 'search.correction.suggest'),
        'to',
        <a href={corrected}>
          <em>{correction.to}</em>
        </a>,
      )}
    </p>
  );
}

/** The count line: the total (or "lebih dari"), and the range of this page when it has results. */
function Count(props: { locale: Locale; result: CatalogSearchResult; page: number; pageSize: number }) {
  const { locale, result, page, pageSize } = props;
  const total = formatCount(result.total, locale);
  const count = result.totalCapped
    ? opacText(locale, 'search.count_capped', { count: total })
    : result.total === 1
      ? opacText(locale, 'search.count_one')
      : opacText(locale, 'search.count', { count: total });
  const shown = result.recordIds.length;
  const from = (page - 1) * pageSize + 1;
  return (
    <p class="search-count">
      {count}
      {shown === 0 ? null : ` ${opacText(locale, 'search.range', { from: formatCount(from, locale), to: formatCount(from + shown - 1, locale) })}`}
    </p>
  );
}

/** The pages the pager names: the first, the last and those near the current one, with gaps (null) between. */
export function pagerPages(page: number, last: number): (number | null)[] {
  const wanted = new Set<number>([1, last]);
  for (let p = page - PAGER_SPAN; p <= page + PAGER_SPAN; p += 1) if (p >= 1 && p <= last) wanted.add(p);
  const sorted = [...wanted].filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const p of sorted) {
    const prev = out.at(-1);
    if (typeof prev === 'number' && p > prev + 1) out.push(null);
    out.push(p);
  }
  return out;
}

function Pager(props: { locale: Locale; lang: Locale | null; echo: OpacSearchEcho; page: number; last: number }) {
  const { locale, lang, echo, page, last } = props;
  if (last <= 1) return null;
  const href = (p: number) => searchPath(echo, { hal: String(p) }, lang);
  return (
    <nav class="pager" aria-label={opacText(locale, 'search.pager.label')}>
      <ul>
        {page > 1 ? (
          <li>
            <a href={href(Math.min(page - 1, last))} rel="prev">
              {opacText(locale, 'search.pager.prev')}
            </a>
          </li>
        ) : null}
        {pagerPages(page, last).map((p) =>
          p === null ? (
            <li class="pager-gap" aria-hidden="true">
              {'\u2026'}
            </li>
          ) : p === page ? (
            <li>
              <span aria-current="page">{formatCount(p, locale)}</span>
            </li>
          ) : (
            <li>
              <a href={href(p)} aria-label={opacText(locale, 'search.pager.page', { page: formatCount(p, locale) })}>
                {formatCount(p, locale)}
              </a>
            </li>
          ),
        )}
        {page < last ? (
          <li>
            <a href={href(page + 1)} rel="next">
              {opacText(locale, 'search.pager.next')}
            </a>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

/** The search page (see the top of this file). */
export function SearchView(props: SearchViewProps) {
  const { locale, lang, echo, text, page, pageSize, result, cards, masters, names } = props;
  const hasResults = result.total > 0;
  const last = Math.min(OPAC_PAGE_MAX, Math.ceil(result.total / pageSize));
  const atCap = result.pageLimitReached || (page === OPAC_PAGE_MAX && result.total > OPAC_PAGE_MAX * pageSize);
  const beyond = hasResults && !result.pageLimitReached && result.recordIds.length === 0;
  const materialType = new Map(masters.materialTypes.map((m) => [m.id, masterName(m, locale)]));
  const facetInput = { locale, lang, echo, masters, names };
  const aside = (
    <FacetsAside input={facetInput} facets={result.facets} approximate={result.facetsApproximate} sample={FACET_SAMPLE} hasResults={hasResults} />
  );
  const hasFilters = FILTER_PARAMS.some((p) => echo[p] !== undefined);
  return (
    <div class="search-page">
      {result.building ? (
        <p class="notice notice-warn" role="status">
          {opacText(locale, 'search.building')}
        </p>
      ) : null}
      {result.correction === null ? null : <Correction locale={locale} lang={lang} echo={echo} correction={result.correction} />}
      <div class="search-layout">
        <section class="search-results" aria-labelledby="hasil-judul">
          <div class="results-head">
            <h1 id="hasil-judul">{searchTitle(locale, text)}</h1>
            {hasResults ? <SortForm locale={locale} lang={lang} echo={echo} text={text} /> : null}
          </div>
          {hasResults ? (
            <div class="search-summary">
              <Count locale={locale} result={result} page={page} pageSize={pageSize} />
              {/* With results the facets aside is there: on a narrow screen it comes after them. */}
              <a class="filter-jump" href="#saring">
                {opacText(locale, 'search.facets.title')}
              </a>
            </div>
          ) : (
            <div class="search-empty">
              <p>
                <strong>{opacText(locale, 'search.empty.title')}</strong>
              </p>
              <p>{opacText(locale, 'search.empty.hint')}</p>
              {hasFilters ? (
                <a class="empty-clear" href={searchPath(echo, Object.fromEntries(FILTER_PARAMS.map((p) => [p, null])), lang)}>
                  {opacText(locale, 'search.filters.clear')}
                </a>
              ) : null}
            </div>
          )}
          {cards.length === 0 ? null : (
            <ol class="card-list result-list" start={(page - 1) * pageSize + 1}>
              {cards.map((card) => (
                <ResultCard card={card} materialType={materialType.get(card.materialTypeId) ?? null} locale={locale} lang={lang} />
              ))}
            </ol>
          )}
          {beyond ? (
            <p class="notice">
              {opacText(locale, 'search.page_empty')} <a href={searchPath(echo, {}, lang)}>{opacText(locale, 'search.page_first')}</a>
            </p>
          ) : null}
          {hasResults && atCap ? (
            <p class="notice notice-warn">{opacText(locale, 'search.page_cap', { max: formatCount(OPAC_PAGE_MAX * pageSize, locale) })}</p>
          ) : null}
          {hasResults ? <Pager locale={locale} lang={lang} echo={echo} page={page} last={last} /> : null}
          {hasResults ? (
            <p class="feed-link">
              <a href={searchPath(echo, {}, lang, '/cari/rss')} type="application/rss+xml">
                {opacText(locale, 'search.feed.link')}
              </a>
            </p>
          ) : null}
        </section>
        {aside}
      </div>
    </div>
  );
}
