import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';

// Phase 2 (catalog), Task 1: the seeds of 0027_catalog_seed (Phase 2 spec §2.6), on the engine picked by
// ALTIS_TEST_DB: inserted only when their `code_key` is absent, so a rerun adds nothing and a library's own edits stay.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`0027_catalog_seed [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  const seed = () => PHASE1_MIGRATIONS['0027_catalog_seed']!.up(h.db, h.dialect);

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-catalog-seed-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const counts = async () => ({
    materialTypes: (await h.db.selectFrom('material_types').select('id').execute()).length,
    languages: (await h.db.selectFrom('languages').select('id').execute()).length,
    collectionTypes: (await h.db.selectFrom('collection_types').select('id').execute()).length,
  });

  it('seeds 8 material types, 16 languages and 4 collection types; running it twice adds nothing', async () => {
    expect(await counts()).toEqual({ materialTypes: 8, languages: 16, collectionTypes: 4 });
    await seed();
    await seed();
    expect(await counts()).toEqual({ materialTypes: 8, languages: 16, collectionTypes: 4 });
    expect((await h.db.selectFrom('material_types').select('code_key').orderBy('sort_order').execute()).map((r) => r.code_key)).toEqual([
      'BUKU',
      'EBOOK',
      'KARYA-ILMIAH',
      'BERSERI',
      'PETA',
      'AUDIO',
      'VIDEO',
      'CAMPURAN',
    ]);
    expect((await h.db.selectFrom('languages').select('code_display').orderBy('code_display').execute()).map((r) => r.code_display)).toEqual(
      ['ara', 'ban', 'bug', 'chi', 'dut', 'eng', 'fre', 'ger', 'ind', 'jav', 'jpn', 'kor', 'mad', 'may', 'min', 'sun'],
    );
  });

  it('keys every code with normalizeKey (upper case) and leaves created_by null, every template empty', async () => {
    const languages = await h.db.selectFrom('languages').select(['code_display', 'code_key', 'created_by', 'archived_at', 'version']).execute();
    for (const l of languages) {
      expect(l).toEqual({ code_display: l.code_display, code_key: l.code_display.toUpperCase(), created_by: null, archived_at: null, version: 0 });
    }
    const templates = await h.db.selectFrom('material_types').select(['template', 'created_by']).execute();
    for (const t of templates) {
      expect(JSON.parse(t.template)).toEqual({ fields: {}, defaults: {}, customFields: [] });
      expect(t.created_by).toBeNull();
    }
  });

  it('REF cannot be borrowed at a kiosk (self_service 0); TANDON cannot be borrowed (loanable 0)', async () => {
    const rows = await h.db.selectFrom('collection_types').select(['code_key', 'loanable', 'self_service']).orderBy('sort_order').execute();
    expect(rows).toEqual([
      { code_key: 'UMUM', loanable: 1, self_service: 1 },
      { code_key: 'REF', loanable: 1, self_service: 0 },
      { code_key: 'FIKSI', loanable: 1, self_service: 1 },
      { code_key: 'TANDON', loanable: 0, self_service: 1 },
    ]);
  });

  it('gives each material type its MARC, schema.org, RDA and DCMI values (§2.6)', async () => {
    const rows = await h.db
      .selectFrom('material_types')
      .select(['code_key', 'marc_type', 'marc_level', 'schema_type', 'content_type', 'media_type', 'carrier_type', 'dcmi_type'])
      .orderBy('sort_order')
      .execute();
    const byCode = Object.fromEntries(rows.map(({ code_key, ...rest }) => [code_key, rest]));
    expect(byCode['PETA']).toEqual({
      marc_type: 'e',
      marc_level: 'm',
      schema_type: 'Map',
      content_type: 'cri',
      media_type: 'n',
      carrier_type: 'nb',
      dcmi_type: 'Image',
    });
    expect(byCode['AUDIO']).toEqual({
      marc_type: 'i',
      marc_level: 'm',
      schema_type: 'AudioObject',
      content_type: 'spw',
      media_type: 's',
      carrier_type: 'sd',
      dcmi_type: 'Sound',
    });
    const line = (r: (typeof rows)[number]) =>
      `${r.code_key} ${r.marc_type}/${r.marc_level} ${r.schema_type} ${r.content_type}/${r.media_type}/${r.carrier_type} ${r.dcmi_type}`;
    expect(rows.map(line)).toEqual([
      'BUKU a/m Book txt/n/nc Text',
      'EBOOK a/m Book txt/c/cr Text',
      'KARYA-ILMIAH a/m Thesis txt/n/nc Text',
      'BERSERI a/s Periodical txt/n/nc Text',
      'PETA e/m Map cri/n/nb Image',
      'AUDIO i/m AudioObject spw/s/sd Sound',
      'VIDEO g/m VideoObject tdi/v/vd MovingImage',
      'CAMPURAN o/m CreativeWork xxx/n/nz Collection',
    ]);
  });

  it('never touches a row the library changed: an edited or archived seed stays as it is', async () => {
    await h.db.updateTable('collection_types').set({ name_id: 'Koleksi umum', archived_at: 1, version: 3 }).where('code_key', '=', 'UMUM').execute();
    await h.db.deleteFrom('languages').where('code_key', '=', 'KOR').execute();
    await seed();
    expect(await h.db.selectFrom('collection_types').select(['name_id', 'archived_at', 'version']).where('code_key', '=', 'UMUM').execute()).toEqual([
      { name_id: 'Koleksi umum', archived_at: 1, version: 3 },
    ]);
    // A seed that is gone is inserted again: absence of its code_key is the only test.
    expect(await h.db.selectFrom('languages').select('name_en').where('code_key', '=', 'KOR').execute()).toEqual([{ name_en: 'Korean' }]);
    expect(await counts()).toEqual({ materialTypes: 8, languages: 16, collectionTypes: 4 });
  });
});
