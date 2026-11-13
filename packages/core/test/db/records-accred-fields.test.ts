import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RecordBulkBody, RecordCreateBody } from '@altis/shared/api/catalog/records';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { txCtx, type Actor } from '../../src/context.js';
import { createCsvReader, csvRecordHeader, csvRecordRow, recordCsvCells } from '../../src/catalog/csv/index.js';
import { CSV_BOM, csvRow } from '../../src/export/csv.js';
import {
  archiveRecord,
  bulkUpdateRecords,
  createRecord,
  loadRecordData,
  mergeRecord,
  recordBodyFromDraft,
  recordDetail,
  updateRecord,
} from '../../src/catalog/records/index.js';
import { ACTOR, DAY, NOW, STAFF, fieldErrors, openRecordsDb, type RecordsDb } from './catalog-records-support.js';

// The four accreditation fields of a record (who it is meant for, who made a local work and its kind, the kind of a
// reference work): saved and loaded by the records service, mapped from a draft, carried through the CSV, and set in
// bulk. They are local annotations, not part of the bibliographic description: a change of only these fields bumps
// the record's version but leaves `updated_by`, `updated_at` and `changed_at` as they were, so a record migrated from
// SLiMS still counts as untouched in ALTIS and keeps following a later re-sync.

const ctx = testDbContext();

/** The actor of a migration run: no staff user. */
const MIGRATION: Actor = { type: 'system', id: null, ip: null };
/** When the record was migrated, a day before the edits. */
const MIGRATED_AT = NOW - DAY;

