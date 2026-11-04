import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId, normalizeKey } from '@altis/shared';
import type { CustomFieldBody, MaterialTypeBody } from '@altis/shared/api/catalog/masters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import {
  archiveCollectionType,
  archiveCustomField,
  archiveLanguage,
  archiveMaterialType,
  archiveSupplier,
  createCollectionType,
  createCustomField,
  createLanguage,
  createMaterialType,
  createSupplier,
  listCollectionTypes,
  listCustomFields,
  listLanguages,
  listMaterialTypes,
  listSuppliers,
  masterUsage,
  updateCollectionType,
  updateCustomField,
  updateLanguage,
  updateMaterialType,
  updateSupplier,
} from '../../src/catalog/masters/index.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';
import * as core from '../../src/index.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { searchJobs } from '../../src/search/jobs.js';

// Phase 2 Task 12: the masters (spec §2.2, §2.6, §3.7, §3.8; Review Focus 2) on the engine picked by ALTIS_TEST_DB:
// material types with their templates, languages, collection types, suppliers and custom fields. A code is unique on
// its key, a stale version is CONFLICT_STALE, a master that live records or items use cannot be archived
// (CATALOG_IN_USE with meta.count), a custom field always can, and every write audits catalog.master.* once.

const ctx = testDbContext();

/** In the past: an audit entry may not be dated ahead of the real clock (R51). */
const NOW = Date.UTC(2026, 8, 2, 9, 0, 0);
const STAFF = newId(NOW - 86_400_000);
const ACTOR: Actor = { type: 'staff', id: STAFF, ip: null };

/** What a rejected promise rejected with: `{code, meta?}` for a DomainError, else the error; 'resolved' when it did not. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, ...(e.meta === undefined ? {} : { meta: e.meta }) } : e),
  );
}

/** The field errors of a rejected VALIDATION_FAILED (or the failure itself, to show what came instead). */
async function fieldErrors(p: Promise<unknown>): Promise<unknown> {
  const f = await failure(p);
  if (typeof f === 'object' && f !== null && (f as { code?: unknown }).code === 'VALIDATION_FAILED') {
    return (f as { meta: { errors: unknown } }).meta.errors;
  }
  return f;
}

const SEED_MATERIAL_TYPES = ['BUKU', 'EBOOK', 'KARYA-ILMIAH', 'BERSERI', 'PETA', 'AUDIO', 'VIDEO', 'CAMPURAN'];

describe('the masters barrel (M14)', () => {
  it('exports the names of the Task 12 interface through @altis/core', () => {
    const names = ['masterUsage'];
    for (const x of ['MaterialType', 'Language', 'CollectionType', 'Supplier', 'CustomField']) {
      names.push(`list${x}s`, `create${x}`, `update${x}`, `archive${x}`);
    }
    for (const name of names) {
      expect({ name, inCore: typeof (core as Record<string, unknown>)[name] }).toEqual({ name, inCore: 'function' });
    }
  });
});

