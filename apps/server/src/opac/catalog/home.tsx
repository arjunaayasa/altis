import { closedBy, loadClosedDayRules, recordUrlPath, topClasses, type ClassActivity } from '@altis/core';
import { isLocale, localDate, t, type Locale } from '@altis/shared';
import {
  OPAC_HOME_DEFAULT,
  OPAC_HOME_HERO_SIZE,
  OPAC_HOME_PHOTO_SIZE,
  opacHomeTextIn,
  type OpacHomeContent,
  type OpacHomeHours,
  type OpacHomePhoto,
} from '@altis/shared/api/opac-home';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { ContactLines, type HeroBand } from '../layout.js';
import { BookCover } from './cover.js';
import { libraryJsonLd, webSiteJsonLd } from './library-json-ld.js';
import { opacText, type OpacKey } from './messages.js';
import { opacContext, opacPage, requestLang, type OpacContextSource } from './page.js';
import {
  CLASS_DIGITS,
  activeMemberCount,
  cachedCatalogueFacts,
  latestNews,
  newTitles,
  popularTitles,
  promotedTitles,
  publicLoanRules,
  publicRecordCount,
  subjectPills,
  type CatalogueFacts,
  type NewsTeaser,
  type PublicLoanRule,
  type SubjectPill,
  type TitleCard,
} from './queries.js';
import { OPAC_ADVANCED_PATH, OPAC_SEARCH_SCOPES, OPAC_SEARCH_TEXT_MAX } from './search-params.js';
import { ShelfStatusLine, yearOf } from './shelf-status.js';
import { pagePath, withLang } from './urls.js';

// The OPAC home page (Phase 2 Task 21; spec §9.1, §9.4; S14, M4), `GET /`: the hero with the library's heading and
// welcome text, the search card floating at its edge (the field to search in, the text, the number of titles, of
// titles on the shelf and today's hours), the ten DDC classes with their number of titles linking to the `cl` facet
// (`/cari?kelas=N`), the popular titles, the new titles (`opac.newTitlesCount`, newest first from search_doc) and the
// promoted titles as covers (a substitute cover for a title without one), the profile blocks, the three latest news
// posts, the visit block, and the JSON-LD `Library` + `WebSite` with its SearchAction. Every link keeps the page's
// `?lang=` when the request named one. The 1b "coming soon" notice is gone.

/** At most this many promoted titles. */
export const PROMOTED_MAX = 12;
/** The latest news posts shown. */
export const HOME_NEWS = 3;
// ---- Komunitas (OPAC home page) ----
/** The popular titles shown, as cards like the new titles. */
export const HOME_POPULAR = 6;
/** At most this many subject pills above a list of titles. */
export const HOME_PILLS = 6;
/** The classes shown in the loans per class. */
export const HOME_CLASSES = 3;
/** A news summary is cut to this many characters on the home page. */
const SUMMARY_MAX = 280;

/** What the home page reads besides the context (a RouteContext has it). */
export interface HomeSource extends OpacContextSource {
  readonly now: number;
}

/** `path` with the page's language when the request named one. */
const keep = (path: string, lang: Locale | null): string => (lang === null ? path : withLang(path, lang));

/** `text` cut to `max` characters (whole code points) with an ellipsis. */
function cut(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** The date of `ms` in the library's time zone, as the page's language writes it. */
function dateText(ms: number, locale: Locale, timeZone: string): string {
  const tag = locale === 'id' ? 'id-ID' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: 'UTC' }).format(ms);
  }
}

