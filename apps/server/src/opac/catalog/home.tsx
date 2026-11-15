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
import { SearchForm, type HeroBand } from '../layout.js';
import { libraryJsonLd, webSiteJsonLd } from './library-json-ld.js';
import { opacText, type OpacKey } from './messages.js';
import { opacContext, opacPage, requestLang, type OpacContextSource } from './page.js';
import {
  activeMemberCount,
  latestNews,
  newTitles,
  popularTitles,
  promotedTitles,
  publicRecordCount,
  subjectPills,
  type NewsTeaser,
  type SubjectPill,
  type TitleCard,
} from './queries.js';
import { pagePath, withLang } from './urls.js';

// The OPAC home page (Phase 2 Task 21; spec §9.1, §9.4; S14, M4), `GET /`: the library's name and welcome text, a
// large search box, the new titles (`opac.newTitlesCount`, newest first from search_doc), the promoted titles, the
// three latest news posts, the ten DDC classes linking to the `cl` facet (`/cari?kelas=N`), and the JSON-LD `Library`
// + `WebSite` with its SearchAction. Every link keeps the page's `?lang=` when the request named one. The 1b "coming
// soon" notice is gone.

/** At most this many promoted titles. */
export const PROMOTED_MAX = 12;
/** The latest news posts shown. */
export const HOME_NEWS = 3;
// ---- Komunitas (OPAC home page) ----
/** The popular titles shown. */
export const HOME_POPULAR = 10;
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

