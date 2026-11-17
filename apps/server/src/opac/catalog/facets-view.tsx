import type { CatalogSearchResult, FacetName } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { ATTACHMENT_MEDIA, t, vocabKey, type AttachmentMedia, type Locale } from '@altis/shared';
import { opacText, type OpacKey } from './messages.js';
import { masterName, searchPath, type OpacSearchEcho, type OpacSearchParam, type SearchMaster, type SearchMasters } from './search-params.js';

// The facets of the OPAC search page (Phase 2 Task 33; spec §4.6, §9.1): one `<section class="facet">` per facet that
// has a value the page can name (an empty facet is hidden), its values as links with their counts, the first five shown
// and the rest folded into `<details>` ("lihat semua"); a selected value is `aria-current` and its link removes it,
// every other link adds its value to the search the page shows (searchPath: the other filters, the text and the order
// kept, the page reset). Above them the active filters, each with a link that removes it, and below them the year form.
// Everything is a link or a GET form: no script.
//
// The names: the masters (search-params.ts) for material types, languages, collection types and branches; rooms,
// subjects and agents read here for the ids the page shows. A room the OPAC does not show (not public, archived) is
// left out of the location facet, whatever the index counted.

type Db = DbHandle['db'];

/** At most this many values of a facet are shown before "lihat semua". */
export const FACET_VISIBLE = 5;

/** The names of the rooms, subjects and agents a page shows, by id. */
export interface FacetNames {
  rooms: ReadonlyMap<string, string>;
  subjects: ReadonlyMap<string, string>;
  agents: ReadonlyMap<string, string>;
}

/** The names of `rooms` (public, not archived ones only) and `subjects` (not archived); `agents` as given. */
export async function loadFacetNames(
  db: Db,
  wanted: { rooms: readonly string[]; subjects: readonly string[] },
  masters: SearchMasters,
  agents: ReadonlyMap<string, string>,
): Promise<FacetNames> {
  const rooms = [...new Set(wanted.rooms)].slice(0, 200);
  const subjects = [...new Set(wanted.subjects)].slice(0, 200);
  const [roomRows, subjectRows] = await Promise.all([
    rooms.length === 0
      ? Promise.resolve([])
      : db.selectFrom('locations').select(['id', 'name', 'branch_id']).where('id', 'in', rooms).where('is_public', '=', 1).where('archived_at', 'is', null).execute(),
    subjects.length === 0
      ? Promise.resolve([])
      : db.selectFrom('subjects').select(['id', 'term_display']).where('id', 'in', subjects).where('archived_at', 'is', null).execute(),
  ]);
  // With more than one branch a room's name alone may be ambiguous ("Ruang Referensi"): the branch follows it.
  const branchName = masters.branches.length > 1 ? new Map(masters.branches.map((b) => [b.id, b.nameId])) : null;
  return {
    rooms: new Map(
      roomRows.map((r) => {
        const branch = branchName?.get(r.branch_id);
        return [r.id, branch === undefined ? r.name : `${r.name} (${branch})`];
      }),
    ),
    subjects: new Map(subjectRows.map((r) => [r.id, r.term_display])),
    agents,
  };
}

/** The facets in the order the page shows them. */
const FACET_ORDER: readonly FacetName[] = ['av', 'cl', 'sb', 'mt', 'at', 'lg', 'ct', 'br', 'lc'];

/** The parameter each facet's values go in. */
const FACET_PARAM: Readonly<Record<FacetName, OpacSearchParam>> = {
  mt: 'jenis',
  lg: 'bahasa',
  ct: 'koleksi',
  br: 'cabang',
  lc: 'lokasi',
  av: 'tersedia',
  at: 'lampiran',
  sb: 'subjek',
  cl: 'kelas',
};

/** The parameters that filter (the active filters), in the order of the page's links. */
export const FILTER_PARAMS: readonly OpacSearchParam[] = [
  'jenis',
  'bahasa',
  'koleksi',
  'cabang',
  'lokasi',
  'subjek',
  'pengarang',
  // ---- Komunitas (OPAC look): the advanced search's ISBN field ----
  'isbn',
  'tahun',
  'tersedia',
  'lampiran',
  'kelas',
];

/** What the facets and the active filters are drawn from. */
export interface FacetsInput {
  locale: Locale;
  /** The `lang` every link keeps (the request named it), or null. */
  lang: Locale | null;
  echo: OpacSearchEcho;
  masters: SearchMasters;
  names: FacetNames;
}

/** `n` written for `locale` (`10.000`, `10,000`). */
export function formatCount(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-GB').format(n);
}

