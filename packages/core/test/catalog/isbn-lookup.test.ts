import type { DB } from '@altis/db';
import { isDomainError } from '@altis/shared';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { SruServer } from '@altis/shared/api/settings';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { lookupIsbn, sruIsbnSource, sruSearchDrafts, sruTestServer, type IsbnSource } from '../../src/catalog/copy/index.js';
import { checkDuplicates } from '../../src/catalog/records/duplicates.js';
import { FAKE_SRU_ISBN, startFakeSru, type FakeSru } from '../support/fake-sru.js';

// Copy cataloguing by ISBN and SRU (Phase 2 spec §6.2-§6.4, K7; plan Task 32, M13) against the local fake SRU server
// (allowPrivate stands for `catalog.sru.allowPrivateHosts`, so the fake on 127.0.0.1 is reachable):
// - the SRU source maps each MARCXML record to a draft (Task 6's reader and mapping), without the remote items;
// - lookupIsbn normalises, checks the catalog first (no source is asked when a live record holds the ISBN), then asks
//   the sources at most 3 at a time, each within its own budget and all within the overall one, merges their drafts by
//   ISBN (≤ 10), scores each with checkDuplicates, and lists each source's failure.
// The database is a fake Kysely connection that answers the local ISBN query; checkDuplicates is mocked here (its own
// behaviour is Task 16's, and the route test runs it on a real database).

vi.mock('../../src/catalog/records/duplicates.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/catalog/records/duplicates.js')>();
  return { ...original, checkDuplicates: vi.fn(async () => []) };
});

const INDEXES = { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' };

function server(id: string, url: string, version: SruServer['version'] = '1.2'): SruServer {
  return { id, name: `Server ${id}`, url, version, recordSchema: 'marcxml', indexes: INDEXES, enabled: true };
}

/** A Kysely handle whose every query is answered by `answer` (SQLite SQL); the queries are kept. */
function fakeDb(answer: (sql: string, parameters: readonly unknown[]) => unknown[] = () => []): { db: Kysely<DB>; queries: string[] } {
  const queries: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(q.sql);
      return Promise.resolve({ rows: answer(q.sql, q.parameters) as R[] });
    },
    // eslint-disable-next-line require-yield -- never streamed
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('fakeDb: no streaming');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new SqliteIntrospector(k),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
  return { db, queries };
}

/** A minimal valid draft with `isbn` (none when null). */
function draft(title: string, isbn: string | null): RecordDraft {
  return {
    materialTypeCode: null,
    title,
    publisher: null,
    identifiers: isbn === null ? [] : [{ type: 'isbn', value: isbn }],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
  };
}

/** A source answering `drafts` (after `delayMs`), counting its calls. */
function fixedSource(id: string, drafts: RecordDraft[], delayMs = 0): IsbnSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    lookup(isbn13) {
      calls.push(isbn13);
      return new Promise((resolve) => setTimeout(() => resolve(drafts), delayMs));
    },
  };
}

/** The DomainError `p` rejects with, as `{code, meta}`. */
async function domainFailure(p: Promise<unknown>): Promise<{ code: string; meta: Record<string, unknown> | undefined }> {
  try {
    await p;
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return { code: e.code, meta: e.meta };
  }
  throw new Error('did not fail');
}

const BUKU = (leader06: string, leader07: string): string | null => (leader06 === 'a' && leader07 === 'm' ? 'BUKU' : null);

