import { closedBy, latestNews, recordUrlPath, topClasses, upcomingEvents, type ClassActivity, type OpacNewsItem } from '@altis/core';
import { isLocale, localDate, t, type Locale } from '@altis/shared';
import {
  OPAC_HOME_DEFAULT,
  OPAC_HOME_HERO_SIZE,
  isSafeInternalPath,
  opacHomeSlidesAt,
  phoneHref,
  type OpacHomeContent,
  type OpacHomeSlide,
  type OpacHomeTarget,
} from '@altis/shared/api/opac-home';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Icon } from '../icons.js';
import { SearchForm } from '../layout.js';
import { OPAC_SLIDER_FILE } from '../slider.js';
import { BookCover } from './cover.js';
import { libraryJsonLd, webSiteJsonLd } from './library-json-ld.js';
import { opacText, type OpacKey } from './messages.js';
import { cachedClosedDays, isoWeekday, libraryToday, opacContext, opacPage, requestLang, type OpacContextSource } from './page.js';
import {
  CLASS_DIGITS,
  cachedCatalogueFacts,
  cachedHomeFigures,
  newTitles,
  popularTitles,
  promotedTitles,
  yearStart,
  type CatalogueFacts,
  type HomeFigures,
  type TitleCard,
} from './queries.js';
import { OPAC_ADVANCED_PATH, OPAC_SEARCH_TEXT_MAX } from './search-params.js';
import { ShelfStatusLine, yearOf } from './shelf-status.js';
import { Agenda, HoursTable, MapLink, NewsRows, Photo, countText, fileSrc, keep, paragraphs, textIn } from './site-blocks.js';
import { pagePath } from './urls.js';

// The OPAC home page as the library's profile site, `GET /`. In this order, each block only when it is switched on
// (`opac.home`'s `blocks`) and has something to show:
//
//   the hero       the slides that show today (the library's day): a solid panel of the library colour with the text
//                  and an optional button, a photo beside it; one slide, or none (the page's heading on the panel
//                  alone), has no controls. See slider.ts for what the script adds and what works without it.
//   the search     the field to search in joined to the text, the number of titles and of titles on the shelf
//   about          the library's paragraph and photo, then its figures (aggregates, kept a minute): titles, active
//                  members, visits this year, the year it was founded
//   services       a title and a sentence each
//   titles         the new titles as cards, the most borrowed as a numbered list beside the ten DDC classes with
//                  their number of titles, the promoted titles, the loans per class
//   news           the latest posts as rows beside the next events
//   gallery        the first four photos
//   visit          the address with a link to a map, the opening hours with today's row marked, the contact, and the
//                  call to become a member
//
// Nothing of a person is shown: the figures are counts, the popular titles and the classes are aggregates without a
// borrower, the people of the profile are typed in by the staff for publication. Every link keeps the page's `?lang=`
// when the request named one. The page carries the JSON-LD `Library` + `WebSite` with its SearchAction.

/** At most this many promoted titles. */
export const PROMOTED_MAX = 12;
/** The latest news posts shown. */
export const HOME_NEWS = 3;
/** The next events shown. */
export const HOME_EVENTS = 3;
/** The new titles shown at most (a phone shows four). */
export const HOME_NEW_TITLES_MAX = 6;
/** The most borrowed titles shown, as a numbered list. */
export const HOME_POPULAR = 5;
/** The classes shown in the loans per class. */
export const HOME_CLASSES = 3;
/** The gallery photos shown (the gallery's own page shows them all). */
export const HOME_GALLERY = 4;

/** What the home page reads besides the context (a RouteContext has it). */
export interface HomeSource extends OpacContextSource {
  readonly now: number;
}

/**
 * A title as a row of a list: its small cover (or substitute cover), title, author and what its copies allow now
 * (never who holds one), all one link.
 */