/** The name of the DDC main class `digit` (`800 Kesusastraan`). */
function className(digit: string, locale: Locale): string {
  return `${digit}00 ${opacText(locale, `shell.home.class.${digit}` as OpacKey)}`;
}

/** The master of `list` with `id` (a facet value) or `code` (a parameter). */
const masterBy = (list: readonly SearchMaster[], key: 'id' | 'code', value: string): SearchMaster | undefined => list.find((m) => m[key] === value);

/** The parameter value and the label of facet `facet`'s value `value`, or null when the page cannot name it. */
function facetValue(facet: FacetName, value: string, i: FacetsInput): { param: string; label: string } | null {
  const { locale, masters, names } = i;
  const master = (list: readonly SearchMaster[]) => {
    const m = masterBy(list, 'id', value);
    return m === undefined ? null : { param: m.code, label: masterName(m, locale) };
  };
  switch (facet) {
    case 'mt':
      return master(masters.materialTypes);
    case 'lg':
      return master(masters.languages);
    case 'ct':
      return master(masters.collectionTypes);
    case 'br':
      return master(masters.branches);
    case 'lc': {
      const name = names.rooms.get(value);
      return name === undefined ? null : { param: value, label: name };
    }
    case 'sb': {
      const name = names.subjects.get(value);
      return name === undefined ? null : { param: value, label: name };
    }
    case 'av':
      return value === '1' ? { param: '1', label: opacText(locale, 'search.facet.available') } : null;
    case 'at':
      return (ATTACHMENT_MEDIA as readonly string[]).includes(value)
        ? { param: value, label: t(locale, vocabKey('attachment_media', value as AttachmentMedia)) }
        : null;
    case 'cl':
      return /^[0-9]$/.test(value) ? { param: value, label: className(value, locale) } : null;
  }
}

/** The heading of a facet (the shared `vocab.facet.*` labels). */
const facetHeading = (facet: FacetName, locale: Locale): string => t(locale, vocabKey('facet', facet));

function FacetLink(props: { href: string; label: string; count: number; current: boolean; locale: Locale }) {
  return (
    <li>
      <a href={props.href} aria-current={props.current ? 'true' : undefined}>
        <span class="facet-label">{props.label}</span> <span class="facet-count">{formatCount(props.count, props.locale)}</span>
      </a>
    </li>
  );
}

/** One facet; null when none of its values can be named. */
function Facet(props: { facet: FacetName; values: readonly { value: string; count: number }[]; input: FacetsInput }) {
  const { facet, input } = props;
  const param = FACET_PARAM[facet];
  const items = props.values.flatMap((v) => {
    const named = facetValue(facet, v.value, input);
    if (named === null || v.count <= 0) return [];
    const current = input.echo[param] === named.param;
    const href = searchPath(input.echo, { [param]: current ? null : named.param }, input.lang);
    return [<FacetLink href={href} label={named.label} count={v.count} current={current} locale={input.locale} />];
  });
  if (items.length === 0) return null;
  const id = `facet-${facet}`;
  return (
    <section class="facet" aria-labelledby={id}>
      <h3 id={id}>{facetHeading(facet, input.locale)}</h3>
      <ul>{items.slice(0, FACET_VISIBLE)}</ul>
      {items.length > FACET_VISIBLE ? (
        <details class="facet-more">
          <summary>{opacText(input.locale, 'search.facet.more', { count: formatCount(items.length, input.locale) })}</summary>
          <ul>{items.slice(FACET_VISIBLE)}</ul>
        </details>
      ) : null}
    </section>
  );
}

/** The heading and value of an active filter, or null when the page cannot name it. */
function activeFilter(param: OpacSearchParam, value: string, i: FacetsInput): string | null {
  const { locale, masters, names } = i;
  const coded = (facet: FacetName, list: readonly SearchMaster[]) => {
    const m = masterBy(list, 'code', value);
    return m === undefined ? null : `${facetHeading(facet, locale)}: ${masterName(m, locale)}`;
  };
  const named = (heading: string, name: string | undefined) => (name === undefined ? null : `${heading}: ${name}`);
  switch (param) {
    case 'jenis':
      return coded('mt', masters.materialTypes);
    case 'bahasa':
      return coded('lg', masters.languages);
    case 'koleksi':
      return coded('ct', masters.collectionTypes);
    case 'cabang':
      return coded('br', masters.branches);
    case 'lokasi':
      return named(facetHeading('lc', locale), names.rooms.get(value));
    case 'subjek':
      return named(facetHeading('sb', locale), names.subjects.get(value));
    case 'pengarang':
      return named(opacText(locale, 'search.filter.agent'), names.agents.get(value));
    case 'isbn':
      return `${opacText(locale, 'search.filter.isbn')}: ${value}`;
    case 'tahun':
      return `${opacText(locale, 'search.year.label')}: ${value}`;
    case 'tersedia':
      return named(facetHeading('av', locale), facetValue('av', value, i)?.label);
    case 'lampiran':
      return named(facetHeading('at', locale), facetValue('at', value, i)?.label);
    case 'kelas':
      return named(facetHeading('cl', locale), facetValue('cl', value, i)?.label);
    default:
      return null;
  }
}

