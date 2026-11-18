import type { OpacNewsItem, OpacNewsPage } from '@altis/core';
import { NEWS_CATEGORIES, type Locale, type NewsCategory } from '@altis/shared';
import type { OpacHomeContent } from '@altis/shared/api/opac-home';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { opacText } from '../messages.js';
import { Agenda, HoursTable, NewsRows, categoryText, keep } from '../site-blocks.js';

// The view of the news list, `/berita`: tabs of the kinds of news (`?kategori=`, each a plain link), the posts of one
// page (10, newest first) as rows with their photo, kind, date, title and summary, the links to the newer and older
// pages (`?hal=`), and beside them the next events and the opening hours. Every link keeps the language the request
// named and the kind chosen. Everything works without JavaScript.

/** `/berita` with the page (`?hal=`, page 1 has none) and the kind (`?kategori=`) it shows. */
export function newsListPath(page: number, category: NewsCategory | null = null): string {
  const query = [category === null ? null : `kategori=${category}`, page <= 1 ? null : `hal=${page}`].filter((p) => p !== null);
  return query.length === 0 ? '/berita' : `/berita?${query.join('&')}`;
}

/** The kind of news `?kategori=` names, or null (none, or not one of the kinds). */
export function newsCategoryOf(value: string | undefined): NewsCategory | null {
  return value !== undefined && (NEWS_CATEGORIES as readonly string[]).includes(value) ? (value as NewsCategory) : null;
}

/** The content of one page of `/berita` in `locale`; `lang` is the language the request named (kept in every link). */
export function newsListView(o: {
  locale: Locale;
  lang: Locale | null;
  news: OpacNewsPage;
  category: NewsCategory | null;
  events: readonly OpacNewsItem[];
  hours: OpacHomeContent['hours'];
  weekday: number | null;
  contentLang: Locale | undefined;
  timeZone: string;
  libraryName: string;
}): {
  title: string;
  description: string;
  body: JSX.Element;
} {
  const { locale, lang, news, category } = o;
  const base = category === null ? opacText(locale, 'pages.news.title') : `${opacText(locale, 'pages.news.title')}: ${categoryText(locale, category)}`;
  const title = news.page <= 1 ? base : `${base}, ${opacText(locale, 'pages.news.page_of', { page: news.page, pages: news.pages }).toLowerCase()}`;
  const aside = o.events.length > 0 || o.hours.length > 0;
  return {
    title,
    description: opacText(locale, 'pages.news.description', { library: o.libraryName }),
    body: (
      <div class={aside ? 'newslist' : 'newslist newslist-1'}>
        <section aria-label={opacText(locale, 'pages.news.list')}>
          <nav class="texttabs" aria-label={opacText(locale, 'pages.news.tabs')}>
            <a href={keep(newsListPath(1), lang)} aria-current={category === null ? 'true' : undefined}>
              {opacText(locale, 'pages.news.all')}
            </a>
            {NEWS_CATEGORIES.map((c) => (
              <a href={keep(newsListPath(1, c), lang)} aria-current={category === c ? 'true' : undefined}>
                {categoryText(locale, c)}
              </a>
            ))}
            <a class="news-feed" href={keep('/berita/rss', lang)} type="application/rss+xml">
              {opacText(locale, 'pages.news.feed')}
            </a>
          </nav>
          {news.items.length === 0 ? (
            <p>{opacText(locale, category === null ? 'pages.news.empty' : 'pages.news.empty_category')}</p>
          ) : (
            <NewsRows items={news.items} locale={locale} lang={lang} timeZone={o.timeZone} heading="h2" />
          )}
          {news.pages <= 1 ? null : (
            <nav class="news-pager" aria-label={opacText(locale, 'pages.news.pager')}>
              {news.page > 1 ? (
                <a class="btn btn-outline btn-sm" href={keep(newsListPath(news.page - 1, category), lang)} rel="prev">
                  {opacText(locale, 'pages.news.newer')}
                </a>
              ) : (
                <span></span>
              )}
              <span>{opacText(locale, 'pages.news.page_of', { page: news.page, pages: news.pages })}</span>
              {news.page < news.pages ? (
                <a class="btn btn-outline btn-sm" href={keep(newsListPath(news.page + 1, category), lang)} rel="next">
                  {opacText(locale, 'pages.news.older')}
                </a>
              ) : (
                <span></span>
              )}
            </nav>
          )}
        </section>
        {!aside ? null : (
          <aside class="box-stack">
            {o.events.length === 0 ? null : (
              <div class="box">
                <h2 id="agenda-terdekat">{opacText(locale, 'pages.news.agenda')}</h2>
                <Agenda events={o.events} locale={locale} lang={lang} timeZone={o.timeZone} />
              </div>
            )}
            {o.hours.length === 0 ? null : (
              <div class="box">
                <h2 id="jam-buka">{opacText(locale, 'pages.news.hours')}</h2>
                <HoursTable hours={o.hours} weekday={o.weekday} locale={locale} contentLang={o.contentLang} labelledBy="jam-buka" />
              </div>
            )}
          </aside>
        )}
      </div>
    ),
  };
}
