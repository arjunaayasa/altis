import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { insertUrlAttachments } from '../../src/catalog/data/attachments.js';
import { resolveAgents, resolvePublisher, resolveSubjects } from '../../src/catalog/data/authorities.js';
import {
  coerceCustomValues,
  customValuesSchema,
  loadCustomDefs,
  readCustomValues,
  writeCustomValues,
  type CustomFieldDef,
} from '../../src/catalog/data/custom-fields.js';
import { defaultCollectionTypeId, defaultMaterialTypeId } from '../../src/catalog/data/defaults.js';
import { agentNameKey, codeKey, publisherNameKey, subjectTermKey } from '../../src/catalog/data/keys.js';
import { legacyTarget, lookupLegacy, mapLegacy } from '../../src/catalog/data/legacy-map.js';
import { locationPaths } from '../../src/catalog/data/locations.js';
import {
  RUN_WORK_KEEP_MS,
  attachRunJob,
  createRun,
  finishRun,
  getRun,
  protectedRunWorkIds,
  saveRunSummary,
  startRun,
  writeRunReport,
} from '../../src/catalog/data/runs.js';
import * as barrel from '../../src/catalog/data/index.js';
import * as core from '../../src/index.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';
import { localStorageDriver } from '../../src/files/serve.js';

// Phase 2 (catalog), Task 1: the catalog data primitives every write path goes through (authority find-or-create,
// custom-field values, runs and their reports, the legacy map, defaults, location paths, URL attachments), on the
// engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const STAFF = newId(NOW - DAY);
const ACTOR: Actor = { type: 'staff', id: STAFF, ip: null };

