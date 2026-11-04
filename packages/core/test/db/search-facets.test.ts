import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { searchCatalog } from '../../src/search/search.js';
import type { CatalogSearchQuery } from '../../src/search/types.js';
import { seedCatalog, wipeCatalog, type SeedRecord } from '../support/search-corpus.js';

// Facets, filters and the limits of a search (Phase 2 spec §4.5, §4.6, D2-09; M4): exact counts over 300 hits, every
// filter, the class digit facet `cl`, the subject facet's top 10; approximate facets over 5 001 hits, the total capped
// at 10 000 for 10 001 hits.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

describe.skipIf(!ctx.available)(`search facets and limits [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-search-facets-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    if (h !== undefined) await wipeCatalog(h);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  const search = (q: Partial<CatalogSearchQuery>) => searchCatalog(h.db, { text: '', scope: 'opac', ...q }, { now: NOW });
  const codeId = async (table: 'material_types' | 'languages' | 'collection_types', code: string) =>
    (await h.db.selectFrom(table).select('id').where('code_key', '=', code).executeTakeFirstOrThrow()).id;
  /** A branch of its own (code unique per call). */
  async function branch(): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id, code_key: id, code_display: id, name: 'Cabang', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    return id;
  }

  describe('300 hits: exact counts and every filter', () => {
    const N = 300;
    const MATERIALS = ['BUKU', 'EBOOK', 'PETA'];
    let branchA: string;
    let branchB: string;
    let room: string;
    /** What each record i is, by the rules it was seeded with. */
    const rules = (i: number) => ({
      material: MATERIALS[i % 3]!,
      language: i % 2 === 0 ? 'IND' : 'ENG',
      subject: i < 225 ? i % 15 : i % 5,
      hasItem: i % 4 !== 0,
      collection: i % 2 === 1 ? 'UMUM' : 'REF',
      available: i % 5 !== 0,
      branchA: i % 3 === 0,
      located: i % 10 === 1,
      url: i % 7 === 0,
      digit: String(i % 10),
      year: 1990 + (i % 20),
      author: i % 3,
    });
    const count = (pred: (r: ReturnType<typeof rules>) => boolean) => Array.from({ length: N }, (_, i) => rules(i)).filter(pred).length;
    let ids: Map<string, string>;

    beforeAll(async () => {
      await wipeCatalog(h);
      [branchA, branchB] = [await branch(), await branch()];
      room = newId(NOW);
      await h.db
        .insertInto('locations')
        .values({
          id: room,
          branch_id: branchB,
          parent_id: null,
          kind: 'room',
          code_display: 'R1',
          code_key: 'R1',
          name: 'Ruang Baca',
          shelf_hint: null,
          class_from: null,
          class_to: null,
          map_file_id: null,
          map_x: null,
          map_y: null,
          map_w: null,
          map_h: null,
          is_public: 1,
          sort_order: 0,
          archived_at: null,
          version: 0,
          created_at: NOW,
          created_by: null,
          updated_at: NOW,
          updated_by: null,
        })
        .execute();
      const records: SeedRecord[] = Array.from({ length: N }, (_, i) => {
        const r = rules(i);
        return {
          key: `f${i}`,
          title: `Ujifaset nomor ${i}`,
          materialType: r.material,
          language: r.language,
          subjects: [`Topik ${String.fromCharCode(65 + r.subject)}`],
          agents: [`Penulis, Nomor ${String.fromCharCode(65 + r.author)}`],
          classification: `${r.digit}00.5`,
          year: String(r.year),
          items: r.hasItem
            ? [
                {
                  barcode: `FS${i}`,
                  collectionType: r.collection,
                  status: r.available ? 'available' : 'repair',
                  branchId: r.branchA ? branchA : branchB,
                  locationId: r.located ? room : null,
                },
              ]
            : [],
        };
      });
      ids = await seedCatalog(h, records, { now: NOW, branchId: branchA, index: false });
      // url attachments, then the index.
      for (let i = 0; i < N; i += 1) {
        if (!rules(i).url) continue;
        await h.db
          .insertInto('attachments')
          .values({
            id: newId(NOW),
            record_id: ids.get(`f${i}`)!,
            kind: 'url',
            file_id: null,
            url: 'https://example.org/',
            title: 'Tautan',
            description: null,
            access: 'public',
            legacy_access_limit: null,
            read_count: 0,
            sort_order: 0,
            archived_at: null,
            version: 0,
            created_at: NOW,
            created_by: null,
            updated_at: NOW,
            updated_by: null,
          })
          .execute();
      }
      const { withTx } = await import('@altis/db');
      const { indexRecords } = await import('../../src/search/index-records.js');
      await withTx(h, (trx) => indexRecords(trx, [...ids.values()], NOW));
    }, 120_000);

    it('every facet counted exactly over the 300 hits; the subject facet keeps its 10 largest values', async () => {
      const r = await search({ text: 'ujifaset', facets: true });
      expect(r).toMatchObject({ total: 300, totalCapped: false, facetsApproximate: false });
      const f = r.facets!;
      const asMap = (list: { value: string; count: number }[] | undefined) => new Map((list ?? []).map((v) => [v.value, v.count]));
      expect(asMap(f.mt)).toEqual(new Map(await Promise.all(MATERIALS.map(async (m) => [await codeId('material_types', m), 100] as const))));
      expect(asMap(f.lg)).toEqual(new Map([[await codeId('languages', 'IND'), 150], [await codeId('languages', 'ENG'), 150]]));
      expect(asMap(f.ct)).toEqual(
        new Map([
          [await codeId('collection_types', 'UMUM'), count((r) => r.hasItem && r.collection === 'UMUM')],
          [await codeId('collection_types', 'REF'), count((r) => r.hasItem && r.collection === 'REF')],
        ]),
      );
      expect(asMap(f.br)).toEqual(new Map([[branchA, count((r) => r.hasItem && r.branchA)], [branchB, count((r) => r.hasItem && !r.branchA)]]));
      expect(asMap(f.lc)).toEqual(new Map([[room, count((r) => r.hasItem && r.located)]]));
      expect(asMap(f.av)).toEqual(new Map([['1', count((r) => r.hasItem && r.available)]]));
      expect(asMap(f.at)).toEqual(new Map([['url', count((r) => r.url)]]));
      expect(asMap(f.cl)).toEqual(new Map(Array.from({ length: 10 }, (_, d) => [String(d), 30])));
      // Subjects A-E hold 30 records each, F-O 15: the 10 largest are A-E and five of the others; the list is by count.
      expect(f.sb).toHaveLength(10);
      expect(f.sb!.map((v) => v.count)).toEqual([30, 30, 30, 30, 30, 15, 15, 15, 15, 15]);
      // The facets come in their fixed order; counts descending inside one.
      expect(Object.keys(f)).toEqual(['mt', 'lg', 'ct', 'br', 'lc', 'av', 'at', 'sb', 'cl']);
      // Without `facets: true` there are none.
      expect((await search({ text: 'ujifaset' })).facets).toBeNull();
    });

    it('each filter narrows to exactly its records, and filters combine (AND)', async () => {
      const total = async (filters: CatalogSearchQuery['filters']) => (await search({ text: 'ujifaset', filters })).total;
      expect(await total({ materialTypeIds: [await codeId('material_types', 'BUKU')] })).toBe(100);
      expect(await total({ languageIds: [await codeId('languages', 'ENG')] })).toBe(150);
      expect(await total({ collectionTypeIds: [await codeId('collection_types', 'UMUM')] })).toBe(count((r) => r.hasItem && r.collection === 'UMUM'));
      expect(await total({ branchIds: [branchA] })).toBe(count((r) => r.hasItem && r.branchA));
      expect(await total({ locationIds: [room] })).toBe(count((r) => r.hasItem && r.located));
      expect(await total({ available: true })).toBe(count((r) => r.hasItem && r.available));
      expect(await total({ attachmentKinds: ['url'] })).toBe(count((r) => r.url));
      expect(await total({ classDigit: 3 })).toBe(30);
      expect(await total({ yearFrom: 2000, yearTo: 2004 })).toBe(count((r) => r.year >= 2000 && r.year <= 2004));
      const subjectA = (await h.db.selectFrom('subjects').select('id').where('term_display', '=', 'Topik A').executeTakeFirstOrThrow()).id;
      expect(await total({ subjectIds: [subjectA] })).toBe(30);
      const agentA = (await h.db.selectFrom('agents').select('id').where('name_display', '=', 'Penulis, Nomor A').executeTakeFirstOrThrow()).id;
      expect(await total({ agentIds: [agentA] })).toBe(100);
      expect(
        await total({ materialTypeIds: [await codeId('material_types', 'BUKU')], languageIds: [await codeId('languages', 'ENG')] }),
      ).toBe(count((r) => r.material === 'BUKU' && r.language === 'ENG'));
      // Several values of one filter are alternatives (OR).
      expect(await total({ materialTypeIds: [await codeId('material_types', 'BUKU'), await codeId('material_types', 'PETA')] })).toBe(200);
      // Malformed values are ignored, never an error.
      expect(await total({ classDigit: 12, materialTypeIds: [], yearFrom: 1.5, branchIds: ['x'.repeat(65)] })).toBe(300);
      // Without text too (newest), and with the filters only.
      expect((await search({ filters: { classDigit: 3 } })).total).toBe(30);
    });
  });

  describe('M4: the class digit facet cl', () => {
    it('899.221 and 808.3 → cl 8 (count 2), filtered by classDigit 8; no digit, no cl', async () => {
      await wipeCatalog(h);
      const ids = await seedCatalog(
        h,
        [
          { key: 'a', title: 'Kelasem satu', classification: '899.221' },
          { key: 'b', title: 'Kelasem dua', classification: '808.3' },
          { key: 'c', title: 'Kelasem tiga', classification: '005.133' },
          { key: 'd', title: 'Kelasem empat', classification: '2X4.1' },
          { key: 'e', title: 'Kelasem lima', classification: 'R 808' },
          { key: 'f', title: 'Kelasem enam' },
        ],
        { now: NOW },
      );
      const r = await search({ text: 'kelasem', facets: true });
      expect(r.facets!.cl).toEqual([
        { value: '8', count: 2 },
        { value: '0', count: 1 },
        { value: '2', count: 1 },
      ]);
      expect((await search({ text: 'kelasem', filters: { classDigit: 8 } })).recordIds.sort()).toEqual([ids.get('a')!, ids.get('b')!].sort());
      expect((await search({ text: 'kelasem', filters: { classDigit: 0 } })).recordIds).toEqual([ids.get('c')!]);
    });
  });

  describe('5 001 and 10 001 hits', () => {
    beforeAll(async () => {
      await wipeCatalog(h);
      const records: SeedRecord[] = Array.from({ length: 10_001 }, (_, i) => ({ key: `m${i}`, title: i < 5001 ? `Massal ganjil ${i}` : `Massal ${i}` }));
      await seedCatalog(h, records, { now: NOW });
    }, 300_000);

    it('5 001 hits → facets over the top 5 000, marked approximate', async () => {
      const r = await search({ text: 'ganjil', facets: true });
      expect(r).toMatchObject({ total: 5001, totalCapped: false, facetsApproximate: true });
      expect(r.facets!.mt).toEqual([{ value: await codeId('material_types', 'BUKU'), count: 5000 }]);
      expect(r.recordIds).toHaveLength(20);
    });

    it('10 001 hits → the total stops at 10 000 (totalCapped), with text and without; page 51 is past the limit', async () => {
      expect(await search({ text: 'massal' })).toMatchObject({ total: 10_000, totalCapped: true, pageLimitReached: false });
      expect(await search({})).toMatchObject({ total: 10_000, totalCapped: true });
      expect(await search({ text: 'massal', page: 51 })).toMatchObject({ recordIds: [], pageLimitReached: true, total: 10_000 });
      const deep = await search({ text: 'massal', page: 50, pageSize: 200 });
      expect(deep.recordIds).toHaveLength(200);
    });
  });
});
