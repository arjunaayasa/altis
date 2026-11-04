import { formatCitation, recordSlug, type CitationPart, type CitationStyle } from '@altis/core';
import type { Locale } from '@altis/shared';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { opacText } from './messages.js';
import { withLang } from './urls.js';

// The citations of the OPAC record detail (Phase 2 Task 34; spec §9.3): inside a <details>, the record cited in APA 7,
// MLA 9 and Chicago author-date (Task 22's `formatCitation`: the connectors follow the page's language, `dkk.`/`et al.`,
// `dan`/`and`), then the downloads for a reference manager (RIS, BibTeX) and the MARCXML record. A citation is text:
// its parts go through JSX, which escapes them, a title in <em>. The download links are `nofollow`: a crawler has the
// page itself, its Dublin Core and its JSON-LD.

/** The styles, in the order shown. */
const STYLES: readonly CitationStyle[] = ['apa', 'mla', 'chicago'];

/** The downloads of a record (`/katalog/:id/<kind>`), in the order shown. */
export const DOWNLOAD_KINDS = ['ris', 'bibtex', 'marcxml'] as const;

export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

/**
 * The path of the download `kind` of the record `id` titled `title`: `/katalog/<id>/<kind>`, with `?unduh=1` when the
 * record's own slug is `kind` (a record titled "RIS" has its page at `/katalog/<id>/ris`; the route then serves the
 * file only when asked so).
 */
export function downloadPath(id: string, title: string, kind: DownloadKind): string {
  const path = `/katalog/${encodeURIComponent(id)}/${kind}`;
  return slugIsDownload(title, kind) ? `${path}?${DOWNLOAD_QUERY}` : path;
}

/** What asks a download route for the file when the record's slug is the download's name. */
export const DOWNLOAD_QUERY = 'unduh=1';

/** Whether the canonical page of a record titled `title` is the path of its download `kind`. */
export function slugIsDownload(title: string, kind: DownloadKind): boolean {
  return recordSlug(title) === kind;
}

function Citation(props: { parts: readonly CitationPart[] }) {
  return <>{props.parts.map((p) => (p.em === true ? <em>{p.text}</em> : p.text))}</>;
}

/** The citations section (see the top of this file); `lang` is the language the request named, kept on the links. */
export function CitationsSection(props: { data: RecordData; locale: Locale; lang: Locale | null }) {
  const { data, locale, lang } = props;
  const keep = (path: string): string => (lang === null ? path : withLang(path, lang));
  return (
    <section class="record-section" aria-labelledby="kutip">
      <details class="citations">
        <summary>
          <h2 id="kutip">{opacText(locale, 'detail.cite')}</h2>
        </summary>
        <dl class="citation-list">
          {STYLES.map((style) => (
            <>
              <dt>{opacText(locale, `detail.cite.${style}`)}</dt>
              <dd class="citation">
                <Citation parts={formatCitation(data, style, locale)} />
              </dd>
            </>
          ))}
        </dl>
        <p class="downloads">{opacText(locale, 'detail.cite.downloads')}</p>
        <ul class="download-list">
          {DOWNLOAD_KINDS.map((kind) => (
            <li>
              <a href={keep(downloadPath(data.id, data.title, kind))} rel="nofollow">
                {opacText(locale, `detail.download.${kind}`)}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
