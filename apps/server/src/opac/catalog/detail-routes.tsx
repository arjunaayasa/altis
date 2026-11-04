import {
  MARCXML_COLLECTION_OPEN,
  incrementReadCount,
  loadCustomDefs,
  loadRecordData,
  recordSlug,
  recordToMarc,
  recordUrlPath,
  toBibtex,
  toRis,
  writeMarcXmlRecord,
} from '@altis/core';
import { isUlid, resolveLocale, t, type Locale } from '@altis/shared';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { AttachmentViewer, viewerAttachment } from './attachment-viewer.js';
import { loadAvailability } from './availability.js';
import { downloadPath, slugIsDownload, type DownloadKind } from './citations-view.js';
import { cutDescription, displayTitle, recordPageOptions, renderOptions, viewerPath } from './detail-view.js';
import { opacContext, opacPage, requestLang } from './page.js';
import { redirect301 } from './respond.js';
import { withLang } from './urls.js';

// The OPAC routes of the record detail (Phase 2 Task 34; spec §9.1, §9.3, §9.4, §9.8, §8), in this order (Hono tries
// the routes in the order they are declared, so the fixed segments come before `/katalog/:id/:slug`):
//
//   GET /katalog/:id/ris            opac.record.ris         RIS, as a download
//   GET /katalog/:id/bibtex         opac.record.bibtex      BibTeX, as a download
//   GET /katalog/:id/marcxml        opac.record.marcxml     MARCXML for the public (S5), as a download
//   GET /katalog/:id/lampiran/:aid  opac.record.attachment  the attachment viewer (noindex; counts one read)
//   GET /katalog/:id                opac.record             301 to the canonical URL
//   GET /katalog/:id/:slug          opac.record.slug        the detail page (a wrong slug: 301 to the canonical URL)
//
// Like every OPAC route (§9.1): public, `session: 'none'` (no cookie read), mode read, `maintenance: allow`,
// `idempotency: none`, `audit: null`, no `query` or `params` schema (values are checked by hand; only `lang` is read).
//
// Every route first finds the record's state (recordState):
// - public (visible, not archived, not merged): served;
// - merged: one 301 to the live record it was merged into, the same page or download of it (P2-20: chains are
//   flattened at merge time; a chain that was not is still followed here, at most 8 links, to one redirect);
// - anything else (hidden, archived, unknown, an id that is not a ULID, a merge target that is not public): the OPAC
//   404 page (S17), an HTML page with the frame, never a thrown NOT_FOUND.
//
// A record whose slug is a download's name (a title "RIS" gives `/katalog/<id>/ris`) keeps its page at its canonical
// URL: that download route serves the page, and the file only with `?unduh=1`, which its page's own link carries. Once
// such a record is merged, that URL leads to the live record's page (and with `?unduh=1` to its download).
//
// Downloads carry no acquisition data: the record is a public load (no item price, supplier, order or invoice), and
// MARCXML is `recordToMarc(…, {audience: 'public'})`, which drops the marcExtra denylist (541, 561, 583, 59X, 852,
// 876-878, 9XX; S5) and writes no 852 of the items. The read count of an attachment rises after the viewer page's
// response (`afterResponse`, best effort), not per request of its file (a player's Range requests), not for a HEAD,
// and not during maintenance (§8).

/** The declaration fields every route of this file shares. */
const OPAC = { method: 'GET', public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null } as const;

type Rc = RouteContext<unknown, unknown, Record<string, string>>;

/** How far a merge chain is followed (they are flattened at merge time; this only bounds a damaged one). */
const MERGE_HOPS_MAX = 8;

/** What a record id names on the OPAC (`sourceTitle`: the title of the merged record the request named). */
type RecordState =
  | { kind: 'public'; id: string; title: string }
  | { kind: 'merged'; id: string; title: string; sourceTitle: string }
  | { kind: 'missing' };

const MISSING: RecordState = Object.freeze({ kind: 'missing' });

/** The record `id` (see the top of this file): public, merged into a public record (`id` is then the target's), or missing. */
async function recordState(rc: Rc, id: string): Promise<RecordState> {
  if (!isUlid(id)) return MISSING;
  const read = (rid: string) =>
    rc.db.db.selectFrom('records').select(['id', 'title', 'opac_visible', 'archived_at', 'merged_into']).where('id', '=', rid).executeTakeFirst();
  let row = await read(id);
  if (row === undefined) return MISSING;
  const sourceTitle = row.title;
  const merged = row.merged_into !== null;
  const seen = new Set<string>([row.id]);
  for (let hop = 0; row.merged_into !== null; hop += 1) {
    if (hop === MERGE_HOPS_MAX || seen.has(row.merged_into)) return MISSING;
    seen.add(row.merged_into);
    row = await read(row.merged_into);
    if (row === undefined) return MISSING;
  }
  if (Number(row.opac_visible) !== 1 || row.archived_at !== null) return MISSING;
  return merged ? { kind: 'merged', id: row.id, title: row.title, sourceTitle } : { kind: 'public', id: row.id, title: row.title };
}

