import type { DbHandle } from '@altis/db';
import { isUlid, t, type AttachmentMedia, type Locale } from '@altis/shared';
import { isHttpUrl, URL_MAX } from '@altis/shared/api/catalog/common';
import { opacText } from './messages.js';

// The attachment viewer of the OPAC (Phase 2 Task 34; spec §9.8, §8), the body of `/katalog/:id/lampiran/:aid`:
//
//   PDF          "Buka PDF" (a new tab with the browser's own viewer; pdf.js waits for the owner, P1) and "Unduh"
//   audio/video  <audio>/<video controls> on /files/<id> (which answers ranges, so a player can seek)
//   image        <img> and a link to the full-size file
//   URL          a notice that the visitor is leaving the site, then the link (`rel="noopener nofollow"`)
//   other        a download link
//
// Only a public, live attachment of the record is shown, a file one only while its stored file is `ok` (else 404). A
// URL is linked only when it is http(s) and at most 2000 characters, checked again here (S4): anything else is a 404,
// never a link. The file itself is served by `/files/:id` with its own headers (CSP `default-src 'none'; sandbox`,
// nosniff); M10's check that Chromium's viewer still renders such a PDF in a new tab is tools/e2e/specs/opac-pdf.spec.ts.

type Db = DbHandle['db'];

/** A public attachment as the viewer shows it. */
export interface ViewerAttachment {
  id: string;
  recordId: string;
  title: string;
  description: string | null;
  media: AttachmentMedia;
  /** A file attachment's stored file. */
  file: { id: string; name: string; mime: string; size: number } | null;
  /** A URL attachment's link (http(s), checked). */
  url: string | null;
}

/** Whether `url` may become a link (S4): http(s), a host, no whitespace or control character, at most 2000 characters. */
export function linkableUrl(url: string | null): url is string {
  return url !== null && url.length <= URL_MAX && isHttpUrl(url);
}

/** What a viewer shows for an attachment of `kind` whose file has `mime` (the search facet's families, §4.6 `at`). */
export function attachmentMedia(kind: string, mime: string | null): AttachmentMedia {
  if (kind === 'url') return 'url';
  const m = (mime ?? '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  return 'other';
}

/**
 * The attachment `aid` of record `recordId` when the OPAC may show it: public, not archived, a file attachment with
 * its file stored (`ok`) and public, a URL attachment with a linkable URL; null otherwise (the viewer's 404).
 */
export async function viewerAttachment(db: Db, recordId: string, aid: string): Promise<ViewerAttachment | null> {
  if (!isUlid(aid)) return null;
  const a = await db
    .selectFrom('attachments as a')
    .leftJoin('files as f', 'f.id', 'a.file_id')
    .select(['a.id', 'a.record_id', 'a.kind', 'a.url', 'a.title', 'a.description', 'f.id as file_id', 'f.original_name', 'f.mime', 'f.size', 'f.status', 'f.access as file_access'])
    .where('a.id', '=', aid)
    .where('a.record_id', '=', recordId)
    .where('a.access', '=', 'public')
    .where('a.archived_at', 'is', null)
    .executeTakeFirst();
  if (a === undefined) return null;
  const base = { id: a.id, recordId: a.record_id, title: a.title, description: a.description };
  if (a.kind === 'url') return linkableUrl(a.url) ? { ...base, media: 'url', file: null, url: a.url } : null;
  if (a.kind !== 'file' || a.file_id === null || a.status !== 'ok' || a.file_access !== 'public') return null;
  const mime = a.mime ?? 'application/octet-stream';
  return {
    ...base,
    media: attachmentMedia('file', mime),
    file: { id: a.file_id, name: a.original_name ?? 'berkas', mime, size: Number(a.size ?? 0) },
    url: null,
  };
}

/** `bytes` as a short size in the page's language ("2,3 MB" / "2.3 MB"). */
export function sizeText(bytes: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-GB', { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** The host a URL leads to, for the notice ("Lanjutkan ke penerbit.example"). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The path of a file (`/files/<id>`). */
const filePath = (id: string): string => `/files/${encodeURIComponent(id)}`;

function DownloadLink(props: { file: NonNullable<ViewerAttachment['file']>; locale: Locale; withSize?: boolean }) {
  const { file, locale } = props;
  return (
    <a class="button" href={filePath(file.id)} download={file.name}>
      {props.withSize === true ? opacText(locale, 'detail.viewer.download_size', { size: sizeText(file.size, locale) }) : opacText(locale, 'detail.viewer.download')}
    </a>
  );
}

/** What the viewer shows for `a` (see the top of this file). */
function ViewerContent(props: { a: ViewerAttachment; locale: Locale; libraryName: string }) {
  const { a, locale } = props;
  if (a.media === 'url' && a.url !== null) {
    return (
      <div class="leaving" role="note">
        <h2>{opacText(locale, 'detail.viewer.leaving_title')}</h2>
        <p>{opacText(locale, 'detail.viewer.leaving_body', { library: props.libraryName })}</p>
        <p class="viewer-url">{a.url}</p>
        <p>
          <a href={a.url} rel="noopener nofollow">
            {opacText(locale, 'detail.viewer.leaving_go', { host: hostOf(a.url) })}
          </a>
        </p>
      </div>
    );
  }
  const file = a.file;
  if (file === null) return null;
  const src = filePath(file.id);
  switch (a.media) {
    case 'pdf':
      return (
        <>
          <p class="viewer-actions">
            <a class="button button-primary" href={src} target="_blank" rel="noopener">
              {opacText(locale, 'detail.viewer.pdf_open')}
            </a>
            <DownloadLink file={file} locale={locale} />
          </p>
          <p class="viewer-hint">{opacText(locale, 'detail.viewer.pdf_hint')}</p>
        </>
      );
    case 'audio':
      return (
        <>
          <audio class="viewer-media" controls preload="metadata" src={src}>
            {opacText(locale, 'detail.viewer.media_fallback')}
          </audio>
          <p class="viewer-actions">
            <DownloadLink file={file} locale={locale} withSize />
          </p>
        </>
      );
    case 'video':
      return (
        <>
          <video class="viewer-media" controls preload="metadata" src={src}>
            {opacText(locale, 'detail.viewer.media_fallback')}
          </video>
          <p class="viewer-actions">
            <DownloadLink file={file} locale={locale} withSize />
          </p>
        </>
      );
    case 'image':
      return (
        <figure class="viewer-image">
          <img src={src} alt={a.title} decoding="async" />
          <figcaption>
            <a href={src}>{opacText(locale, 'detail.viewer.image_full')}</a>
          </figcaption>
        </figure>
      );
    default:
      return (
        <>
          <p>{opacText(locale, 'detail.viewer.other')}</p>
          <p class="viewer-actions">
            <DownloadLink file={file} locale={locale} withSize />
          </p>
        </>
      );
  }
}

/** The viewer page's content: back to the record, the attachment's title, kind and description, then what it shows. */
export function AttachmentViewer(props: { a: ViewerAttachment; recordTitle: string; recordHref: string; locale: Locale; libraryName: string }) {
  const { a, locale } = props;
  return (
    <article class="viewer">
      <p class="viewer-back">
        <a href={props.recordHref}>{opacText(locale, 'detail.viewer.back', { title: props.recordTitle })}</a>
      </p>
      <h1>{a.title}</h1>
      <p class="viewer-kind">{t(locale, `vocab.attachment_media.${a.media}`)}</p>
      {a.description === null || a.description.trim() === '' ? null : <p class="record-text">{a.description}</p>}
      <ViewerContent a={a} locale={locale} libraryName={props.libraryName} />
    </article>
  );
}
