import { XmlWriter } from '@altis/core';
import type { Locale } from '@altis/shared';

// The OPAC's catalogue feeds (Phase 2 Task 33; spec §9.1, §9.6): RSS 2.0 with `atom:link rel="self"`, written by our
// own XmlWriter (every text escaped, characters XML 1.0 forbids dropped). `/rss` carries the 50 newest public records
// (S14: read from search_doc), `/cari/rss` the top 50 of a search; an item's `pubDate` is the record's `created_at`.
// Every URL in a feed is absolute from config.baseUrl, never from the Host header; no personal data (a record's main
// agent is bibliographic data, never a staff member or a borrower).

/** Items per feed (§9.1). */
export const FEED_ITEMS = 50;

/** The `Cache-Control` of the feeds (§9.6): a reader polling every few minutes is answered from caches. */
export const FEED_CACHE = 'public, max-age=900';

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const ATOM = 'http://www.w3.org/2005/Atom';

/** A feed's channel. */
export interface FeedChannel {
  title: string;
  /** The absolute URL of the page the feed follows. */
  link: string;
  description: string;
  /** The absolute URL of the feed itself (`atom:link rel="self"`). */
  self: string;
  language: Locale;
}

/** One item of a feed. */
export interface FeedItem {
  title: string;
  /** The absolute URL of the record (also its `guid`). */
  link: string;
  /** Epoch ms. */
  pubDate: number;
  /** Plain text (main agent, year), or null for none. */
  description: string | null;
}

/** `ms` in the RFC 822 form RSS 2.0 wants (`Fri, 30 Oct 2026 09:15:05 GMT`). */
export function rfc822(ms: number): string {
  return new Date(ms).toUTCString();
}

/** The RSS 2.0 document of `channel` and `items`. */
export function rssXml(channel: FeedChannel, items: readonly FeedItem[]): string {
  const w = new XmlWriter().raw(DECLARATION).open('rss', { version: '2.0', 'xmlns:atom': ATOM }).open('channel');
  w.leaf('title', channel.title).leaf('link', channel.link).leaf('description', channel.description).leaf('language', channel.language);
  w.leaf('atom:link', '', { href: channel.self, rel: 'self', type: 'application/rss+xml' });
  for (const item of items) {
    w.open('item').leaf('title', item.title).leaf('link', item.link).leaf('guid', item.link, { isPermaLink: 'true' });
    w.leaf('pubDate', rfc822(item.pubDate));
    if (item.description !== null && item.description !== '') w.leaf('description', item.description);
    w.close();
  }
  return w.close().close().toString();
}