/** `path` with the request's `?lang=` when it named one. */
function keepLang(rc: Rc, path: string): string {
  const lang = requestLang(rc.c);
  return lang === null ? path : withLang(path, lang);
}

/** The OPAC 404 page (S17). */
async function notFoundPage(rc: Rc): Promise<Response> {
  const ctx = await opacContext(rc);
  const title = t(ctx.locale, 'opac.not_found.title');
  const body = t(ctx.locale, 'opac.not_found.body');
  return opacPage(rc, ctx, {
    status: 404,
    title,
    description: body,
    robots: 'noindex',
    canonicalPath: null,
    body: () => (
      <>
        <h1>{title}</h1>
        <p>{body}</p>
      </>
    ),
  });
}

/** The public load of record `id` (with its items for the page), or undefined when it is gone since recordState. */
async function publicRecord(rc: Rc, id: string, includeItems: boolean): Promise<RecordData | undefined> {
  const d = (await loadRecordData(rc.db.db, [id], { publicOnly: true, includeItems })).get(id);
  return d === undefined || !d.opacVisible || d.archived || d.mergedInto !== null ? undefined : d;
}

/** The record's cover when it is a stored, public file; null otherwise (the page then shows the type's icon). */
async function publicCover(rc: Rc, fileId: string | null): Promise<string | null> {
  if (fileId === null) return null;
  const f = await rc.db.db.selectFrom('files').select('id').where('id', '=', fileId).where('status', '=', 'ok').where('access', '=', 'public').executeTakeFirst();
  return f === undefined ? null : f.id;
}

// ---- the detail page ---------------------------------------------------------------------------------------------------

/** `/katalog/:id` (`slug` null) and `/katalog/:id/:slug`. */
async function recordPage(rc: Rc, slug: string | null): Promise<Response> {
  const state = await recordState(rc, rc.params['id'] ?? '');
  if (state.kind === 'missing') return notFoundPage(rc);
  const canonical = recordUrlPath(state.id, state.title);
  if (state.kind === 'merged' || slug !== recordSlug(state.title)) return redirect301(rc.c, keepLang(rc, canonical));
  const d = await publicRecord(rc, state.id, true);
  if (d === undefined) return notFoundPage(rc);
  const ctx = await opacContext(rc);
  const handle = rc.db.db;
  const showShelfMap = await rc.services.settings.get<boolean>(handle, 'opac.showShelfMap');
  const [coverFileId, availability, customDefs] = await Promise.all([
    publicCover(rc, d.coverFileId),
    loadAvailability(handle, d, { showShelfMap: showShelfMap !== false, dataDir: () => rc.services.dataDir }),
    d.customPublic.length === 0 ? Promise.resolve([]) : loadCustomDefs(handle, 'records'),
  ]);
  return opacPage(rc, ctx, recordPageOptions(ctx, d, { coverFileId, availability, customDefs }, requestLang(rc.c)));
}

const record = route<unknown, unknown, Record<string, string>>({
  ...OPAC,
  id: 'opac.record',
  path: '/katalog/:id',
  handler: (rc) => recordPage(rc, null),
});

const recordWithSlug = route<unknown, unknown, Record<string, string>>({
  ...OPAC,
  id: 'opac.record.slug',
  path: '/katalog/:id/:slug',
  handler: (rc) => recordPage(rc, rc.params['slug'] ?? ''),
});

// ---- the downloads -------------------------------------------------------------------------------------------------------

/** The XML declaration of the MARCXML download (the first line of MARCXML_COLLECTION_OPEN). */
const XML_DECLARATION = `${MARCXML_COLLECTION_OPEN.split('\n')[0]!}\n`;

/** The page's language for a download (`?lang=`, else the library's): RIS names the language in it. */
async function downloadLocale(rc: Rc): Promise<Locale> {
  return resolveLocale(rc.c.req.query('lang'), await rc.services.settings.get<string>(rc.db.db, 'library.locale'));
}

