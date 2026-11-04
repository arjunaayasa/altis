import { newId } from '@altis/shared';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createRecord, mergeRecord, restoreRecord, updateRecord } from '../../src/catalog/records/index.js';
import { NOW, audits, changedEvents, failure, openRecordsDb, seedItem, type RecordsDb } from './catalog-records-support.js';

// Phase 2 Task 16: merging records (spec §3.3; Review Focus 4, decision P2-20), on the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`records: merge [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;

  const create = async (over: Partial<RecordCreateBody> = {}): Promise<string> =>
    (await db.run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Ronggeng Dukuh Paruk', ...over }))).id;
  const record = (id: string) => db.h.db.selectFrom('records').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const merge = (target: string, source: string, version: number, now = NOW + 100) => db.run((tx) => mergeRecord(tx, target, source, version), now);

  beforeAll(async () => {
    db = await openRecordsDb('records-merge');
    buku = await db.materialTypeId('BUKU');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('moves 2 items and 1 attachment, drops the duplicate ISBN, joins agents and subjects, archives the source', async () => {
    const hirata = { ref: { type: 'person' as const, name: 'Tohari, Ahmad' }, role: 'aut' as const, isMain: true };
    const target = await create({
      identifiers: [{ type: 'isbn', value: '9789792201963' }],
      agents: [hirata],
      subjects: [{ ref: { type: 'topic', term: 'Budaya Jawa' }, isPrimary: true }],
    });
    const source = await create({
      title: 'Ronggeng Dukuh Paruk (cetak ulang)',
      identifiers: [
        { type: 'isbn', value: '978-979-22-0196-3' },
        { type: 'isbn', value: '9786020301129' },
      ],
      agents: [hirata, { ref: { type: 'person', name: 'Penyunting, Uji' }, role: 'edt', isMain: false }],
      subjects: [
        { ref: { type: 'topic', term: 'budaya jawa' }, isPrimary: false },
        { ref: { type: 'topic', term: 'Ronggeng' }, isPrimary: false },
      ],
      links: [{ url: 'https://contoh.example/ronggeng' }],
    });
    const items = [await seedItem(db, source), await seedItem(db, source)];

    expect(await merge(target, source, 0)).toEqual({ version: 1 });

    expect(await db.h.db.selectFrom('items').select('record_id').where('id', 'in', items).execute()).toEqual([{ record_id: target }, { record_id: target }]);
    expect(await db.h.db.selectFrom('attachments').select(['record_id', 'url']).where('record_id', 'in', [target, source]).execute()).toEqual([
      { record_id: target, url: 'https://contoh.example/ronggeng' },
    ]);
    const identifiers = await db.h.db
      .selectFrom('record_identifiers')
      .select(['record_id', 'value_key'])
      .where('record_id', 'in', [target, source])
      .orderBy('value_key')
      .execute();
    expect(identifiers).toEqual([
      { record_id: target, value_key: '9786020301129' },
      { record_id: target, value_key: '9789792201963' },
    ]);
    const agentLinks = await db.h.db.selectFrom('record_agents').select(['record_id', 'role', 'is_main']).where('record_id', 'in', [target, source]).orderBy('role').execute();
    expect(agentLinks).toEqual([
      { record_id: target, role: 'aut', is_main: 1 },
      { record_id: target, role: 'edt', is_main: 0 },
    ]);
    const subjectLinks = await db.h.db.selectFrom('record_subjects').select(['record_id', 'is_primary']).where('record_id', 'in', [target, source]).orderBy('sort_order').execute();
    expect(subjectLinks).toEqual([
      { record_id: target, is_primary: 1 },
      { record_id: target, is_primary: 0 },
    ]);

    expect(await record(source)).toMatchObject({ merged_into: target, archived_at: NOW + 100, changed_at: NOW + 100, version: 1 });
    expect(await record(target)).toMatchObject({ merged_into: null, archived_at: null, changed_at: NOW + 100, version: 1 });
    expect(await audits(db, 'catalog.record.merge', target)).toEqual([
      {
        entity: 'records',
        meta: { sourceId: source, moved: { items: 2, attachments: 1, identifiers: 1, agents: 1, subjects: 1, relations: 0 }, repointed: 0 },
      },
    ]);
    expect(await changedEvents(db, target)).toBe(2); // its create and the merge
    expect(await changedEvents(db, source)).toBe(2);
  });

  it('moves relations in both directions and drops the links between the two', async () => {
    const x = await create({ title: 'Lintang Kemukus Dini Hari' });
    const y = await create({ title: 'Jantera Bianglala' });
    const target = await create({ title: 'Trilogi' });
    const source = await create({
      title: 'Trilogi (salinan)',
      relations: [
        { relatedId: x, type: 'related' },
        { relatedId: target, type: 'other_edition' },
      ],
    });
    await db.run((tx) => updateRecord(tx, y, { version: 0, relations: [{ relatedId: source, type: 'part_of' }] }));
    await db.run((tx) => updateRecord(tx, target, { version: 0, relations: [{ relatedId: source, type: 'related' }, { relatedId: x, type: 'related' }] }));

    await merge(target, source, 1);
    const relations = await db.h.db.selectFrom('record_relations').select(['record_id', 'related_id', 'type']).where('record_id', 'in', [x, y, target, source]).execute();
    expect(relations.sort((a, b) => (a.record_id + a.type).localeCompare(b.record_id + b.type))).toEqual(
      [
        { record_id: target, related_id: x, type: 'related' },
        { record_id: y, related_id: target, type: 'part_of' },
      ].sort((a, b) => (a.record_id + a.type).localeCompare(b.record_id + b.type)),
    );
  });

  it('Review Focus 4: after A→B and B→C, A.merged_into is C; merging C into A or restoring A → CATALOG_MERGE_INVALID', async () => {
    const a = await create({ title: 'A' });
    const b = await create({ title: 'B' });
    const c = await create({ title: 'C' });
    await merge(b, a, 0);
    expect((await record(a)).merged_into).toBe(b);
    await merge(c, b, 0);
    expect((await record(a)).merged_into).toBe(c);
    expect((await record(b)).merged_into).toBe(c);
    expect((await audits(db, 'catalog.record.merge', c))[0]?.meta['repointed']).toBe(1);
    expect(await failure(merge(a, c, 1))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' });
    expect(await failure(merge(c, a, 1))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' }); // A is merged already
    expect(await failure(db.run((tx) => restoreRecord(tx, a, 1)))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' });
    expect(await failure(db.run((tx) => updateRecord(tx, a, { version: 1, title: 'A lagi' })))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' });
  });

  it('refuses the same record, an archived target, a stale version and an unknown record', async () => {
    const t = await create({ title: 'Target' });
    const s = await create({ title: 'Sumber' });
    expect(await failure(merge(t, t, 0))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' });
    expect(await failure(merge(t, s, 3))).toEqual({ code: 'CONFLICT_STALE' });
    expect(await failure(merge(t, newId(), 0))).toEqual({ code: 'NOT_FOUND' });
    expect(await failure(merge(newId(), s, 0))).toEqual({ code: 'NOT_FOUND' });
    await db.h.db.updateTable('records').set({ archived_at: NOW }).where('id', '=', t).execute();
    expect(await failure(merge(t, s, 0))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' });
    // Nothing of the refused merges was written.
    expect(await record(s)).toMatchObject({ merged_into: null, archived_at: null, version: 0 });
  });
});