function Card(props: { card: TitleCard; locale: Locale; lang: Locale | null; year: number }) {
  const { card, locale, lang } = props;
  return (
    <li class="card">
      <BookCover
        book={{ title: card.title, author: card.mainAgent, callNumber: card.callNumber, classification: card.classification, coverFileId: card.coverFileId }}
        size="card"
        imgClass="card-cover"
        width={84}
        height={126}
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

function SectionHead(props: { id: string; heading: string; sub?: string | undefined; more?: { href: string; label: string } | undefined }) {
  return (
    <div class="section-head">
      <div>
        <h2 id={props.id}>{props.heading}</h2>
        {props.sub === undefined ? null : <p class="section-sub">{props.sub}</p>}
      </div>
      {props.more === undefined ? null : (
        <a class="section-link" href={props.more.href}>
          {props.more.label}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The hero

/**
 * The slides the hero shows at `now`, in their order: those switched on whose days (calendar days of the library's
 * time zone; UTC when the setting names none `Intl` knows) hold today.
 */
export function heroSlidesAt(home: Pick<OpacHomeContent, 'hero'>, timeZone: string, now: number): OpacHomeSlide[] {
  try {
    return opacHomeSlidesAt(home.hero, timeZone, now);
  } catch {
    return opacHomeSlidesAt(home.hero, 'UTC', now);
  }
}

/**
 * Where a slide's button leads: a path of this site made from the target's kind and reference, never the reference as
 * a free URL; null when a `path` target is not a safe path of this site (the button is then left out).
 */
export function slideTargetPath(target: OpacHomeTarget): string | null {
  switch (target.kind) {
    case 'catalog':
      return '/cari';
    case 'profile':
      return '/profil';
    case 'news':
      return target.ref === undefined ? '/berita' : pagePath('news', target.ref);
    case 'path':
      return isSafeInternalPath(target.ref) ? target.ref : null;
  }
}

/** The texts of the hero when a slide has none of its own: the page's heading and the welcome text. */
interface HeroDefaults {
  libraryName: string;
  title: OpacHomeContent['title'];
  welcome: { id: string | null; en: string | null };
}

/** The panel of a slide: an optional note, the heading (`h1` on the first slide), the lead sentence, the button. */
function SlideText(props: { slide: OpacHomeSlide | null; first: boolean; defaults: HeroDefaults; locale: Locale; lang: Locale | null }) {
  const { slide, defaults, locale, lang } = props;
  const note = slide === null ? null : textIn(slide.note, locale);
  const title = (slide === null ? null : textIn(slide.title, locale)) ?? textIn(defaults.title, locale);
  const lead = (slide === null ? null : textIn(slide.subtitle, locale)) ?? textIn(defaults.welcome, locale);
  const label = slide === null || slide.cta === null ? null : textIn(slide.cta.label, locale);
  const target = slide === null || slide.cta === null ? null : slideTargetPath(slide.cta.target);
  const Heading = props.first ? 'h1' : 'h2';
  return (
    <div class="slide-text">
      <div class="slide-body">
        {note === null ? null : (
          <p class="slide-note" lang={note.lang}>
            {note.text}
          </p>
        )}
        <Heading lang={title?.lang}>{title === null ? defaults.libraryName : title.text}</Heading>
        {lead === null ? null : (
          <p class="slide-lead" lang={lead.lang}>
            {lead.text}
          </p>
        )}
        {label === null || target === null ? null : (
          <p class="slide-cta">
            <a class="btn btn-inv" href={keep(target, lang)} lang={label.lang}>
              {label.text}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The hero: the slides in one stack (see the top of this file and the stylesheet's home module), and, with more than
 * one slide, the controls: an indicator per slide (a link to it, with a hidden label "Slide n of N"), and the previous,
 * next and pause buttons, which the script reveals.
 */
export function Hero(props: {
  slides: readonly OpacHomeSlide[];
  autoplay: boolean;
  intervalSec: number;
  defaults: HeroDefaults;
  locale: Locale;
  lang: Locale | null;
}) {
  const { slides, defaults, locale, lang } = props;
  const total = slides.length;
  if (total === 0) {
    return (
      <section class="hero" aria-label={opacText(locale, 'home.hero.label')}>
        <div class="hero-track">
          <div class="slide slide-nophoto">
            <SlideText slide={null} first defaults={defaults} locale={locale} lang={lang} />
          </div>
        </div>
      </section>
    );
  }
  const many = total > 1;
  return (
    <section
      class="hero"
      data-hero={many ? '' : undefined}
      data-autoplay={many ? String(props.autoplay) : undefined}
      data-interval={many ? String(props.intervalSec) : undefined}
      aria-roledescription={many ? 'carousel' : undefined}
      aria-label={opacText(locale, 'home.hero.label')}
    >
      <div class="hero-track" aria-live={many ? 'off' : undefined}>
        {slides.map((slide, i) => (
          <div
            class="slide"
            id={`slide-${i + 1}`}
            role={many ? 'group' : undefined}
            aria-roledescription={many ? 'slide' : undefined}
            aria-label={many ? opacText(locale, 'home.hero.slide_of', { n: i + 1, total }) : undefined}
          >
            <SlideText slide={slide} first={i === 0} defaults={defaults} locale={locale} lang={lang} />
            <img
              class={`hero-pos-${heroPosition(slide.position)}`}
              src={fileSrc(slide.fileId)}
              alt={slide.alt}
              width={OPAC_HOME_HERO_SIZE.width}
              height={OPAC_HOME_HERO_SIZE.height}
              fetchpriority={i === 0 ? 'high' : undefined}
              loading={i === 0 ? undefined : 'lazy'}
              decoding="async"
            />
          </div>
        ))}
      </div>
      {!many ? null : (
        <div class="hero-ui">
          <nav class="hero-dots" aria-label={opacText(locale, 'home.hero.pick')}>
            {slides.map((_, i) => (
              <a href={`#slide-${i + 1}`} aria-current={i === 0 ? 'true' : 'false'}>
                <span class="visually-hidden">{opacText(locale, 'home.hero.slide_n', { n: i + 1, total })}</span>
              </a>
            ))}
          </nav>
          <button type="button" data-js hidden data-prev aria-label={opacText(locale, 'home.hero.prev')}>
            <Icon name="left" />
          </button>
          <button type="button" data-js hidden data-next aria-label={opacText(locale, 'home.hero.next')}>
            <Icon name="right" />
          </button>
          <button
            type="button"
            data-js
            hidden
            data-pause
            aria-label={opacText(locale, 'home.hero.pause')}
            data-label-pause={opacText(locale, 'home.hero.pause')}
            data-label-play={opacText(locale, 'home.hero.play')}
          >
            <span data-icon-pause>
              <Icon name="pause" />
            </span>
            <span data-icon-play hidden>
              <Icon name="play" />
            </span>
          </button>
        </div>
      )}
    </section>
  );
}

/** The position class of a photo: its position rounded to a step of 10 within 0-100. */
function heroPosition(position: number): number {
  const p = Number.isFinite(position) ? Math.round(position / 10) * 10 : 50;
  return Math.min(100, Math.max(0, p));
}

/** The slider's script element: a static file under its content hash, deferred. */
function SliderScript() {
  return <script src={`/assets/${OPAC_SLIDER_FILE}`} defer></script>;
}

// ---------------------------------------------------------------------------------------------------------------
// The blocks

interface Block {
  id?: string;
  labelledBy: string;
  variant?: 'band' | 'compact';
  body: JSX.Element;
}

function SearchBand(props: { locale: Locale; lang: Locale | null; titles: number; available: number }) {
  const { locale, lang, titles } = props;
  const meta = (
    <p class="search-meta">
      {titles > 0 ? (
        <span>
          {opacText(locale, titles === 1 ? 'home.search.summary_one' : 'home.search.summary', {
            count: countText(titles, locale),
            available: countText(props.available, locale),
          })}
        </span>
      ) : null}
      <a href={keep(OPAC_ADVANCED_PATH, lang)}>{opacText(locale, 'search.advanced.link')}</a>
    </p>
  );
  return (
    <div class="search-band home-search">
      <div class="wrap">
        <SearchForm locale={locale} lang={lang} id="cari-beranda" scope="semua" label meta={meta} maxlength={OPAC_SEARCH_TEXT_MAX} />
      </div>
    </div>
  );
}

/** "About the library": its paragraphs and one photo, then the figures (each only when it is known and not zero). */
function about(o: { home: OpacHomeContent; figures: HomeFigures; profile: boolean; locale: Locale; lang: Locale | null; contentLang: Locale | undefined }): Block | null {
  const { home, figures, locale } = o;
  const { photo, founded } = home.about;
  const text = textIn(home.about.text, locale);
  const rows: [label: string, value: string][] = [];
  if (figures.titles > 0) rows.push([opacText(locale, 'home.figure.titles'), countText(figures.titles, locale)]);
  if (figures.members > 0) rows.push([opacText(locale, 'home.figure.members'), countText(figures.members, locale)]);
  if (figures.visits > 0) rows.push([opacText(locale, 'home.figure.visits'), countText(figures.visits, locale)]);
  if (founded !== null) rows.push([opacText(locale, 'home.figure.founded'), String(founded)]);
  if (text === null && photo === null && rows.length === 0) return null;
  return {
    id: 'tentang',
    labelledBy: 'tentang-judul',
    body: (
      <>
        <div class={photo === null ? 'about about-nophoto' : 'about'}>
          <div>
            <h2 id="tentang-judul">{opacText(locale, 'home.about.title')}</h2>
            {text === null ? null : paragraphs(text.text).map((p) => <p lang={text.lang}>{p}</p>)}
            {o.profile ? (
              <a class="more-link" href={keep('/profil', o.lang)}>
                {opacText(locale, 'home.about.more')}
              </a>
            ) : null}
          </div>
          {photo === null ? null : (
            <Photo fileId={photo.fileId} alt={photo.alt} class="about-photo" lang={o.contentLang}>
              {photo.caption}
            </Photo>
          )}
        </div>
        {rows.length === 0 ? null : (
          <dl class={rows.length === 4 ? 'figures' : `figures figures-${rows.length}`} aria-label={opacText(locale, 'home.about.facts')}>
            {rows.map(([label, value]) => (
              <div>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </>
    ),
  };
}

/** The services: a title and one sentence each. */
function services(o: { home: OpacHomeContent; profile: boolean; locale: Locale; lang: Locale | null; contentLang: Locale | undefined }): Block | null {
  const { home, locale } = o;
  if (home.services.length === 0) return null;
  const more = o.profile && home.facilities.length > 0 ? { href: `${keep('/profil', o.lang)}#fasilitas`, label: opacText(locale, 'home.services.more') } : undefined;
  return {
    id: 'layanan',
    labelledBy: 'layanan-judul',
    variant: 'compact',
    body: (
      <>
        <SectionHead id="layanan-judul" heading={opacText(locale, 'home.services.title')} more={more} />
        <ul class="svc-grid" lang={o.contentLang}>
          {home.services.map((s) => (
            <li>
              <h3>{s.title}</h3>
              {s.text === null || s.text === '' ? null : <p>{s.text}</p>}
            </li>
          ))}
        </ul>
      </>
    ),
  };
}

/** The most borrowed titles as a numbered list: the title and its author; no count and no borrower. */
function Popular(props: { cards: readonly TitleCard[]; locale: Locale; lang: Locale | null }) {
  const { cards, locale, lang } = props;
  return (
    <div>
      <h3 class="h3" id="judul-populer">
        {opacText(locale, 'home.popular.title')} <small>· {opacText(locale, 'home.popular.window')}</small>
      </h3>
      <ol class="rank" aria-labelledby="judul-populer">
        {cards.map((card, i) => (
          <li>
            <span class="rank-n" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <a href={keep(recordUrlPath(card.id, card.title), lang)}>{card.title}</a>
              {card.mainAgent === null ? null : <small>{card.mainAgent}</small>}
            </span>
          </li>
        ))}
      </ol>
      <p class="section-note">{opacText(locale, 'home.popular.note')}</p>
    </div>
  );
}

/**
 * "Jelajahi menurut subjek": the ten DDC main classes, each with its number of public titles (the search index's `cl`
 * facet, what the linked search finds), each a link to the search for that class, an empty one included.
 */
function Classes(props: { locale: Locale; lang: Locale | null; counts: CatalogueFacts['classes'] }) {
  const { locale, lang, counts } = props;
  return (
    <div>
      <h3 class="h3" id="jelajah-kelas">
        {opacText(locale, 'shell.home.classes')}
      </h3>
      <ul class="ddc" aria-labelledby="jelajah-kelas">
        {CLASS_DIGITS.map((n) => (
          <li>
            <a href={keep(`/cari?kelas=${n}`, lang)}>
              <span class="mono">{`${n}00`}</span>
              <span>{opacText(locale, `shell.home.class.${n}` as OpacKey)}</span>
              <span class="ddc-count">
                <span aria-hidden="true">{countText(counts[n], locale)}</span>
                <span class="visually-hidden">
                  {opacText(locale, counts[n] === 1 ? 'home.subjects.count_one' : 'home.subjects.count', { count: countText(counts[n], locale) })}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The new titles as cards, then the most borrowed beside the subjects by class. */
function titles(o: {
  fresh: readonly TitleCard[];
  popular: readonly TitleCard[];
  classes: CatalogueFacts['classes'] | null;
  locale: Locale;
  lang: Locale | null;
  year: number;
}): Block | null {
  const { fresh, popular, classes, locale, lang } = o;
  const lists = (popular.length > 0 ? 1 : 0) + (classes === null ? 0 : 1);
  if (fresh.length === 0 && lists === 0) return null;
  return {
    labelledBy: fresh.length > 0 ? 'judul-baru' : popular.length > 0 ? 'judul-populer' : 'jelajah-kelas',
    variant: 'band',
    body: (
      <>
        {fresh.length === 0 ? null : (
          <>
            <SectionHead id="judul-baru" heading={opacText(locale, 'shell.home.new_titles')} more={{ href: keep('/cari', lang), label: opacText(locale, 'home.new.all') }} />
            <ul class="card-grid home-titles">
              {fresh.map((card) => (
                <Card card={card} locale={locale} lang={lang} year={o.year} />
              ))}
            </ul>
          </>
        )}
        {lists === 0 ? null : (
          <div class={lists === 1 ? 'cols-2 cols-1' : 'cols-2'}>
            {popular.length === 0 ? null : <Popular cards={popular} locale={locale} lang={lang} />}
            {classes === null ? null : <Classes locale={locale} lang={lang} counts={classes} />}
          </div>
        )}
      </>
    ),
  };
}

/** The promoted titles as cards. */
function promotedBlock(o: { cards: readonly TitleCard[]; locale: Locale; lang: Locale | null; year: number }): Block | null {
  if (o.cards.length === 0) return null;
  return {
    labelledBy: 'judul-unggulan',
    body: (
      <>
        <SectionHead id="judul-unggulan" heading={opacText(o.locale, 'shell.home.promoted')} />
        <ul class="card-grid">
          {o.cards.map((card) => (
            <Card card={card} locale={o.locale} lang={o.lang} year={o.year} />
          ))}
        </ul>
      </>
    ),
  };
}

/** The loans per class: the first classes of the aggregate, each with its place and counts; no member. */
function readingClasses(o: { classes: readonly ClassActivity[]; locale: Locale }): Block | null {
  const { classes, locale } = o;
  if (classes.length === 0) return null;
  return {
    labelledBy: 'kelas-rajin',
    body: (
      <>
        <SectionHead id="kelas-rajin" heading={opacText(locale, 'home.classes.title')} sub={opacText(locale, 'home.classes.note')} />
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
      </>
    ),
  };
}

/** The latest news as rows, beside the next events. */
function news(o: { news: readonly OpacNewsItem[]; events: readonly OpacNewsItem[]; locale: Locale; lang: Locale | null; timeZone: string }): Block | null {
  const { locale, lang, timeZone } = o;
  if (o.news.length === 0) return null;
  return {
    labelledBy: 'berita-terbaru',
    body: (
      <>
        <SectionHead id="berita-terbaru" heading={opacText(locale, 'shell.home.news')} more={{ href: keep('/berita', lang), label: opacText(locale, 'shell.home.news_all') }} />
        <div class={o.events.length === 0 ? 'news-agenda news-agenda-1 home-news' : 'news-agenda home-news'}>
          <NewsRows items={o.news} locale={locale} lang={lang} timeZone={timeZone} heading="h3" />
          {o.events.length === 0 ? null : (
            <aside aria-labelledby="agenda-terdekat">
              <h3 class="h3" id="agenda-terdekat">
                {opacText(locale, 'home.agenda.title')}
              </h3>
              <Agenda events={o.events} locale={locale} lang={lang} timeZone={timeZone} />
            </aside>
          )}
        </div>
      </>
    ),
  };
}

/** The first photos of the gallery, with a link to all of them. */
function gallery(o: { home: OpacHomeContent; locale: Locale; lang: Locale | null }): Block | null {
  const photos = (o.home.gallery ?? []).slice(0, HOME_GALLERY);
  if (photos.length === 0) return null;
  return {
    labelledBy: 'galeri-judul',
    variant: 'compact',
    body: (
      <>
        <SectionHead id="galeri-judul" heading={opacText(o.locale, 'home.gallery.title')} more={{ href: keep('/galeri', o.lang), label: opacText(o.locale, 'home.gallery.all') }} />
        <ul class="gallery">
          {photos.map((photo) => {
            const caption = textIn(photo.caption, o.locale);
            return (
              <li>
                <Photo fileId={photo.fileId} alt={photo.alt} lang={caption?.lang}>
                  {caption?.text ?? null}
                </Photo>
              </li>
            );
          })}
        </ul>
      </>
    ),
  };
}

/**
 * The visit block: one box with the library's address and a link to open it in a map app, its opening hours (today's
 * row in bold and named so; on a day the library calendar closes the block says the library is closed) and its
 * contact, each column only with content; then the call to become a member.
 */
function visit(o: {
  address: string | null;
  phone: string | null;
  email: string | null;
  home: OpacHomeContent;
  weekday: number | null;
  profile: boolean;
  locale: Locale;
  lang: Locale | null;
  contentLang: Locale | undefined;
}): Block | null {
  const { home, weekday, locale, contentLang } = o;
  const address = o.address === null || o.address.trim() === '' ? null : o.address;
  const librarians = home.about.librarians;
  const contact = o.phone !== null || o.email !== null;
  const columns = (address === null ? 0 : 1) + (home.hours.length === 0 ? 0 : 1) + (contact ? 1 : 0);
  if (columns === 0) return null;
  return {
    id: 'kunjungi',
    labelledBy: 'kunjungi-judul',
    body: (
      <>
        <SectionHead id="kunjungi-judul" heading={opacText(locale, 'home.visit.title')} />
        <div class={columns === 3 ? 'visit' : `visit visit-${columns}`}>
          {address === null ? null : (
            <div>
              <h3>{opacText(locale, 'home.visit.location')}</h3>
              <p class="visit-address" lang={contentLang}>
                {address}
              </p>
              <MapLink address={address} locale={locale} />
            </div>
          )}
          {home.hours.length === 0 ? null : (
            <div>
              <h3 id="jam-buka">{opacText(locale, 'home.visit.hours')}</h3>
              <HoursTable hours={home.hours} weekday={weekday} locale={locale} contentLang={contentLang} labelledBy="jam-buka" />
              {weekday === null ? <p class="note">{opacText(locale, 'home.visit.closed_today')}</p> : null}
            </div>
          )}
          {!contact ? null : (
            <div>
              <h3>{opacText(locale, 'home.visit.contact')}</h3>
              <dl class="kv">
                {o.phone === null ? null : (
                  <>
                    <dt>{opacText(locale, 'shell.contact.phone')}</dt>
                    <dd>
                      <a href={phoneHref(o.phone)}>{o.phone}</a>
                    </dd>
                  </>
                )}
                {o.email === null ? null : (
                  <>
                    <dt>{opacText(locale, 'shell.contact.email')}</dt>
                    <dd>
                      <a href={`mailto:${o.email}`}>{o.email}</a>
                    </dd>
                  </>
                )}
                {librarians === null || librarians <= 0 ? null : (
                  <>
                    <dt>{opacText(locale, 'home.fact.librarians')}</dt>
                    <dd>{opacText(locale, 'home.fact.librarians_value', { count: countText(librarians, locale) })}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
        </div>
        <div class="cta">
          <div>
            <h2>{opacText(locale, 'home.join.title')}</h2>
            <p>{opacText(locale, 'home.join.text')}</p>
          </div>
          {o.profile ? (
            <a class="btn btn-primary" href={`${keep('/profil', o.lang)}#anggota`}>
              {opacText(locale, 'home.join.how')}
            </a>
          ) : (
            <a class="btn btn-primary" href={keep('/akun', o.lang)}>
              {opacText(locale, 'akun.header.link')}
            </a>
          )}
        </div>
      </>
    ),
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
  const today = libraryToday(timeZone, rc.now);
  const dateAt = (ms: number): string => {
    try {
      return localDate(timeZone, ms);
    } catch {
      return localDate('UTC', ms);
    }
  };
  const [fresh, promoted, latest, events, popular, figures, classes, closedDays, facts] = await Promise.all([
    blocks.newTitles ? newTitles(handle, Math.min(newCount, HOME_NEW_TITLES_MAX)) : [],
    blocks.promoted ? promotedTitles(handle, PROMOTED_MAX) : [],
    blocks.news ? latestNews(handle, HOME_NEWS, rc.now) : [],
    blocks.news ? upcomingEvents(handle, HOME_EVENTS, rc.now) : [],
    blocks.popular ? popularTitles(handle, HOME_POPULAR) : [],
    cachedHomeFigures(handle, today, yearStart(today, dateAt)),
    blocks.readingClasses ? topClasses(handle, HOME_CLASSES) : [],
    blocks.visit ? cachedClosedDays(handle) : [],
    cachedCatalogueFacts(handle),
  ]);
  const lang = requestLang(rc.c);
  const contentLang = isLocale(libraryLocale) && libraryLocale !== locale ? libraryLocale : undefined;
  // A day the library calendar closes (a holiday, a break) is nobody's opening day, whatever the hours say.
  const weekday = closedBy(closedDays)(today) ? null : isoWeekday(today);
  const year = ctx.year ?? yearOf(rc.now);
  const profile = ctx.site?.profile === true;
  const slides = heroSlidesAt(home, timeZone, rc.now);
  const shown: (Block | null)[] = [
    blocks.about ? about({ home, figures, profile, locale, lang, contentLang }) : null,
    blocks.services ? services({ home, profile, locale, lang, contentLang }) : null,
    titles({ fresh, popular, classes: blocks.classes ? facts.classes : null, locale, lang, year }),
    promotedBlock({ cards: promoted, locale, lang, year }),
    readingClasses({ classes, locale }),
    news({ news: latest, events, locale, lang, timeZone }),
    gallery({ home, locale, lang }),
    blocks.visit ? visit({ address, phone: ctx.site?.phone ?? null, email: ctx.site?.email ?? null, home, weekday, profile, locale, lang, contentLang }) : null,
  ];
  const sections = shown.filter((b): b is Block => b !== null);
  const tagline = ctx.site === undefined ? null : textIn(ctx.site.tagline, locale);
  return opacPage(rc, ctx, {
    title: `${ctx.libraryName} · ${t(locale, 'opac.home.title')}`,
    description: tagline?.text ?? opacText(locale, 'shell.home.description', { library: ctx.libraryName }),
    canonicalPath: '/',
    robots: 'index',
    bleed: true,
    head: () => (slides.length > 1 ? <SliderScript /> : <></>),
    openGraph: slides[0] === undefined ? {} : { image: fileSrc(slides[0].fileId) },
    jsonLd: [libraryJsonLd({ name: ctx.libraryName, address, baseUrl: ctx.baseUrl }), webSiteJsonLd({ name: ctx.libraryName, baseUrl: ctx.baseUrl, locale })],
    body: () => (
      <>
        <Hero
          slides={slides}
          autoplay={home.hero.autoplay}
          intervalSec={home.hero.intervalSec}
          defaults={{ libraryName: ctx.libraryName, title: home.title, welcome: { id: welcomeId, en: welcomeEn } }}
          locale={locale}
          lang={lang}
        />
        <SearchBand locale={locale} lang={lang} titles={figures.titles} available={facts.available} />
        {sections.map((block) => (
          <section
            class={block.variant === 'band' ? 'section section-band' : block.variant === 'compact' ? 'section section-compact' : 'section'}
            id={block.id}
            aria-labelledby={block.labelledBy}
          >
            <div class="wrap">{block.body}</div>
          </section>
        ))}
      </>
    ),
  });
}