/** The body, content type and file extension of `kind` for the public load `d`. */
async function downloadOf(rc: Rc, kind: DownloadKind, d: RecordData): Promise<{ body: string; type: string; ext: string }> {
  const o = renderOptions(rc.config.baseUrl, d, await downloadLocale(rc), await publicCover(rc, d.coverFileId));
  switch (kind) {
    case 'ris':
      return { body: toRis(d, o), type: 'application/x-research-info-systems; charset=utf-8', ext: 'ris' };
    case 'bibtex':
      return { body: toBibtex(d, o), type: 'application/x-bibtex; charset=utf-8', ext: 'bib' };
    case 'marcxml': {
      const orgCode = await rc.services.settings.get<string | null>(rc.db.db, 'catalog.marcOrgCode');
      const marc = recordToMarc(d, { audience: 'public', orgCode, baseUrl: rc.config.baseUrl, includeItems: false });
      return { body: `${XML_DECLARATION}${writeMarcXmlRecord(marc)}`, type: 'application/marcxml+xml; charset=utf-8', ext: 'xml' };
    }
  }
}

function downloadRoute(kind: DownloadKind): RouteDecl {
  return route<unknown, unknown, Record<string, string>>({
    ...OPAC,
    id: `opac.record.${kind}`,
    path: `/katalog/:id/${kind}`,
    handler: async (rc) => {
      const state = await recordState(rc, rc.params['id'] ?? '');
      if (state.kind === 'missing') return notFoundPage(rc);
      // A record titled "RIS" has its page here: the file only when the page's own link asks for it (`?unduh=1`).
      const asksPage = rc.c.req.query('unduh') !== '1';
      if (state.kind === 'merged') {
        // The old page of a merged record titled "RIS" leads to the live record's page, its download to the download.
        const to = asksPage && slugIsDownload(state.sourceTitle, kind) ? recordUrlPath(state.id, state.title) : downloadPath(state.id, state.title, kind);
        return redirect301(rc.c, keepLang(rc, to));
      }
      if (asksPage && slugIsDownload(state.title, kind)) return recordPage(rc, kind);
      const d = await publicRecord(rc, state.id, false);
      if (d === undefined) return notFoundPage(rc);
      const file = await downloadOf(rc, kind, d);
      return rc.c.body(file.body, 200, {
        'Content-Type': file.type,
        // The slug is a-z, 0-9 and hyphens only: a safe file name in a quoted string.
        'Content-Disposition': `attachment; filename="${recordSlug(d.title)}.${file.ext}"`,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      });
    },
  });
}

// ---- the attachment viewer -----------------------------------------------------------------------------------------------

const attachmentViewer = route<unknown, unknown, Record<string, string>>({
  ...OPAC,
  id: 'opac.record.attachment',
  path: '/katalog/:id/lampiran/:aid',
  handler: async (rc) => {
    const aid = rc.params['aid'] ?? '';
    const state = await recordState(rc, rc.params['id'] ?? '');
    if (state.kind === 'missing' || !isUlid(aid)) return notFoundPage(rc);
    if (state.kind === 'merged') return redirect301(rc.c, keepLang(rc, viewerPath(state.id, aid)));
    const a = await viewerAttachment(rc.db.db, state.id, aid);
    if (a === null) return notFoundPage(rc);
    const ctx = await opacContext(rc);
    const recordTitle = displayTitle({ title: state.title, subtitle: undefined });
    // §8: one read per view of the page, after its response; not for a HEAD, not during maintenance.
    if (rc.c.req.method !== 'HEAD' && (rc.services.opsFence?.maintenance() ?? null) === null) {
      const handle = rc.db;
      rc.afterResponse(() => incrementReadCount(handle, a.id));
    }
    return opacPage(rc, ctx, {
      title: `${a.title} · ${recordTitle}`,
      description: cutDescription(a.description?.trim() || `${a.title} · ${recordTitle}`),
      canonicalPath: viewerPath(state.id, a.id),
      robots: 'noindex',
      openGraph: false,
      body: () => (
        <AttachmentViewer a={a} recordTitle={recordTitle} recordHref={keepLang(rc, recordUrlPath(state.id, state.title))} locale={ctx.locale} libraryName={ctx.libraryName} />
      ),
    });
  },
});

/** The record detail's routes, in the order of the top of this file. */
export const OPAC_DETAIL_ROUTES: RouteDecl[] = [downloadRoute('ris'), downloadRoute('bibtex'), downloadRoute('marcxml'), attachmentViewer, record, recordWithSlug];
