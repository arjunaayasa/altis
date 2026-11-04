import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { indexRecords } from '../../src/search/index-records.js';
import { searchCatalog } from '../../src/search/search.js';
import { decodeSearchToken } from '../../src/search/tokenize.js';
import { LASKAR_ISBN, LASKAR_ISBN_HYPHENS, seedCatalog, wipeCatalog } from '../support/search-corpus.js';

// indexRecords, the synchronous index (Phase 2 spec §4.1, §4.2, §4.6; Review Focus 3; S20), on the engine picked by
// ALTIS_TEST_DB: the document's four token columns, its flags and sort keys, its facets, the full-text row, the 60 000
// byte cut, the rollback, and the custom values that may (public and searchable) or may not be indexed.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

describe.skipIf(!ctx.available)(`indexRecords [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-search-index-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    if (h !== undefined) await wipeCatalog(h);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await wipeCatalog(h);
  });

  const doc = (recordId: string) => h.db.selectFrom('search_doc').selectAll().where('record_id', '=', recordId).executeTakeFirst();
  const facets = async (recordId: string) =>
    (await h.db.selectFrom('search_facet').select(['facet', 'value_key']).where('record_id', '=', recordId).execute()).map((f) => `${f.facet}:${f.value_key}`).sort();
  const opac = async (text: string) => (await searchCatalog(h.db, { text, scope: 'opac', pageSize: 200 }, { now: NOW })).recordIds;
  const codeId = async (table: 'material_types' | 'languages' | 'collection_types', code: string) =>
    (await h.db.selectFrom(table).select('id').where('code_key', '=', code).executeTakeFirstOrThrow()).id;
  const reindex = (ids: string[]) => withTx(h, (trx) => indexRecords(trx, ids, NOW));

  /** A location row (every column named). */
  const location = (id: string, branchId: string, kind: string, parent: string | null, isPublic: 0 | 1) => ({
    id,
    branch_id: branchId,
    parent_id: parent,
    kind,
    code_display: id.slice(-6),
    code_key: id.slice(-6),
    name: `${kind} ${id.slice(-4)}`,
    shelf_hint: null,
    class_from: null,
    class_to: null,
    map_file_id: null,
    map_x: null,
    map_y: null,
    map_w: null,
    map_h: null,
    is_public: isPublic,
    sort_order: 0,
    archived_at: null,
    version: 0,
    created_at: NOW,
    created_by: null,
    updated_at: NOW,
    updated_by: null,
  });

  /** A `files` row of `mime`. */
  async function file(mime: string): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('files')
      .values({ id, original_name: 'x', mime, size: 1, sha256: '0'.repeat(64), context: 'catalog.attachment', owner_type: 'attachments', owner_id: null, access: 'public', status: 'ok', created_at: NOW, created_by: null })
      .execute();
    return id;
  }

  /** An attachment of `recordId`. */
  async function attachment(recordId: string, o: { kind: 'file' | 'url'; fileId?: string; access?: string; archived?: boolean }): Promise<void> {
    await h.db
      .insertInto('attachments')
      .values({
        id: newId(NOW),
        record_id: recordId,
        kind: o.kind,
        file_id: o.fileId ?? null,
        url: o.kind === 'url' ? 'https://example.org/x' : null,
        title: 'Lampiran',
        description: null,
        access: o.access ?? 'public',
        legacy_access_limit: null,
        read_count: 0,
        sort_order: 0,
        archived_at: o.archived === true ? NOW : null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
  }

  it('writes the four token columns, the flags, the sort keys and every facet of a record', async () => {
    const branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'CABANG', code_display: 'CABANG', name: 'Cabang', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    const [room, shelf] = [newId(NOW), newId(NOW)];
    await h.db.insertInto('locations').values([location(room, branchId, 'room', null, 1), location(shelf, branchId, 'shelf', room, 1)]).execute();
    const ids = await seedCatalog(
      h,
      [
        {
          key: 'r',
          title: 'Laskar Pelangi',
          subtitle: 'Edisi Khusus',
          series: 'Tetralogi Laskar',
          agents: ['Hirata, Andrea', { name: 'Tim Redaksi Bentang', type: 'organization' }],
          subjects: [{ term: 'Novel Indonesia', classification: '899.221' }, 'Pendidikan'],
          publisher: { name: 'Bentang Pustaka', place: 'Yogyakarta' },
          place: 'Jakarta',
          year: '2005',
          classification: '899.221',
          callNumber: '899.221 HIR',
          identifiers: [{ type: 'isbn', display: LASKAR_ISBN_HYPHENS, key: LASKAR_ISBN }],
          summary: 'Kisah sepuluh anak Belitung.',
          notes: 'Cetakan pertama.',
          language: 'IND',
          createdAt: NOW - 5000,
          items: [
            { barcode: 'B0000001', locationId: shelf, collectionType: 'UMUM', callNumber: '899.221 HIR l' },
            { barcode: 'B0000002', status: 'repair', collectionType: 'REF' },
            { barcode: 'B0000003', collectionType: 'TANDON', archived: true },
          ],
        },
      ],
      { now: NOW, branchId, index: false },
    );
    const id = ids.get('r')!;
    await attachment(id, { kind: 'file', fileId: await file('application/pdf') });
    await attachment(id, { kind: 'url' });
    await attachment(id, { kind: 'file', fileId: await file('audio/mpeg'), access: 'staff' });
    await attachment(id, { kind: 'file', fileId: await file('image/png'), archived: true });
    await reindex([id]);

    expect(await doc(id)).toMatchObject({
      record_id: id,
      is_public: 1,
      is_archived: 0,
      t_title: 'laskar pelangi edisi khusus tetralogi laskar',
      t_agents: 'hirata andrea andrea hirata tim redaksi bentang',
      t_subjects: 'novel indonesia 899 221 pendidikan 899 221',
      title_key: 'laskar pelangi edisi khusus',
      year: 2005,
      created_at: NOW - 5000,
      changed_at: NOW - 5000,
    });
    const rest = (await doc(id))!.t_rest.split(' ');
    expect(rest).toEqual(expect.arrayContaining([LASKAR_ISBN, 'bentang', 'pustaka', 'yogyakarta', 'jakarta', 'hir', 'b0000001', 'b0000002', 'kisah', 'cetakan']));
    expect(rest).not.toContain('b0000003'); // an archived item is not part of the record's document
    const mt = await codeId('material_types', 'BUKU');
    const subjects = await h.db.selectFrom('subjects').select('id').execute();
    expect(await facets(id)).toEqual(
      [
        `mt:${mt}`,
        `lg:${await codeId('languages', 'IND')}`,
        `ct:${await codeId('collection_types', 'UMUM')}`,
        `ct:${await codeId('collection_types', 'REF')}`,
        `br:${branchId}`,
        `lc:${room}`,
        'av:1',
        'at:pdf',
        'at:url',
        ...subjects.map((s) => `sb:${s.id}`),
        'cl:8',
      ].sort(),
    );
    expect(await opac('pendidikan laskar')).toEqual([id]);
  });

  it('av: an available item in a public location or without one; not in a closed room, not when it is not available', async () => {
    const branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'CABANG2', code_display: 'CABANG2', name: 'Cabang', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    const [closed, shelfInClosed, open] = [newId(NOW), newId(NOW), newId(NOW)];
    await h.db
      .insertInto('locations')
      .values([location(closed, branchId, 'room', null, 0), location(shelfInClosed, branchId, 'shelf', closed, 1), location(open, branchId, 'room', null, 1)])
      .execute();
    const ids = await seedCatalog(
      h,
      [
        { key: 'closed', title: 'Satu', items: [{ barcode: 'C1', locationId: shelfInClosed }] },
        { key: 'open', title: 'Dua', items: [{ barcode: 'C2', locationId: open }] },
        { key: 'none', title: 'Tiga', items: [{ barcode: 'C3' }] },
        { key: 'missing', title: 'Empat', items: [{ barcode: 'C4', status: 'missing' }] },
        { key: 'noitem', title: 'Lima' },
      ],
      { now: NOW, branchId },
    );
    const av = async (key: string) => (await facets(ids.get(key)!)).includes('av:1');
    expect(await av('closed')).toBe(false);
    expect(await av('open')).toBe(true);
    expect(await av('none')).toBe(true);
    expect(await av('missing')).toBe(false);
    expect(await av('noitem')).toBe(false);
    expect((await facets(ids.get('closed')!)).filter((f) => f.startsWith('lc:'))).toEqual([`lc:${closed}`]);
  });

  it('at: the MIME family of each public live file (pdf, audio, video, image, other) or url', async () => {
    const ids = await seedCatalog(h, [{ key: 'r', title: 'Lampiran' }], { now: NOW, index: false });
    const id = ids.get('r')!;
    for (const mime of ['audio/ogg', 'video/mp4', 'image/jpeg', 'application/zip']) await attachment(id, { kind: 'file', fileId: await file(mime) });
    await reindex([id]);
    expect((await facets(id)).filter((f) => f.startsWith('at:'))).toEqual(['at:audio', 'at:image', 'at:other', 'at:video']);
  });

  it('Review Focus 3: summary + notes + custom text over 60 000 bytes → t_rest ≤ 60 000 bytes, valid UTF-8, cut between tokens; found by a title word', async () => {
    // Multi-byte tokens that NFKD keeps: Arabic (2 bytes a letter) and CJK (3 bytes a character).
    // The summary stays within its own 60 000-byte cap (longText; a MySQL/MariaDB TEXT holds 65 535 bytes), and the
    // summary and notes together go past 60 000 bytes.
    const summary = 'كتاب 図書館目録 '.repeat(2390); // 59 750 bytes
    const notes = 'ب'.repeat(500);
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(summary + notes, 'utf8')).toBeGreaterThan(60_000);
    const ids = await seedCatalog(h, [{ key: 'r', title: 'Ensiklopedia Arsitektur Nusantara', summary, notes }], { now: NOW });
    const id = ids.get('r')!;
    const row = (await doc(id))!;
    const bytes = Buffer.from(row.t_rest, 'utf8');
    expect(bytes.length).toBeLessThanOrEqual(60_000);
    expect(bytes.length).toBeGreaterThan(59_000);
    expect(bytes.toString('utf8')).toBe(row.t_rest);
    expect(row.t_rest).not.toContain('\u{FFFD}');
    // Task 39: every token of another script is written in ASCII (tokenize.ts step 6), a long one cut to 20 code points.
    for (const token of row.t_rest.split(' ')) expect(['كتاب', '図書館目録', 'ب'.repeat(20)]).toContain(decodeSearchToken(token));
    expect(row.t_rest).toMatch(/^[0-9a-z ]+$/);
    expect(await opac('كتاب')).toEqual([id]);
    expect(await opac('arsitektur')).toEqual([id]);
  });

  it('an indexRecords inside a transaction that rolls back leaves no document, facet or full-text row', async () => {
    const ids = await seedCatalog(h, [{ key: 'r', title: 'Gulungan Batal', items: [{ barcode: 'R1' }] }], { now: NOW, index: false });
    const id = ids.get('r')!;
    await expect(
      withTx(h, async (trx) => {
        await indexRecords(trx, [id], NOW);
        throw new Error('the write failed');
      }),
    ).rejects.toThrow('the write failed');
    expect(await doc(id)).toBeUndefined();
    expect(await facets(id)).toEqual([]);
    expect(await opac('gulungan')).toEqual([]);
    if (ctx.engine === 'sqlite') {
      const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH '"gulungan"'`.execute(h.db);
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });

  it('a record written again replaces its document; the old words no longer match; FTS5 stays consistent', async () => {
    const ids = await seedCatalog(h, [{ key: 'r', title: 'Judul Lama Sekali', items: [{ barcode: 'X1' }] }], { now: NOW });
    const id = ids.get('r')!;
    expect(await opac('lama')).toEqual([id]);
    await h.db.updateTable('records').set({ title: 'Judul Baru Saja', title_key: 'judul baru saja' }).where('id', '=', id).execute();
    await reindex([id, id]);
    expect(await opac('lama')).toEqual([]);
    expect(await opac('baru')).toEqual([id]);
    expect(await h.db.selectFrom('search_doc').select('record_id').execute()).toEqual([{ record_id: id }]);
    if (ctx.engine === 'sqlite') await sql`INSERT INTO search_fts(search_fts) VALUES ('integrity-check')`.execute(h.db);
  });

  it('flags: hidden, archived and merged records are not public; an archived record is marked archived; a gone record loses its document', async () => {
    const ids = await seedCatalog(
      h,
      [
        { key: 'live', title: 'Hidup' },
        { key: 'hidden', title: 'Tersembunyi', hidden: true },
        { key: 'archived', title: 'Diarsipkan', archived: true },
        { key: 'merged', title: 'Digabung', mergedInto: 'live' },
      ],
      { now: NOW },
    );
    const flags = async (key: string) => {
      const row = (await doc(ids.get(key)!))!;
      return [row.is_public, row.is_archived];
    };
    expect(await flags('live')).toEqual([1, 0]);
    expect(await flags('hidden')).toEqual([0, 0]);
    expect(await flags('archived')).toEqual([0, 1]);
    expect(await flags('merged')).toEqual([0, 1]);
    // A record deleted outright (a test fixture; the API archives) loses its document on its next index.
    const gone = ids.get('archived')!;
    await h.db.deleteFrom('records').where('id', '=', gone).execute();
    await reindex([gone, newId(NOW)]);
    expect(await doc(gone)).toBeUndefined();
    await reindex([]);
    await expect(withTx(h, (trx) => indexRecords(trx, 'nope' as unknown as string[], NOW))).rejects.toThrow(TypeError);
  });

  describe('S20: custom values in t_rest only for fields that are searchable AND public', () => {
    async function defineField(entity: 'records' | 'items', code: string, o: { isPublic: 0 | 1; isSearchable: 0 | 1; type?: string; options?: string | null }): Promise<string> {
      const id = newId(NOW);
      await h.db
        .insertInto('custom_field_defs')
        .values({
          id,
          entity,
          code_key: code.toUpperCase(),
          code_display: code,
          label: code,
          label_en: null,
          type: o.type ?? 'text',
          options: o.options ?? null,
          is_required: 0,
          sort_order: 0,
          is_public: o.isPublic,
          is_searchable: o.isSearchable,
          archived_at: null,
          version: 0,
          created_at: NOW,
          created_by: null,
          updated_at: NOW,
          updated_by: null,
        })
        .execute();
      return id;
    }
    const value = (fieldId: string, entityId: string, v: unknown) =>
      h.db.insertInto('custom_values').values({ field_id: fieldId, entity_id: entityId, value: JSON.stringify(v), updated_at: NOW, updated_by: null }).execute();

    it('a searchable staff-only value is not found from the OPAC (nor indexed at all); a searchable public one is', async () => {
      const pub = await defineField('records', 'kode_lokal', { isPublic: 1, isSearchable: 1 });
      const staff = await defineField('records', 'catatan_staf', { isPublic: 0, isSearchable: 1 });
      const shown = await defineField('records', 'warna', { isPublic: 1, isSearchable: 0 });
      const kind = await defineField('records', 'jenis', {
        isPublic: 1,
        isSearchable: 1,
        type: 'select',
        options: JSON.stringify([{ value: 'hdc', label_id: 'Sampulkeras', label_en: 'Hardcover' }]),
      });
      const itemField = await defineField('items', 'rak_lama', { isPublic: 1, isSearchable: 1 });
      const ids = await seedCatalog(
        h,
        [
          { key: 'a', title: 'Satu', items: [{ barcode: 'S20A' }] },
          { key: 'b', title: 'Dua' },
        ],
        { now: NOW, index: false },
      );
      const [a, b] = [ids.get('a')!, ids.get('b')!];
      const itemId = (await h.db.selectFrom('items').select('id').where('record_id', '=', a).executeTakeFirstOrThrow()).id;
      await value(staff, a, 'rahasiakita');
      await value(pub, b, 'kodeterbuka');
      await value(shown, b, 'merahmuda');
      await value(kind, b, 'hdc');
      await value(itemField, itemId, 'rakkuno');
      await reindex([a, b]);
      expect(await opac('rahasiakita')).toEqual([]);
      expect((await searchCatalog(h.db, { text: 'rahasiakita', scope: 'admin', filters: { includeHidden: true, includeArchived: true } }, { now: NOW })).recordIds).toEqual([]);
      expect((await doc(a))!.t_rest).not.toContain('rahasiakita');
      expect(await opac('kodeterbuka')).toEqual([b]);
      expect(await opac('merahmuda')).toEqual([]);
      expect(await opac('sampulkeras')).toEqual([b]);
      expect(await opac('hardcover')).toEqual([b]);
      expect(await opac('rakkuno')).toEqual([a]);
    });
  });
});
