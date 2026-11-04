import { newId } from '@altis/shared';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  archiveRecord,
  createRecord,
  recordBodyFromDraft,
  restoreRecord,
  setCover,
  updateRecord,
} from '../../src/catalog/records/index.js';
import * as core from '../../src/index.js';
import {
  ACTOR,
  NOW,
  audits,
  changedEvents,
  failure,
  fieldErrors,
  openRecordsDb,
  seedCustomField,
  seedFile,
  seedItem,
  seedMaterialType,
  type RecordsDb,
} from './catalog-records-support.js';

// Phase 2 Task 16: saving bibliographic records (spec §3.1, §3.2, §3.7, §3.8; S4), archive and restore, the cover, and
// the draft mapping, on the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe('the records barrel (M14)', () => {
  it('exports the names of the Task 16 interface through @altis/core', () => {
    for (const name of [
      'createRecord',
      'updateRecord',
      'archiveRecord',
      'restoreRecord',
      'mergeRecord',
      'setCover',
      'checkDuplicates',
      'recordBodyFromDraft',
      'loadRecordData',
      'listRecords',
      'recordDetail',
    ]) {
      expect({ name, inCore: typeof (core as Record<string, unknown>)[name] }).toEqual({ name, inCore: 'function' });
    }
  });
});

describe.skipIf(!ctx.available)(`records: save, archive, restore, cover, drafts [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;

  const body = (over: Partial<RecordCreateBody> = {}): RecordCreateBody => ({ materialTypeId: buku, title: 'Laskar Pelangi', ...over });
  const create = (b: RecordCreateBody, o?: Parameters<typeof createRecord>[2], now = NOW) => db.run((tx) => createRecord(tx, b, o), now);
  const row = (id: string) => db.h.db.selectFrom('records').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  beforeAll(async () => {
    db = await openRecordsDb('records-save');
    buku = await db.materialTypeId('BUKU');
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('createRecord', () => {
    it('writes the row with title_key and changed_at, audits catalog.record.create and publishes catalog.record.changed', async () => {
      const r = await create(body({ subtitle: 'Sebuah Novel', publicationYear: '2005', summary: 'Kisah anak Belitung.', opacVisible: false }));
      expect(r).toEqual({ id: expect.any(String), version: 0, warnings: [], authoritiesCreated: 0 });
      expect(await row(r.id)).toMatchObject({
        title: 'Laskar Pelangi',
        subtitle: 'Sebuah Novel',
        title_key: 'laskar pelangi sebuah novel',
        publication_year: '2005',
        summary: 'Kisah anak Belitung.',
        opac_visible: 0,
        source: 'manual',
        changed_at: NOW,
        created_at: NOW,
        created_by: ACTOR.id,
        version: 0,
        archived_at: null,
      });
      const entries = await audits(db, 'catalog.record.create', r.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        entity: 'records',
        meta: { fields: expect.arrayContaining(['title', 'subtitle', 'publicationYear', 'summary', 'opacVisible']), authoritiesCreated: 0 },
      });
      expect(await changedEvents(db, r.id)).toBe(1);
    });

    it('bulk mode neither audits nor publishes (the caller audits once)', async () => {
      const r = await create(body({ title: 'Sang Pemimpi' }), { mode: 'bulk', source: 'import:01JRUNRUNRUNRUNRUNRUNRUNRU' });
      expect(await audits(db, 'catalog.record.create', r.id)).toEqual([]);
      expect(await changedEvents(db, r.id)).toBe(0);
      expect((await row(r.id)).source).toBe('import:01JRUNRUNRUNRUNRUNRUNRUNRU');
    });

    it('identifiers: ISBN-10 0-306-40615-2 → value_key 9780306406157; a bad check digit is stored with is_valid 0 and a warning', async () => {
      const r = await create(
        body({
          identifiers: [
            { type: 'isbn', value: '0-306-40615-2' },
            { type: 'isbn', value: '978-0-306-40615-8', qualifier: 'jil. 2' },
            { type: 'issn', value: '0317-8472' },
            { type: 'doi', value: 'https://doi.org/10.1000/ABC' },
            { type: 'isbn', value: '0306406152' },
          ],
        }),
      );
      expect(r.warnings).toEqual([
        { path: 'identifiers.1.value', code: 'isbn_invalid' },
        { path: 'identifiers.2.value', code: 'issn_invalid' },
      ]);
      const ids = await db.h.db
        .selectFrom('record_identifiers')
        .select(['type', 'value_display', 'value_key', 'qualifier', 'is_valid', 'sort_order'])
        .where('record_id', '=', r.id)
        .orderBy('sort_order')
        .execute();
      // The fifth is the first one again (the same key): kept once.
      expect(ids).toEqual([
        { type: 'isbn', value_display: '0-306-40615-2', value_key: '9780306406157', qualifier: null, is_valid: 1, sort_order: 0 },
        { type: 'isbn', value_display: '978-0-306-40615-8', value_key: '9780306406158', qualifier: 'jil. 2', is_valid: 0, sort_order: 1 },
        { type: 'issn', value_display: '0317-8472', value_key: '03178472', qualifier: null, is_valid: 0, sort_order: 2 },
        { type: 'doi', value_display: 'https://doi.org/10.1000/ABC', value_key: '10.1000/abc', qualifier: null, is_valid: 1, sort_order: 3 },
      ]);
    });

    it('inline agents, subjects and publisher are found or created by key: the agent is created once across two records', async () => {
      const agents = [{ ref: { type: 'person' as const, name: 'Hirata, Andrea' }, role: 'aut' as const, isMain: true }];
      const first = await create(
        body({ agents, subjects: [{ ref: { type: 'topic', term: 'Pendidikan' }, isPrimary: true }], publisher: { name: 'Bentang Pustaka', place: 'Yogyakarta' } }),
      );
      expect(first.authoritiesCreated).toBe(3);
      const second = await create(body({ title: 'Edensor', agents, subjects: [{ ref: { type: 'topic', term: 'pendidikan' }, isPrimary: false }] }));
      expect(second.authoritiesCreated).toBe(0);
      const found = await db.h.db.selectFrom('agents').select('id').where('name_key', '=', 'HIRATA, ANDREA').execute();
      expect(found).toHaveLength(1);
      const links = await db.h.db.selectFrom('record_agents').select(['record_id', 'agent_id', 'role', 'is_main']).where('agent_id', '=', found[0]!.id).orderBy('record_id').execute();
      expect(links).toEqual(
        [first.id, second.id].sort().map((record_id) => ({ record_id, agent_id: found[0]!.id, role: 'aut', is_main: 1 })),
      );
      expect((await audits(db, 'catalog.record.create', first.id))[0]?.meta['authoritiesCreated']).toBe(3);
      const pub = await db.h.db.selectFrom('publishers').select(['id', 'place']).where('name_key', '=', 'BENTANG PUSTAKA').executeTakeFirstOrThrow();
      expect((await row(first.id)).publisher_id).toBe(pub.id);
    });

    it('an unknown authority id is VALIDATION_FAILED at its ref, before anything is written', async () => {
      const before = await db.h.db.selectFrom('agents').select('id').execute();
      expect(
        await fieldErrors(
          create(
            body({
              agents: [
                { ref: { type: 'person', name: 'Orang Baru Sekali' }, role: 'aut', isMain: true },
                { ref: { id: newId() }, role: 'edt', isMain: false },
              ],
              publisher: { id: newId() },
            }),
          ),
        ),
      ).toEqual([
        { path: 'publisher', code: 'not_found' },
        { path: 'agents.1.ref', code: 'not_found' },
      ]);
      expect(await db.h.db.selectFrom('agents').select('id').execute()).toEqual(before);
    });

    it('S4: links become public URL attachments; a javascript: URL is skipped with invalid_url at links.1.url', async () => {
      const r = await create(body({ links: [{ url: 'https://a.example' }, { url: 'javascript:x' }] }));
      expect(r.warnings).toEqual([{ path: 'links.1.url', code: 'invalid_url' }]);
      const rows = await db.h.db.selectFrom('attachments').select(['kind', 'url', 'access', 'title', 'file_id']).where('record_id', '=', r.id).execute();
      expect(rows).toEqual([{ kind: 'url', url: 'https://a.example/', access: 'public', title: 'https://a.example/', file_id: null }]);
    });

    it('§3.8 template: a missing required subtitle → required at subtitle; a value in a hidden field → hidden', async () => {
      const skripsi = await seedMaterialType(db, 'SKRIPSI-UJI', {
        fields: { subtitle: 'required', series: 'hidden', agents: 'required', rda: 'hidden' },
        defaults: {},
        customFields: [],
      });
      expect(await fieldErrors(create(body({ materialTypeId: skripsi, series: 'Seri Uji', contentType: 'txt' })))).toEqual([
        { path: 'subtitle', code: 'required' },
        { path: 'series', code: 'hidden' },
        { path: 'contentType', code: 'hidden' },
        { path: 'agents', code: 'required' },
      ]);
      const ok = await create(
        body({ materialTypeId: skripsi, subtitle: 'Studi Kasus', agents: [{ ref: { type: 'person', name: 'Mahasiswa, Uji' }, role: 'aut', isMain: true }] }),
      );
      // A patch keeps the template: clearing the subtitle is refused, the stored agents count for `required`.
      expect(await fieldErrors(db.run((tx) => updateRecord(tx, ok.id, { version: 0, subtitle: null })))).toEqual([{ path: 'subtitle', code: 'required' }]);
      expect((await db.run((tx) => updateRecord(tx, ok.id, { version: 0, edition: 'Cet. 2' }))).version).toBe(1);
    });

    it('refuses an unknown or archived material type and language, and an unknown related record', async () => {
      const archived = await seedMaterialType(db, 'ARSIP-UJI', { fields: {}, defaults: {}, customFields: [] });
      await db.h.db.updateTable('material_types').set({ archived_at: NOW }).where('id', '=', archived).execute();
      expect(await fieldErrors(create(body({ materialTypeId: archived })))).toEqual([{ path: 'materialTypeId', code: 'archived' }]);
      expect(await fieldErrors(create(body({ materialTypeId: newId(), languageId: newId(), relations: [{ relatedId: newId(), type: 'related' }] })))).toEqual([
        { path: 'materialTypeId', code: 'not_found' },
        { path: 'languageId', code: 'not_found' },
        { path: 'relations.0.relatedId', code: 'not_found' },
      ]);
    });

    it('custom fields (§3.7): stored by code; a bad value → custom.<code>; a required field shown by the template → required', async () => {
      await seedCustomField(db, { code: 'halaman', type: 'number' });
      await seedCustomField(db, { code: 'wajib', type: 'text', required: true });
      const r = await create(body({ custom: { halaman: 120 } }));
      const values = await db.h.db.selectFrom('custom_values as v').innerJoin('custom_field_defs as d', 'd.id', 'v.field_id').select(['d.code_display', 'v.value']).where('v.entity_id', '=', r.id).execute();
      expect(values).toEqual([{ code_display: 'halaman', value: '120' }]);
      expect(await fieldErrors(create(body({ custom: { halaman: 'seratus' } })))).toEqual([{ path: 'custom.halaman', code: 'invalid_type' }]);
      expect(await fieldErrors(create(body({ custom: { tidakada: 1 } })))).toEqual([{ path: 'custom', code: 'unrecognized_keys' }]);
      // `wajib` is required only where the template shows it.
      const tesis = await seedMaterialType(db, 'TESIS-UJI', { fields: {}, defaults: {}, customFields: ['wajib'] });
      expect(await fieldErrors(create(body({ materialTypeId: tesis })))).toEqual([{ path: 'custom.wajib', code: 'required' }]);
      expect((await create(body({ materialTypeId: tesis, custom: { wajib: 'ada' } }))).warnings).toEqual([]);
    });
  });

  describe('updateRecord', () => {
    it('changes the fields sent, moves changed_at and title_key, bumps the version and audits the changed fields', async () => {
      const r = await create(body({ title: 'Maryamah Karpov', series: 'Tetralogi' }));
      const u = await db.run((tx) => updateRecord(tx, r.id, { version: 0, title: 'Maryamah Karpov: Mimpi-mimpi Lintang', series: 'Tetralogi' }), NOW + 10);
      expect(u).toEqual({ id: r.id, version: 1, warnings: [], authoritiesCreated: 0 });
      expect(await row(r.id)).toMatchObject({ title_key: 'maryamah karpov mimpi mimpi lintang', changed_at: NOW + 10, updated_at: NOW + 10, version: 1, series: 'Tetralogi' });
      expect((await audits(db, 'catalog.record.update', r.id)).map((e) => e.meta)).toEqual([{ fields: ['title'], authoritiesCreated: 0 }]);
      expect(await changedEvents(db, r.id)).toBe(2); // the create's and the update's
    });

    it('a stale version → CONFLICT_STALE, nothing written', async () => {
      const r = await create(body({ title: 'Padang Bulan' }));
      await db.run((tx) => updateRecord(tx, r.id, { version: 0, edition: 'Cet. 1' }));
      expect(await failure(db.run((tx) => updateRecord(tx, r.id, { version: 0, edition: 'Cet. 9' })))).toEqual({ code: 'CONFLICT_STALE' });
      expect(await row(r.id)).toMatchObject({ edition: 'Cet. 1', version: 1 });
      expect(await failure(db.run((tx) => updateRecord(tx, newId(), { version: 0 })))).toEqual({ code: 'NOT_FOUND' });
    });

    it('a list sent replaces the list; a relation to itself → self', async () => {
      const other = await create(body({ title: 'Cinta di Dalam Gelas' }));
      const r = await create(body({ title: 'Padang Bulan 2', identifiers: [{ type: 'isbn', value: '9786028811217' }] }));
      expect(await fieldErrors(db.run((tx) => updateRecord(tx, r.id, { version: 0, relations: [{ relatedId: r.id, type: 'related' }] })))).toEqual([
        { path: 'relations.0.relatedId', code: 'self' },
      ]);
      await db.run((tx) => updateRecord(tx, r.id, { version: 0, identifiers: [], relations: [{ relatedId: other.id, type: 'other_edition' }] }));
      expect(await db.h.db.selectFrom('record_identifiers').select('id').where('record_id', '=', r.id).execute()).toEqual([]);
      expect(await db.h.db.selectFrom('record_relations').select(['related_id', 'type']).where('record_id', '=', r.id).execute()).toEqual([
        { related_id: other.id, type: 'other_edition' },
      ]);
    });
  });

  describe('archive and restore', () => {
    it('a record with one live item → 409 CATALOG_RECORD_HAS_ITEMS with meta.count 1; archived items do not count', async () => {
      const r = await create(body({ title: 'Ayah' }));
      const item = await seedItem(db, r.id);
      await seedItem(db, r.id, { status: 'withdrawn', archived: true });
      expect(await failure(db.run((tx) => archiveRecord(tx, r.id, 0)))).toEqual({ code: 'CATALOG_RECORD_HAS_ITEMS', meta: { count: 1 } });
      await db.h.db.updateTable('items').set({ archived_at: NOW, status: 'withdrawn' }).where('id', '=', item).execute();
      expect(await db.run((tx) => archiveRecord(tx, r.id, 0), NOW + 20)).toEqual({ version: 1 });
      expect(await row(r.id)).toMatchObject({ archived_at: NOW + 20, changed_at: NOW + 20, version: 1 });
      expect(await audits(db, 'catalog.record.archive', r.id)).toHaveLength(1);
      expect(await failure(db.run((tx) => archiveRecord(tx, r.id, 0)))).toEqual({ code: 'CONFLICT_STALE' });
      expect(await db.run((tx) => restoreRecord(tx, r.id, 1), NOW + 30)).toEqual({ version: 2 });
      expect(await row(r.id)).toMatchObject({ archived_at: null, changed_at: NOW + 30, version: 2 });
      expect(await audits(db, 'catalog.record.restore', r.id)).toHaveLength(1);
    });
  });

  describe('setCover', () => {
    it('claims a catalog.cover file (owner records, access public); a new cover releases the old one; null removes it', async () => {
      const r = await create(body({ title: 'Sirkus Pohon' }));
      const first = await seedFile(db, { context: 'catalog.cover' });
      const second = await seedFile(db, { context: 'catalog.cover' });
      expect(await db.run((tx) => setCover(tx, r.id, first, 0))).toEqual({ version: 1 });
      const file = (id: string) => db.h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', id).executeTakeFirstOrThrow();
      expect(await file(first)).toEqual({ owner_type: 'records', owner_id: r.id, access: 'public' });
      expect((await row(r.id)).cover_file_id).toBe(first);
      await db.run((tx) => setCover(tx, r.id, second, 1));
      expect(await file(first)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
      expect(await file(second)).toEqual({ owner_type: 'records', owner_id: r.id, access: 'public' });
      expect((await audits(db, 'catalog.record.update', r.id)).map((e) => e.meta)).toEqual([{ fields: ['cover'] }, { fields: ['cover'] }]);
      await db.run((tx) => setCover(tx, r.id, null, 2));
      expect((await row(r.id)).cover_file_id).toBeNull();
      expect(await file(second)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
    });

    it('refuses a file of another context or with another owner', async () => {
      const r = await create(body({ title: 'Guru Aini' }));
      const attachment = await seedFile(db, { context: 'catalog.attachment' });
      const owned = await seedFile(db, { context: 'catalog.cover', ownerType: 'records', ownerId: newId() });
      expect(await fieldErrors(db.run((tx) => setCover(tx, r.id, attachment, 0)))).toEqual([{ path: 'fileId', code: 'invalid' }]);
      expect(await fieldErrors(db.run((tx) => setCover(tx, r.id, owned, 0)))).toEqual([{ path: 'fileId', code: 'invalid' }]);
      expect(await fieldErrors(db.run((tx) => setCover(tx, r.id, newId(), 0)))).toEqual([{ path: 'fileId', code: 'not_found' }]);
    });
  });

  describe('recordBodyFromDraft', () => {
    const draft = (over: Partial<RecordDraft> = {}): RecordDraft => ({
      materialTypeCode: null,
      title: 'Bumi Manusia',
      publisher: { name: 'Hasta Mitra', place: 'Jakarta' },
      identifiers: [{ type: 'isbn', value: '979-8659-12-1' }],
      agents: [{ type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', role: 'aut', isMain: true }],
      subjects: [{ type: 'topic', term: 'Sejarah', isPrimary: true }],
      links: [{ url: 'https://contoh.example/bumi', title: 'Teks lengkap' }],
      items: [{ barcode: 'B0000001' }],
      marcExtra: [{ tag: '500', ind1: ' ', ind2: ' ', data: '[["a","Catatan"]]' }],
      ...over,
    });

    it('maps codes to ids and authorities to refs; links survive (S4); items are left to the caller', async () => {
      const ebook = await db.materialTypeId('EBOOK');
      const ind = await db.languageId('ind');
      const { body: b, warnings } = await recordBodyFromDraft(db.h.db, draft({ materialTypeCode: 'ebook', languageCode: 'IND', publicationYear: '1980' }), {
        defaultMaterialTypeId: buku,
      });
      expect(warnings).toEqual([]);
      expect(b).toEqual({
        materialTypeId: ebook,
        title: 'Bumi Manusia',
        publisher: { name: 'Hasta Mitra', place: 'Jakarta' },
        publicationYear: '1980',
        languageId: ind,
        identifiers: [{ type: 'isbn', value: '979-8659-12-1' }],
        agents: [{ ref: { type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006' }, role: 'aut', isMain: true }],
        subjects: [{ ref: { type: 'topic', term: 'Sejarah' }, isPrimary: true }],
        links: [{ url: 'https://contoh.example/bumi', title: 'Teks lengkap' }],
        marcExtra: [{ tag: '500', ind1: ' ', ind2: ' ', data: '[["a","Catatan"]]' }],
      });
      const r = await create(b);
      expect(await db.h.db.selectFrom('attachments').select('url').where('record_id', '=', r.id).execute()).toEqual([{ url: 'https://contoh.example/bumi' }]);
    });

    it('an unknown material type or language code → the default and a warning', async () => {
      const { body: b, warnings } = await recordBodyFromDraft(db.h.db, draft({ materialTypeCode: 'TIDAK-ADA', languageCode: 'xxx' }), { defaultMaterialTypeId: buku });
      expect(b.materialTypeId).toBe(buku);
      expect(b.languageId).toBeUndefined();
      expect(warnings).toEqual(['material_type_unknown', 'language_unknown']);
      expect((await recordBodyFromDraft(db.h.db, draft(), { defaultMaterialTypeId: buku })).body.materialTypeId).toBe(buku);
    });
  });
});
