import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { checkDuplicates, createRecord } from '../../src/catalog/records/index.js';
import { titleCandidates } from '../../src/search/candidates.js';
import { NOW, openRecordsDb, type RecordsDb } from './catalog-records-support.js';

// Phase 2 Task 16: the duplicate check (spec §3.3), on the engine picked by ALTIS_TEST_DB. The full-text candidates
// are Task 15's (`titleCandidates`); here they are replaced by the ids the test names, so that the scoring of this task
// is what is checked, whichever provider is in place.

vi.mock('../../src/search/candidates.js', () => ({ titleCandidates: vi.fn(async () => [] as string[]) }));

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`records: duplicate check [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;
  const candidates = vi.mocked(titleCandidates);

  const create = async (over: Partial<RecordCreateBody>): Promise<string> =>
    (await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Judul', ...over }), NOW)).id;

  beforeAll(async () => {
    db = await openRecordsDb('records-duplicates');
    buku = await db.materialTypeId('BUKU');
  });

  beforeEach(() => {
    candidates.mockReset();
    candidates.mockResolvedValue([]);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('the same ISBN key with an equal or empty qualifier → 100 with reason isbn; another qualifier does not count', async () => {
    const same = await create({ title: 'Negeri 5 Menara', identifiers: [{ type: 'isbn', value: '978-979-22-4861-6' }] });
    const volume = await create({ title: 'Negeri 5 Menara jilid 2', identifiers: [{ type: 'isbn', value: '9789792248616', qualifier: 'jil. 2' }] });
    const archived = await create({ title: 'Negeri 5 Menara (lama)', identifiers: [{ type: 'isbn', value: '9789792248616' }] });
    await db.h.db.updateTable('records').set({ archived_at: NOW }).where('id', '=', archived).execute();

    const found = await checkDuplicates(db.h.db, { title: 'Apa saja', identifiers: [{ type: 'isbn', value: '9789792248616', qualifier: 'jil. 1' }] }, 80);
    expect(found).toEqual([{ recordId: same, title: 'Negeri 5 Menara', year: null, score: 100, reasons: ['isbn'] }]);

    const both = await checkDuplicates(db.h.db, { title: 'Apa saja', identifiers: [{ type: 'isbn', value: '979-22-4861-0' }] }, 80);
    expect(both.map((c) => c.recordId).sort()).toEqual([same, volume].sort());
    expect(both.every((c) => c.score === 100 && c.reasons.join() === 'isbn')).toBe(true);

    // The record being edited is left out.
    expect(await checkDuplicates(db.h.db, { title: 'Apa saja', identifiers: [{ type: 'isbn', value: '9789792248616' }], excludeId: same }, 80)).toEqual([
      { recordId: volume, title: 'Negeri 5 Menara jilid 2', year: null, score: 100, reasons: ['isbn'] },
    ]);
  });

  it('a title candidate scores 60 × Dice of the title keys + 15 year + 15 main agent + 10 publisher, at or above the threshold', async () => {
    const author = { ref: { type: 'person' as const, name: 'Fuadi, Ahmad' }, role: 'aut' as const, isMain: true };
    const exact = await create({ title: 'Ranah 3 Warna', publicationYear: '2011', agents: [author], publisher: { name: 'Gramedia Pustaka Utama' } });
    const titleOnly = await create({ title: 'Ranah 3 Warna', publicationYear: '1999' });
    const far = await create({ title: 'Rantau 1 Muara', publicationYear: '2011' });
    candidates.mockResolvedValue([far, titleOnly, exact]);

    const input = { title: 'Ranah 3 Warna', year: '2011', mainAgentName: 'fuadi,  ahmad', publisherName: 'GRAMEDIA PUSTAKA UTAMA' };
    expect(await checkDuplicates(db.h.db, input, 60)).toEqual([
      { recordId: exact, title: 'Ranah 3 Warna', year: '2011', score: 100, reasons: ['title', 'year', 'agent', 'publisher'] },
      { recordId: titleOnly, title: 'Ranah 3 Warna', year: '1999', score: 60, reasons: ['title'] },
    ]);
    expect(candidates).toHaveBeenCalledWith(db.h.db, 'Ranah 3 Warna', 50);
    // The default threshold of 80 keeps only the first.
    expect((await checkDuplicates(db.h.db, input, 80)).map((c) => c.recordId)).toEqual([exact]);
  });

  it('answers at most 5 candidates, best first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push(await create({ title: 'Kumpulan Cerpen Pilihan' }));
    candidates.mockResolvedValue(ids);
    const found = await checkDuplicates(db.h.db, { title: 'Kumpulan Cerpen Pilihan' }, 50);
    expect(found).toHaveLength(5);
    expect(found.every((c) => c.score === 60)).toBe(true);
  });
});
