import { newId } from '@altis/shared';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the OPAC record detail (Phase 2 Task 34): the RIS, BibTeX and
// MARCXML downloads, the attachment viewer and the record page with and without its slug, as the plan's route catalog
// gives them (public, `session: 'none'`, mode read, `maintenance: allow`, no idempotency store, no audit). Every
// fixture is anonymous and names a record that does not exist: the gate lets every persona through, and the handler
// answers the OPAC 404 page (S17); the routes' own behaviour is db/opac-detail.test.ts's.

const PUBLIC_PAGE = 'pub- | - | - | read | allow | none | null | - | -';

const record = (): Record<string, string> => ({ id: newId() });

export const MATRIX: AreaMatrix = {
  rows: {
    'opac.record.ris': `GET /katalog/:id/ris | ${PUBLIC_PAGE}`,
    'opac.record.bibtex': `GET /katalog/:id/bibtex | ${PUBLIC_PAGE}`,
    'opac.record.marcxml': `GET /katalog/:id/marcxml | ${PUBLIC_PAGE}`,
    'opac.record.attachment': `GET /katalog/:id/lampiran/:aid | ${PUBLIC_PAGE}`,
    'opac.record': `GET /katalog/:id | ${PUBLIC_PAGE}`,
    'opac.record.slug': `GET /katalog/:id/:slug | ${PUBLIC_PAGE}`,
  },
  fixtures: {
    'opac.record.ris': async () => ({ params: record() }),
    'opac.record.bibtex': async () => ({ params: record() }),
    'opac.record.marcxml': async () => ({ params: record() }),
    'opac.record.attachment': async () => ({ params: { ...record(), aid: newId() } }),
    'opac.record': async () => ({ params: record() }),
    'opac.record.slug': async () => ({ params: { ...record(), slug: 'judul' } }),
  },
  maintenance: {
    'opac.record.ris': 'allow',
    'opac.record.bibtex': 'allow',
    'opac.record.marcxml': 'allow',
    'opac.record.attachment': 'allow',
    'opac.record': 'allow',
    'opac.record.slug': 'allow',
  },
};