describe('copy cataloguing: SRU source and ISBN lookup (K7, M13)', () => {
  let fake: FakeSru;

  beforeAll(async () => {
    fake = await startFakeSru();
  });

  afterAll(async () => {
    await fake.close();
  });

  afterEach(() => {
    vi.mocked(checkDuplicates).mockReset();
    vi.mocked(checkDuplicates).mockResolvedValue([]);
  });

  it('the SRU source finds the ISBN on the fake server and maps the record to a draft, without the remote items', async () => {
    const source = sruIsbnSource(server('perpusnas', `${fake.url}/sru`), { allowPrivate: true, materialTypeCodeFor: BUKU });
    expect(source.id).toBe('sru:perpusnas');
    const drafts = await source.lookup(FAKE_SRU_ISBN, new AbortController().signal);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      materialTypeCode: 'BUKU',
      title: 'Laskar pelangi',
      publicationYear: '2005',
      identifiers: expect.arrayContaining([{ type: 'isbn', value: FAKE_SRU_ISBN }]),
      agents: [expect.objectContaining({ name: 'Hirata, Andrea', isMain: true })],
      items: [],
    });
    expect(fake.requests.at(-1)?.path).toContain(`query=${encodeURIComponent(`bath.isbn="${FAKE_SRU_ISBN}"`)}`);
  });

  it('ISBN lookup → 1 candidate with the draft title, from the SRU source; the ISBN-10 form is looked up as ISBN-13', async () => {
    const { db, queries } = fakeDb();
    // 602-03-3295-0 is the ISBN-10 form of 978-602-03-3295-6.
    const found = await lookupIsbn(db, '602-03-3295-0', { sources: [sruIsbnSource(server('perpusnas', `${fake.url}/sru`), { allowPrivate: true })], threshold: 80 });
    expect(queries.some((q) => q.includes('record_identifiers'))).toBe(true);
    expect(fake.requests.at(-1)?.path).toContain(encodeURIComponent(`"${FAKE_SRU_ISBN}"`));
    expect(found).toEqual({
      isbn13: FAKE_SRU_ISBN,
      local: null,
      candidates: [{ source: 'sru:perpusnas', draft: expect.objectContaining({ title: 'Laskar pelangi' }), duplicate: null }],
      errors: [],
    });
  });

  it('a live record holding the ISBN → `local` is set and no source is asked', async () => {
    const { db } = fakeDb((sql) => (sql.includes('record_identifiers') ? [{ id: '01JZRECORD0000000000000001', title: 'Laskar Pelangi' }] : []));
    const source = fixedSource('sru:x', [draft('Tidak dipakai', FAKE_SRU_ISBN)]);
    const res = await lookupIsbn(db, '978-602-03-3295-6', { sources: [source], threshold: 80 });
    expect(res).toEqual({ isbn13: FAKE_SRU_ISBN, local: { recordId: '01JZRECORD0000000000000001', title: 'Laskar Pelangi' }, candidates: [], errors: [] });
    expect(source.calls).toEqual([]);
    expect(checkDuplicates).not.toHaveBeenCalled();
  });

  it('an ISBN that does not parse, or has a wrong check digit → VALIDATION_FAILED {path: isbn, code: invalid}, nothing asked', async () => {
    const { db, queries } = fakeDb();
    const source = fixedSource('sru:x', []);
    for (const bad of ['12345', '9786020332957', 'ISBN', '']) {
      const f = await domainFailure(lookupIsbn(db, bad, { sources: [source], threshold: 80 }));
      expect(f, bad).toEqual({ code: 'VALIDATION_FAILED', meta: { errors: [{ path: 'isbn', code: 'invalid' }] } });
    }
    expect(queries).toEqual([]);
    expect(source.calls).toEqual([]);
  });

  it('one source hangs and one answers → the candidate and an error entry, within the overall budget (short test budgets)', async () => {
    const { db } = fakeDb();
    const hanging = sruIsbnSource(server('macet', `${fake.url}/hang`), { allowPrivate: true });
    // A source that ignores its signal altogether still ends with the budget.
    const deaf: IsbnSource = { id: 'sru:other', lookup: () => new Promise<RecordDraft[]>(() => {}) };
    const answering = sruIsbnSource(server('perpusnas', `${fake.url}/sru`), { allowPrivate: true });
    const started = Date.now();
    const res = await lookupIsbn(db, FAKE_SRU_ISBN, { sources: [hanging, deaf, answering], threshold: 80, sourceTimeoutMs: 300, totalTimeoutMs: 600 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.candidates.map((c) => [c.source, c.draft.title])).toEqual([['sru:perpusnas', 'Laskar pelangi']]);
    expect(res.errors).toEqual([
      { source: 'sru:macet', code: 'CATALOG_OUTBOUND_FAILED' },
      { source: 'sru:other', code: 'CATALOG_OUTBOUND_FAILED' },
    ]);
  });

  it('the overall budget ends the sources still waiting for a slot: each is an error entry', async () => {
    const { db } = fakeDb();
    const slow = [1, 2, 3, 4].map((n) => fixedSource(`sru:s${n}`, [draft(`Buku ${n}`, null)], 400));
    const res = await lookupIsbn(db, FAKE_SRU_ISBN, { sources: slow, threshold: 80, sourceTimeoutMs: 1000, totalTimeoutMs: 250 });
    expect(res.candidates).toEqual([]);
    expect(res.errors).toEqual(slow.map((s) => ({ source: s.id, code: 'CATALOG_OUTBOUND_FAILED' })));
    // The fourth never started: no slot came free within the budget.
    expect(slow.map((s) => s.calls.length)).toEqual([1, 1, 1, 0]);
  });

  it('a private address with allowPrivate false → errors[0].code CATALOG_OUTBOUND_BLOCKED, and nothing reaches the server', async () => {
    const { db } = fakeDb();
    const before = fake.requests.length;
    const res = await lookupIsbn(db, FAKE_SRU_ISBN, { sources: [sruIsbnSource(server('lan', `${fake.url}/sru`), { allowPrivate: false })], threshold: 80 });
    expect(res.candidates).toEqual([]);
    expect(res.errors[0]).toEqual({ source: 'sru:lan', code: 'CATALOG_OUTBOUND_BLOCKED' });
    expect(fake.requests.length).toBe(before);
  });

  it('M13: with 5 enabled sources, no more than 3 requests are open at once; all 5 are asked and their one record merges into one candidate', async () => {
    const own = await startFakeSru();
    try {
      const { db } = fakeDb();
      const sources = [1, 2, 3, 4, 5].map((n) => sruIsbnSource(server(`s${n}`, `${own.url}/sru?delay=300`), { allowPrivate: true }));
      const res = await lookupIsbn(db, FAKE_SRU_ISBN, { sources, threshold: 80 });
      expect(own.requests.filter((r) => r.path.startsWith('/sru')).length).toBe(5);
      expect(own.maxOpenRequests()).toBe(3);
      expect(res.errors).toEqual([]);
      expect(res.candidates.map((c) => c.source)).toEqual(['sru:s1']);
    } finally {
      await own.close();
    }
  });

  it('merges in source order, drops a draft whose ISBN an earlier one has, keeps at most 10, and drops a draft the contract refuses', async () => {
    const { db } = fakeDb();
    const isbns = ['9780306406157', '9781861972712', '9780262033848', '9780131103627', '9780201633610', '9780596007126'];
    const first = fixedSource('sru:other', [draft('Satu', isbns[0]!), draft('Dua', isbns[1]!), { ...draft('', isbns[5]!) }]);
    const second = fixedSource('sru:b', [
      draft('Satu lagi', '0-306-40615-2'),
      draft('Tiga', isbns[2]!),
      draft('Empat', isbns[3]!),
      draft('Lima', isbns[4]!),
      ...Array.from({ length: 8 }, (_, i) => draft(`Tanpa ISBN ${i}`, null)),
    ]);
    const res = await lookupIsbn(db, FAKE_SRU_ISBN, { sources: [first, second], threshold: 80 });
    expect(res.candidates.map((c) => `${c.source} ${c.draft.title}`)).toEqual([
      'sru:other Satu',
      'sru:other Dua',
      'sru:b Tiga',
      'sru:b Empat',
      'sru:b Lima',
      'sru:b Tanpa ISBN 0',
      'sru:b Tanpa ISBN 1',
      'sru:b Tanpa ISBN 2',
      'sru:b Tanpa ISBN 3',
      'sru:b Tanpa ISBN 4',
    ]);
    expect(first.calls).toEqual([FAKE_SRU_ISBN]);
  });

  it('each candidate is scored with checkDuplicates: the best one at or above the threshold is its duplicate hint', async () => {
    const { db } = fakeDb();
    vi.mocked(checkDuplicates).mockImplementation(async (_db, input) =>
      input.title === 'Laskar pelangi' ? [{ recordId: '01JZRECORD0000000000000009', title: 'Laskar Pelangi', year: '2005', score: 95, reasons: ['title', 'year', 'agent'] }] : [],
    );
    const res = await lookupIsbn(db, FAKE_SRU_ISBN, {
      sources: [sruIsbnSource(server('perpusnas', `${fake.url}/sru`), { allowPrivate: true }), fixedSource('sru:other', [draft('Lain', '9780306406157')])],
      threshold: 85,
    });
    expect(res.candidates.map((c) => c.duplicate)).toEqual([{ recordId: '01JZRECORD0000000000000009', score: 95 }, null]);
    const [, input, threshold] = vi.mocked(checkDuplicates).mock.calls[0]!;
    expect(threshold).toBe(85);
    expect(input).toMatchObject({
      title: 'Laskar pelangi',
      year: '2005',
      mainAgentName: 'Hirata, Andrea',
      publisherName: 'Bentang Pustaka',
      identifiers: expect.arrayContaining([{ type: 'isbn', value: FAKE_SRU_ISBN }]),
    });
  });

  it('a source that fails with something other than a DomainError is an INTERNAL entry, logged', async () => {
    const { db } = fakeDb();
    const warn = vi.fn();
    const broken: IsbnSource = { id: 'sru:other', lookup: () => Promise.reject(new TypeError('boom')) };
    const res = await lookupIsbn(db, FAKE_SRU_ISBN, { sources: [broken], threshold: 80, log: { info: vi.fn(), warn, error: vi.fn() } as never });
    expect(res.errors).toEqual([{ source: 'sru:other', code: 'INTERNAL' }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('SRU search by title and by author returns drafts (one page)', async () => {
    const byTitle = await sruSearchDrafts(server('perpusnas', `${fake.url}/sru`), 'title', 'pemimpi', { start: 1, allowPrivate: true, materialTypeCodeFor: BUKU });
    expect(byTitle.total).toBe(1);
    expect(byTitle.drafts.map((d) => [d.title, d.materialTypeCode, d.publicationYear])).toEqual([['Sang pemimpi', 'BUKU', '2006']]);
    const byAuthor = await sruSearchDrafts(server('loc', `${fake.url}/sru`, '2.0'), 'author', 'Hirata', { start: 2, allowPrivate: true });
    expect(byAuthor.total).toBe(3);
    expect(byAuthor.drafts.map((d) => d.title)).toEqual(['Sang pemimpi', 'Edensor']);
    expect(byAuthor.drafts.every((d) => d.materialTypeCode === null && d.items.length === 0)).toBe(true);
  });

  it('SRU search: a diagnostic → CATALOG_SRU_INVALID; a private address with allowPrivate false → CATALOG_OUTBOUND_BLOCKED', async () => {
    expect((await domainFailure(sruSearchDrafts(server('diag', `${fake.url}/diag`), 'title', 'x', { start: 1, allowPrivate: true }))).code).toBe('CATALOG_SRU_INVALID');
    expect((await domainFailure(sruSearchDrafts(server('lan', `${fake.url}/sru`), 'title', 'x', { start: 1, allowPrivate: false }))).code).toBe('CATALOG_OUTBOUND_BLOCKED');
  });

  it('the SRU server test answers ok with the version the server reported, or the failure with its code and message', async () => {
    expect(await sruTestServer({ url: `${fake.url}/sru`, version: '1.1' }, { allowPrivate: true })).toEqual({ ok: true, version: '1.1' });
    expect(await sruTestServer({ url: `${fake.url}/sru`, version: '2.0' }, { allowPrivate: true })).toEqual({ ok: true, version: '2.0' });
    const diag = await sruTestServer({ url: `${fake.url}/diag`, version: '1.2' }, { allowPrivate: true });
    expect(diag).toMatchObject({ ok: false, code: 'CATALOG_SRU_INVALID', message: expect.stringMatching(/^Unsupported index/) });
    expect(diag.message!.length).toBeLessThanOrEqual(200);
    expect(await sruTestServer({ url: `${fake.url}/sru`, version: '1.2' }, { allowPrivate: false })).toEqual({ ok: false, code: 'CATALOG_OUTBOUND_BLOCKED' });
    expect(await sruTestServer({ url: `${fake.url}/status/404`, version: '1.2' }, { allowPrivate: true })).toEqual({ ok: false, code: 'CATALOG_OUTBOUND_FAILED', message: 'status 404' });
    expect(await sruTestServer({ url: `${fake.url}/redirect/0`, version: '1.2' }, { allowPrivate: true })).toMatchObject({ ok: false, code: 'CATALOG_SRU_INVALID' });
  });
});