/** A title's availability as words (the status colour only repeats them); nothing for a title without copies. */
function Availability(props: { card: TitleCard; locale: Locale }) {
  const { card, locale } = props;
  if (card.availability === null) return null;
  return card.availability === 'available' ? (
    <span class="status status-ok card-status">{opacText(locale, 'home.card.available')}</span>
  ) : (
    <span class="status status-muted card-status">{opacText(locale, 'home.card.unavailable')}</span>
  );
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

function Card(props: { card: TitleCard; locale: Locale; lang: Locale | null }) {
  const { card, locale, lang } = props;
  return (
    <li class="card">
      {card.coverFileId === null ? (
        <span class="card-cover" aria-hidden="true"></span>
      ) : (
        <img class="card-cover" src={`/files/${encodeURIComponent(card.coverFileId)}`} alt="" loading="lazy" decoding="async" width={120} height={180} />
      )}
      <span class="card-body">
        <a class="card-title" href={keep(recordUrlPath(card.id, card.title), lang)}>
          {card.title}
          {card.subtitle === null || card.subtitle.trim() === '' ? null : <span class="card-subtitle">: {card.subtitle}</span>}
        </a>
        {card.mainAgent === null ? null : <span class="card-meta">{card.mainAgent}</span>}
        {card.year === null ? null : <span class="card-meta">{card.year}</span>}
        <Availability card={card} locale={locale} />
      </span>
    </li>
  );
}

function Titles(props: { id: string; heading: string; cards: readonly TitleCard[]; pills?: readonly SubjectPill[]; locale: Locale; lang: Locale | null }) {
  if (props.cards.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.heading}</h2>
      {props.pills === undefined ? null : <SubjectPills pills={props.pills} locale={props.locale} lang={props.lang} />}
      <ul class="card-grid">
        {props.cards.map((card) => (
          <Card card={card} locale={props.locale} lang={props.lang} />
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
      <h2 id="berita-terbaru">{opacText(locale, 'shell.home.news')}</h2>
      <ul class="news-list">
        {news.map((n) => (
          <li lang={n.lang ?? undefined}>
            <article>
              <h3>
                <a href={keep(pagePath('news', n.slug), lang)}>{n.title}</a>
              </h3>
              <time datetime={new Date(n.publishedAt).toISOString()}>{dateText(n.publishedAt, locale, props.timeZone)}</time>
              {n.summary === null || n.summary.trim() === '' ? null : <p>{cut(n.summary, SUMMARY_MAX)}</p>}
            </article>
          </li>
        ))}
      </ul>
      <p class="more">
        <a href={keep('/berita', lang)}>{opacText(locale, 'shell.home.news_all')}</a>
      </p>
    </section>
  );
}

/** The ten DDC main classes, `0`-`9`. */
const CLASSES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function Classes(props: { locale: Locale; lang: Locale | null }) {
  const { locale, lang } = props;
  return (
    <section class="home-section" aria-labelledby="jelajah-kelas">
      <h2 id="jelajah-kelas">{opacText(locale, 'shell.home.classes')}</h2>
      <ul class="class-grid">
        {CLASSES.map((n) => (
          <li>
            <a href={keep(`/cari?kelas=${n}`, lang)}>
              <span class="class-code">{`${n}00`}</span>
              <span class="class-name">{opacText(locale, `shell.home.class.${n}` as OpacKey)}</span>
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

/**
 * The page's search card, floating at the hero's lower edge: the search form, the number of titles and today's hours,
 * or that the library is closed today (`closed`: a closed day of the library calendar).
 */
function SearchCard(props: { locale: Locale; lang: Locale | null; titles: number; today: readonly OpacHomeHours[]; closed: boolean }) {
  const { locale, lang, titles, today, closed } = props;
  const facts: string[] = [];
  if (titles > 0) facts.push(opacText(locale, 'home.search.titles', { count: countText(titles, locale) }));
  if (closed) facts.push(opacText(locale, 'home.search.closed_today'));
  else if (today.length > 0) facts.push(opacText(locale, 'home.search.today', { time: today.map((h) => h.time).join(', ') }));
  return (
    <div class="home-search">
      <SearchForm locale={locale} lang={lang} id="cari-beranda" hero />
      {facts.length === 0 ? null : (
        <p class="home-search-meta">
          {facts.map((f) => (
            <span>{f}</span>
          ))}
        </p>
      )}
    </div>
  );
}

/** The popular titles: a numbered list, the most lent first, with their availability; no count and no borrower. */
function Popular(props: { cards: readonly TitleCard[]; pills: readonly SubjectPill[]; locale: Locale; lang: Locale | null }) {
  const { cards, locale, lang } = props;
  if (cards.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby="judul-populer">
      <h2 id="judul-populer">{opacText(locale, 'home.popular.title')}</h2>
      <p class="section-note">{opacText(locale, 'home.popular.note')}</p>
      <SubjectPills pills={props.pills} locale={locale} lang={lang} />
      <ol class="popular-list">
        {cards.map((card) => (
          <li>
            <a href={keep(recordUrlPath(card.id, card.title), lang)}>
              {card.title}
              {card.subtitle === null || card.subtitle.trim() === '' ? null : <span class="card-subtitle">: {card.subtitle}</span>}
            </a>
            {card.mainAgent === null ? null : <span class="card-meta">{card.mainAgent}</span>}
            <Availability card={card} locale={locale} />
          </li>
        ))}
      </ol>
      <p class="more">
        <a href={keep('/cari?urut=populer', lang)}>{opacText(locale, 'home.popular.all')}</a>
      </p>
    </section>
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

/**
 * The visit block: the library's address and its opening hours, today's row (by its weekdays) in bold and named so; on
 * a day the library calendar closes (`weekday` null), no row is today's and the block says the library is closed.
 */
function Visit(props: { address: string | null; home: OpacHomeContent; weekday: number | null; locale: Locale; contentLang: Locale | undefined }) {
  const { home, weekday, locale, contentLang } = props;
  const address = props.address === null || props.address.trim() === '' ? null : props.address;
  if (address === null && home.hours.length === 0) return null;
  return (
    <section class="home-section" id="kunjungi" aria-labelledby="kunjungi-judul">
      <h2 id="kunjungi-judul">{opacText(locale, 'home.visit.title')}</h2>
      <div class="visit-grid">
        {address === null ? null : (
          <div class="visit-block">
            <h3>{opacText(locale, 'home.visit.location')}</h3>
            <p class="visit-address" lang={contentLang}>
              {address}
            </p>
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
  const [fresh, promoted, news, popular, titles, members, classes, closedDays] = await Promise.all([
    blocks.newTitles ? newTitles(handle, newCount) : [],
    blocks.promoted ? promotedTitles(handle, PROMOTED_MAX) : [],
    blocks.news ? latestNews(handle, rc.now, locale, HOME_NEWS) : [],
    blocks.popular ? popularTitles(handle, HOME_POPULAR) : [],
    publicRecordCount(handle),
    blocks.about ? activeMemberCount(handle, today) : 0,
    blocks.readingClasses ? topClasses(handle, HOME_CLASSES) : [],
    blocks.visit ? loadClosedDayRules(handle, null) : [],
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
        <SearchCard locale={locale} lang={lang} titles={titles} today={blocks.visit ? todayHours : []} closed={blocks.visit && closedToday} />
        {blocks.classes ? <Classes locale={locale} lang={lang} /> : null}
        {blocks.popular ? <Popular cards={popular} pills={popularPills ?? []} locale={locale} lang={lang} /> : null}
        <Titles id="judul-baru" heading={opacText(locale, 'shell.home.new_titles')} cards={fresh} pills={freshPills ?? []} locale={locale} lang={lang} />
        <Titles id="judul-unggulan" heading={opacText(locale, 'shell.home.promoted')} cards={promoted} locale={locale} lang={lang} />
        {blocks.about ? <About home={home} titles={titles} members={members} locale={locale} contentLang={contentLang} /> : null}
        {blocks.services ? <Services home={home} locale={locale} contentLang={contentLang} /> : null}
        {blocks.readingClasses ? <ReadingClasses classes={classes} locale={locale} /> : null}
        <News news={news} locale={locale} lang={lang} timeZone={timeZone} />
        {blocks.visit ? <Visit address={address} home={home} weekday={weekday} locale={locale} contentLang={contentLang} /> : null}
      </>
    ),
  });
}
