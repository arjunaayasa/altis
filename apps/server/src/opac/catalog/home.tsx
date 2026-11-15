import { recordUrlPath } from '@altis/core';
import { isLocale, localDate, t, type Locale } from '@altis/shared';
import { OPAC_HOME_DEFAULT, OPAC_HOME_HERO_SIZE, OPAC_HOME_PHOTO_SIZE, type OpacHomeContent, type OpacHomePhoto } from '@altis/shared/api/opac-home';
import { SearchForm, type HeroBand } from '../layout.js';
import { libraryJsonLd, webSiteJsonLd } from './library-json-ld.js';
import { opacText, type OpacKey } from './messages.js';
import { opacContext, opacPage, requestLang, type OpacContextSource } from './page.js';
import { activeMemberCount, latestNews, newTitles, popularTitles, promotedTitles, publicRecordCount, type NewsTeaser, type TitleCard } from './queries.js';
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

function Card(props: { card: TitleCard; lang: Locale | null }) {
  const { card, lang } = props;
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
      </span>
    </li>
  );
}

function Titles(props: { id: string; heading: string; cards: readonly TitleCard[]; lang: Locale | null }) {
  if (props.cards.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.heading}</h2>
      <ul class="card-grid">
        {props.cards.map((card) => (
          <Card card={card} lang={props.lang} />
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

/** The page's search card, floating at the hero's lower edge: the search form and the number of titles. */
function SearchCard(props: { locale: Locale; lang: Locale | null; titles: number }) {
  const { locale, lang, titles } = props;
  return (
    <div class="home-search">
      <SearchForm locale={locale} lang={lang} id="cari-beranda" hero />
      {titles > 0 ? <p class="home-search-meta">{opacText(locale, 'home.search.titles', { count: countText(titles, locale) })}</p> : null}
    </div>
  );
}

/** The popular titles: a numbered list, the most lent first; no count and no borrower. */
function Popular(props: { cards: readonly TitleCard[]; locale: Locale; lang: Locale | null }) {
  const { cards, locale, lang } = props;
  if (cards.length === 0) return null;
  return (
    <section class="home-section" aria-labelledby="judul-populer">
      <h2 id="judul-populer">{opacText(locale, 'home.popular.title')}</h2>
      <p class="section-note">{opacText(locale, 'home.popular.note')}</p>
      <ol class="popular-list">
        {cards.map((card) => (
          <li>
            <a href={keep(recordUrlPath(card.id, card.title), lang)}>
              {card.title}
              {card.subtitle === null || card.subtitle.trim() === '' ? null : <span class="card-subtitle">: {card.subtitle}</span>}
            </a>
            {card.mainAgent === null ? null : <span class="card-meta">{card.mainAgent}</span>}
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

/** "About the library": its photo, its paragraph and the facts (each fact only when known). */
function About(props: { home: OpacHomeContent; titles: number; members: number; locale: Locale; contentLang: Locale | undefined }) {
  const { home, titles, members, locale, contentLang } = props;
  const { text, photo, founded, librarians } = home.about;
  const hasText = text !== null && text !== '';
  if (!hasText && photo === null && founded === null && librarians === null) return null;
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
          {hasText ? (
            <p class="about-text" lang={contentLang}>
              {text}
            </p>
          ) : null}
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

/** The visit block: the library's address and its opening hours. */
function Visit(props: { address: string | null; home: OpacHomeContent; locale: Locale; contentLang: Locale | undefined }) {
  const { home, locale, contentLang } = props;
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
            <table class="hours" aria-labelledby="jam-buka">
              <thead class="visually-hidden">
                <tr>
                  <th scope="col">{opacText(locale, 'home.visit.days')}</th>
                  <th scope="col">{opacText(locale, 'home.visit.time')}</th>
                </tr>
              </thead>
              <tbody lang={contentLang}>
                {home.hours.map((h) => (
                  <tr>
                    <th scope="row">{h.days}</th>
                    <td>{h.time}</td>
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

/** The hero band of `home`: its photo (if any), its heading (else the library's name) and the welcome text. */
function heroOf(home: OpacHomeContent, libraryName: string, welcome: string | null): HeroBand {
  const title = home.title === null || home.title.trim() === '' ? libraryName : home.title;
  return {
    title,
    lead: welcome === null || welcome.trim() === '' ? null : welcome,
    photo:
      home.hero === null
        ? null
        : { src: fileSrc(home.hero.fileId), alt: home.hero.alt, position: home.hero.position, width: OPAC_HOME_HERO_SIZE.width, height: OPAC_HOME_HERO_SIZE.height },
  };
}

/** The home page (`opac.home`): see the top of this file. */
export async function homeResponse(rc: HomeSource): Promise<Response> {
  const ctx = await opacContext(rc);
  const { locale } = ctx;
  const handle = rc.db.db;
  const settings = rc.services.settings;
  const [welcome, address, newCount, timeZone, stored, libraryLocale] = await Promise.all([
    settings.get<string | null>(handle, locale === 'id' ? 'opac.welcome.id' : 'opac.welcome.en'),
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
  const [fresh, promoted, news, popular, titles, members] = await Promise.all([
    blocks.newTitles ? newTitles(handle, newCount) : [],
    blocks.promoted ? promotedTitles(handle, PROMOTED_MAX) : [],
    blocks.news ? latestNews(handle, rc.now, locale, HOME_NEWS) : [],
    blocks.popular ? popularTitles(handle, HOME_POPULAR) : [],
    publicRecordCount(handle),
    blocks.about ? activeMemberCount(handle, today) : 0,
  ]);
  const lang = requestLang(rc.c);
  const contentLang = isLocale(libraryLocale) && libraryLocale !== locale ? libraryLocale : undefined;
  return opacPage(rc, ctx, {
    title: `${ctx.libraryName} · ${t(locale, 'opac.home.title')}`,
    description: opacText(locale, 'shell.home.description', { library: ctx.libraryName }),
    canonicalPath: '/',
    robots: 'index',
    headerSearch: false,
    hero: heroOf(home, ctx.libraryName, welcome),
    openGraph: home.hero === null ? {} : { image: fileSrc(home.hero.fileId) },
    jsonLd: [libraryJsonLd({ name: ctx.libraryName, address, baseUrl: ctx.baseUrl }), webSiteJsonLd({ name: ctx.libraryName, baseUrl: ctx.baseUrl, locale })],
    body: () => (
      <>
        <SearchCard locale={locale} lang={lang} titles={titles} />
        {blocks.classes ? <Classes locale={locale} lang={lang} /> : null}
        {blocks.popular ? <Popular cards={popular} locale={locale} lang={lang} /> : null}
        <Titles id="judul-baru" heading={opacText(locale, 'shell.home.new_titles')} cards={fresh} lang={lang} />
        <Titles id="judul-unggulan" heading={opacText(locale, 'shell.home.promoted')} cards={promoted} lang={lang} />
        {blocks.about ? <About home={home} titles={titles} members={members} locale={locale} contentLang={contentLang} /> : null}
        {blocks.services ? <Services home={home} locale={locale} contentLang={contentLang} /> : null}
        <News news={news} locale={locale} lang={lang} timeZone={timeZone} />
        {blocks.visit ? <Visit address={address} home={home} locale={locale} contentLang={contentLang} /> : null}
      </>
    ),
  });
}
