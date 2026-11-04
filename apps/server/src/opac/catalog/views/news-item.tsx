import type { OpacPublishedPage } from '@altis/core';
import type { Locale } from '@altis/shared';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { opacText } from '../messages.js';
import { FallbackNote, PageArticle, formatDate, keepLang, metaDescription, shownText } from './page.js';

// The view of one news post, `/berita/<slug>` (Phase 2 Task 20; spec §9.1, §9.5): a link back to the list, then the
// post with its publication date (in the library's time zone), its cover, its summary as a lead and its body.

/** The content of `/berita/<slug>` in `locale`; `lang` is the language the request named (kept in the back link). */
export function newsItemView(o: { locale: Locale; lang: Locale | null; post: OpacPublishedPage; timeZone: string }): {
  title: string;
  description: string;
  body: JSX.Element;
} {
  const { text, lang } = shownText(o.post.translations, o.locale);
  const date = formatDate(o.locale, o.post.publishedAt, o.timeZone);
  return {
    title: text.title,
    description: metaDescription(text.summary ?? text.title),
    body: (
      <>
        <p class="page-back">
          <a href={keepLang('/berita', o.lang)}>{opacText(o.locale, 'pages.news.back')}</a>
        </p>
        <FallbackNote locale={o.locale} lang={lang} />
        <PageArticle
          locale={o.locale}
          text={text}
          lang={lang}
          coverFileId={o.post.coverFileId}
          dateline={{ ms: o.post.publishedAt, text: opacText(o.locale, 'pages.news.published', { date }) }}
          lead
        />
      </>
    ),
  };
}
