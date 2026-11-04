import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the locations and shelf maps (Phase 2 Task 14; the plan's
// route catalog): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the
// same order. Every route is `deny` in maintenance, so there is no maintenance entry. The writes are branch-scoped
// (`P:catalog.locations.manage@branchId`): the matrix personas hold their roles globally, so they pass at any branch;
// api-catalog-locations.test.ts checks a holder at branch A refused at branch B.
//
// Each call seeds a branch and the locations it needs of its own, so that a super admin's call succeeds (audit once)
// whatever the personas before it did. The branch is seeded here rather than with matrix-fixtures.ts's seedBranch: a
// value import of that file from an area file would close the import cycle at module load (see matrix/catalog.ts).

/** A non-default, active branch of its own; its id. */
async function seedBranch(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = `ML${id.slice(-12)}`;
  await s.h.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  return id;
}

/** A location of its own (version 0) in `branchId`: a room, or an area of `parentId`. */
async function seedLocation(s: MatrixSeed, branchId: string, o: { kind?: 'room' | 'area'; parentId?: string } = {}): Promise<string> {
  const id = newId();
  const code = `MX-${id.slice(-10)}`;
  await s.h.db
    .insertInto('locations')
    .values({
      id,
      branch_id: branchId,
      parent_id: o.parentId ?? null,
      kind: o.kind ?? 'room',
      code_display: code,
      code_key: normalizeKey(code),
      name: `Lokasi ${code}`,
      shelf_hint: null,
      class_from: null,
      class_to: null,
      map_file_id: null,
      map_x: null,
      map_y: null,
      map_w: null,
      map_h: null,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A room of its own in a branch of its own: the path parameters of a call on it. */
async function room(s: MatrixSeed): Promise<{ branchId: string; id: string }> {
  const branchId = await seedBranch(s);
  return { branchId, id: await seedLocation(s, branchId) };
}

const ROW = (method: string, path: string, audit: string): string =>
  `${method} ${path} | P:catalog.locations.manage@branchId | - | - | write | deny | store | ${audit} | handler | -`;

const fixtures: Record<string, MatrixFixture> = {
  'catalog.locations.list': async () => ({ query: { includeArchived: 'true' } }),
  'catalog.locations.create': async (s) => ({
    params: { branchId: await seedBranch(s) },
    body: { parentId: null, kind: 'room', code: 'LT-1', name: 'Lantai 1', isPublic: true, sortOrder: 0 },
  }),
  'catalog.locations.update': async (s) => ({ params: await room(s), body: { version: 0, name: 'Lantai Dua' } }),
  'catalog.locations.archive': async (s) => ({ params: await room(s), body: { version: 0 } }),
  'catalog.locations.map': async (s) => {
    const { branchId, id } = await room(s);
    const area = await seedLocation(s, branchId, { kind: 'area', parentId: id });
    return { params: { branchId, id: area }, body: { version: 0, box: { x: 100, y: 200, w: 300, h: 150 } } };
  },
};

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.locations.list': 'GET /api/v1/catalog/locations | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.locations.create': ROW('POST', '/api/v1/branches/:branchId/locations', 'catalog.master.create'),
    'catalog.locations.update': ROW('PATCH', '/api/v1/branches/:branchId/locations/:id', 'catalog.master.update'),
    'catalog.locations.archive': ROW('DELETE', '/api/v1/branches/:branchId/locations/:id', 'catalog.master.archive'),
    'catalog.locations.map': ROW('PUT', '/api/v1/branches/:branchId/locations/:id/map', 'catalog.master.update'),
  },
  fixtures,
  maintenance: {},
};