/** The subject pills above a list of titles: each links to the search for that subject and says its titles. */
function SubjectPills(props: { pills: readonly SubjectPill[]; locale: Locale; lang: Locale | null }) {
  const { pills, locale, lang } = props;
  if (pills.length === 0) return null;
  return (
    <ul class="subject-pills" aria-label={opacText(locale, 'home.pills.label')}>
      {pills.map((p) => (
        <li>
          <a href={keep(`/cari?subjek=${encodeURIComponent(p.id)}`, lang)}>
            {p.term}
            <span class="pill-count" aria-hidden="true">
              {countText(p.titles, locale)}
            </span>
            <span class="visually-hidden">{` (${opacText(locale, p.titles === 1 ? 'home.pills.count_one' : 'home.pills.count', { count: countText(p.titles, locale) })})`}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * A title as a book on the shelf: its cover (or substitute cover), title, author and what its copies allow now (never
 * who holds one), all one link (the year is the record page's).
 */
function Card(props: { card: TitleCard; locale: Locale; lang: Locale | null; year: number }) {
  const { card, locale, lang } = props;
  return (
    <li class="card">
      <BookCover
        book={{ title: card.title, author: card.mainAgent, callNumber: card.callNumber, classification: card.classification, coverFileId: card.coverFileId }}
        size="card"
        imgClass="card-cover"
        width={120}
        height={180}
      />
      <span class="card-body">
        <a class="card-title" href={keep(recordUrlPath(card.id, card.title), lang)}>
          {card.title}
          {card.subtitle === null || card.subtitle.trim() === '' ? null : <span class="card-subtitle">: {card.subtitle}</span>}
        </a>
        {card.mainAgent === null ? null : <span class="card-meta">{card.mainAgent}</span>}
        <ShelfStatusLine status={card.shelf} locale={locale} year={props.year} extraClass="card-status" />
      </span>
    </li>
  );
}

/** A section's head: its heading (and a line under it) on the left, a "see all" link on the right. */
function SectionHead(props: { id: string; heading: string; sub?: string | undefined; aside?: string | undefined; more?: { href: string; label: string } | undefined }) {
  return (
    <div class="section-head">
      <div>
        <h2 id={props.id}>{props.heading}</h2>
        {props.sub === undefined ? null : <p class="section-sub">{props.sub}</p>}
      </div>
      {props.aside === undefined ? null : <p class="section-aside">{props.aside}</p>}
      {props.more === undefined ? null : (
        <a class="section-link" href={props.more.href}>
          {props.more.label}
        </a>
      )}
    </div>
  );
}

function Titles(props: {
  id: string;
  heading: string;
  sub?: string;
  cards: readonly TitleCard[];
  pills?: readonly SubjectPill[];
  more?: { href: string; label: string };
  locale: Locale;
  lang: Locale | null;
  year: number;
}) {
  if (props.cards.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby={props.id}>
      <SectionHead id={props.id} heading={props.heading} sub={props.sub} more={props.more} />
      {props.pills === undefined ? null : <SubjectPills pills={props.pills} locale={props.locale} lang={props.lang} />}
      <ul class="card-grid">
        {props.cards.map((card) => (
          <Card card={card} locale={props.locale} lang={props.lang} year={props.year} />
        ))}
      </ul>
    </section>
  );
}

function News(props: { news: readonly NewsTeaser[]; locale: Locale; lang: Locale | null; timeZone: string }) {
  const { news, locale, lang } = props;
  if (news.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby="berita-terbaru">
      <SectionHead id="berita-terbaru" heading={opacText(locale, 'shell.home.news')} more={{ href: keep('/berita', lang), label: opacText(locale, 'shell.home.news_all') }} />
      <ul class="news-list">
        {news.map((n) => (
          <li lang={n.lang ?? undefined}>
            <article>
              <time datetime={new Date(n.publishedAt).toISOString()}>{dateText(n.publishedAt, locale, props.timeZone)}</time>
              <h3>
                <a href={keep(pagePath('news', n.slug), lang)}>{n.title}</a>
              </h3>
              {n.summary === null || n.summary.trim() === '' ? null : <p>{cut(n.summary, SUMMARY_MAX)}</p>}
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Jelajahi menurut subjek": the ten DDC main classes, each with its number of public titles (the search index's `cl`
 * facet, what the linked search finds), each a link to the search for that class, an empty one included.
 */
function Classes(props: { locale: Locale; lang: Locale | null; counts: CatalogueFacts['classes'] }) {
  const { locale, lang, counts } = props;
  return (
    <section class="home-section" aria-labelledby="jelajah-kelas">
      <SectionHead id="jelajah-kelas" heading={opacText(locale, 'shell.home.classes')} aside={opacText(locale, 'home.subjects.scheme')} />
      <ul class="class-grid">
        {CLASS_DIGITS.map((n) => (
          <li>
            <a href={keep(`/cari?kelas=${n}`, lang)}>
              <span class="class-code">{`${n}00`}</span>
              <span class="class-name">{opacText(locale, `shell.home.class.${n}` as OpacKey)}</span>
              <span class="class-count">
                {opacText(locale, counts[n] === 1 ? 'home.subjects.count_one' : 'home.subjects.count', { count: countText(counts[n], locale) })}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Komunitas (OPAC home page) ----

/** A count as the page's language writes it. */
function countText(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-GB').format(n);
}

/** The local path of a stored photo. */
const fileSrc = (fileId: string): string => `/files/${encodeURIComponent(fileId)}`;

/** `template` with its `{name}` replaced by `value` in bold (the copy keeps the placeholder where the language puts it). */
function strong(template: string, name: string, value: string): (string | JSX.Element)[] {
  const at = template.indexOf(`{${name}}`);
  if (at === -1) return [template, ' ', <strong>{value}</strong>];
  return [template.slice(0, at), <strong>{value}</strong>, template.slice(at + name.length + 2)];
}

/**
 * The page's search card, floating at the hero's lower edge: the field to search in (radio buttons, every field first),
 * the text and the button, then the collection's facts (the number of titles, of titles on the shelf now, today's
 * hours or that the library is closed today) and the link to the advanced search.
 */
function SearchCard(props: { locale: Locale; lang: Locale | null; titles: number; available: number; today: readonly OpacHomeHours[]; closed: boolean }) {
  const { locale, lang, titles, today, closed } = props;
  return (
    <div class="home-search">
      <form class="search-box search-hero" role="search" method="get" action="/cari">
        <fieldset class="scope">
          <legend class="visually-hidden">{opacText(locale, 'search.scope.label')}</legend>
          {OPAC_SEARCH_SCOPES.map((s) => (
            <label>
              <input type="radio" name="ruas" value={s} checked={s === 'semua'} />
              <span>{opacText(locale, `search.scope.${s}`)}</span>
            </label>
          ))}
        </fieldset>
        <label for="cari-beranda" class="visually-hidden">
          {opacText(locale, 'shell.search.label')}
        </label>
        <span class="search-row">
          <input id="cari-beranda" type="search" name="q" maxlength={OPAC_SEARCH_TEXT_MAX} placeholder={opacText(locale, 'shell.search.placeholder')} />
          {lang === null ? null : <input type="hidden" name="lang" value={lang} />}
          <button type="submit">{opacText(locale, 'shell.search.submit')}</button>
        </span>
      </form>
      <p class="home-search-meta">
        {titles > 0 ? <span>{strong(opacText(locale, 'home.search.titles'), 'count', countText(titles, locale))}</span> : null}
        {titles > 0 ? <span>{strong(opacText(locale, 'home.search.available'), 'count', countText(props.available, locale))}</span> : null}
        {closed ? (
          <span>{opacText(locale, 'home.search.closed_today')}</span>
        ) : today.length > 0 ? (
          <span>{strong(opacText(locale, 'home.search.today'), 'time', today.map((h) => h.time).join(', '))}</span>
        ) : null}
        <a href={keep(OPAC_ADVANCED_PATH, lang)}>{opacText(locale, 'search.advanced.link')}</a>
      </p>
    </div>
  );
}

/** A photo of the profile with its caption (in the library's language, `contentLang` when the page is in another). */
function Figure(props: { photo: OpacHomePhoto; contentLang: Locale | undefined }) {
  const { photo, contentLang } = props;
  return (
    <figure class="home-figure" lang={contentLang}>
      <img src={fileSrc(photo.fileId)} alt={photo.alt} width={OPAC_HOME_PHOTO_SIZE.width} height={OPAC_HOME_PHOTO_SIZE.height} loading="lazy" decoding="async" />
      {photo.caption === null || photo.caption === '' ? null : <figcaption>{photo.caption}</figcaption>}
    </figure>
  );
}

/** "About the library": its photo, its paragraph (the page's language, else the other) and the facts (each when known). */
function About(props: { home: OpacHomeContent; titles: number; members: number; locale: Locale; contentLang: Locale | undefined }) {
  const { home, titles, members, locale, contentLang } = props;
  const { photo, founded, librarians } = home.about;
  const text = opacHomeTextIn(home.about.text, locale);
  if (text === null && photo === null && founded === null && librarians === null) return null;
  const facts: [label: string, value: string][] = [];
  if (founded !== null) facts.push([opacText(locale, 'home.fact.founded'), String(founded)]);
  if (titles > 0) facts.push([opacText(locale, 'home.fact.titles'), opacText(locale, 'home.fact.titles_value', { count: countText(titles, locale) })]);
  if (members > 0) facts.push([opacText(locale, 'home.fact.members'), countText(members, locale)]);
  if (librarians !== null && librarians > 0) {
    facts.push([opacText(locale, 'home.fact.librarians'), opacText(locale, 'home.fact.librarians_value', { count: countText(librarians, locale) })]);
  }
  return (
    <section class="home-section" id="tentang" aria-labelledby="tentang-judul">
      <div class={photo === null ? 'about-grid about-nophoto' : 'about-grid'}>
        {photo === null ? null : <Figure photo={photo} contentLang={contentLang} />}
        <div class="about-body">
          <h2 id="tentang-judul">{opacText(locale, 'home.about.title')}</h2>
          {text === null ? null : (
            <p class="about-text" lang={text.lang === locale ? undefined : text.lang}>
              {text.text}
            </p>
          )}
          {facts.length === 0 ? null : (
            <dl class="facts" aria-label={opacText(locale, 'home.about.facts')}>
              {facts.map(([label, value]) => (
                <div>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}

/** The services and up to four facility photos. */
function Services(props: { home: OpacHomeContent; locale: Locale; contentLang: Locale | undefined }) {
  const { home, locale, contentLang } = props;
  const photos = home.facilities.slice(0, 4);
  if (home.services.length === 0 && photos.length === 0) return null;
  return (
    <section class="home-section" id="layanan" aria-labelledby="layanan-judul">
      <h2 id="layanan-judul">{opacText(locale, 'home.services.title')}</h2>
      <div class={photos.length === 0 || home.services.length === 0 ? 'services-grid services-single' : 'services-grid'}>
        {home.services.length === 0 ? null : (
          <ul class="service-list" lang={contentLang}>
            {home.services.map((s) => (
              <li>
                <h3>{s.title}</h3>
                {s.text === null || s.text === '' ? null : <p>{s.text}</p>}
              </li>
            ))}
          </ul>
        )}
        {photos.length === 0 ? null : (
          <div class={`facility-photos facility-n${photos.length}`} role="group" aria-label={opacText(locale, 'home.services.photos')}>
            {photos.map((photo) => (
              <Figure photo={photo} contentLang={contentLang} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** A link that opens `address` in the visitor's map app or site: a search for it, nothing embedded on the page. */
export function mapLink(address: string): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(address.replace(/\s+/gu, ' ').trim())}`;
}

/** A member type's loan terms in words (`3 buku, 7 hari`). */
function ruleText(rule: PublicLoanRule, locale: Locale): string {
  const limit =
    rule.limit === null
      ? opacText(locale, 'home.rules.no_limit')
      : opacText(locale, rule.limit === 1 ? 'home.rules.items_one' : 'home.rules.items', { count: countText(rule.limit, locale) });
  const days =
    rule.days === 0 ? opacText(locale, 'home.rules.same_day') : opacText(locale, rule.days === 1 ? 'home.rules.days_one' : 'home.rules.days', { count: countText(rule.days, locale) });
  return `${limit}, ${days}`;
}

/**
 * The visit block: the library's address with a link to open it in a map app, its opening hours (today's row, by its
 * weekdays, in bold and named so; on a day the library calendar closes, `weekday` null, no row is today's and the block
 * says the library is closed), and the loan terms per member type. Each part only with content.
 */
function Visit(props: {
  address: string | null;
  phone: string | null;
  email: string | null;
  home: OpacHomeContent;
  weekday: number | null;
  rules: readonly PublicLoanRule[];
  locale: Locale;
  contentLang: Locale | undefined;
}) {
  const { home, weekday, rules, locale, contentLang } = props;
  const address = props.address === null || props.address.trim() === '' ? null : props.address;
  const contact = props.phone !== null || props.email !== null;
  if (address === null && !contact && home.hours.length === 0 && rules.length === 0) return null;
  return (
    <section class="home-section" id="kunjungi" aria-labelledby="kunjungi-judul">
      <h2 id="kunjungi-judul">{opacText(locale, 'home.visit.title')}</h2>
      <div class="visit-grid">
        {address === null && !contact ? null : (
          <div class="visit-block">
            <h3>{opacText(locale, address === null ? 'home.visit.contact' : 'home.visit.location')}</h3>
            {address === null ? null : (
              <p class="visit-address" lang={contentLang}>
                {address}
              </p>
            )}
            <ContactLines locale={locale} phone={props.phone} email={props.email} class="visit-contact" />
            {address === null ? null : (
              <a class="map-link" href={mapLink(address)} rel="noopener noreferrer">
                {opacText(locale, 'home.visit.map')}
              </a>
            )}
          </div>
        )}
        {home.hours.length === 0 ? null : (
          <div class="visit-block">
            <h3 id="jam-buka">{opacText(locale, 'home.visit.hours')}</h3>
            {weekday === null ? <p class="section-note">{opacText(locale, 'home.visit.closed_today')}</p> : null}
            <table class="hours" aria-labelledby="jam-buka">
              <thead class="visually-hidden">
                <tr>
                  <th scope="col">{opacText(locale, 'home.visit.days')}</th>
                  <th scope="col">{opacText(locale, 'home.visit.time')}</th>
                </tr>
              </thead>
              <tbody lang={contentLang}>
                {home.hours.map((h) =>
                  weekday !== null && h.weekdays.includes(weekday) ? (
                    <tr class="today">
                      <th scope="row">
                        {h.days} <span lang={locale}>({opacText(locale, 'home.visit.today')})</span>
                      </th>
                      <td>{h.time}</td>
                    </tr>
                  ) : (
                    <tr>
                      <th scope="row">{h.days}</th>
                      <td>{h.time}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        {rules.length === 0 ? null : (
          <div class="visit-block">
            <h3 id="aturan-pinjam">{opacText(locale, 'home.rules.title')}</h3>
            <table class="hours" aria-labelledby="aturan-pinjam">
              <thead class="visually-hidden">
                <tr>
                  <th scope="col">{opacText(locale, 'home.rules.type')}</th>
                  <th scope="col">{opacText(locale, 'home.rules.terms')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr>
                    <th scope="row" lang={r.lang}>
                      {r.name}
                    </th>
                    <td>{ruleText(r, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** The loans per class: the first classes of the aggregate, each with its place and counts; no member. */
function ReadingClasses(props: { classes: readonly ClassActivity[]; locale: Locale }) {
  const { classes, locale } = props;
  if (classes.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby="kelas-rajin">
      <h2 id="kelas-rajin">{opacText(locale, 'home.classes.title')}</h2>
      <p class="section-note">{opacText(locale, 'home.classes.note')}</p>
      <ol class="class-ranking">
        {classes.map((c) => (
          <li>
            <span class="class-place">{opacText(locale, 'home.classes.place', { n: countText(c.place, locale) })}</span>
            <span class="class-label">{c.className}</span>
            <span class="class-counts">
              {opacText(locale, c.titles === 1 ? 'home.classes.counts_one' : 'home.classes.counts', { loans: countText(c.loans, locale), titles: countText(c.titles, locale) })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The ISO weekday (1 Monday to 7 Sunday) of a calendar date `YYYY-MM-DD`. */
function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The hero band of `home` in `locale`: its photo (if any) under its overlay, the library colour, its heading (the
 * page's language, else the other, else the library's name) and the welcome text (likewise).
 */
function heroOf(home: OpacHomeContent, libraryName: string, welcome: { id: string | null; en: string | null }, locale: Locale): HeroBand {
  const title = opacHomeTextIn(home.title, locale);
  const lead = opacHomeTextIn(welcome, locale);
  return {
    title: title === null ? libraryName : title.text,
    titleLang: title === null || title.lang === locale ? undefined : title.lang,
    lead: lead === null ? null : lead.text,
    leadLang: lead === null || lead.lang === locale ? undefined : lead.lang,
    photo:
      home.hero === null
        ? null
        : {
            src: fileSrc(home.hero.fileId),
            alt: home.hero.alt,
            position: home.hero.position,
            overlay: home.hero.overlay,
            width: OPAC_HOME_HERO_SIZE.width,
            height: OPAC_HOME_HERO_SIZE.height,
          },
    brand: home.brand,
  };
}

/** The home page (`opac.home`): see the top of this file. */
export async function homeResponse(rc: HomeSource): Promise<Response> {
  const ctx = await opacContext(rc);
  const { locale } = ctx;
  const handle = rc.db.db;
  const settings = rc.services.settings;
  const [welcomeId, welcomeEn, address, newCount, timeZone, stored, libraryLocale] = await Promise.all([
    settings.get<string | null>(handle, 'opac.welcome.id'),
    settings.get<string | null>(handle, 'opac.welcome.en'),
    settings.get<string | null>(handle, 'library.address'),
    settings.get<number>(handle, 'opac.newTitlesCount'),
    settings.get<string>(handle, 'library.timezone'),
    settings.get<OpacHomeContent>(handle, 'opac.home'),
    settings.get<string>(handle, 'library.locale'),
  ]);
  const home = stored ?? OPAC_HOME_DEFAULT;
  const blocks = home.blocks;
  let today: string;
  try {
    today = localDate(timeZone, rc.now);
  } catch {
    today = localDate('UTC', rc.now);
  }
  const [fresh, promoted, news, popular, titles, members, classes, closedDays, facts, rules] = await Promise.all([
    blocks.newTitles ? newTitles(handle, newCount) : [],
    blocks.promoted ? promotedTitles(handle, PROMOTED_MAX) : [],
    blocks.news ? latestNews(handle, rc.now, locale, HOME_NEWS) : [],
    blocks.popular ? popularTitles(handle, HOME_POPULAR) : [],
    publicRecordCount(handle),
    blocks.about ? activeMemberCount(handle, today) : 0,
    blocks.readingClasses ? topClasses(handle, HOME_CLASSES) : [],
    blocks.visit ? loadClosedDayRules(handle, null) : [],
    cachedCatalogueFacts(handle),
    blocks.visit ? publicLoanRules(handle, locale) : [],
  ]);
  const [popularPills, freshPills] = await subjectPills(
    handle,
    [popular.map((c) => c.id), fresh.map((c) => c.id)],
    HOME_PILLS,
  );
  const lang = requestLang(rc.c);
  const contentLang = isLocale(libraryLocale) && libraryLocale !== locale ? libraryLocale : undefined;
  // A day the library calendar closes (a holiday, a break) is nobody's opening day, whatever the hours say.
  const closedToday = closedBy(closedDays)(today);
  const weekday = closedToday ? null : isoWeekday(today);
  const todayHours = weekday === null ? [] : home.hours.filter((h) => h.weekdays.includes(weekday));
  const year = ctx.year ?? yearOf(rc.now);
  return opacPage(rc, ctx, {
    title: `${ctx.libraryName} · ${t(locale, 'opac.home.title')}`,
    description: opacText(locale, 'shell.home.description', { library: ctx.libraryName }),
    canonicalPath: '/',
    robots: 'index',
    headerSearch: false,
    hero: heroOf(home, ctx.libraryName, { id: welcomeId, en: welcomeEn }, locale),
    openGraph: home.hero === null ? {} : { image: fileSrc(home.hero.fileId) },
    jsonLd: [libraryJsonLd({ name: ctx.libraryName, address, baseUrl: ctx.baseUrl }), webSiteJsonLd({ name: ctx.libraryName, baseUrl: ctx.baseUrl, locale })],
    body: () => (
      <>
        <SearchCard
          locale={locale}
          lang={lang}
          titles={titles}
          available={facts.available}
          today={blocks.visit ? todayHours : []}
          closed={blocks.visit && closedToday}
        />
        {blocks.classes ? <Classes locale={locale} lang={lang} counts={facts.classes} /> : null}
        {/* The popular titles: the most lent first, as cards like the new titles; no count and no borrower. */}
        {blocks.popular ? (
          <Titles
            id="judul-populer"
            heading={opacText(locale, 'home.popular.title')}
            sub={opacText(locale, 'home.popular.note')}
            cards={popular}
            pills={popularPills ?? []}
            more={{ href: keep('/cari?urut=populer', lang), label: opacText(locale, 'home.popular.all') }}
            locale={locale}
            lang={lang}
            year={year}
          />
        ) : null}
        <Titles
          id="judul-baru"
          heading={opacText(locale, 'shell.home.new_titles')}
          cards={fresh}
          pills={freshPills ?? []}
          more={{ href: keep('/cari', lang), label: opacText(locale, 'home.new.all') }}
          locale={locale}
          lang={lang}
          year={year}
        />
        <Titles id="judul-unggulan" heading={opacText(locale, 'shell.home.promoted')} cards={promoted} locale={locale} lang={lang} year={year} />
        {blocks.about ? <About home={home} titles={titles} members={members} locale={locale} contentLang={contentLang} /> : null}
        {blocks.services ? <Services home={home} locale={locale} contentLang={contentLang} /> : null}
        {blocks.readingClasses ? <ReadingClasses classes={classes} locale={locale} /> : null}
        <News news={news} locale={locale} lang={lang} timeZone={timeZone} />
        {blocks.visit ? (
          <Visit
            address={address}
            phone={ctx.site?.phone ?? null}
            email={ctx.site?.email ?? null}
            home={home}
            weekday={weekday}
            rules={rules}
            locale={locale}
            contentLang={contentLang}
          />
        ) : null}
      </>
    ),
  });
}
