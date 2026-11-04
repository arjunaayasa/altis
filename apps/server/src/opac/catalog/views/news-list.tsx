import type { OpacNewsPage } from '@altis/core';
import type { Locale } from '@altis/shared';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { opacText } from '../messages.js';
import { pagePath } from '../urls.js';
import { formatDate, keepLang, shownText } from './page.js';

// The view of the news list, `/berita` (Phase 2 Task 20; spec §9.1, §9.5): the posts of one page (10, newest first),
// each with its title as a link, its publication date and its summary; the feed link; and the links to the newer and
// older pages (`?hal=`), which keep the language the request named. Everything works without JavaScript.

/** `/berita` or `/berita?hal=<page>` (page 1 is `/berita` itself, its one address). */
export function newsListPath(page: number): string {
  return page <= 1 ? '/berita' : `/berita?hal=${page}`;
}

/** The content of one page of `/berita` in `locale`; `lang` is the language the request named (kept in every link). */
export function newsListView(o: { locale: Locale; lang: Locale | null; news: OpacNewsPage; timeZone: string; libraryName: string }): {
  title: string;
  description: string;
  body: JSX.Element;
} {
  const { locale, lang, news } = o;
  const title = news.page <= 1 ? opacText(locale, 'pages.news.title') : opacText(locale, 'pages.news.title_paged', { page: news.page });
  return {
    title,
    description: opacText(locale, 'pages.news.description', { library: o.libraryName }),
    body: (
      <>
        <h1>{title}</h1>
        <p class="news-feed">
          <a href={keepLang('/berita/rss', lang)} type="application/rss+xml">
            {opacText(locale, 'pages.news.feed')}
          </a>
        </p>
        {news.items.length === 0 ? (
          <p>{opacText(locale, 'pages.news.empty')}</p>
        ) : (
          <ol class="news-index">
            {news.items.map((item) => {
              const shown = shownText(item.translations, locale);
              return (
                <li>
                  <article lang={shown.lang ?? undefined}>
                    <h2>
                      <a href={keepLang(pagePath('news', item.slug), lang)}>{shown.text.title}</a>
                    </h2>
                    <p class="page-meta" lang={shown.lang === null ? undefined : locale}>
                      <time datetime={new Date(item.publishedAt).toISOString()}>{formatDate(locale, item.publishedAt, o.timeZone)}</time>
                    </p>
                    {shown.text.summary === null || shown.text.summary.trim() === '' ? null : <p>{shown.text.summary}</p>}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
        {news.pages <= 1 ? null : (
          <nav class="news-pager" aria-label={opacText(locale, 'pages.news.pager')}>
            {news.page > 1 ? (
              <a href={keepLang(newsListPath(news.page - 1), lang)} rel="prev">
                {opacText(locale, 'pages.news.newer')}
              </a>
            ) : (
              <span></span>
            )}
            <span>{opacText(locale, 'pages.news.page_of', { page: news.page, pages: news.pages })}</span>
            {news.page < news.pages ? (
              <a href={keepLang(newsListPath(news.page + 1), lang)} rel="next">
                {opacText(locale, 'pages.news.older')}
              </a>
            ) : (
              <span></span>
            )}
          </nav>
        )}
      </>
    ),
  };
}
