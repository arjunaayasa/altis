import { renderMarkdown, sanitizedHtml, type OpacPageTranslation, type OpacPublishedPage } from '@altis/core';
import type { Locale } from '@altis/shared';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { opacText } from '../messages.js';
import { safeHtml } from '../page.js';
import { withLang } from '../urls.js';

// The views of Halaman & Berita (Phase 2 Task 20; spec §9.1, §9.5): a static page (`/halaman/<slug>`) here, with what
// the news list and the news post share. Every text is JSX text (escaped) or a message; a body reaches the page only
// rendered and sanitized again (S6): `safeHtml(sanitizedHtml(stored))` for HTML, `safeHtml(renderMarkdown(stored))` for
// Markdown, whatever the stored body is (the service stores HTML sanitized, but a body may have been written around it).
//
// Languages (§9.5): a page shows its English translation on an English page; without one it shows the Indonesian text,
// marked `lang="id"` (the content's language, for screen readers and search engines), with a note in English above it.

/** The text a page shows in `locale`: its own translation, or the Indonesian one (`lang: 'id'`) when it has none. */
export function shownText<T>(translations: { id: T; en: T | null }, locale: Locale): { text: T; lang: 'id' | null } {
  if (locale === 'en') return translations.en === null ? { text: translations.id, lang: 'id' } : { text: translations.en, lang: null };
  return { text: translations.id, lang: null };
}

/** `path` with the language the request named (`?lang=`) kept, so that a visitor stays in the language chosen. */
export function keepLang(path: string, lang: Locale | null): string {
  return lang === null ? path : withLang(path, lang);
}

/** A day as a reader writes it (`20 Oktober 2026`, `20 October 2026`) in the library's time zone (UTC if unknown). */
export function formatDate(locale: Locale, ms: number, timeZone: string): string {
  const tag = locale === 'id' ? 'id-ID' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: 'UTC' }).format(ms);
  }
}

/** The longest meta description, in characters (code points). */
const DESCRIPTION_MAX = 160;

/** `text` as a meta description: spaces collapsed, at most {@link DESCRIPTION_MAX} characters (`…` when cut). */
export function metaDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= DESCRIPTION_MAX ? flat : `${chars.slice(0, DESCRIPTION_MAX - 1).join('').trimEnd()}…`;
}

/** The note above Indonesian content on an English page. */
export function FallbackNote(props: { locale: Locale; lang: 'id' | null }): JSX.Element | null {
  return props.lang === null ? null : <p class="page-note">{opacText(props.locale, 'pages.fallback')}</p>;
}

/** The publication line of a news post. */
export interface Dateline {
  ms: number;
  text: string;
}

/**
 * One page or news post: its title, its date (news), its cover, its summary as a lead (news) and its body. `lang` marks
 * content that is not in the page's language (`locale`), and the date line, written in the page's language, is then
 * marked back.
 */
export function PageArticle(props: {
  locale: Locale;
  text: OpacPageTranslation;
  lang: 'id' | null;
  coverFileId: string | null;
  dateline?: Dateline | null;
  lead?: boolean;
}): JSX.Element {
  const { text, lang, coverFileId, dateline } = props;
  return (
    <article class="page-article" lang={lang ?? undefined}>
      <h1>{text.title}</h1>
      {dateline === undefined || dateline === null ? null : (
        <p class="page-meta" lang={lang === null ? undefined : props.locale}>
          <time datetime={new Date(dateline.ms).toISOString()}>{dateline.text}</time>
        </p>
      )}
      {coverFileId === null ? null : <img class="page-cover" src={`/files/${encodeURIComponent(coverFileId)}`} alt="" decoding="async" />}
      {props.lead === true && text.summary !== null && text.summary.trim() !== '' ? <p class="page-lead">{text.summary}</p> : null}
      <div class="page-body">{safeHtml(text.bodyFormat === 'html' ? sanitizedHtml(text.body) : renderMarkdown(text.body))}</div>
    </article>
  );
}

/** The content of `/halaman/<slug>` in `locale`. */
export function pageView(o: { locale: Locale; page: OpacPublishedPage }): { title: string; description: string; body: JSX.Element } {
  const { text, lang } = shownText(o.page.translations, o.locale);
  return {
    title: text.title,
    description: metaDescription(text.summary ?? text.title),
    body: (
      <>
        <FallbackNote locale={o.locale} lang={lang} />
        <PageArticle locale={o.locale} text={text} lang={lang} coverFileId={o.page.coverFileId} />
      </>
    ),
  };
}