/** The filters in use, each with a link that removes it, and one that removes them all (the text and order kept). */
export function ActiveFilters(props: { input: FacetsInput }) {
  const { input } = props;
  const active = FILTER_PARAMS.flatMap((param) => {
    const value = input.echo[param];
    if (value === undefined) return [];
    const label = activeFilter(param, value, input);
    return label === null ? [] : [{ param, label }];
  });
  if (active.length === 0) return null;
  const none = Object.fromEntries(FILTER_PARAMS.map((p) => [p, null]));
  return (
    <section class="filters-active" aria-labelledby="filter-aktif">
      <h3 id="filter-aktif">{opacText(input.locale, 'search.filters.active')}</h3>
      <ul>
        {active.map((f) => (
          <li>
            <a href={searchPath(input.echo, { [f.param]: null }, input.lang)}>
              {f.label} <span class="visually-hidden">{opacText(input.locale, 'search.facet.remove')}</span>
            </a>
          </li>
        ))}
      </ul>
      <p class="filters-clear">
        <a href={searchPath(input.echo, none, input.lang)}>{opacText(input.locale, 'search.filters.clear')}</a>
      </p>
    </section>
  );
}

/** The echo's parameters as hidden inputs (all but `omit`, `hal` never), then `lang`: what a GET form carries along. */
export function HiddenParams(props: { echo: OpacSearchEcho; omit: readonly OpacSearchParam[]; lang: Locale | null }) {
  const { echo, omit, lang } = props;
  const params = (Object.keys(echo) as OpacSearchParam[]).filter((p) => p !== 'hal' && !omit.includes(p));
  return (
    <>
      {params.map((name) => (
        <input type="hidden" name={name} value={echo[name]} />
      ))}
      {lang === null ? null : <input type="hidden" name="lang" value={lang} />}
    </>
  );
}

/** The year form: `tahun` as one year or a range, the other parameters kept. */
function YearForm(props: { input: FacetsInput }) {
  const { input } = props;
  return (
    <form class="facet year-form" method="get" action="/cari">
      <label for="cari-tahun">{opacText(input.locale, 'search.year.label')}</label>
      <span class="year-row">
        <input
          id="cari-tahun"
          type="text"
          name="tahun"
          value={input.echo.tahun ?? ''}
          inputmode="numeric"
          maxlength={11}
          placeholder="1990-2000"
          aria-describedby="cari-tahun-hint"
        />
        <button type="submit">{opacText(input.locale, 'search.year.submit')}</button>
      </span>
      <span id="cari-tahun-hint" class="facet-hint">
        {opacText(input.locale, 'search.year.hint')}
      </span>
      <HiddenParams echo={input.echo} omit={['tahun']} lang={input.lang} />
    </form>
  );
}

/**
 * The aside of the search page (`#saring`): the active filters, the facets of the results and the year form. With no
 * result only the active filters are left (the way out of an empty search); null when there is nothing to show.
 */
export function FacetsAside(props: {
  input: FacetsInput;
  facets: CatalogSearchResult['facets'];
  approximate: boolean;
  /** The facet counts' sample when approximate (§4.6: the top 5 000). */
  sample: number;
  hasResults: boolean;
}) {
  const { input, facets } = props;
  const sections = props.hasResults
    ? FACET_ORDER.flatMap((facet) => {
        const values = facets?.[facet];
        return values === undefined || values.length === 0 ? [] : [<Facet facet={facet} values={values} input={input} />];
      })
    : [];
  const active = <ActiveFilters input={input} />;
  const hasActive = FILTER_PARAMS.some((p) => input.echo[p] !== undefined);
  if (!props.hasResults && !hasActive) return null;
  return (
    <aside class="facets" id="saring" aria-labelledby="saring-judul">
      <h2 id="saring-judul">{opacText(input.locale, 'search.facets.title')}</h2>
      {props.approximate && props.hasResults ? (
        <p class="facet-hint">{opacText(input.locale, 'search.facets.approximate', { count: formatCount(props.sample, input.locale) })}</p>
      ) : null}
      {active}
      {sections}
      {props.hasResults ? <YearForm input={input} /> : null}
    </aside>
  );
}
