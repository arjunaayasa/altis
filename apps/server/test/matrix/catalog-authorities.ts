import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the authorities (agents, subjects, publishers, orphans) (Phase
// 2 Task 13; the plan's route catalog): one row per route id in the row format of db/matrix.test.ts's CATALOG, one
// fixture per route in the same order. Every route is `deny` in maintenance, so there is no maintenance entry.
//
// The fixtures seed what a call needs straight into the tables, each call its own rows under names of their own, so
// that a super admin's call succeeds (audit once) whatever the personas before it did.

/** A name no other call uses. */
const unique = (base: string): string => `${base} ${newId().slice(-10)}`;

/** An agent of its own (version 0, no links); its id. */
async function seedAgent(s: MatrixSeed, type: 'person' | 'organization' = 'person'): Promise<string> {
  const id = newId();
  const name = unique('Penulis Matriks');
  await s.h.db
    .insertInto('agents')
    .values({
      id,
      type,
      name_display: name,
      name_key: normalizeKey(name),
      dates: null,
      authority_source: null,
      authority_ref: null,
      note: null,
      merged_into: null,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A topical subject of its own (version 0, no links, no relations); its id. */
async function seedSubject(s: MatrixSeed): Promise<string> {
  const id = newId();
  const term = unique('Subjek Matriks');
  await s.h.db
    .insertInto('subjects')
    .values({
      id,
      type: 'topic',
      term_display: term,
      term_key: normalizeKey(term),
      classification: null,
      scope_note: null,
      authority_source: null,
      merged_into: null,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A publisher of its own (version 0, no records); its id. */
async function seedPublisher(s: MatrixSeed): Promise<string> {
  const id = newId();
  const name = unique('Penerbit Matriks');
  await s.h.db
    .insertInto('publishers')
    .values({
      id,
      name_display: name,
      name_key: normalizeKey(name),
      place: null,
      merged_into: null,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

const SEEDS = { agents: seedAgent, subjects: seedSubject, publishers: seedPublisher } as const;
type Kind = keyof typeof SEEDS;

const getOne =
  (kind: Kind): MatrixFixture =>
  async (s) => ({ params: { id: await SEEDS[kind](s) } });
const archiveOne =
  (kind: Kind): MatrixFixture =>
  async (s) => ({ params: { id: await SEEDS[kind](s) }, body: { version: 0 } });
const mergeOne =
  (kind: Kind): MatrixFixture =>
  async (s) => ({ params: { id: await SEEDS[kind](s) }, body: { intoId: await SEEDS[kind](s), version: 0 } });

/** The rows of one kind's six routes (list, get, create, update, archive, merge). */
function kindRows(kind: Kind): Record<string, string> {
  const base = `/api/v1/catalog/${kind}`;
  const write = (method: string, p: string, audit: string) =>
    `${method} ${p} | P:catalog.authorities.manage | - | - | write | deny | store | ${audit} | handler | -`;
  return {
    [`catalog.${kind}.list`]: `GET ${base} | P:catalog.records.read | - | - | read | deny | none | null | - | -`,
    [`catalog.${kind}.get`]: `GET ${base}/:id | P:catalog.records.read | - | - | read | deny | none | null | - | -`,
    [`catalog.${kind}.create`]: write('POST', base, 'catalog.authority.create'),
    [`catalog.${kind}.update`]: write('PATCH', `${base}/:id`, 'catalog.authority.update'),
    [`catalog.${kind}.archive`]: write('DELETE', `${base}/:id`, 'catalog.authority.archive'),
    [`catalog.${kind}.merge`]: write('POST', `${base}/:id/merge`, 'catalog.authority.merge'),
  };
}

export const MATRIX: AreaMatrix = {
  rows: {
    ...kindRows('agents'),
    ...kindRows('subjects'),
    'catalog.subjects.relations':
      'PUT /api/v1/catalog/subjects/:id/relations | P:catalog.authorities.manage | - | - | write | deny | store | catalog.authority.update | handler | -',
    ...kindRows('publishers'),
    'catalog.orphans.list': 'GET /api/v1/catalog/orphans | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.orphans.archive':
      'POST /api/v1/catalog/orphans/archive | P:catalog.authorities.manage | - | - | write | deny | store | catalog.authority.archive | handler | -',
  },
  fixtures: {
    'catalog.agents.list': async () => ({ query: { q: 'matriks', type: 'person', limit: '5' } }),
    'catalog.agents.get': getOne('agents'),
    'catalog.agents.create': async () => ({ body: { type: 'person', name: unique('Penulis Baru Matriks'), dates: '1950-' } }),
    'catalog.agents.update': async (s) => ({ params: { id: await seedAgent(s) }, body: { version: 0, name: unique('Nama Baru Matriks') } }),
    'catalog.agents.archive': archiveOne('agents'),
    'catalog.agents.merge': mergeOne('agents'),
    'catalog.subjects.list': async () => ({ query: { q: 'matriks', limit: '5' } }),
    'catalog.subjects.get': getOne('subjects'),
    'catalog.subjects.create': async () => ({ body: { type: 'topic', term: unique('Subjek Baru Matriks') } }),
    'catalog.subjects.update': async (s) => ({ params: { id: await seedSubject(s) }, body: { version: 0, scopeNote: 'Catatan cakupan' } }),
    'catalog.subjects.archive': archiveOne('subjects'),
    'catalog.subjects.merge': mergeOne('subjects'),
    'catalog.subjects.relations': async (s) => ({
      params: { id: await seedSubject(s) },
      body: { relations: [{ rel: 'bt', subjectId: await seedSubject(s) }], version: 0 },
    }),
    'catalog.publishers.list': async () => ({ query: { limit: '5' } }),
    'catalog.publishers.get': getOne('publishers'),
    'catalog.publishers.create': async () => ({ body: { name: unique('Penerbit Baru Matriks'), place: 'Bandung' } }),
    'catalog.publishers.update': async (s) => ({ params: { id: await seedPublisher(s) }, body: { version: 0, place: 'Yogyakarta' } }),
    'catalog.publishers.archive': archiveOne('publishers'),
    'catalog.publishers.merge': mergeOne('publishers'),
    'catalog.orphans.list': async () => ({ query: { kind: 'agents', limit: '5' } }),
    'catalog.orphans.archive': async (s) => ({ body: { kind: 'publishers', ids: [await seedPublisher(s), await seedPublisher(s)] } }),
  },
  maintenance: {},
};