describe.skipIf(!ctx.available)(`masters: material types, languages, collection types, suppliers, custom fields [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let branchId: string;
  let buku: string;

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, now = NOW): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR)));

  /** The audit entries of `action` after `seq`, as `{entity, entityId, meta}`. */
  async function auditsAfter(seq: number, action: string): Promise<{ entity: string | null; entityId: string | null; meta: unknown }[]> {
    const rows = await h.db
      .selectFrom('audit_log')
      .select(['entity', 'entity_id', 'meta'])
      .where('seq', '>', seq)
      .where('action', '=', action)
      .orderBy('seq')
      .execute();
    return rows.map((r) => ({ entity: r.entity, entityId: r.entity_id, meta: JSON.parse(r.meta) as unknown }));
  }

  async function lastSeq(): Promise<number> {
    const row = await h.db.selectFrom('audit_log').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  /** A live (or archived) record of material type `materialTypeId`, written straight into the table. */
  async function seedRecord(materialTypeId: string, o: { languageId?: string; archived?: boolean } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: materialTypeId,
        title: 'Cantuman Uji',
        subtitle: null,
        responsibility: null,
        title_key: 'cantuman uji',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: null,
        language_id: o.languageId ?? null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        source: 'manual',
        merged_into: null,
        changed_at: NOW,
        archived_at: o.archived === true ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** A live (or archived) item of a new record, of collection type `collectionTypeId`, from `supplierId`. */
  async function seedItem(collectionTypeId: string, o: { supplierId?: string; archived?: boolean } = {}): Promise<string> {
    const recordId = await seedRecord(buku);
    const id = newId();
    const barcode = `UJI${id.slice(-12)}`;
    await h.db
      .insertInto('items')
      .values({
        id,
        record_id: recordId,
        branch_id: branchId,
        barcode_display: barcode,
        barcode_key: barcode,
        inventory_no: null,
        call_number: null,
        location_id: null,
        collection_type_id: collectionTypeId,
        status: o.archived === true ? 'withdrawn' : 'available',
        status_note: null,
        acq_source: null,
        order_no: null,
        order_date: null,
        received_date: null,
        invoice_date: null,
        supplier_id: o.supplierId ?? null,
        invoice_no: null,
        price: null,
        currency: null,
        note: null,
        archived_at: o.archived === true ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  const materialTypeBody = (over: Partial<MaterialTypeBody> = {}): MaterialTypeBody => ({
    code: `JB-${newId().slice(-8)}`,
    nameId: 'Partitur',
    nameEn: 'Score',
    marcType: 'c',
    marcLevel: 'm',
    contentType: 'ntm',
    mediaType: 'n',
    carrierType: 'nc',
    schemaType: 'MusicComposition',
    dcmiType: 'Text',
    template: { fields: {}, defaults: {}, customFields: [] },
    sortOrder: 90,
    ...over,
  });

  const customFieldBody = (over: Partial<CustomFieldBody> = {}): CustomFieldBody =>
    ({
      entity: 'records',
      type: 'text',
      code: `rf_${newId().slice(-8).toLowerCase()}`,
      labelId: 'Nomor induk lama',
      labelEn: 'Old accession number',
      required: false,
      sortOrder: 10,
      isPublic: false,
      isSearchable: false,
      ...over,
    }) as CustomFieldBody;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-masters-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  describe('lists', () => {
    it('the 8 seeded material types come in seed order (sort_order, then code), live, unused, with the empty template', async () => {
      const list = await listMaterialTypes(h.db, {});
      expect(list.slice(0, 8).map((m) => m.code)).toEqual(SEED_MATERIAL_TYPES);
      expect(list[0]).toEqual({
        id: buku,
        code: 'BUKU',
        nameId: 'Buku',
        nameEn: 'Book',
        marcType: 'a',
        marcLevel: 'm',
        contentType: 'txt',
        mediaType: 'n',
        carrierType: 'nc',
        schemaType: 'Book',
        dcmiType: 'Text',
        template: { fields: {}, defaults: {}, customFields: [] },
        sortOrder: 10,
        usage: 0,
        archived: false,
        version: 0,
      });
    });

    it('the seeded languages (by code), collection types (in seed order) with their flags', async () => {
      const languages = await listLanguages(h.db, {});
      expect(languages.map((l) => l.code)).toEqual(expect.arrayContaining(['ind', 'eng', 'ara', 'jav']));
      expect(languages.map((l) => normalizeKey(l.code))).toEqual([...languages.map((l) => normalizeKey(l.code))].sort());
      expect(languages.find((l) => l.code === 'ind')).toMatchObject({ nameId: 'Indonesia', nameEn: 'Indonesian', usage: 0, archived: false, version: 0 });
      const types = await listCollectionTypes(h.db, {});
      expect(types.slice(0, 4).map((t) => [t.code, t.loanable, t.selfService])).toEqual([
        ['UMUM', true, true],
        ['REF', true, false],
        ['FIKSI', true, true],
        ['TANDON', false, true],
      ]);
    });

    it('q filters on the code and the names, whatever their case; archived rows only with includeArchived', async () => {
      expect((await listMaterialTypes(h.db, { q: 'peta' })).map((m) => m.code)).toEqual(['PETA']);
      expect((await listMaterialTypes(h.db, { q: 'sound REC' })).map((m) => m.code)).toEqual(['AUDIO']);
      expect((await listLanguages(h.db, { q: 'jaw' })).map((l) => l.code)).toEqual(['jav']);
      const lang = await run((tx) => createLanguage(tx, { code: 'tet', nameId: 'Tetun', nameEn: 'Tetum' }));
      await run((tx) => archiveLanguage(tx, lang.id, 0));
      expect((await listLanguages(h.db, { q: 'tetun' })).map((l) => l.code)).toEqual([]);
      expect((await listLanguages(h.db, { q: 'tetun', includeArchived: true })).map((l) => [l.code, l.archived])).toEqual([['tet', true]]);
    });
  });

  describe('material types', () => {
    it('create → the view (usage 0, version 0) and one catalog.master.create entry with entity material_types and meta.fields', async () => {
      const seq = await lastSeq();
      const body = materialTypeBody({ code: 'PARTITUR' });
      const view = await run((tx) => createMaterialType(tx, body));
      expect(view).toEqual({ id: expect.any(String), ...body, usage: 0, archived: false, version: 0 });
      expect(await auditsAfter(seq, 'catalog.master.create')).toEqual([
        { entity: 'material_types', entityId: view.id, meta: { fields: Object.keys(body) } },
      ]);
      expect((await listMaterialTypes(h.db, {})).map((m) => m.code)).toContain('PARTITUR');
    });

    it('a template with fields {subtitle: required} round-trips through create, list and update', async () => {
      const template = { fields: { subtitle: 'required' as const }, defaults: {}, customFields: [] };
      const view = await run((tx) => createMaterialType(tx, materialTypeBody({ template })));
      expect(view.template).toEqual(template);
      expect((await listMaterialTypes(h.db, {})).find((m) => m.id === view.id)?.template).toEqual(template);
      const stored = await h.db.selectFrom('material_types').select('template').where('id', '=', view.id).executeTakeFirstOrThrow();
      expect(JSON.parse(stored.template)).toEqual(template);

      const umum = (await listCollectionTypes(h.db, {})).find((t) => t.code === 'UMUM')!.id;
      const ind = (await listLanguages(h.db, {})).find((l) => l.code === 'ind')!.id;
      const next = { fields: { subtitle: 'required' as const, series: 'hidden' as const }, defaults: { collectionTypeId: umum, languageId: ind }, customFields: [] };
      const updated = await run((tx) => updateMaterialType(tx, view.id, { version: 0, template: next }));
      expect(updated).toMatchObject({ template: next, version: 1 });
    });

    it('update changes only what it sends, audits the names of the changed fields; a stale version → CONFLICT_STALE', async () => {
      const view = await run((tx) => createMaterialType(tx, materialTypeBody({ nameEn: 'Music score' })));
      const seq = await lastSeq();
      const updated = await run((tx) => updateMaterialType(tx, view.id, { version: 0, nameId: 'Partitur musik', nameEn: 'Music score', sortOrder: 95 }));
      expect(updated).toEqual({ ...view, nameId: 'Partitur musik', sortOrder: 95, version: 1 });
      expect(await auditsAfter(seq, 'catalog.master.update')).toEqual([
        { entity: 'material_types', entityId: view.id, meta: { fields: ['nameId', 'sortOrder'] } },
      ]);
      expect(await failure(run((tx) => updateMaterialType(tx, view.id, { version: 0, nameId: 'Basi' })))).toMatchObject({ code: 'CONFLICT_STALE' });
      expect(await failure(run((tx) => archiveMaterialType(tx, view.id, 0)))).toMatchObject({ code: 'CONFLICT_STALE' });
      expect(await failure(run((tx) => updateMaterialType(tx, newId(), { version: 0, nameId: 'Tidak ada' })))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a code another master holds (case and spaces aside) is taken, on create and on update; its own code is fine', async () => {
      expect(await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ code: 'buku' }))))).toEqual([{ path: 'code', code: 'taken' }]);
      expect(await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ code: ' karya-ilmiah ' }))))).toEqual([
        { path: 'code', code: 'taken' },
      ]);
      const view = await run((tx) => createMaterialType(tx, materialTypeBody({ code: 'Komik' })));
      expect(await fieldErrors(run((tx) => updateMaterialType(tx, view.id, { version: 0, code: 'EBOOK' })))).toEqual([{ path: 'code', code: 'taken' }]);
      expect(await run((tx) => updateMaterialType(tx, view.id, { version: 0, code: 'KOMIK' }))).toMatchObject({ code: 'KOMIK', version: 1 });
      // An archived master keeps its code (the key is unique over every row).
      await run((tx) => archiveMaterialType(tx, view.id, 1));
      expect(await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ code: 'komik' }))))).toEqual([{ path: 'code', code: 'taken' }]);
    });

    it('a template naming an unknown custom code → template.customFields.<i> not_found; a records field code passes; an item field is unknown', async () => {
      const field = await run((tx) => createCustomField(tx, customFieldBody({ code: 'nomor_lama' })));
      const itemField = await run((tx) => createCustomField(tx, customFieldBody({ entity: 'items', code: 'kode_rak_lama' })));
      expect(field.code).toBe('nomor_lama');
      expect(itemField.entity).toBe('items');
      const template = (customFields: string[]) => ({ fields: {}, defaults: {}, customFields });
      expect(await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ template: template(['NOMOR_LAMA', 'tak_dikenal', 'kode_rak_lama']) }))))).toEqual([
        { path: 'template.customFields.1', code: 'not_found' },
        { path: 'template.customFields.2', code: 'not_found' },
      ]);
      expect(await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ template: template(['nomor_lama', 'Nomor_Lama']) }))))).toEqual([
        { path: 'template.customFields.1', code: 'duplicate' },
      ]);
      const ok = await run((tx) => createMaterialType(tx, materialTypeBody({ template: template(['nomor_lama']) })));
      expect(ok.template.customFields).toEqual(['nomor_lama']);
    });

    it('template defaults must name a live collection type and language', async () => {
      const ct = await run((tx) => createCollectionType(tx, { code: `CT${newId().slice(-6)}`, nameId: 'Hadiah', nameEn: 'Gift', loanable: true, selfService: true, sortOrder: 50 }));
      await run((tx) => archiveCollectionType(tx, ct.id, 0));
      const missing = newId();
      expect(
        await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ template: { fields: {}, defaults: { collectionTypeId: ct.id, languageId: missing }, customFields: [] } })))),
      ).toEqual([
        { path: 'template.defaults.collectionTypeId', code: 'archived' },
        { path: 'template.defaults.languageId', code: 'not_found' },
      ]);
    });

    it('an archived reference the stored template already names is kept on update; a new one is refused', async () => {
      const ct = await run((tx) => createCollectionType(tx, { code: `CT${newId().slice(-6)}`, nameId: 'Pinjam kilat', nameEn: 'Short loan', loanable: true, selfService: false, sortOrder: 60 }));
      const field = await run((tx) => createCustomField(tx, customFieldBody()));
      const template = { fields: {}, defaults: { collectionTypeId: ct.id }, customFields: [field.code] };
      const view = await run((tx) => createMaterialType(tx, materialTypeBody({ template })));
      await run((tx) => archiveCollectionType(tx, ct.id, 0));
      await run((tx) => archiveCustomField(tx, field.id, 0));
      expect(await run((tx) => updateMaterialType(tx, view.id, { version: 0, nameId: 'Partitur lama', template }))).toMatchObject({ version: 1, template });
      expect(
        await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ template })))),
      ).toEqual([
        { path: 'template.defaults.collectionTypeId', code: 'archived' },
        { path: 'template.customFields.0', code: 'archived' },
      ]);
    });

    it('the service checks a body against the strict contract too (a caller other than the API)', async () => {
      const bad = { ...materialTypeBody(), extra: 1 } as unknown as MaterialTypeBody;
      expect(await fieldErrors(run((tx) => createMaterialType(tx, bad)))).toEqual([{ path: '', code: 'unrecognized_keys' }]);
      expect(await fieldErrors(run((tx) => createMaterialType(tx, materialTypeBody({ marcType: 'AB' }))))).toEqual([{ path: 'marcType', code: 'invalid_format' }]);
    });
  });

  describe('Review Focus 2: a master in use cannot be archived', () => {
    it('archiving BUKU with one live record → 409 CATALOG_IN_USE with meta.count = 1; nothing changes', async () => {
      const fresh = await run((tx) => createMaterialType(tx, materialTypeBody({ code: `UJI-${newId().slice(-6)}` })));
      // BUKU itself: the only live record of the database is the one seeded here (earlier tests seeded none of BUKU).
      const live = await h.db.selectFrom('records').select('id').where('material_type_id', '=', buku).where('archived_at', 'is', null).execute();
      expect(live).toEqual([]);
      await seedRecord(buku);
      await seedRecord(buku, { archived: true });
      expect(await masterUsage(h.db, 'material_types', buku)).toBe(1);
      expect(await failure(run((tx) => archiveMaterialType(tx, buku, 0)))).toEqual({ code: 'CATALOG_IN_USE', meta: { count: 1 } });
      const row = await h.db.selectFrom('material_types').select(['archived_at', 'version']).where('id', '=', buku).executeTakeFirstOrThrow();
      expect(row).toEqual({ archived_at: null, version: 0 });
      expect((await listMaterialTypes(h.db, {})).find((m) => m.id === buku)?.usage).toBe(1);

      // An unused master archives: version + 1, one catalog.master.archive entry.
      const seq = await lastSeq();
      expect(await run((tx) => archiveMaterialType(tx, fresh.id, 0))).toEqual({ version: 1 });
      expect(await auditsAfter(seq, 'catalog.master.archive')).toEqual([{ entity: 'material_types', entityId: fresh.id, meta: {} }]);
      expect((await listMaterialTypes(h.db, {})).map((m) => m.id)).not.toContain(fresh.id);
      expect((await listMaterialTypes(h.db, { includeArchived: true })).find((m) => m.id === fresh.id)).toMatchObject({ archived: true, version: 1 });
      // Archiving it again answers as it is (a retried DELETE), with one entry that says so.
      const again = await lastSeq();
      expect(await run((tx) => archiveMaterialType(tx, fresh.id, 1))).toEqual({ version: 1 });
      expect(await auditsAfter(again, 'catalog.master.archive')).toEqual([{ entity: 'material_types', entityId: fresh.id, meta: { alreadyArchived: true } }]);
    });

    it('a language with live records, a collection type and a supplier with live items are in use; archived ones do not count', async () => {
      const lang = await run((tx) => createLanguage(tx, { code: 'sas', nameId: 'Sasak', nameEn: 'Sasak' }));
      await seedRecord(buku, { languageId: lang.id });
      await seedRecord(buku, { languageId: lang.id });
      await seedRecord(buku, { languageId: lang.id, archived: true });
      expect(await failure(run((tx) => archiveLanguage(tx, lang.id, 0)))).toEqual({ code: 'CATALOG_IN_USE', meta: { count: 2 } });
      expect((await listLanguages(h.db, { q: 'sasak' }))[0]?.usage).toBe(2);

      const ct = await run((tx) => createCollectionType(tx, { code: `KL${newId().slice(-6)}`, nameId: 'Koleksi lokal', nameEn: 'Local collection', loanable: true, selfService: true, sortOrder: 70 }));
      const supplier = await run((tx) => createSupplier(tx, { code: `PM${newId().slice(-6)}`, name: 'CV Buku Nusantara' }));
      await seedItem(ct.id, { supplierId: supplier.id });
      await seedItem(ct.id, { archived: true });
      expect(await masterUsage(h.db, 'collection_types', ct.id)).toBe(1);
      expect(await masterUsage(h.db, 'suppliers', supplier.id)).toBe(1);
      expect(await failure(run((tx) => archiveCollectionType(tx, ct.id, 0)))).toEqual({ code: 'CATALOG_IN_USE', meta: { count: 1 } });
      expect(await failure(run((tx) => archiveSupplier(tx, supplier.id, 0)))).toEqual({ code: 'CATALOG_IN_USE', meta: { count: 1 } });
      expect((await listSuppliers(h.db, {})).find((s) => s.id === supplier.id)?.usage).toBe(1);
      expect((await listCollectionTypes(h.db, {})).find((t) => t.id === ct.id)?.usage).toBe(1);
    });
  });

  describe('languages, collection types, suppliers', () => {
    it('language: create, update, archive, each audited once with entity languages', async () => {
      const seq = await lastSeq();
      const view = await run((tx) => createLanguage(tx, { code: 'bjn', nameId: 'Banjar', nameEn: 'Banjar' }));
      expect(view).toEqual({ id: expect.any(String), code: 'bjn', nameId: 'Banjar', nameEn: 'Banjar', usage: 0, archived: false, version: 0 });
      const key = await h.db.selectFrom('languages').select(['code_display', 'code_key']).where('id', '=', view.id).executeTakeFirstOrThrow();
      expect(key).toEqual({ code_display: 'bjn', code_key: 'BJN' });
      expect(await fieldErrors(run((tx) => createLanguage(tx, { code: 'IND', nameId: 'Lagi', nameEn: 'Again' })))).toEqual([{ path: 'code', code: 'taken' }]);
      expect(await run((tx) => updateLanguage(tx, view.id, { version: 0, nameEn: 'Banjarese' }))).toMatchObject({ nameEn: 'Banjarese', version: 1 });
      expect(await run((tx) => archiveLanguage(tx, view.id, 1))).toEqual({ version: 2 });
      expect((await auditsAfter(seq, 'catalog.master.create')).map((a) => a.entity)).toEqual(['languages']);
      expect(await auditsAfter(seq, 'catalog.master.update')).toEqual([{ entity: 'languages', entityId: view.id, meta: { fields: ['nameEn'] } }]);
      expect(await auditsAfter(seq, 'catalog.master.archive')).toEqual([{ entity: 'languages', entityId: view.id, meta: {} }]);
    });

    it('collection type: create, update the flags, archive', async () => {
      const view = await run((tx) => createCollectionType(tx, { code: 'Langka', nameId: 'Koleksi langka', nameEn: 'Rare books', loanable: false, selfService: false, sortOrder: 80 }));
      expect(view).toEqual({
        id: expect.any(String),
        code: 'Langka',
        nameId: 'Koleksi langka',
        nameEn: 'Rare books',
        loanable: false,
        selfService: false,
        sortOrder: 80,
        usage: 0,
        archived: false,
        version: 0,
      });
      const updated = await run((tx) => updateCollectionType(tx, view.id, { version: 0, loanable: true }));
      expect(updated).toMatchObject({ loanable: true, selfService: false, version: 1 });
      expect(await run((tx) => archiveCollectionType(tx, view.id, 1))).toEqual({ version: 2 });
    });

    it('supplier: blank optional texts are stored as null, the contact fields are named in the audit but their values never', async () => {
      const seq = await lastSeq();
      const view = await run((tx) =>
        createSupplier(tx, { code: 'gramedia', name: 'PT Gramedia', contactName: 'Budi Santoso', phone: '  ', email: 'budi@example.test', address: 'Jl. Palmerah 1', note: '' }),
      );
      expect(view).toEqual({
        id: expect.any(String),
        code: 'gramedia',
        name: 'PT Gramedia',
        contactName: 'Budi Santoso',
        phone: null,
        email: 'budi@example.test',
        address: 'Jl. Palmerah 1',
        note: null,
        usage: 0,
        archived: false,
        version: 0,
      });
      const updated = await run((tx) => updateSupplier(tx, view.id, { version: 0, contactName: null, phone: '021-555' }));
      expect(updated).toMatchObject({ contactName: null, phone: '021-555', version: 1 });
      const entries = [...(await auditsAfter(seq, 'catalog.master.create')), ...(await auditsAfter(seq, 'catalog.master.update'))];
      expect(entries.map((e) => e.meta)).toEqual([{ fields: ['code', 'name', 'contactName', 'email', 'address'] }, { fields: ['contactName', 'phone'] }]);
      expect(JSON.stringify(entries)).not.toMatch(/Budi|Palmerah|021-555/);
      expect(await run((tx) => archiveSupplier(tx, view.id, 1))).toEqual({ version: 2 });
      expect((await listSuppliers(h.db, {})).map((s) => s.id)).not.toContain(view.id);
    });
  });

  describe('custom fields', () => {
    it('select options are stored in the §3.7 shape [{value, label_id, label_en}] and read back', async () => {
      const view = await run((tx) =>
        createCustomField(
          tx,
          customFieldBody({
            type: 'select',
            code: 'tingkat',
            options: [
              { value: 'sd', labelId: 'Sekolah dasar', labelEn: 'Primary school' },
              { value: 'smp', labelId: 'Sekolah menengah pertama' },
            ],
            isPublic: true,
          }),
        ),
      );
      expect(view).toMatchObject({
        entity: 'records',
        code: 'tingkat',
        type: 'select',
        options: [
          { value: 'sd', labelId: 'Sekolah dasar', labelEn: 'Primary school' },
          { value: 'smp', labelId: 'Sekolah menengah pertama', labelEn: null },
        ],
        isPublic: true,
        isSearchable: false,
        usage: 0,
        archived: false,
        version: 0,
      });
      const row = await h.db.selectFrom('custom_field_defs').select(['options', 'label', 'label_en', 'entity', 'type']).where('id', '=', view.id).executeTakeFirstOrThrow();
      expect(row.options).toBe(
        JSON.stringify([
          { value: 'sd', label_id: 'Sekolah dasar', label_en: 'Primary school' },
          { value: 'smp', label_id: 'Sekolah menengah pertama', label_en: null },
        ]),
      );
      expect(row).toMatchObject({ label: 'Nomor induk lama', label_en: 'Old accession number', entity: 'records', type: 'select' });
      // A text field stores no options.
      const text = await run((tx) => createCustomField(tx, customFieldBody()));
      expect(text.options).toEqual([]);
      expect((await h.db.selectFrom('custom_field_defs').select('options').where('id', '=', text.id).executeTakeFirstOrThrow()).options).toBeNull();
    });

    it('a select or multiselect without options → options required, on create and on a patch that empties them', async () => {
      expect(await fieldErrors(run((tx) => createCustomField(tx, customFieldBody({ type: 'multiselect' }))))).toEqual([{ path: 'options', code: 'required' }]);
      expect(await fieldErrors(run((tx) => createCustomField(tx, customFieldBody({ type: 'select', options: [] }))))).toEqual([{ path: 'options', code: 'required' }]);
      const view = await run((tx) => createCustomField(tx, customFieldBody({ type: 'multiselect', options: [{ value: 'a', labelId: 'A' }] })));
      expect(await fieldErrors(run((tx) => updateCustomField(tx, view.id, { version: 0, options: [] })))).toEqual([{ path: 'options', code: 'required' }]);
      // Options on a field that has no choices are refused.
      expect(await fieldErrors(run((tx) => createCustomField(tx, customFieldBody({ options: [{ value: 'a', labelId: 'A' }] }))))).toEqual([
        { path: 'options', code: 'not_allowed' },
      ]);
    });

    it('entity or type in a patch is refused by the strict body; the code is unique per entity', async () => {
      const view = await run((tx) => createCustomField(tx, customFieldBody({ code: 'asal' })));
      expect(await fieldErrors(run((tx) => updateCustomField(tx, view.id, { version: 0, type: 'number' } as never)))).toEqual([{ path: '', code: 'unrecognized_keys' }]);
      expect(await fieldErrors(run((tx) => updateCustomField(tx, view.id, { version: 0, entity: 'items' } as never)))).toEqual([{ path: '', code: 'unrecognized_keys' }]);
      expect(await fieldErrors(run((tx) => createCustomField(tx, customFieldBody({ code: 'ASAL' }))))).toEqual([{ path: 'code', code: 'taken' }]);
      expect(await run((tx) => createCustomField(tx, customFieldBody({ entity: 'items', code: 'asal' })))).toMatchObject({ entity: 'items', code: 'asal' });
    });

    it('a code that cannot key a value (a dot, __proto__) is invalid_format', async () => {
      expect(await fieldErrors(run((tx) => createCustomField(tx, customFieldBody({ code: 'a.b' }))))).toEqual([{ path: 'code', code: 'invalid_format' }]);
      expect(await fieldErrors(run((tx) => createCustomField(tx, customFieldBody({ code: '__proto__' }))))).toEqual([{ path: 'code', code: 'invalid_format' }]);
    });

    it('a custom field is archived even with values, which stay; usage counts its values', async () => {
      const view = await run((tx) => createCustomField(tx, customFieldBody()));
      const recordId = await seedRecord(buku);
      await h.db.insertInto('custom_values').values({ field_id: view.id, entity_id: recordId, value: '"B-001"', updated_at: NOW, updated_by: null }).execute();
      expect(await masterUsage(h.db, 'custom_field_defs', view.id)).toBe(1);
      expect((await listCustomFields(h.db, { entity: 'records' })).find((f) => f.id === view.id)?.usage).toBe(1);
      const seq = await lastSeq();
      expect(await run((tx) => archiveCustomField(tx, view.id, 0))).toEqual({ version: 1 });
      expect(await auditsAfter(seq, 'catalog.master.archive')).toEqual([{ entity: 'custom_field_defs', entityId: view.id, meta: {} }]);
      expect(await h.db.selectFrom('custom_values').select('value').where('field_id', '=', view.id).execute()).toEqual([{ value: '"B-001"' }]);
    });

    it('lists by entity, sort order then code', async () => {
      const a = await run((tx) => createCustomField(tx, customFieldBody({ entity: 'items', code: 'zz_urut', sortOrder: 1 })));
      const b = await run((tx) => createCustomField(tx, customFieldBody({ entity: 'items', code: 'aa_urut', sortOrder: 1 })));
      const c = await run((tx) => createCustomField(tx, customFieldBody({ entity: 'items', code: 'mm_urut', sortOrder: 0 })));
      const items = await listCustomFields(h.db, { entity: 'items' });
      expect(items.every((f) => f.entity === 'items')).toBe(true);
      const mine = new Set([a.id, b.id, c.id]);
      expect(items.map((f) => f.id).filter((id) => mine.has(id))).toEqual([c.id, b.id, a.id]);
      expect((await listCustomFields(h.db, {})).some((f) => f.entity === 'records')).toBe(true);
    });

    it('renaming a records field code rewrites the material type templates that name it', async () => {
      const field = await run((tx) => createCustomField(tx, customFieldBody({ code: 'kode_awal' })));
      const mt = await run((tx) => createMaterialType(tx, materialTypeBody({ template: { fields: {}, defaults: {}, customFields: ['KODE_AWAL'] } })));
      const seq = await lastSeq();
      expect(await run((tx) => updateCustomField(tx, field.id, { version: 0, code: 'kode_baru' }))).toMatchObject({ code: 'kode_baru', version: 1 });
      expect((await listMaterialTypes(h.db, {})).find((m) => m.id === mt.id)).toMatchObject({ template: { customFields: ['kode_baru'] }, version: 1 });
      expect(await auditsAfter(seq, 'catalog.master.update')).toEqual([
        { entity: 'custom_field_defs', entityId: field.id, meta: { fields: ['code'], templatesUpdated: 1 } },
      ]);
    });

    it('a change that alters what the search index holds queues catalog.reindex of the records its values feed, or of everything past 1000', async () => {
      const registry = createJobRegistry(
        searchJobs(() => {
          throw new Error('not run here');
        }),
      );
      const reindex = { registry, keyring: [] };
      const reindexJobs = async (): Promise<unknown[]> =>
        (await h.db.selectFrom('jobs').select(['id', 'payload']).where('type', '=', 'catalog.reindex').orderBy('created_at').orderBy('id').execute()).map(
          (j) => JSON.parse(j.payload) as unknown,
        );
      await h.db.deleteFrom('jobs').where('type', '=', 'catalog.reindex').execute();

      // No value: nothing to rebuild.
      const empty = await run((tx) => createCustomField(tx, customFieldBody()));
      await run((tx) => updateCustomField(tx, empty.id, { version: 0, isPublic: true, isSearchable: true }, { reindex }));
      expect(await reindexJobs()).toEqual([]);

      // A records field with one value: a label change leaves the index alone; becoming public and searchable does not.
      const used = await run((tx) => createCustomField(tx, customFieldBody()));
      const recordId = await seedRecord(buku);
      await h.db.insertInto('custom_values').values({ field_id: used.id, entity_id: recordId, value: '"x"', updated_at: NOW, updated_by: null }).execute();
      await run((tx) => updateCustomField(tx, used.id, { version: 0, labelId: 'Label baru' }, { reindex }));
      expect(await reindexJobs()).toEqual([]);
      await run((tx) => updateCustomField(tx, used.id, { version: 1, isPublic: true, isSearchable: true }, { reindex }));
      expect(await reindexJobs()).toEqual([{ recordIds: [recordId] }]);
      // Archiving the now indexed field changes the index again.
      await run((tx) => archiveCustomField(tx, used.id, 2, { reindex }));
      expect(await reindexJobs()).toEqual([{ recordIds: [recordId] }, { recordIds: [recordId] }]);

      // An items field: the records of its items; a select field's options feed the index too.
      await h.db.deleteFrom('jobs').where('type', '=', 'catalog.reindex').execute();
      const itemField = await run((tx) =>
        createCustomField(tx, customFieldBody({ entity: 'items', type: 'select', options: [{ value: 'a', labelId: 'A' }], isPublic: true, isSearchable: true })),
      );
      const umum = (await listCollectionTypes(h.db, {})).find((t) => t.code === 'UMUM')!.id;
      const itemId = await seedItem(umum);
      const itemRecord = (await h.db.selectFrom('items').select('record_id').where('id', '=', itemId).executeTakeFirstOrThrow()).record_id;
      await h.db.insertInto('custom_values').values({ field_id: itemField.id, entity_id: itemId, value: '"a"', updated_at: NOW, updated_by: null }).execute();
      await run((tx) => updateCustomField(tx, itemField.id, { version: 0, options: [{ value: 'a', labelId: 'Pilihan A' }] }, { reindex }));
      expect(await reindexJobs()).toEqual([{ recordIds: [itemRecord] }]);

      // More than 1000 records: everything, once (a second change joins the queued rebuild).
      await h.db.deleteFrom('jobs').where('type', '=', 'catalog.reindex').execute();
      const wide = await run((tx) => createCustomField(tx, customFieldBody()));
      const values = Array.from({ length: 1001 }, () => ({ field_id: wide.id, entity_id: newId(), value: '"v"', updated_at: NOW, updated_by: null }));
      for (let i = 0; i < values.length; i += 200) await h.db.insertInto('custom_values').values(values.slice(i, i + 200)).execute();
      await run((tx) => updateCustomField(tx, wide.id, { version: 0, isPublic: true, isSearchable: true }, { reindex }));
      await run((tx) => updateCustomField(tx, wide.id, { version: 1, isSearchable: false }, { reindex }));
      expect(await reindexJobs()).toEqual([{ scope: 'all' }]);
    });
  });
});
