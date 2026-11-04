import { archivePage, createPage, getPage, listPages, previewBody, updatePage } from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField, versionField } from '@altis/shared/api/common';
import { PageBody, PageListQuery, PagePatchBody, PagePreviewBody, type PagePreviewResponse } from '@altis/shared/api/opac-pages';
import { z } from 'zod';
import type { RouteDecl } from '../../http/route.js';
import { route } from '../../http/route.js';

// The admin API of Halaman & Berita (Phase 2 spec §9.5, §12.2; plan Task 20, route catalog): `GET opac/pages?kind=`,
// `GET opac/pages/:id`, `POST opac/pages`, `PATCH opac/pages/:id`, `DELETE opac/pages/:id` (archive) and `POST
// opac/pages/preview`. 6 routes, all `opac.pages.manage` (pages are global: no branch).
//
// - The writes are `store` routes and answer `StoreResponse` (`{id, version}`), never the page (S15): a PageView with
//   two 60 KB bodies would pass the 60 000-byte stored-response limit. A create answers 201, as every create of the
//   codebase does; the editor reads the page again with GET. Archive takes the page's `version` in its body.
// - The services (core opac-pages) audit once in the handler's transaction (`opac.page.create|update|archive`).
// - The preview is a read (`mode: read`, `idempotency: none`, no audit): the body rendered and sanitized exactly as the
//   OPAC shows it, which the editor puts in `<iframe sandbox="" srcDoc>` (S6). The `/preview` path never meets
//   `/:id`, which is not a POST.

const PAGES = '/api/v1/opac/pages';
const IdParams = z.strictObject({ id: ulidField });
/** The body of an archive: the page's version. */
const VersionBody = z.strictObject({ version: versionField });

/** A store route's answer: the id and the new version. */
const storeResponse = (id: string, version: number): StoreResponse => ({ id, version });

const pagesList = route({
  id: 'opac.pages.list',
  method: 'GET',
  path: PAGES,
  permission: 'opac.pages.manage',
  idempotency: 'none',
  audit: null,
  query: PageListQuery,
  handler: async (rc) => ({ body: await listPages(rc.db.db, rc.query) }),
});

const pagesGet = route({
  id: 'opac.pages.get',
  method: 'GET',
  path: `${PAGES}/:id`,
  permission: 'opac.pages.manage',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await getPage(rc.db.db, rc.params.id) }),
});

const pagesCreate = route({
  id: 'opac.pages.create',
  method: 'POST',
  path: PAGES,
  permission: 'opac.pages.manage',
  idempotency: 'store',
  audit: 'opac.page.create',
  body: PageBody,
  handler: async (rc) => {
    const view = await createPage(rc.tx(), rc.body);
    return { status: 201, body: storeResponse(view.id, view.version) };
  },
});

const pagesUpdate = route({
  id: 'opac.pages.update',
  method: 'PATCH',
  path: `${PAGES}/:id`,
  permission: 'opac.pages.manage',
  idempotency: 'store',
  audit: 'opac.page.update',
  params: IdParams,
  body: PagePatchBody,
  handler: async (rc) => {
    const view = await updatePage(rc.tx(), rc.params.id, rc.body);
    return { body: storeResponse(view.id, view.version) };
  },
});

const pagesArchive = route({
  id: 'opac.pages.archive',
  method: 'DELETE',
  path: `${PAGES}/:id`,
  permission: 'opac.pages.manage',
  idempotency: 'store',
  audit: 'opac.page.archive',
  params: IdParams,
  body: VersionBody,
  handler: async (rc) => {
    const out = await archivePage(rc.tx(), rc.params.id, rc.body.version);
    return { body: storeResponse(out.id, out.version) };
  },
});

const pagesPreview = route({
  id: 'opac.pages.preview',
  method: 'POST',
  path: `${PAGES}/preview`,
  permission: 'opac.pages.manage',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  body: PagePreviewBody,
  handler: async (rc) => {
    const body: PagePreviewResponse = { html: previewBody(rc.body.bodyFormat, rc.body.body) };
    return { body };
  },
});

export const PAGES_API_ROUTES: RouteDecl[] = [pagesList, pagesGet, pagesCreate, pagesUpdate, pagesArchive, pagesPreview];
