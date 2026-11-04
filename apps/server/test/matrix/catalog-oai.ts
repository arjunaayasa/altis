import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of OAI-PMH (Phase 2 Task 35), as the plan's route catalog gives
// them: public, `session: 'none'`, mode read, `maintenance: allow`, no idempotency store, no audit, rate-limited per IP
// (`oai`); the POST is the cookieless read (`tx: 'self'`, explicit `mode: 'read'`, CSRF step skipped). Every fixture
// is anonymous: no persona is turned away. The gate outcome is read before the handler, so a 503 (OAI off in the
// matrix's database) or a protocol error does not change it.

export const MATRIX: AreaMatrix = {
  rows: {
    'oai.get': 'GET /oai | pub- | - | - | read | allow | none | null | - | ip:oai',
    'oai.post': 'POST /oai | pub- | - | - | read | allow | none | null | self | ip:oai',
  },
  fixtures: {
    'oai.get': async () => ({ query: { verb: 'Identify' } }),
    'oai.post': async () => ({ body: 'verb=Identify', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
  },
  maintenance: {
    'oai.get': 'allow',
    'oai.post': 'allow',
  },
};
