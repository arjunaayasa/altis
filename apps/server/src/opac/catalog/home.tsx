import { recordUrlPath } from '@altis/core';
import { t, type Locale } from '@altis/shared';
import { SearchForm } from '../layout.js';
import { libraryJsonLd, webSiteJsonLd } from './library-json-ld.js';
import { opacText, type OpacKey } from './messages.js';
import { opacContext, opacPage, requestLang, type OpacContextSource } from './page.js';
import { latestNews, newTitles, promotedTitles, type NewsTeaser, type TitleCard } from './queries.js';
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

/** The home page (`opac.home`): see the top of this file. */
export async function homeResponse(rc: HomeSource): Promise<Response> {
  const ctx = await opacContext(rc);
  const { locale } = ctx;
  const handle = rc.db.db;
  const settings = rc.services.settings;
  const [welcome, address, newCount, timeZone] = await Promise.all([
    settings.get<string | null>(handle, locale === 'id' ? 'opac.welcome.id' : 'opac.welcome.en'),
    settings.get<string | null>(handle, 'library.address'),
    settings.get<number>(handle, 'opac.newTitlesCount'),
    settings.get<string>(handle, 'library.timezone'),
  ]);
  const [fresh, promoted, news] = await Promise.all([
    newTitles(handle, newCount),
    promotedTitles(handle, PROMOTED_MAX),
    latestNews(handle, rc.now, locale, HOME_NEWS),
  ]);
  const lang = requestLang(rc.c);
  return opacPage(rc, ctx, {
    title: `${ctx.libraryName} · ${t(locale, 'opac.home.title')}`,
    description: opacText(locale, 'shell.home.description', { library: ctx.libraryName }),
    canonicalPath: '/',
    robots: 'index',
    headerSearch: false,
    jsonLd: [libraryJsonLd({ name: ctx.libraryName, address, baseUrl: ctx.baseUrl }), webSiteJsonLd({ name: ctx.libraryName, baseUrl: ctx.baseUrl, locale })],
    body: () => (
      <>
        <div class="hero">
          <h1>{ctx.libraryName}</h1>
          {welcome !== null && welcome.trim() !== '' ? <p class="welcome">{welcome}</p> : null}
          <SearchForm locale={locale} lang={lang} id="cari-beranda" hero />
        </div>
        <Titles id="judul-baru" heading={opacText(locale, 'shell.home.new_titles')} cards={fresh} lang={lang} />
        <Titles id="judul-unggulan" heading={opacText(locale, 'shell.home.promoted')} cards={promoted} lang={lang} />
        <News news={news} locale={locale} lang={lang} timeZone={timeZone} />
        <Classes locale={locale} lang={lang} />
      </>
    ),
  });
}
