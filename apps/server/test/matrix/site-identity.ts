import { readSiteIdentity } from '@altis/core';
import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows and fixtures of the site identity: the admin screen's two routes (`opac.pages.manage`, `deny` in
// maintenance), the public reading and the site icon (no session, open in maintenance as the sign-in and the pages
// that show them). A save names the revision stored when its call is made and a name of its own, so that a super
// admin's call succeeds (audit once) whatever the personas before it did.

const PG = 'P:opac.pages.manage | - | -';
const API = '/api/v1/site/identity';

const save: MatrixFixture = async (s) => {
  const state = await readSiteIdentity(s.h.db);
  return { body: { revision: state.revision, identity: { ...state.identity, name: `Matriks ${Date.now() % 100000}-${Math.random().toString(36).slice(2, 8)}` } } };
};

export const MATRIX: AreaMatrix = {
  rows: {
    'site.identity.get': `GET ${API} | ${PG} | read | deny | none | null | - | -`,
    'site.identity.put': `PUT ${API} | ${PG} | write | deny | store | site.identity.update | handler | -`,
    'site.identity.public': `GET ${API}/public | pub- | - | - | read | allow | none | null | - | -`,
    'site.icon': 'GET /site-icon/:file | pub- | - | - | read | allow | none | null | - | -',
  },
  fixtures: {
    'site.identity.get': async () => ({}),
    'site.identity.put': save,
    'site.identity.public': async () => ({}),
    'site.icon': async () => ({ params: { file: '32.png' } }),
  },
  maintenance: { 'site.identity.public': 'allow', 'site.icon': 'allow' },
};
