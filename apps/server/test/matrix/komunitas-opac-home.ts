import { readOpacHome } from '@altis/core';
import { newId } from '@altis/shared';
import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows and fixtures of the OPAC home page's admin API (screen OPAC › Halaman awal): one row per route id in
// the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Both routes are `deny` in
// maintenance, neither is `system`. A save names the revision stored when its call is made, and a heading of its own,
// so that a super admin's call succeeds (audit once) whatever the personas before it did.

const PG = 'P:opac.pages.manage | - | -';

/** A save of the stored content with a heading of its own, at the stored revision. */
const save: MatrixFixture = async (s) => {
  const state = await readOpacHome(s.h.db);
  return { body: { revision: state.revision, home: { ...state.home, title: `Matriks ${newId().slice(-8)}` }, welcome: state.welcome } };
};

export const MATRIX: AreaMatrix = {
  rows: {
    'opac.home.get': `GET /api/v1/opac/home | ${PG} | read | deny | none | null | - | -`,
    'opac.home.put': `PUT /api/v1/opac/home | ${PG} | write | deny | store | opac.home.update | handler | -`,
  },
  fixtures: {
    'opac.home.get': async () => ({}),
    'opac.home.put': save,
  },
  maintenance: {},
};
