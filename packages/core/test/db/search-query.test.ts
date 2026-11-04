import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { titleCandidates } from '../../src/search/candidates.js';
import { searchCatalog, searchPageQuery } from '../../src/search/search.js';
import { suggestCorrections } from '../../src/search/spelling.js';
import type { CatalogSearchQuery } from '../../src/search/types.js';
import { ALL_CORPUS_RECORDS, CORPUS_QUERIES, PUBLIC_KEYS, finishSeededIndex, seedCatalog, wipeCatalog } from '../support/search-corpus.js';

// searchCatalog over the K8 corpus (Phase 2 spec §4.4–§4.7, §15 K8): every corpus query returns exactly its record set
// (§4.3: sets, not relevance orders, are what every dialect must agree on), the typo correction (applied with no hit,
// offered otherwise), the page limit, the orders (S14: newest through the search_doc index), the building flag, title
// candidates, and 500 random query strings that never make a search fail.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

describe.skipIf(!ctx.available)(`searchCatalog and the K8 corpus [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let ids: Map<string, string>;
  let keyOf: Map<string, string>;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-search-query-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await wipeCatalog(h);
    ids = await seedCatalog(h, ALL_CORPUS_RECORDS, { now: NOW - 1_000_000_000 });
    keyOf = new Map([...ids].map(([k, id]) => [id, k]));
    await finishSeededIndex(h, NOW);
  }, 120_000);

  afterAll(async () => {
    if (h !== undefined) await wipeCatalog(h);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  const search = (q: Partial<CatalogSearchQuery>) => searchCatalog(h.db, { text: '', scope: 'opac', ...q }, { now: NOW });
  const keys = (recordIds: readonly string[]) => recordIds.map((id) => keyOf.get(id) ?? id);

  /** Every hit of `q`, page after page (pages of 200). */
  async function all(q: Partial<CatalogSearchQuery>): Promise<{ keys: string[]; correction: unknown; total: number }> {
    const out: string[] = [];
    const first = await search({ ...q, page: 1, pageSize: 200 });
    out.push(...keys(first.recordIds));
    for (let page = 2; (page - 1) * 200 < first.total; page += 1) out.push(...keys((await search({ ...q, page, pageSize: 200 })).recordIds));
    return { keys: out, correction: first.correction, total: first.total };
  }

  it('the corpus has at least 200 records and 30 queries', () => {
    expect(ALL_CORPUS_RECORDS.length).toBeGreaterThanOrEqual(200);
    expect(CORPUS_QUERIES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CORPUS_QUERIES.map((c) => [`${c.q}${c.scope === 'admin' ? ' (admin, archived and hidden too)' : ''}`, c] as const))(
    'K8: %s → its record set',
    async (_, c) => {
      const r = await all({ text: c.q, ...(c.scope === undefined ? {} : { scope: c.scope }), ...(c.filters === undefined ? {} : { filters: c.filters }) });
      expect([...r.keys].sort()).toEqual([...c.expect].sort());
      expect(new Set(r.keys).size).toBe(r.keys.length); // no hit twice
      expect(r.total).toBe(c.expect.length);
      if (c.correction !== undefined) {
        expect(r.correction).toEqual(c.correction === null ? null : { from: c.q, ...c.correction });
      }
    },
  );

  it('a correction is only offered when the query found something (a word not in the vocabulary)', async () => {
    const r = await search({ text: 'laskar OR pendidkan' });
    expect(keys(r.recordIds).sort()).toEqual(['laskar-pelangi', 'laskar-rakyat']);
    expect(r.correction).toEqual({ from: 'laskar OR pendidkan', to: 'laskar OR pendidikan', applied: false });
    // A word of 3 letters or one with digits is never corrected; a word too far from every term has no correction.
    expect(await suggestCorrections(h.db, ['pdk', 'pendidkan2', 'qqqqqqqq', 'pendidikan', 'pendidkan'])).toEqual(new Map([['pendidkan', 'pendidikan']]));
  });

  it('relevance: a title match ranks before a subject-only match', async () => {
    const r = await search({ text: 'pendidikan', pageSize: 200 });
    const order = keys(r.recordIds);
    expect(order.indexOf('kurikulum')).toBeGreaterThan(order.indexOf('pendidikan-karakter'));
  });

  it('hal=51 → pageLimitReached, no ids, the total still counted', async () => {
    const r = await search({ text: 'koleksi', page: 51, pageSize: 1 });
    expect(r).toMatchObject({ pageLimitReached: true, recordIds: [], total: 180, totalCapped: false });
    const last = await search({ text: 'koleksi', page: 50, pageSize: 1 });
    expect(last.pageLimitReached).toBe(false);
    expect(last.recordIds).toHaveLength(1);
    // Past the last hit (but within 50 pages): an empty page, no limit reached.
    expect(await search({ text: 'laskar', page: 3 })).toMatchObject({ recordIds: [], pageLimitReached: false, total: 2 });
  });

  it('S14: newest without text is the public records by created_at, newest first', async () => {
    const r = await search({ pageSize: 5 });
    const expected = ALL_CORPUS_RECORDS.filter((rec) => PUBLIC_KEYS.includes(rec.key)).slice(-5).reverse().map((rec) => rec.key);
    expect(keys(r.recordIds)).toEqual(expected);
    expect(r.total).toBe(PUBLIC_KEYS.length);
    expect(r.correction).toBeNull();
    // `relevance` without text is `newest` too.
    expect((await search({ pageSize: 5, sort: 'relevance' })).recordIds).toEqual(r.recordIds);
  });

  it.runIf(ctx.engine === 'sqlite')('S14 (SQLite): the OPAC reads newest through ix_search_doc_public_created, the admin through ix_search_doc_created', async () => {
    const plan = async (q: CatalogSearchQuery) => (await searchPageQuery(h.db, q).explain(undefined, sql`query plan`)).map((r) => String(r['detail'])).join('\n');
    const opac = await plan({ text: '', scope: 'opac', sort: 'newest' });
    expect(opac).toContain('ix_search_doc_public_created');
    expect(opac).not.toContain('TEMP B-TREE');
    const admin = await plan({ text: '', scope: 'admin', sort: 'newest', filters: { includeArchived: true, includeHidden: true } });
    expect(admin).toContain('ix_search_doc_created');
    expect(admin).not.toContain('TEMP B-TREE');
  });

  it('orders: title, year (records without a year last either way)', async () => {
    const byTitle = keys((await search({ text: 'pendidikan', sort: 'title' })).recordIds);
    expect(byTitle.slice(0, 3)).toEqual(['filsafat-pendidikan', 'jurnal', 'laskar-pelangi']);
    const yearDesc = keys((await search({ text: 'novel', sort: 'year_desc' })).recordIds);
    expect(yearDesc).toEqual(['edensor', 'sang-pemimpi', 'laskar-pelangi', 'anak-semua-bangsa', 'bumi-manusia', 'ensiklopedia-novel']);
    const yearAsc = keys((await search({ text: 'novel', sort: 'year_asc' })).recordIds);
    expect(yearAsc).toEqual(['bumi-manusia', 'anak-semua-bangsa', 'laskar-pelangi', 'sang-pemimpi', 'edensor', 'ensiklopedia-novel']);
  });

  it('building: true while search_state is missing or building, false once ready', async () => {
    expect((await search({ text: 'laskar' })).building).toBe(false);
    await h.db.updateTable('search_state').set({ status: 'building' }).execute();
    expect((await search({ text: 'laskar' })).building).toBe(true);
    await h.db.deleteFrom('search_state').execute();
    expect((await search({ text: 'laskar' })).building).toBe(true);
    await finishSeededIndex(h, NOW);
  });

  it('titleCandidates: live records sharing title words, best first; archived ones never; bounded', async () => {
    const found = keys(await titleCandidates(h.db, 'Laskar Pelangi: edisi baru', 10));
    expect(found[0]).toBe('laskar-pelangi');
    expect(found).toEqual(expect.arrayContaining(['laskar-pelangi', 'laskar-rakyat', 'pelangi-jakarta', 'laskar-rahasia']));
    expect(found).not.toContain('laskar-arsip');
    expect(found).not.toContain('laskar-gabung');
    expect(await titleCandidates(h.db, 'Laskar Pelangi', 1)).toHaveLength(1);
    expect(await titleCandidates(h.db, '', 10)).toEqual([]);
    expect(await titleCandidates(h.db, '—', 10)).toEqual([]);
    expect(await titleCandidates(h.db, 'Laskar', 0)).toEqual([]);
    // Only short words or stopwords: they are used then.
    expect(keys(await titleCandidates(h.db, 'The AI', 10)).sort()).toEqual(['ai-pemula', 'art-programming', 'hobbit']);
  });

  it('500 random query strings never make a search fail (OPAC and admin, with facets)', async () => {
    const alphabet = ['a', 'k', 'laskar', 'pelangi', ' ', ' ', '"', '-', '*', ':', 'OR', 'ATAU', 'judul:', 'isbn:', 'pengarang:', '978', '-', '0', 'X', '\u{0301}', '\u{D800}', '\u{0000}', '東', '+', '(', ')', '\\', "'", '{', '}', '^', 'NEAR', 'AND', 'NOT', '%', '_'];
    let seed = 0x1234_abcd;
    const random = (n: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    for (let i = 0; i < 500; i += 1) {
      let q = '';
      const len = random(12);
      for (let k = 0; k < len; k += 1) q += alphabet[random(alphabet.length)]!;
      const scope = i % 2 === 0 ? 'opac' : 'admin';
      const r = await searchCatalog(h.db, { text: q, scope, facets: i % 5 === 0, sort: (['relevance', 'newest', 'title', 'year_desc', 'year_asc'] as const)[i % 5] }, { now: NOW }).catch(
        (e: unknown) => {
          throw new Error(`query ${JSON.stringify(q)} failed: ${String(e)}`);
        },
      );
      expect(r.total).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it('C07: a digit prefix of 82 characters or more never makes a search fail (its float form is cut to 84)', async () => {
    const texts = [
      `${'1'.repeat(83)}*`,
      `${'1'.repeat(84)}*`,
      `${'1'.repeat(200)}*`,
      `${'9'.repeat(82)}e*`,
      `-${'1'.repeat(90)}*`,
      `judul:${'1'.repeat(90)}*`,
      `laskar ${'2'.repeat(85)}* ATAU ${'3'.repeat(86)}e*`,
    ];
    for (const text of texts) {
      for (const scope of ['opac', 'admin'] as const) {
        for (const sort of ['relevance', 'newest'] as const) {
          const r = await searchCatalog(h.db, { text, scope, sort, facets: true }, { now: NOW }).catch((e: unknown) => {
            throw new Error(`query ${JSON.stringify(text)} failed: ${String(e)}`);
          });
          expect(r.total).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