describe.skipIf(!ctx.available)(`records: the accreditation fields [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;

  const body = (over: Partial<RecordCreateBody> = {}): RecordCreateBody => ({ materialTypeId: buku, title: 'Kliping Lingkungan Sekolah', ...over });
  const row = (id: string) => db.h.db.selectFrom('records').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const fieldsOf = (r: { audience: string | null; local_work: string | null; local_work_kind: string | null; reference_kind: string | null }) => ({
    audience: r.audience,
    local_work: r.local_work,
    local_work_kind: r.local_work_kind,
    reference_kind: r.reference_kind,
  });
  const loaded = async (id: string) => {
    const d = (await loadRecordData(db.h.db, [id], { publicOnly: false, includeItems: false })).get(id)!;
    return { audience: d.audience, localWork: d.localWork, localWorkKind: d.localWorkKind, referenceKind: d.referenceKind };
  };
  /** A record as the SLiMS migration leaves it: saved in bulk mode by a run with no staff actor, a day ago. */
  const migrated = async (over: Partial<RecordCreateBody> = {}): Promise<string> =>
    (await withTx(db.h, (trx) => createRecord(txCtx(trx, MIGRATED_AT, MIGRATION), body(over), { mode: 'bulk', source: `slims:${newId().slice(-6)}` }))).id;
  const updateAudits = async (id: string) =>
    (await db.h.db.selectFrom('audit_log').select('meta').where('action', '=', 'catalog.record.update').where('entity_id', '=', id).orderBy('seq').execute()).map(
      (r) => JSON.parse(r.meta) as { fields: string[] },
    );
  const bulkAudits = async () =>
    (
      await db.h.db
        .selectFrom('audit_log')
        .select(['entity', 'entity_id', 'actor_id', 'meta'])
        .where('action', '=', 'catalog.record.bulk_update')
        .orderBy('seq')
        .execute()
    ).map((r) => ({ entity: r.entity, entityId: r.entity_id, actorId: r.actor_id, meta: JSON.parse(r.meta) as Record<string, unknown> }));
  const bulk = (b: RecordBulkBody, now = NOW) => db.run((tx) => bulkUpdateRecords(tx, b, now), now);

  beforeAll(async () => {
    db = await openRecordsDb('records-accred');
    buku = await db.materialTypeId('BUKU');
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('create, load and the detail', () => {
    it('a create with the four fields reads back equal, from the row, the load and the detail', async () => {
      const fields = { audience: 'children', localWork: 'student', localWorkKind: 'clipping', referenceKind: null } as const;
      const r = await db.run((tx) => createRecord(tx, body(fields)));
      expect(fieldsOf(await row(r.id))).toEqual({ audience: 'children', local_work: 'student', local_work_kind: 'clipping', reference_kind: null });
      expect(await loaded(r.id)).toEqual(fields);
      expect(await recordDetail(db.h.db, r.id)).toMatchObject(fields);
      // The public load carries them too (nothing in them is personal).
      const pub = (await loadRecordData(db.h.db, [r.id], { publicOnly: true, includeItems: false })).get(r.id)!;
      expect(pub).toMatchObject(fields);
      const entry = await db.h.db.selectFrom('audit_log').select('meta').where('action', '=', 'catalog.record.create').where('entity_id', '=', r.id).executeTakeFirstOrThrow();
      expect((JSON.parse(entry.meta) as { fields: string[] }).fields).toEqual(expect.arrayContaining(['audience', 'localWork', 'localWorkKind']));
    });

    it('a record saved without them stores and loads nulls', async () => {
      const r = await db.run((tx) => createRecord(tx, body({ title: 'Ensiklopedia Tanpa Ruas' })));
      expect(fieldsOf(await row(r.id))).toEqual({ audience: null, local_work: null, local_work_kind: null, reference_kind: null });
      expect(await loaded(r.id)).toEqual({ audience: null, localWork: null, localWorkKind: null, referenceKind: null });
    });

    it('a value outside its list is refused at its field, nothing written', async () => {
      const before = await db.h.db.selectFrom('records').select('id').execute();
      const bad = body({ audience: 'adults', localWork: 'alumni', referenceKind: 'novel' } as unknown as Partial<RecordCreateBody>);
      expect(await fieldErrors(db.run((tx) => createRecord(tx, bad)))).toEqual([
        { path: 'audience', code: 'invalid_value' },
        { path: 'localWork', code: 'invalid_value' },
        { path: 'referenceKind', code: 'invalid_value' },
      ]);
      expect(await db.h.db.selectFrom('records').select('id').execute()).toHaveLength(before.length);
    });

    it('recordBodyFromDraft maps the four fields: a value and null pass, an absent one stays absent', async () => {
      const draft: RecordDraft = {
        materialTypeCode: 'BUKU',
        title: 'Antologi Puisi Kelas IX',
        publisher: null,
        identifiers: [],
        agents: [],
        subjects: [],
        links: [],
        items: [],
        marcExtra: [],
        audience: 'general',
        localWork: 'school',
        localWorkKind: 'poetry',
        referenceKind: null,
      };
      const built = await recordBodyFromDraft(db.h.db, draft, { defaultMaterialTypeId: buku });
      expect(built.body).toMatchObject({ audience: 'general', localWork: 'school', localWorkKind: 'poetry', referenceKind: null });
      const { audience, localWork, localWorkKind, referenceKind, ...rest } = draft;
      void [audience, localWork, localWorkKind, referenceKind];
      const plain = await recordBodyFromDraft(db.h.db, rest, { defaultMaterialTypeId: buku });
      for (const key of ['audience', 'localWork', 'localWorkKind', 'referenceKind']) expect(key in plain.body, key).toBe(false);
    });
  });

  describe('update: a change of only these fields is not an edit of the description', () => {
    it('on a migrated record, PATCH {localWork} bumps the version only: updated_by stays null, updated_at and changed_at stay', async () => {
      const id = await migrated();
      const before = await row(id);
      expect(before).toMatchObject({ updated_by: null, updated_at: MIGRATED_AT, changed_at: MIGRATED_AT, version: 0 });
      const r = await db.run((tx) => updateRecord(tx, id, { version: 0, localWork: 'teacher' }));
      expect(r.version).toBe(1);
      const after = await row(id);
      expect(after).toMatchObject({ local_work: 'teacher', updated_by: null, version: 1 });
      expect(Number(after.updated_at)).toBe(MIGRATED_AT);
      expect(Number(after.changed_at)).toBe(MIGRATED_AT);
      expect(after.title_key).toBe(before.title_key);
      // It is still audited as an update of that field.
      expect(await updateAudits(id)).toEqual([{ fields: ['localWork'], authoritiesCreated: 0 }]);
    });

    it('the fields sent unchanged do not count: {title: same, localWorkKind} is still only an annotation', async () => {
      const id = await migrated({ title: 'Kumpulan Cerpen Siswa' });
      await db.run((tx) => updateRecord(tx, id, { version: 0, title: 'Kumpulan Cerpen Siswa', edition: null, localWork: 'student', localWorkKind: 'short_stories' }));
      expect(await row(id)).toMatchObject({ local_work: 'student', local_work_kind: 'short_stories', updated_by: null, version: 1 });
      expect(Number((await row(id)).changed_at)).toBe(MIGRATED_AT);
    });

    it('PATCH {title, audience} on a migrated record is an edit: updated_by is set, updated_at and changed_at = now', async () => {
      const id = await migrated({ title: 'Atlas Lama' });
      await db.run((tx) => updateRecord(tx, id, { version: 0, localWork: 'teacher' }));
      const at = NOW + 60_000;
      const r = await db.run((tx) => updateRecord(tx, id, { version: 1, title: 'Atlas Baru', audience: 'general' }), at);
      expect(r.version).toBe(2);
      const after = await row(id);
      expect(after).toMatchObject({ title: 'Atlas Baru', title_key: 'atlas baru', audience: 'general', local_work: 'teacher', updated_by: STAFF, version: 2 });
      expect(Number(after.updated_at)).toBe(at);
      expect(Number(after.changed_at)).toBe(at);
      expect((await updateAudits(id)).at(-1)).toEqual({ fields: ['title', 'audience'], authoritiesCreated: 0 });
    });

    it('a PATCH that changes nothing keeps the Phase 2 behaviour (an edit by the caller)', async () => {
      const id = await migrated({ title: 'Kamus Tanpa Ubah', referenceKind: 'dictionary' });
      await db.run((tx) => updateRecord(tx, id, { version: 0, referenceKind: 'dictionary' }));
      expect(await row(id)).toMatchObject({ updated_by: STAFF, version: 1 });
      expect(Number((await row(id)).changed_at)).toBe(NOW);
    });

    it('null clears a field (an annotation change too)', async () => {
      const id = await migrated({ title: 'Globe Sekolah', referenceKind: 'globe' });
      await db.run((tx) => updateRecord(tx, id, { version: 0, referenceKind: null }));
      expect(await row(id)).toMatchObject({ reference_kind: null, updated_by: null, version: 1 });
    });
  });

  describe('bulkUpdateRecords', () => {
    it('[live, archived, unknown] set {referenceKind: atlas} → updated 1, two refusals in body order; one audit entry', async () => {
      const live = await migrated({ title: 'Atlas Indonesia' });
      const archived = (await db.run((tx) => createRecord(tx, body({ title: 'Atlas Usang' })))).id;
      await db.run((tx) => archiveRecord(tx, archived, 0));
      const unknown = newId();
      const archivedBefore = await row(archived);
      const audited = (await bulkAudits()).length;

      const r = await bulk({ ids: [live, archived, unknown], set: { referenceKind: 'atlas' } });
      expect(r).toEqual({
        updated: 1,
        refused: [
          { id: archived, code: 'archived' },
          { id: unknown, code: 'not_found' },
        ],
      });
      const after = await row(live);
      expect(after).toMatchObject({ reference_kind: 'atlas', updated_by: null, version: 1 });
      expect(Number(after.updated_at)).toBe(MIGRATED_AT);
      expect(Number(after.changed_at)).toBe(MIGRATED_AT);
      expect(await row(archived)).toEqual(archivedBefore);
      expect((await bulkAudits()).slice(audited)).toEqual([{ entity: 'records', entityId: null, actorId: ACTOR.id, meta: { count: 1, fields: ['referenceKind'] } }]);
    });

    it('locks the records first, in id order, and never touches the search index', async () => {
      const ids = [await migrated({ title: 'Biografi B' }), await migrated({ title: 'Biografi A' }), await migrated({ title: 'Biografi C' })].reverse();
      const statements: { sql: string; parameters: readonly unknown[] }[] = [];
      const capture: KyselyPlugin = {
        transformQuery(args) {
          const compiled = db.h.db.getExecutor().compileQuery(args.node, args.queryId);
          statements.push({ sql: compiled.sql, parameters: compiled.parameters });
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      };
      await withTx({ ...db.h, db: db.h.db.withPlugin(capture) }, (trx) => bulkUpdateRecords(txCtx(trx, NOW, ACTOR), { ids, set: { referenceKind: 'biography', audience: 'general' } }, NOW));
      const work = statements.filter((s) => !/^\s*(begin|start|set|savepoint|release|commit|rollback|pragma)\b/i.test(s.sql));
      expect(work[0]!.sql).toMatch(/^update ["`]records["`] set ["`]version["`] = ["`]version["`] where ["`]id["`] in \(/);
      expect(work[0]!.parameters).toEqual([...ids].sort());
      expect(work.filter((s) => /search_/.test(s.sql))).toEqual([]);
      for (const id of ids) expect(await row(id)).toMatchObject({ reference_kind: 'biography', audience: 'general', version: 1, updated_by: null });
    });

    it('a record already as asked counts as updated and is not written; null clears; a merged record is archived', async () => {
      const same = await migrated({ title: 'Almanak Sama', referenceKind: 'almanac' });
      const cleared = await migrated({ title: 'Direktori Dihapus', referenceKind: 'directory' });
      const target = (await db.run((tx) => createRecord(tx, body({ title: 'Target Gabung' })))).id;
      const source = (await db.run((tx) => createRecord(tx, body({ title: 'Sumber Gabung' })))).id;
      await db.run((tx) => mergeRecord(tx, target, source, 0));

      expect(await bulk({ ids: [same, source], set: { referenceKind: 'almanac' } })).toEqual({ updated: 1, refused: [{ id: source, code: 'archived' }] });
      expect(await row(same)).toMatchObject({ reference_kind: 'almanac', version: 0 });

      expect(await bulk({ ids: [cleared], set: { referenceKind: null, localWork: null } })).toEqual({ updated: 1, refused: [] });
      expect(await row(cleared)).toMatchObject({ reference_kind: null, local_work: null, version: 1, updated_by: null });
      expect((await bulkAudits()).at(-1)!.meta).toEqual({ count: 1, fields: ['localWork', 'referenceKind'] });
    });

    it('publishes catalog.record.changed for each record it wrote', async () => {
      const a = await migrated({ title: 'Kliping A' });
      const b = await migrated({ title: 'Kliping B', localWork: 'student' });
      await bulk({ ids: [a, b], set: { localWork: 'student' } });
      const events = (await db.h.db.selectFrom('events').select(['channel', 'payload']).where('type', '=', 'catalog.record.changed').execute())
        .filter((e) => e.channel === 'catalog')
        .map((e) => (JSON.parse(e.payload) as { id: string }).id);
      expect(events.filter((id) => id === a)).toHaveLength(1);
      expect(events.filter((id) => id === b)).toHaveLength(0);
    });

    it('checks its body as the route does: an empty set and more than 500 ids are VALIDATION_FAILED', async () => {
      const id = await migrated({ title: 'Ditolak' });
      expect(await fieldErrors(bulk({ ids: [id], set: {} }))).toEqual([{ path: 'set', code: 'required' }]);
      const many = Array.from({ length: 501 }, () => newId());
      expect(await fieldErrors(bulk({ ids: many, set: { audience: 'general' } }))).toEqual([{ path: 'ids', code: 'too_big' }]);
      expect(await fieldErrors(bulk({ ids: [id, id], set: { audience: 'general' } }))).toEqual([{ path: 'ids', code: 'duplicate' }]);
      expect(await row(id)).toMatchObject({ audience: null, version: 0 });
    });
  });

  // Last in this file: it empties the database (one test database per worker) to import into.
  describe('csv-records: an export read into an empty database keeps the four values', () => {
    it('export (loadRecordData → recordCsvCells → a file) → a new database → csvRecordRow → recordBodyFromDraft → createRecord', async () => {
      const fields = { audience: 'special_needs', localWork: 'teacher', localWorkKind: 'written_work', referenceKind: 'handbook' } as const;
      const id = (await db.run((tx) => createRecord(tx, body({ title: 'Buku Pegangan Guru', ...fields })))).id;
      const data = (await loadRecordData(db.h.db, [id], { publicOnly: false, includeItems: false })).get(id)!;
      const file = new TextEncoder().encode(CSV_BOM + csvRow(csvRecordHeader([]), ',') + csvRow(recordCsvCells(data, []), ','));

      await db.close();
      db = await openRecordsDb('records-accred-copy');
      expect(await db.h.db.selectFrom('records').select('id').execute()).toEqual([]);

      const reader = createCsvReader();
      const [header, cells] = [...reader.push(file), ...reader.end()];
      const read = csvRecordRow(header!.cells, cells!.cells);
      expect(read.errors).toEqual([]);
      expect(read.draft).toMatchObject(fields);
      const built = await recordBodyFromDraft(db.h.db, read.draft, { defaultMaterialTypeId: await db.materialTypeId('BUKU') });
      const copy = await db.run((tx) => createRecord(tx, built.body));
      expect(await loaded(copy.id)).toEqual(fields);
      expect(fieldsOf(await row(copy.id))).toEqual({ audience: 'special_needs', local_work: 'teacher', local_work_kind: 'written_work', reference_kind: 'handbook' });
    });
  });
});
