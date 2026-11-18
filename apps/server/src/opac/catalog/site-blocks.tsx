import type { OpacNewsItem } from '@altis/core';
import type { Locale, NewsCategory } from '@altis/shared';
import { OPAC_HOME_PHOTO_SIZE, type OpacHomeContent, type OpacHomeText } from '@altis/shared/api/opac-home';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Icon } from '../icons.js';
import { opacText, type OpacKey } from './messages.js';
import { pagePath, withLang } from './urls.js';

// What the pages of the library's site share (the home page, the profile, the news): the rows of a news list, the
// agenda, the opening hours, a stored photo. Every text is JSX text (escaped) or a message.

/** `path` with the page's language when the request named one. */
export const keep = (path: string, lang: Locale | null): string => (lang === null ? path : withLang(path, lang));

/** The local path of a stored, public file. */
export const fileSrc = (fileId: string): string => `/files/${encodeURIComponent(fileId)}`;

/** The BCP 47 tag dates and numbers are written with in `locale`. */
export const localeTag = (locale: Locale): string => (locale === 'id' ? 'id-ID' : 'en-GB');

/** A count as the page's language writes it. */
export function countText(n: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale)).format(n);
}

/** `ms` written with `options` in the library's time zone (UTC when `Intl` does not know it). */
export function formatIn(locale: Locale, ms: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone: 'UTC' }).format(ms);
  }
}

/** The paragraphs of a text: its parts between blank lines (line breaks within a part are kept by the stylesheet). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** A text per language as a page in `locale` shows it: its own, else the other language's (with `lang` to mark it). */
export function textIn(value: OpacHomeText | undefined, locale: Locale): { text: string; lang: Locale | undefined } | null {
  if (value === undefined) return null;
  const other: Locale = locale === 'id' ? 'en' : 'id';
  const own = value[locale];
  if (own !== null && own.trim() !== '') return { text: own, lang: undefined };
  const fallback = value[other];
  return fallback !== null && fallback.trim() !== '' ? { text: fallback, lang: other } : null;
}

/** The word of a news category. */
export function categoryText(locale: Locale, category: NewsCategory): string {
  return opacText(locale, `pages.category.${category}` as OpacKey);
}

/** The title and summary a news post shows in `locale`: its translation, or the Indonesian text (`lang: 'id'`). */
export function newsText(item: Pick<OpacNewsItem, 'translations'>, locale: Locale): { title: string; summary: string | null; lang: 'id' | undefined } {
  const own = locale === 'en' ? item.translations.en : item.translations.id;
  if (own !== null) return { title: own.title, summary: own.summary, lang: undefined };
  return { title: item.translations.id.title, summary: item.translations.id.summary, lang: 'id' };
}

/** `text` cut to `max` characters (whole code points) with an ellipsis. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** A news summary is cut to this many characters in a list. */
const SUMMARY_MAX = 280;

/**
 * News posts as rows: a small photo (the post's cover, when it has one), its category and date, its title (the link,
 * which covers the row) and its summary. `heading`: the level of a row's title.
 */
