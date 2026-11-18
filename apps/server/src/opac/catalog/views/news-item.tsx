import type { OpacPublishedPage } from '@altis/core';
import type { Locale } from '@altis/shared';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { opacText } from '../messages.js';
import { categoryText, eventTimeText } from '../site-blocks.js';
import { FallbackNote, PageArticle, formatDate, keepLang, metaDescription, shownText } from './page.js';

// The view of one news post, `/berita/<slug>`: the post with its kind and publication date (in the library's time
// zone), its summary as a lead, its cover, the event it announces (when and where, when the post has one) and its
// body, then a link back to the list.

/** The content of `/berita/<slug>` in `locale`; `lang` is the language the request named (kept in the back link). */
export function newsItemView(o: { locale: Locale; lang: Locale | null; post: OpacPublishedPage; timeZone: string }): {
  title: string;
  description: string;
  body: JSX.Element;
} {
  const { locale, post } = o;
  const { text, lang } = shownText(post.translations, locale);
  const date = formatDate(locale, post.publishedAt, o.timeZone);
  const place = post.eventPlace === null || post.eventPlace.trim() === '' ? null : post.eventPlace;
  const event =
    post.eventStartsAt === null ? null : (
      <div class="eventbox" role="group" aria-label={opacText(locale, 'pages.event.label')}>
        <dl class="kv">
          <dt>{opacText(locale, 'pages.event.when')}</dt>
          <dd>
            <time datetime={new Date(post.eventStartsAt).toISOString()}>{eventTimeText(locale, post.eventStartsAt, post.eventEndsAt, o.timeZone)}</time>
          </dd>
          {place === null ? null : (
            <>
              <dt>{opacText(locale, 'pages.event.where')}</dt>
              <dd>{place}</dd>
            </>
          )}
        </dl>
      </div>
    );
  return {
    title: text.title,
    description: metaDescription(text.summary ?? text.title),
    body: (
      <div class="article">
        <FallbackNote locale={locale} lang={lang} />
        <PageArticle
          locale={locale}
          text={text}
          lang={lang}
          coverFileId={post.coverFileId}
          dateline={{ ms: post.publishedAt, text: opacText(locale, 'pages.news.published', { date }) }}
          category={post.category === null ? null : categoryText(locale, post.category)}
          event={event}
          lead
        />
        <p class="page-back">
          <a href={keepLang('/berita', o.lang)}>{opacText(locale, 'pages.news.back')} →</a>
        </p>
      </div>
    ),
  };
}