/** The VALIDATION_FAILED errors of a rejected promise, or the error itself. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, errors: e.meta?.['errors'] } : e),
  );
}

describe('catalog keys (Phase 2 spec §2.1)', () => {
  it('agentNameKey = normalizeKey(name + dates), cut to 191 code points, never ending in a blank', () => {
    expect(agentNameKey('Toer, Pramoedya Ananta', '1925-2006')).toBe('TOER, PRAMOEDYA ANANTA 1925-2006');
    expect(agentNameKey('  toer,  pramoedya ananta', '1925-2006')).toBe('TOER, PRAMOEDYA ANANTA 1925-2006');
    expect(agentNameKey('Soekarno')).toBe('SOEKARNO');
    expect(agentNameKey('Soekarno', null)).toBe('SOEKARNO');
    expect(agentNameKey('Soekarno', '')).toBe('SOEKARNO');
    const long = agentNameKey(`${'𝔞'.repeat(190)} b`);
    expect([...long]).toHaveLength(190); // cut at 191 code points, then the trailing blank dropped (R24)
    expect(long.endsWith(' ')).toBe(false);
    expect(subjectTermKey(' sastra   indonesia ')).toBe('SASTRA INDONESIA');
    expect(publisherNameKey('Gramedia  Pustaka')).toBe('GRAMEDIA PUSTAKA');
    expect(codeKey(' karya-ilmiah ')).toBe('KARYA-ILMIAH');
    expect([...subjectTermKey('x'.repeat(300))]).toHaveLength(191);
  });
});

describe('customValuesSchema and coerceCustomValues (§3.7, S19)', () => {
  const def = (over: Partial<CustomFieldDef>): CustomFieldDef => ({
    id: newId(),
    code: 'kode',
    type: 'text',
    labelId: 'Kode',
    labelEn: null,
    options: [],
    required: false,
    sortOrder: 0,
    isPublic: false,
    isSearchable: false,
    archived: false,
    ...over,
  });
  const DEFS: CustomFieldDef[] = [
    def({ code: 'catatan', type: 'text' }),
    def({ code: 'abstrak', type: 'longtext' }),
    def({ code: 'halaman', type: 'number' }),
    def({ code: 'terbit', type: 'date' }),
    def({ code: 'hibah', type: 'boolean' }),
    def({ code: 'kondisi', type: 'select', options: [{ value: 'baik', labelId: 'Baik', labelEn: 'Good' }, { value: 'rusak', labelId: 'Rusak', labelEn: null }] }),
    def({ code: 'label', type: 'multiselect', options: [{ value: 'a', labelId: 'A', labelEn: null }, { value: 'b|c', labelId: 'B|C', labelEn: null }] }),
    def({ code: 'tautan', type: 'url' }),
    def({ code: 'wajib', type: 'text', required: true }),
    def({ code: 'lama', type: 'text', archived: true }),
  ];
  /** The body a route parses: `custom` nested, so error paths read `custom.<code>`. */
  const body = (mode: 'create' | 'patch') => z.strictObject({ custom: customValuesSchema(DEFS, mode) });
  const errors = (mode: 'create' | 'patch', custom: Record<string, unknown>) => {
    const r = body(mode).safeParse({ custom });
    return r.success ? [] : r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code }));
  };

  it('accepts valid values of every type, null to clear, and keys by live codes only', () => {
    const ok = {
      wajib: 'x',
      catatan: 'teks',
      abstrak: 'panjang',
      halaman: 12.5,
      terbit: '2026-02-28',
      hibah: true,
      kondisi: 'baik',
      label: ['a', 'b|c'],
      tautan: 'https://contoh.example/a',
    };
    expect(errors('create', ok)).toEqual([]);
    expect(errors('patch', { catatan: null, kondisi: null })).toEqual([]);
    // An archived code is not part of the schema: refused as an unknown key.
    expect(errors('patch', { lama: 'x' })).toEqual([{ path: 'custom', code: 'unrecognized_keys' }]);
  });

  it('refuses a select value outside its options at custom.<code>', () => {
    expect(errors('patch', { kondisi: 'hilang' })).toEqual([{ path: 'custom.kondisi', code: expect.any(String) }]);
    expect(errors('patch', { label: ['a', 'a'] })).toEqual([{ path: 'custom.label', code: expect.any(String) }]);
    expect(errors('patch', { label: ['x'] })).toEqual([{ path: 'custom.label', code: expect.any(String) }]);
  });

  it('a required code is required in create only', () => {
    expect(errors('create', {})).toEqual([{ path: 'custom.wajib', code: 'invalid_type' }]);
    expect(errors('create', { wajib: null })).toEqual([{ path: 'custom.wajib', code: 'invalid_type' }]);
    expect(errors('patch', {})).toEqual([]);
  });

  it('caps text at 1000 characters, longtext at 60 000 UTF-8 bytes and both by their JSON encoding (S19)', () => {
    expect(errors('patch', { catatan: 'x'.repeat(1000) })).toEqual([]);
    expect(errors('patch', { catatan: 'x'.repeat(1001) })).toEqual([{ path: 'custom.catatan', code: 'too_big' }]);
    // 15 001 four-byte characters: 60 004 bytes.
    expect(errors('patch', { abstrak: '😀'.repeat(15_001) })).toEqual([{ path: 'custom.abstrak', code: 'too_big' }]);
    expect(errors('patch', { abstrak: 'a'.repeat(20_000) })).toEqual([]);
    // 30 000 quotes: 30 000 bytes as text, 60 002 as JSON.
    expect(errors('patch', { abstrak: '"'.repeat(30_000) })).toEqual([{ path: 'custom.abstrak', code: 'too_big' }]);
  });

  it('checks numbers, dates, booleans and URLs', () => {
    expect(errors('patch', { halaman: 'dua' })).toEqual([{ path: 'custom.halaman', code: 'invalid_type' }]);
    expect(errors('patch', { halaman: Number.POSITIVE_INFINITY })).toHaveLength(1);
    expect(errors('patch', { terbit: '2026-13-01' })).toEqual([{ path: 'custom.terbit', code: expect.any(String) }]);
    expect(errors('patch', { terbit: '2026-02-30' })).toHaveLength(1);
    expect(errors('patch', { hibah: 'ya' })).toEqual([{ path: 'custom.hibah', code: 'invalid_type' }]);
    expect(errors('patch', { tautan: 'javascript:alert(1)' })).toEqual([{ path: 'custom.tautan', code: expect.any(String) }]);
    expect(errors('patch', { tautan: `https://x.example/${'a'.repeat(2000)}` })).toHaveLength(1);
  });

  it('coerceCustomValues turns CSV and SLiMS strings into the schema types', () => {
    const raw = {
      halaman: '12',
      hibah: 'ya',
      label: 'a|b\\|c',
      terbit: '2026-13-01',
      catatan: '',
      kondisi: 'baik',
      asing: 'x',
    };
    expect(coerceCustomValues(DEFS, raw)).toEqual({
      values: { halaman: 12, hibah: true, label: ['a', 'b|c'], catatan: null, kondisi: 'baik', asing: 'x' },
      errors: [{ path: 'custom.terbit', code: 'invalid' }],
    });
    expect(coerceCustomValues(DEFS, { halaman: '12,5', hibah: 'TIDAK' }).values).toEqual({ halaman: 12.5, hibah: false });
    expect(coerceCustomValues(DEFS, { hibah: '1' }).values).toEqual({ hibah: true });
    expect(coerceCustomValues(DEFS, { hibah: 'False' }).values).toEqual({ hibah: false });
    expect(coerceCustomValues(DEFS, { hibah: 'mungkin', halaman: '1.2.3' }).errors).toEqual([
      { path: 'custom.hibah', code: 'invalid' },
      { path: 'custom.halaman', code: 'invalid' },
    ]);
    // The unknown code is passed through for the strict schema to refuse.
    expect(z.strictObject({ custom: customValuesSchema(DEFS, 'patch') }).safeParse({ custom: { asing: 'x' } }).success).toBe(false);
    // A CSV header `custom.__proto__` stays a key (never the object's prototype) and is refused like any unknown code.
    const hostile = coerceCustomValues(DEFS, JSON.parse('{"__proto__":"x","halaman":"3"}') as Record<string, string>);
    expect(Object.getPrototypeOf(hostile.values)).toBe(Object.prototype);
    expect(Object.keys(hostile.values)).toEqual(['__proto__', 'halaman']);
    expect(z.strictObject({ custom: customValuesSchema(DEFS, 'patch') }).safeParse({ custom: hostile.values }).success).toBe(false);
    // A field whose code is `__proto__` would escape Zod's checks: its values are refused, never accepted unchecked.
    const odd = [def({ code: '__proto__', type: 'number' }), def({ code: 'constructor', type: 'number' })];
    expect(customValuesSchema(odd, 'patch').safeParse(JSON.parse('{"__proto__":"dua"}')).success).toBe(false);
    expect(customValuesSchema(odd, 'patch').safeParse(JSON.parse('{"__proto__":2}')).success).toBe(false);
    expect(customValuesSchema(odd, 'patch').safeParse({ constructor: 2 }).success).toBe(true);
    expect(customValuesSchema(odd, 'patch').safeParse({ constructor: 'dua' }).success).toBe(false);
  });
});