export function NewsRows(props: { items: readonly OpacNewsItem[]; locale: Locale; lang: Locale | null; timeZone: string; heading: 'h2' | 'h3' }) {
  const { items, locale, lang } = props;
  const Heading = props.heading;
  return (
    <ul class="news-rows">
      {items.map((item) => {
        const shown = newsText(item, locale);
        const summary = shown.summary === null || shown.summary.trim() === '' ? null : cut(shown.summary, SUMMARY_MAX);
        return (
          <li>
            <article class={item.coverFileId === null ? 'newsrow newsrow-nophoto' : 'newsrow'} lang={shown.lang}>
              {item.coverFileId === null ? null : <img src={fileSrc(item.coverFileId)} alt="" width={368} height={245} loading="lazy" decoding="async" />}
              <div>
                <p class="newsmeta" lang={shown.lang === undefined ? undefined : locale}>
                  {item.category === null ? null : (
                    <>
                      <b>{categoryText(locale, item.category)}</b>
                      {' · '}
                    </>
                  )}
                  <time datetime={new Date(item.publishedAt).toISOString()}>{formatIn(locale, item.publishedAt, props.timeZone, { dateStyle: 'long' })}</time>
                </p>
                <Heading>
                  <a href={keep(pagePath('news', item.slug), lang)}>{shown.title}</a>
                </Heading>
                {summary === null ? null : <p class="news-summary">{summary}</p>}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

/** When an event is, in words: its day and start time, and its end (the time alone on the same day). */
export function eventTimeText(locale: Locale, startsAt: number, endsAt: number | null, timeZone: string): string {
  const day = (ms: number): string => formatIn(locale, ms, timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = (ms: number): string => formatIn(locale, ms, timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
  const start = `${day(startsAt)}, ${time(startsAt)}`;
  if (endsAt === null || endsAt <= startsAt) return start;
  return day(endsAt) === day(startsAt) ? `${start}–${time(endsAt)}` : `${start} – ${day(endsAt)}, ${time(endsAt)}`;
}

/** The next events: a bordered date box (day and short month), the post's title as a link, the time and the place. */
export function Agenda(props: { events: readonly OpacNewsItem[]; locale: Locale; lang: Locale | null; timeZone: string }) {
  const { events, locale, lang, timeZone } = props;
  return (
    <ul class="agenda">
      {events.map((event) => {
        const shown = newsText(event, locale);
        const at = event.eventStartsAt ?? event.publishedAt;
        const time = formatIn(locale, at, timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
        return (
          <li>
            <time class="datebox" datetime={new Date(at).toISOString()}>
              <b>{formatIn(locale, at, timeZone, { day: '2-digit' })}</b>
              <small>{formatIn(locale, at, timeZone, { month: 'short' })}</small>
            </time>
            <span>
              <a class="agenda-title" href={keep(pagePath('news', event.slug), lang)} lang={shown.lang}>
                {shown.title}
              </a>
              <span class="agenda-meta">{event.eventPlace === null || event.eventPlace.trim() === '' ? time : `${time} · ${event.eventPlace}`}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The opening hours as a table: today's row (by its weekdays) in bold and named so; on a day the library calendar
 * closes (`weekday` null) no row is today's. `labelledBy`: the id of the heading that names the table.
 */
export function HoursTable(props: { hours: OpacHomeContent['hours']; weekday: number | null; locale: Locale; contentLang: Locale | undefined; labelledBy: string }) {
  const { hours, weekday, locale } = props;
  return (
    <table class="hours" aria-labelledby={props.labelledBy}>
      <thead class="visually-hidden">
        <tr>
          <th scope="col">{opacText(locale, 'home.visit.days')}</th>
          <th scope="col">{opacText(locale, 'home.visit.time')}</th>
        </tr>
      </thead>
      <tbody lang={props.contentLang}>
        {hours.map((h) =>
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
  );
}

/** A link that opens `address` in the visitor's map app or site: a search for it, nothing embedded on the page. */
export function mapLink(address: string): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(address.replace(/\s+/gu, ' ').trim())}`;
}

/** The link to the map, with the mark of a link that leaves the site. */
export function MapLink(props: { address: string; locale: Locale }) {
  return (
    <a class="more-link map-link" href={mapLink(props.address)} rel="noopener noreferrer">
      {opacText(props.locale, 'home.visit.map')} <Icon name="external" />
    </a>
  );
}

/** A stored photo (4:3 as uploaded, shown 3:2) with what stands under it. */
export function Photo(props: { fileId: string; alt: string; class?: string; lang?: Locale | undefined; children?: JSX.Element | string | null }): JSX.Element {
  return (
    <figure class={props.class} lang={props.lang}>
      <img src={fileSrc(props.fileId)} alt={props.alt} width={OPAC_HOME_PHOTO_SIZE.width} height={OPAC_HOME_PHOTO_SIZE.height} loading="lazy" decoding="async" />
      {props.children === undefined || props.children === null || props.children === '' ? null : <figcaption>{props.children}</figcaption>}
    </figure>
  );
}
