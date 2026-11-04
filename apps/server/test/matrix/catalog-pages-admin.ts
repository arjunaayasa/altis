import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the admin API of Halaman & Berita (Phase 2 Task 20; the plan's
// route catalog): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the
// same order. Every route is `deny` in maintenance, so there is no maintenance entry.
//
// The fixtures seed what a call needs straight into the tables (a page with its Indonesian translation), each call its
// own, and a create names a slug of its own, so that a super admin's call succeeds (audit once) whatever the personas
// before it did.

/** A slug no other call uses. */
const slug = (): string => `matriks-${newId().slice(-12).toLowerCase()}`;

/** A published page of its own (version 0) with its Indonesian translation. */
async function seedPage(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('pages')
    .values({
      id,
      kind: 'page',
      slug_key: slug(),
      status: 'published',
      published_at: s.now,
      show_in_nav: 0,
      cover_file_id: null,
      sort_order: 0,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  await s.h.db
    .insertInto('page_translations')
    .values({ page_id: id, locale: 'id', title: 'Halaman Matriks', summary: null, body_format: 'markdown', body: 'Isi halaman matriks.', updated_at: s.now })
    .execute();
  return id;
}

const onPage = (body?: Record<string, unknown>): MatrixFixture => async (s) => ({ params: { id: await seedPage(s) }, ...(body === undefined ? {} : { body }) });

const PG = 'P:opac.pages.manage | - | -';

export const MATRIX: AreaMatrix = {
  rows: {
    'opac.pages.list': `GET /api/v1/opac/pages | ${PG} | read | deny | none | null | - | -`,
    'opac.pages.get': `GET /api/v1/opac/pages/:id | ${PG} | read | deny | none | null | - | -`,
    'opac.pages.create': `POST /api/v1/opac/pages | ${PG} | write | deny | store | opac.page.create | handler | -`,
    'opac.pages.update': `PATCH /api/v1/opac/pages/:id | ${PG} | write | deny | store | opac.page.update | handler | -`,
    'opac.pages.archive': `DELETE /api/v1/opac/pages/:id | ${PG} | write | deny | store | opac.page.archive | handler | -`,
    'opac.pages.preview': `POST /api/v1/opac/pages/preview | ${PG} | read | deny | none | null | handler | -`,
  },
  fixtures: {
    'opac.pages.list': async () => ({ query: { kind: 'page' } }),
    'opac.pages.get': onPage(),
    'opac.pages.create': async () => ({
      body: {
        kind: 'news',
        slug: slug(),
        status: 'published',
        showInNav: false,
        sortOrder: 0,
        translations: { id: { title: 'Berita Matriks', bodyFormat: 'markdown', body: 'Isi berita matriks.' } },
      },
    }),
    'opac.pages.update': onPage({ version: 0, showInNav: true }),
    'opac.pages.archive': onPage({ version: 0 }),
    'opac.pages.preview': async () => ({ body: { bodyFormat: 'markdown', body: '**Pratinjau** matriks' } }),
  },
  maintenance: {},
};