describe('the catalog data barrel', () => {
  it('exports the primitives from @altis/core', () => {
    for (const name of [
      'agentNameKey',
      'subjectTermKey',
      'publisherNameKey',
      'codeKey',
      'resolveAgents',
      'resolveSubjects',
      'resolvePublisher',
      'defaultMaterialTypeId',
      'defaultCollectionTypeId',
      'loadCustomDefs',
      'customValuesSchema',
      'coerceCustomValues',
      'writeCustomValues',
      'readCustomValues',
      'createRun',
      'attachRunJob',
      'startRun',
      'saveRunSummary',
      'finishRun',
      'writeRunReport',
      'getRun',
      'RUN_WORK_KEEP_MS',
      'protectedRunWorkIds',
      'insertUrlAttachments',
      'mapLegacy',
      'lookupLegacy',
      'legacyTarget',
      'locationPaths',
    ]) {
      expect({ name, inBarrel: name in barrel, inCore: name in core }).toEqual({ name, inBarrel: true, inCore: true });
    }
  });
});

describe.skipIf(!ctx.available)(`catalog data primitives [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let branchId: string;

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, now = NOW): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR)));

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-catalog-data-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** A record row (the minimum), for the tables that reference one. */
  async function record(): Promise<string> {
    const id = newId();
    const mt = await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: mt.id,
        title: 'Bumi Manusia',
        subtitle: null,
        responsibility: null,
        title_key: 'bumi manusia',
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
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        source: 'manual',
        merged_into: null,
        changed_at: NOW - DAY,
        archived_at: null,
        created_at: NOW - DAY,
        created_by: null,
        updated_at: NOW - DAY,
        updated_by: null,
      })
      .execute();
    return id;
  }

  describe('authorities: find-or-create (P2-10: no audit entry)', () => {
    beforeEach(async () => {
      for (const t of ['agents', 'subjects', 'publishers', 'audit_log'] as const) await h.db.deleteFrom(t).execute();
    });

    it('resolveAgents finds what it created: the same id twice, created 1 then 0, and by the normalized key', async () => {
      const ref = { type: 'person' as const, name: 'Toer, Pramoedya Ananta', dates: '1925-2006' };
      const first = await run((tx) => resolveAgents(tx, [ref]));
      expect(first.created).toBe(1);
      expect(first.ids).toHaveLength(1);
      const second = await run((tx) => resolveAgents(tx, [ref]));
      expect(second).toEqual({ ids: first.ids, created: 0 });
      const sloppy = await run((tx) => resolveAgents(tx, [{ type: 'person', name: '  toer,  pramoedya ananta', dates: '1925-2006' }]));
      expect(sloppy).toEqual({ ids: first.ids, created: 0 });
      // Another type, or no dates: other agents.
      const other = await run((tx) => resolveAgents(tx, [{ type: 'organization', name: 'Toer, Pramoedya Ananta', dates: '1925-2006' }, { type: 'person', name: 'Toer, Pramoedya Ananta' }]));
      expect(other.created).toBe(2);
      const row = await h.db.selectFrom('agents').selectAll().where('id', '=', first.ids[0]!).executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        type: 'person',
        name_display: 'Toer, Pramoedya Ananta',
        name_key: 'TOER, PRAMOEDYA ANANTA 1925-2006',
        dates: '1925-2006',
        merged_into: null,
        archived_at: null,
        created_at: NOW,
        created_by: STAFF,
      });
      expect(await h.db.selectFrom('audit_log').select('id').execute()).toEqual([]);
    });

    it('resolves a ref to the target of the agent its key names when that one was merged; an id too', async () => {
      const [target] = (await run((tx) => resolveAgents(tx, [{ type: 'person', name: 'Ananta Toer, Pramoedya' }]))).ids;
      const [merged] = (await run((tx) => resolveAgents(tx, [{ type: 'person', name: 'Toer, Pram' }]))).ids;
      await h.db.updateTable('agents').set({ merged_into: target!, archived_at: NOW }).where('id', '=', merged!).execute();
      expect(await run((tx) => resolveAgents(tx, [{ type: 'person', name: 'toer, pram' }]))).toEqual({ ids: [target], created: 0 });
      expect(await run((tx) => resolveAgents(tx, [{ id: merged! }]))).toEqual({ ids: [target], created: 0 });
      expect(await run((tx) => resolveAgents(tx, [{ id: target! }, { id: target! }]))).toEqual({ ids: [target, target], created: 0 });
    });

    it('brings back an archived authority it finds (an authority in use is never archived)', async () => {
      const [id] = (await run((tx) => resolveAgents(tx, [{ type: 'person', name: 'Chairil Anwar' }]))).ids;
      await h.db.updateTable('agents').set({ archived_at: NOW, version: 4 }).where('id', '=', id!).execute();
      expect(await run((tx) => resolveAgents(tx, [{ type: 'person', name: 'Chairil Anwar' }]), NOW + 5)).toEqual({ ids: [id], created: 0 });
      expect(await h.db.selectFrom('agents').select(['archived_at', 'version', 'updated_at']).where('id', '=', id!).execute()).toEqual([
        { archived_at: null, version: 5, updated_at: NOW + 5 },
      ]);
    });

    it('an unknown {id} is VALIDATION_FAILED not_found at its index; nothing is created', async () => {
      const unknown = newId();
      expect(await failure(run((tx) => resolveAgents(tx, [{ type: 'person', name: 'Baru' }, { id: unknown }])))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: '1', code: 'not_found' }],
      });
      expect(await failure(run((tx) => resolveSubjects(tx, [{ id: unknown }])))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: '0', code: 'not_found' }],
      });
      expect(await failure(run((tx) => resolvePublisher(tx, { id: unknown })))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: '0', code: 'not_found' }],
      });
      expect(await h.db.selectFrom('agents').select('id').execute()).toEqual([]);
    });

    it('refuses a ref that does not fit its columns: empty or over-long name, unknown type', async () => {
      expect(
        await failure(
          run((tx) =>
            resolveAgents(tx, [
              { type: 'person', name: '   ' },
              { type: 'robot' as never, name: 'R2' },
              { type: 'person', name: 'x'.repeat(192) },
              { type: 'person', name: 'Ok', dates: 'd'.repeat(65) },
            ]),
          ),
        ),
      ).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [
          { path: '0.name', code: 'too_small' },
          { path: '1.type', code: 'invalid_value' },
          { path: '2.name', code: 'too_big' },
          { path: '3.dates', code: 'too_big' },
        ],
      });
    });

    it('resolveSubjects keys by (type, term); resolvePublisher by name, null for no publisher', async () => {
      const a = await run((tx) => resolveSubjects(tx, [{ type: 'topic', term: 'Sastra Indonesia', classification: '899.221' }, { type: 'geographic', term: 'Sastra Indonesia' }]));
      expect(a.created).toBe(2);
      expect(await run((tx) => resolveSubjects(tx, [{ type: 'topic', term: ' sastra  indonesia' }]))).toEqual({ ids: [a.ids[0]], created: 0 });
      expect(await h.db.selectFrom('subjects').select(['term_key', 'classification']).where('id', '=', a.ids[0]!).execute()).toEqual([
        { term_key: 'SASTRA INDONESIA', classification: '899.221' },
      ]);
      const p = await run((tx) => resolvePublisher(tx, { name: 'Gramedia Pustaka Utama', place: 'Jakarta' }));
      expect(p.created).toBe(true);
      expect(await run((tx) => resolvePublisher(tx, { name: 'GRAMEDIA pustaka utama' }))).toEqual({ id: p.id, created: false });
      expect(await run((tx) => resolvePublisher(tx, { id: p.id! }))).toEqual({ id: p.id, created: false });
      expect(await run((tx) => resolvePublisher(tx, null))).toEqual({ id: null, created: false });
    });
  });

  describe('defaults', () => {
    it('the configured id when live, else BUKU / UMUM, else the lowest sort_order', async () => {
      const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
      const peta = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'PETA').executeTakeFirstOrThrow()).id;
      const umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
      const ref = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'REF').executeTakeFirstOrThrow()).id;
      expect(await defaultMaterialTypeId(h.db, peta)).toBe(peta);
      expect(await defaultMaterialTypeId(h.db, null)).toBe(buku);
      expect(await defaultMaterialTypeId(h.db, newId())).toBe(buku);
      expect(await defaultCollectionTypeId(h.db, ref)).toBe(ref);
      expect(await defaultCollectionTypeId(h.db, null)).toBe(umum);
      try {
        await h.db.updateTable('material_types').set({ archived_at: NOW }).where('id', 'in', [peta, buku]).execute();
        expect(await defaultMaterialTypeId(h.db, peta)).toBe(
          (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'EBOOK').executeTakeFirstOrThrow()).id,
        );
      } finally {
        await h.db.updateTable('material_types').set({ archived_at: null }).execute();
      }
    });
  });

  describe('custom fields', () => {
    let recordId: string;

    beforeAll(async () => {
      recordId = await record();
      const def = (code: string, type: string, o: { required?: number; archived?: number | null; isPublic?: number; options?: string | null; sort?: number } = {}) => ({
        id: newId(),
        entity: 'records',
        code_key: code.toUpperCase(),
        code_display: code,
        label: `Label ${code}`,
        label_en: code === 'kondisi' ? 'Condition' : null,
        type,
        options: o.options ?? null,
        is_required: o.required ?? 0,
        sort_order: o.sort ?? 0,
        archived_at: o.archived ?? null,
        is_public: o.isPublic ?? 0,
        is_searchable: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      });
      await h.db
        .insertInto('custom_field_defs')
        .values([
          def('catatan', 'text', { sort: 2 }),
          def('kondisi', 'select', { sort: 1, isPublic: 1, options: '[{"value":"baik","label_id":"Baik","label_en":"Good"}]' }),
          def('lama', 'text', { archived: NOW }),
          { ...def('nip', 'text'), entity: 'items' },
        ])
        .execute();
    });

    it('loadCustomDefs: the live definitions of an entity in sort order, archived ones on request', async () => {
      const defs = await loadCustomDefs(h.db, 'records');
      expect(defs.map((d) => d.code)).toEqual(['kondisi', 'catatan']);
      expect(defs[0]).toMatchObject({
        code: 'kondisi',
        type: 'select',
        labelId: 'Label kondisi',
        labelEn: 'Condition',
        options: [{ value: 'baik', labelId: 'Baik', labelEn: 'Good' }],
        required: false,
        sortOrder: 1,
        isPublic: true,
        isSearchable: false,
        archived: false,
      });
      expect((await loadCustomDefs(h.db, 'records', { includeArchived: true })).map((d) => d.code)).toEqual(['lama', 'kondisi', 'catatan']);
      expect((await loadCustomDefs(h.db, 'items')).map((d) => d.code)).toEqual(['nip']);
    });

    it('writeCustomValues upserts per field and deletes on null; readCustomValues omits archived codes', async () => {
      const all = await loadCustomDefs(h.db, 'records', { includeArchived: true });
      const o = { now: NOW, actor: STAFF };
      await run((tx) => writeCustomValues(tx.trx, 'records', recordId, { catatan: 'satu', kondisi: 'baik' }, all, o));
      await run((tx) => writeCustomValues(tx.trx, 'records', recordId, { catatan: 'dua' }, all, { now: NOW + 1, actor: null }));
      // An archived field's value is kept in the table but never read.
      const lama = all.find((d) => d.code === 'lama')!;
      await h.db.insertInto('custom_values').values({ field_id: lama.id, entity_id: recordId, value: '"x"', updated_at: NOW, updated_by: null }).execute();
      const other = newId();
      expect(await readCustomValues(h.db, 'records', [recordId, other])).toEqual(
        new Map([
          [recordId, { catatan: 'dua', kondisi: 'baik' }],
          [other, {}],
        ]),
      );
      await run((tx) => writeCustomValues(tx.trx, 'records', recordId, { catatan: null }, all, o));
      expect(await readCustomValues(h.db, 'records', [recordId])).toEqual(new Map([[recordId, { kondisi: 'baik' }]]));
      const rows = await h.db.selectFrom('custom_values').select(['value', 'updated_by']).where('entity_id', '=', recordId).orderBy('value').execute();
      expect(rows).toEqual([
        { value: '"baik"', updated_by: STAFF },
        { value: '"x"', updated_by: null },
      ]);
      await expect(run((tx) => writeCustomValues(tx.trx, 'records', recordId, { unknown: 1 }, all, o))).rejects.toThrow(TypeError);
    });
  });

  describe('runs', () => {
    it('create → attach job → start → save summary → finish succeeded; getRun reads it back', async () => {
      const runId = await run((tx) => createRun(tx, { kind: 'import', dryRun: true, format: 'marc21', options: { matchOn: 'isbn' } }));
      expect(await getRun(h.db, runId)).toMatchObject({ id: runId, kind: 'import', status: 'queued', dry_run: 1, format: 'marc21', created_by: STAFF, created_at: NOW });
      const jobId = newId();
      await run((tx) => attachRunJob(tx.trx, runId, jobId));
      await run((tx) => startRun(tx.trx, runId, NOW + 1));
      expect(await getRun(h.db, runId)).toMatchObject({ status: 'running', job_id: jobId, finished_at: null });
      await run((tx) => saveRunSummary(tx.trx, runId, { read: 5 }));
      expect(JSON.parse((await getRun(h.db, runId))!.summary)).toEqual({ read: 5 });
      await run((tx) => finishRun(tx.trx, runId, { status: 'succeeded', summary: { read: 5, created: 5 }, outputName: `${runId}.mrc`, outputSize: 10, expiresAt: NOW + 7 * DAY }, NOW + 2));
      expect(await getRun(h.db, runId)).toMatchObject({
        status: 'succeeded',
        finished_at: NOW + 2,
        output_name: `${runId}.mrc`,
        output_size: 10,
        expires_at: NOW + 7 * DAY,
        report_file_id: null,
      });
      expect(JSON.parse((await getRun(h.db, runId))!.options)).toEqual({ matchOn: 'isbn' });
      expect(await getRun(h.db, newId())).toBeNull();
    });

    it('a run is finished once: a second finish (a retried slice) changes nothing', async () => {
      const runId = await run((tx) => createRun(tx, { kind: 'export', dryRun: false, format: null, options: {} }));
      await run((tx) => finishRun(tx.trx, runId, { status: 'failed', summary: { error: 'X' } }, NOW + 3));
      await run((tx) => finishRun(tx.trx, runId, { status: 'succeeded', summary: {} }, NOW + 4));
      expect(await getRun(h.db, runId)).toMatchObject({ status: 'failed', finished_at: NOW + 3, format: null });
    });

    it('saveRunSummary refuses JSON over 60 000 bytes (TypeError), and so do options and finishRun', async () => {
      const runId = await run((tx) => createRun(tx, { kind: 'migration', dryRun: false, format: null, options: {} }));
      const big = { text: 'x'.repeat(70_000) };
      await expect(run((tx) => saveRunSummary(tx.trx, runId, big))).rejects.toThrow(TypeError);
      await expect(run((tx) => finishRun(tx.trx, runId, { status: 'succeeded', summary: big }, NOW))).rejects.toThrow(TypeError);
      await expect(run((tx) => createRun(tx, { kind: 'import', dryRun: false, format: null, options: big }))).rejects.toThrow(TypeError);
      expect(JSON.parse((await getRun(h.db, runId))!.summary)).toEqual({});
    });

    it('writeRunReport writes a staff CSV file of the header and the first 10 000 rows, then # truncated,<n>', async () => {
      const runId = await run((tx) => createRun(tx, { kind: 'import', dryRun: false, format: 'csv-records', options: {} }));
      const storage = localStorageDriver(dataDir);
      async function* rows() {
        for (let i = 1; i <= 10_005; i += 1) yield [String(i), i === 1 ? '=SUM(A1)' : `baris ${i}`];
      }
      const fileId = await writeRunReport(h, storage, runId, ['row', 'message'], rows(), { now: NOW, createdBy: STAFF });
      const file = await h.db.selectFrom('files').selectAll().where('id', '=', fileId).executeTakeFirstOrThrow();
      expect(file).toMatchObject({
        context: 'catalog.report',
        owner_type: 'catalog_runs',
        owner_id: runId,
        access: 'staff',
        mime: 'text/csv',
        status: 'ok',
        created_at: NOW,
        created_by: STAFF,
      });
      const chunks: Buffer[] = [];
      for await (const c of (await storage.get(fileId))!) chunks.push(Buffer.from(c));
      const text = Buffer.concat(chunks).toString('utf8');
      expect(Buffer.byteLength(text)).toBe(file.size);
      expect(text.startsWith('﻿')).toBe(true);
      const lines = text.slice(1).split('\r\n');
      expect(lines.at(-1)).toBe('');
      expect(lines).toHaveLength(1 + 10_000 + 1 + 1);
      expect(lines[0]).toBe('"row","message"');
      expect(lines[1]).toBe(`"1","'=SUM(A1)"`); // csvCell's formula guard
      expect(lines[10_000]).toBe('"10000","baris 10000"');
      expect(lines[10_001]).toBe('"# truncated","5"');
      // A short report has no truncation line; plain iterables work too.
      const shortId = await writeRunReport(h, storage, runId, ['a'], [['1'], ['2']], { now: NOW, createdBy: null });
      const short: Buffer[] = [];
      for await (const c of (await storage.get(shortId))!) short.push(Buffer.from(c));
      expect(Buffer.concat(short).toString('utf8')).toBe('﻿"a"\r\n"1"\r\n"2"\r\n');
    });

    it('protectedRunWorkIds: queued/running runs, and terminal ones for 7 days after they finished (S2, S3)', async () => {
      const mk = async (status: string, finishedAt: number | null) => {
        const id = await run((tx) => createRun(tx, { kind: 'import', dryRun: true, format: null, options: {} }));
        await h.db.updateTable('catalog_runs').set({ status, finished_at: finishedAt }).where('id', '=', id).execute();
        return id;
      };
      const queued = await mk('queued', null);
      const running = await mk('running', null);
      const fresh = await mk('succeeded', NOW - 2 * DAY);
      const old = await mk('failed', NOW - 8 * DAY);
      const edge = await mk('cancelled', NOW - RUN_WORK_KEEP_MS);
      const none = newId();
      expect(RUN_WORK_KEEP_MS).toBe(7 * 86_400_000);
      expect(await protectedRunWorkIds(h.db, [queued, running, fresh, old, edge, none], NOW)).toEqual(new Set([queued, running, fresh]));
      expect(await protectedRunWorkIds(h.db, [], NOW)).toEqual(new Set());
    });
  });

  describe('the legacy map', () => {
    it('mapLegacy twice keeps one row per key; lookupLegacy and legacyTarget read it', async () => {
      const runId = newId();
      const a = newId();
      const b = newId();
      const rows = [
        { source: 'slims', entity: 'biblio', legacyKey: '1', targetId: a, runId },
        { source: 'slims', entity: 'biblio', legacyKey: '2', targetId: b, runId },
        { source: 'slims', entity: 'biblio', legacyKey: '2', targetId: b, runId },
      ];
      await run((tx) => mapLegacy(tx.trx, rows));
      await run((tx) => mapLegacy(tx.trx, [...rows, { source: 'slims', entity: 'item', legacyKey: '1', targetId: b, runId }]));
      expect(await h.db.selectFrom('migration_map').select(['entity', 'legacy_key']).orderBy('entity').orderBy('legacy_key').execute()).toEqual([
        { entity: 'biblio', legacy_key: '1' },
        { entity: 'biblio', legacy_key: '2' },
        { entity: 'item', legacy_key: '1' },
      ]);
      expect(await lookupLegacy(h.db, 'slims', 'biblio', ['1', '2', '3'])).toEqual(
        new Map([
          ['1', a],
          ['2', b],
        ]),
      );
      expect(await legacyTarget(h.db, 'slims', 'item', '1')).toBe(b);
      expect(await legacyTarget(h.db, 'import:x', 'biblio', '1')).toBeNull();
    });

    it('writes in batches of at most 500 and maps 1 200 keys', async () => {
      const runId = newId();
      const many = Array.from({ length: 1_200 }, (_, i) => ({ source: 'import:many', entity: 'row', legacyKey: String(i), targetId: newId(), runId }));
      await run((tx) => mapLegacy(tx.trx, many));
      expect((await lookupLegacy(h.db, 'import:many', 'row', many.map((m) => m.legacyKey))).size).toBe(1_200);
    });
  });

  describe('locationPaths', () => {
    it('a shelf under an area under a room: the room’s map file, the shelf’s box and hint, public only when all are', async () => {
      const room = newId();
      const area = newId();
      const shelf = newId();
      const bare = newId();
      const mapFile = newId();
      const loc = (id: string, kind: string, parent: string | null, name: string, over: Record<string, unknown> = {}) => ({
        id,
        branch_id: branchId,
        parent_id: parent,
        kind,
        code_display: name,
        code_key: name.toUpperCase(),
        name,
        shelf_hint: null,
        class_from: null,
        class_to: null,
        map_file_id: null,
        map_x: null,
        map_y: null,
        map_w: null,
        map_h: null,
        // Every row names every column: a multi-row INSERT cannot leave one to its default on SQLite.
        is_public: 1,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
        ...over,
      });
      await h.db
        .insertInto('locations')
        .values([
          loc(room, 'room', null, 'Lantai 2', { map_file_id: mapFile }),
          loc(area, 'area', room, 'Sayap Timur', { map_x: 0, map_y: 0, map_w: 500, map_h: 1000 }),
          loc(shelf, 'shelf', area, 'Rak 800–899', { shelf_hint: 'Rak 800', map_x: 100, map_y: 200, map_w: 50, map_h: 300, is_public: 0 }),
          loc(bare, 'shelf', room, 'Rak tanpa kotak dengan nama yang panjang sekali melebihi empat puluh'),
        ])
        .execute();
      const paths = await locationPaths(h.db, [shelf, room, bare, newId()]);
      expect(paths.get(shelf)).toEqual({
        roomId: room,
        roomName: 'Lantai 2',
        areaName: 'Sayap Timur',
        shelfName: 'Rak 800–899',
        shelfHint: 'Rak 800',
        mapFileId: mapFile,
        box: { x: 100, y: 200, w: 50, h: 300 },
        isPublic: false,
      });
      expect(paths.get(room)).toEqual({
        roomId: room,
        roomName: 'Lantai 2',
        areaName: null,
        shelfName: null,
        shelfHint: 'Lantai 2',
        mapFileId: mapFile,
        box: null,
        isPublic: true,
      });
      // A shelf without a hint gets its name cut to 40 characters (§3.6); without a box of its own, none.
      expect(paths.get(bare)).toMatchObject({ areaName: null, shelfName: 'Rak tanpa kotak dengan nama yang panjang sekali melebihi empat puluh', box: null, isPublic: true });
      expect([...paths.get(bare)!.shelfHint!]).toHaveLength(40);
      expect(paths.size).toBe(3);
    });
  });

  describe('insertUrlAttachments (S4)', () => {
    it('keeps http(s) URLs of at most 2000 characters, reports the others as invalid_url, moves changed_at', async () => {
      const recordId = await record();
      const before = await h.db.selectFrom('records').select('changed_at').where('id', '=', recordId).executeTakeFirstOrThrow();
      const long = `https://x.example/${'a'.repeat(2001 - 'https://x.example/'.length)}`;
      expect(long).toHaveLength(2001);
      const result = await run((tx) =>
        insertUrlAttachments(
          tx.trx,
          recordId,
          [{ url: ' https://x.example/a ', title: 'Situs' }, { url: 'javascript:alert(1)' }, { url: 'ftp://x' }, { url: long }],
          { access: 'public', now: NOW, actor: STAFF },
        ),
      );
      expect(result).toEqual({
        inserted: 1,
        invalid: [
          { index: 1, code: 'invalid_url' },
          { index: 2, code: 'invalid_url' },
          { index: 3, code: 'invalid_url' },
        ],
      });
      const rows = await h.db.selectFrom('attachments').selectAll().where('record_id', '=', recordId).execute();
      expect(rows).toEqual([
        expect.objectContaining({
          kind: 'url',
          url: 'https://x.example/a',
          title: 'Situs',
          file_id: null,
          access: 'public',
          archived_at: null,
          read_count: 0,
          sort_order: 0,
          created_at: NOW,
          created_by: STAFF,
        }),
      ]);
      expect(before.changed_at).toBe(NOW - DAY);
      expect(await h.db.selectFrom('records').select('changed_at').where('id', '=', recordId).executeTakeFirstOrThrow()).toEqual({ changed_at: NOW });

      // A second call places its links after the record's existing ones; without a title the URL is the title.
      expect(await run((tx) => insertUrlAttachments(tx.trx, recordId, [{ url: 'http://y.example/' }], { access: 'staff', now: NOW + 1, actor: null }))).toEqual({
        inserted: 1,
        invalid: [],
      });
      const second = await h.db.selectFrom('attachments').select(['url', 'title', 'sort_order', 'access']).where('record_id', '=', recordId).orderBy('sort_order').execute();
      expect(second).toEqual([
        { url: 'https://x.example/a', title: 'Situs', sort_order: 0, access: 'public' },
        { url: 'http://y.example/', title: 'http://y.example/', sort_order: 1, access: 'staff' },
      ]);
      // Nothing valid: nothing inserted, changed_at untouched.
      expect(await run((tx) => insertUrlAttachments(tx.trx, recordId, [{ url: 'data:text/html,x' }], { access: 'public', now: NOW + 9, actor: null }))).toEqual({
        inserted: 0,
        invalid: [{ index: 0, code: 'invalid_url' }],
      });
      expect(await h.db.selectFrom('records').select('changed_at').where('id', '=', recordId).executeTakeFirstOrThrow()).toEqual({ changed_at: NOW + 1 });
    });

    it('inserts many links in batches: 4 200 links, more than MySQL/PostgreSQL take as parameters of one INSERT, in order', async () => {
      // 4 200 rows × 16 columns = 67 200 parameters, over the 65 535 of MySQL and PostgreSQL (node:sqlite allows 250 000).
      const recordId = await record();
      const links = Array.from({ length: 4200 }, (_, i) => ({ url: `https://x.example/${i}` }));
      expect(await run((tx) => insertUrlAttachments(tx.trx, recordId, links, { access: 'public', now: NOW, actor: null }))).toEqual({
        inserted: 4200,
        invalid: [],
      });
      const rows = await h.db.selectFrom('attachments').select(['url', 'sort_order']).where('record_id', '=', recordId).orderBy('sort_order').execute();
      expect(rows).toHaveLength(4200);
      expect(rows.every((r, i) => r.sort_order === i && r.url === `https://x.example/${i}`)).toBe(true);
    });
  });
});
