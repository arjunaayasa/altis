import { createHash, randomBytes } from 'node:crypto';
import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { AttachmentCreateBody } from '@altis/shared/api/catalog/attachments';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { orphanUploadsStep } from '../../src/catalog/attachments/housekeeping.js';
import { catalogFileAccess } from '../../src/catalog/attachments/access.js';
import {
  archiveAttachment,
  createAttachment,
  incrementReadCount,
  listAttachments,
  updateAttachment,
} from '../../src/catalog/attachments/service.js';
import type { HousekeepingStepContext } from '../../src/catalog/housekeeping.js';
import { setCover } from '../../src/catalog/records/cover.js';
import { UPLOAD_CONTEXTS } from '../../src/files/contexts.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { acceptChunk, completeUpload, createUpload, prepareUpload, uploadOwner } from '../../src/files/uploads.js';
import { indexRecords } from '../../src/search/index-records.js';
import { writeSettings } from '../../src/settings/service.js';
import {
  ACTOR,
  DAY,
  NOW,
  STAFF,
  audits,
  changedEvents,
  failure,
  fieldErrors,
  openRecordsDb,
  type RecordsDb,
} from './catalog-records-support.js';

// The attachments of records, their files and the orphan cleanup (Phase 2 spec §8, K12; plan Task 18) on the engine
// picked by ALTIS_TEST_DB:
// - the attachment service claims a completed `catalog.attachment` upload (or stores a link), keeps `files.access`
//   equal to `attachments.access` in the same transaction, and on every change moves the record's `changed_at`,
//   indexes it and publishes `catalog.record.changed`; archiving makes the attachment and its file `staff`;
// - which access `/files/:id` serves a catalog file with: a cover or attachment of a hidden, archived or merged record
//   (or an archived or staff attachment) is not public; a run report is never served there (S18);
// - the orphan step of `catalog.housekeeping` removes, blob first, the unclaimed uploads of the catalog contexts once
//   they are 24 h old, in batches of 200, and a claim racing it fails rather than losing its file;
// - uploads: `catalog.attachment.maxMb` lowers the static ceiling; a cover's EXIF is gone before it is stored.

vi.mock('../../src/search/index-records.js', () => ({ indexRecords: vi.fn(async () => undefined) }));

const ctx = testDbContext();
const HOUR = 3_600_000;
const MIB = 1024 * 1024;

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe.skipIf(!ctx.available)(`catalog attachments [${engineLabel()}]`, () => {
  let db: RecordsDb;
  const indexed = vi.mocked(indexRecords);

  beforeAll(async () => {
    db = await openRecordsDb('attachments');
    await db.h.db
      .insertInto('staff_users')
      .values({ id: STAFF, username_key: 'pustakawan', username_display: 'pustakawan', name: 'Pustakawan', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(() => {
    indexed.mockClear();
  });

  /** A record (version 0, `changed_at` a day back); hidden, archived or merged into another when asked. */
  async function seedRecord(o: { opacVisible?: boolean; archived?: boolean; mergedInto?: string } = {}): Promise<string> {
    const id = newId();
    await db.h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: await db.materialTypeId('BUKU'),
        title: 'Laskar Pelangi',
        subtitle: null,
        responsibility: null,
        title_key: 'laskar pelangi',
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
        opac_visible: o.opacVisible === false ? 0 : 1,
        source: 'manual',
        merged_into: o.mergedInto ?? null,
        changed_at: NOW - DAY,
        archived_at: o.archived === true || o.mergedInto !== undefined ? NOW - DAY : null,
        created_at: NOW - DAY,
        created_by: null,
        updated_at: NOW - DAY,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** A completed upload's `files` row (no owner) created at `createdAt`, with its blob unless `blob: false`. */
  async function seedFile(o: { context?: string; createdAt?: number; blob?: boolean; ownerType?: string | null; ownerId?: string | null; access?: string } = {}) {
    const id = newId(o.createdAt ?? NOW);
    const data = new Uint8Array(randomBytes(64));
    await db.h.db
      .insertInto('files')
      .values({
        id,
        original_name: 'lampiran.pdf',
        mime: 'application/pdf',
        size: data.byteLength,
        sha256: sha(data),
        context: o.context ?? 'catalog.attachment',
        owner_type: o.ownerType ?? null,
        owner_id: o.ownerId ?? null,
        access: o.access ?? 'staff',
        status: 'ok',
        created_at: o.createdAt ?? NOW,
        created_by: STAFF,
      })
      .execute();
    if (o.blob !== false) await localStorageDriver(db.dataDir).put(id, data, { size: data.byteLength, sha256: sha(data) });
    return id;
  }

  const fileRow = (id: string) =>
    db.h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access', 'status']).where('id', '=', id).executeTakeFirst();
  const recordRow = (id: string) => db.h.db.selectFrom('records').select(['changed_at', 'version']).where('id', '=', id).executeTakeFirstOrThrow();
  const attachmentRow = (id: string) => db.h.db.selectFrom('attachments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const create = (recordId: string, body: AttachmentCreateBody, now = NOW) => db.run((tx) => createAttachment(tx, recordId, body), now);

  describe('createAttachment', () => {
    it('claims a catalog.attachment upload: the file belongs to the attachment and takes its access', async () => {
      const recordId = await seedRecord();
      const fileId = await seedFile();
      const view = await create(recordId, { kind: 'file', fileId, title: 'Bab 1', description: 'Pratinjau', access: 'public' });
      expect(view).toEqual({
        id: expect.any(String),
        recordId,
        kind: 'file',
        fileId,
        url: null,
        title: 'Bab 1',
        description: 'Pratinjau',
        access: 'public',
        mime: 'application/pdf',
        size: 64,
        readCount: 0,
        sortOrder: 0,
        version: 0,
      });
      expect(await fileRow(fileId)).toEqual({ owner_type: 'attachments', owner_id: view.id, access: 'public', status: 'ok' });
      // The record's public representation changed: changed_at moves, its version stays (the editor keeps its own).
      expect(await recordRow(recordId)).toMatchObject({ changed_at: NOW, version: 0 });
      expect(indexed).toHaveBeenCalledWith(expect.anything(), [recordId], NOW);
      expect(await changedEvents(db, recordId)).toBe(1);
      expect(await audits(db, 'catalog.attachment.create', view.id)).toEqual([
        { entity: 'attachments', meta: { recordId, kind: 'file', access: 'public' } },
      ]);
    });

    it('stores a link after the attachments already there; a non-http(s) link is a field error', async () => {
      const recordId = await seedRecord();
      const first = await create(recordId, { kind: 'url', url: 'https://repositori.example.id/a', title: 'Repositori', access: 'staff' });
      const second = await create(recordId, { kind: 'url', url: 'http://contoh.example/b', title: 'Contoh', access: 'public' });
      expect([first.sortOrder, second.sortOrder]).toEqual([0, 1]);
      expect(second).toMatchObject({ kind: 'url', url: 'http://contoh.example/b', fileId: null, mime: null, size: null });
      expect(await fieldErrors(create(recordId, { kind: 'url', url: 'javascript:alert(1)', title: 'x', access: 'public' }))).toEqual([
        { path: 'url', code: 'invalid_url' },
      ]);
    });

    it('refuses a file that is missing, of another context, owned already or claimed by an orphan cleanup', async () => {
      const recordId = await seedRecord();
      const body = (fileId: string): AttachmentCreateBody => ({ kind: 'file', fileId, title: 'x', access: 'public' });
      expect(await fieldErrors(create(recordId, body(newId())))).toEqual([{ path: 'fileId', code: 'not_found' }]);
      expect(await fieldErrors(create(recordId, body(await seedFile({ context: 'catalog.cover' }))))).toEqual([{ path: 'fileId', code: 'invalid' }]);
      const owned = await seedFile({ ownerType: 'attachments', ownerId: newId() });
      expect(await fieldErrors(create(recordId, body(owned)))).toEqual([{ path: 'fileId', code: 'invalid' }]);
      const marked = await seedFile({ ownerType: 'orphan' });
      expect(await fieldErrors(create(recordId, body(marked)))).toEqual([{ path: 'fileId', code: 'invalid' }]);
      // Nothing was written by the refusals.
      expect(await db.h.db.selectFrom('attachments').select('id').where('record_id', '=', recordId).execute()).toEqual([]);
    });

    it('refuses an unknown record (NOT_FOUND) and a merged one (CATALOG_MERGE_INVALID)', async () => {
      const link: AttachmentCreateBody = { kind: 'url', url: 'https://a.example/', title: 'a', access: 'public' };
      expect(await failure(create(newId(), link))).toMatchObject({ code: 'NOT_FOUND' });
      const merged = await seedRecord({ mergedInto: await seedRecord() });
      expect(await failure(create(merged, link))).toMatchObject({ code: 'CATALOG_MERGE_INVALID' });
    });
  });

  describe('updateAttachment and archiveAttachment', () => {
    it('changes the fields sent; files.access follows attachments.access in the same transaction', async () => {
      const recordId = await seedRecord();
      const fileId = await seedFile();
      const a = await create(recordId, { kind: 'file', fileId, title: 'Bab 1', access: 'public' }, NOW - HOUR);
      const later = NOW + 1000;
      const updated = await db.run((tx) => updateAttachment(tx, a.id, { version: 0, access: 'staff', title: 'Bab 1 (revisi)', description: '' }), later);
      expect(updated).toMatchObject({ title: 'Bab 1 (revisi)', description: null, access: 'staff', version: 1 });
      expect((await fileRow(fileId))?.access).toBe('staff');
      expect((await recordRow(recordId)).changed_at).toBe(later);
      expect(indexed).toHaveBeenLastCalledWith(expect.anything(), [recordId], later);
      expect(await audits(db, 'catalog.attachment.update', a.id)).toEqual([
        { entity: 'attachments', meta: { recordId, fields: ['title', 'description', 'access'] } },
      ]);
      const back = await db.run((tx) => updateAttachment(tx, a.id, { version: 1, access: 'public', sortOrder: 5 }), later);
      expect(back).toMatchObject({ access: 'public', sortOrder: 5, version: 2 });
      expect((await fileRow(fileId))?.access).toBe('public');
    });

    it('refuses a stale version (CONFLICT_STALE) and an unknown or archived attachment (NOT_FOUND)', async () => {
      const recordId = await seedRecord();
      const a = await create(recordId, { kind: 'url', url: 'https://a.example/', title: 'a', access: 'public' });
      expect(await failure(db.run((tx) => updateAttachment(tx, a.id, { version: 7, title: 'b' })))).toMatchObject({ code: 'CONFLICT_STALE' });
      expect(await failure(db.run((tx) => updateAttachment(tx, newId(), { version: 0, title: 'b' })))).toMatchObject({ code: 'NOT_FOUND' });
      await db.run((tx) => archiveAttachment(tx, a.id, 0));
      expect(await failure(db.run((tx) => updateAttachment(tx, a.id, { version: 1, title: 'b' })))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('archives: the attachment and its file become staff; a retry is answered as it is', async () => {
      const recordId = await seedRecord();
      const fileId = await seedFile();
      const a = await create(recordId, { kind: 'file', fileId, title: 'Bab 2', access: 'public' });
      const archived = await db.run((tx) => archiveAttachment(tx, a.id, 0), NOW + 5);
      expect(archived).toMatchObject({ access: 'staff', version: 1 });
      expect(await attachmentRow(a.id)).toMatchObject({ archived_at: NOW + 5, access: 'staff' });
      expect(await fileRow(fileId)).toEqual({ owner_type: 'attachments', owner_id: a.id, access: 'staff', status: 'ok' });
      expect((await recordRow(recordId)).changed_at).toBe(NOW + 5);
      expect(await failure(db.run((tx) => archiveAttachment(tx, a.id, 0)))).toMatchObject({ code: 'CONFLICT_STALE' });
      const again = await db.run((tx) => archiveAttachment(tx, a.id, 1));
      expect(again.version).toBe(1);
      expect(await audits(db, 'catalog.attachment.archive', a.id)).toEqual([
        { entity: 'attachments', meta: { recordId } },
        { entity: 'attachments', meta: { recordId, alreadyArchived: true } },
      ]);
      // An archived attachment is gone for the librarian and for the OPAC.
      expect(await listAttachments(db.h.db, recordId, { publicOnly: false })).toEqual([]);
    });
  });

  describe('listAttachments and incrementReadCount', () => {
    it('lists the live attachments in sort order; publicOnly leaves out the staff ones', async () => {
      const recordId = await seedRecord();
      const a = await create(recordId, { kind: 'url', url: 'https://a.example/', title: 'A', access: 'public' });
      const b = await create(recordId, { kind: 'url', url: 'https://b.example/', title: 'B', access: 'staff' });
      const c = await create(recordId, { kind: 'file', fileId: await seedFile(), title: 'C', access: 'public' });
      await db.run((tx) => updateAttachment(tx, a.id, { version: 0, sortOrder: 9 }));
      expect((await listAttachments(db.h.db, recordId, { publicOnly: false })).map((v) => v.title)).toEqual(['B', 'C', 'A']);
      expect((await listAttachments(db.h.db, recordId, { publicOnly: true })).map((v) => v.id)).toEqual([c.id, a.id]);
      expect(b.access).toBe('staff');
      expect(await failure(listAttachments(db.h.db, newId(), { publicOnly: false }))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('counts a read best effort: +1 each, nothing for an unknown id (no row is created, nothing thrown)', async () => {
      const recordId = await seedRecord();
      const a = await create(recordId, { kind: 'url', url: 'https://a.example/', title: 'A', access: 'public' });
      await incrementReadCount(db.h, a.id);
      await incrementReadCount(db.h, a.id);
      expect(Number((await attachmentRow(a.id)).read_count)).toBe(2);
      const before = await db.h.db.selectFrom('attachments').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      await expect(incrementReadCount(db.h, newId())).resolves.toBeUndefined();
      await expect(incrementReadCount(db.h, 'not-an-id')).resolves.toBeUndefined();
      const after = await db.h.db.selectFrom('attachments').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
      expect(Number(after.n)).toBe(Number(before.n));
    });
  });

  describe('catalogFileAccess', () => {
    const access = async (fileId: string) => {
      const f = await db.h.db.selectFrom('files').select(['context', 'owner_type', 'owner_id', 'access']).where('id', '=', fileId).executeTakeFirstOrThrow();
      return catalogFileAccess(db.h.db, f);
    };

    it('serves a public attachment of a visible record as public, and every other one as not published', async () => {
      const visible = await seedRecord();
      const hidden = await seedRecord({ opacVisible: false });
      const archived = await seedRecord({ archived: true });
      const target = await seedRecord();
      const merged = await seedRecord({ mergedInto: target });
      const attach = async (recordId: string, access: 'public' | 'staff') => {
        const fileId = await seedFile();
        await create(recordId, { kind: 'file', fileId, title: 'x', access });
        return fileId;
      };
      expect(await access(await attach(visible, 'public'))).toBe('public');
      expect(await access(await attach(visible, 'staff'))).toBe('staff');
      expect(await access(await attach(hidden, 'public'))).toBe('unpublished');
      expect(await access(await attach(archived, 'public'))).toBe('unpublished');
      // A merged record's attachments moved to its target; one written straight under it is not published either.
      const left = await seedFile({ ownerType: 'attachments', access: 'public' });
      const row = await create(target, { kind: 'url', url: 'https://x.example/', title: 'x', access: 'public' });
      await db.h.db.updateTable('attachments').set({ record_id: merged, kind: 'file', file_id: left, url: null }).where('id', '=', row.id).execute();
      await db.h.db.updateTable('files').set({ owner_id: row.id }).where('id', '=', left).execute();
      expect(await access(left)).toBe('unpublished');
      // An archived attachment whose file somehow stayed public.
      const fileId = await attach(visible, 'public');
      const a = (await db.h.db.selectFrom('attachments').select('id').where('file_id', '=', fileId).executeTakeFirstOrThrow()).id;
      await db.h.db.updateTable('attachments').set({ archived_at: NOW }).where('id', '=', a).execute();
      expect(await access(fileId)).toBe('unpublished');
    });

    it('serves a cover by its record, other public files as they are, and never a run report (S18)', async () => {
      const visible = await seedRecord();
      const hidden = await seedRecord({ opacVisible: false });
      const cover = async (recordId: string) => {
        const fileId = await seedFile({ context: 'catalog.cover' });
        await db.run((tx) => setCover(tx, recordId, fileId, 0));
        return fileId;
      };
      expect(await access(await cover(visible))).toBe('public');
      expect(await access(await cover(hidden))).toBe('unpublished');
      expect(await access(await seedFile({ context: 'opac.page_image', ownerType: 'pages', ownerId: newId(), access: 'public' }))).toBe('public');
      expect(await access(await seedFile({ context: 'catalog.report', ownerType: 'catalog_runs', ownerId: newId() }))).toBe('never');
      expect(await access(await seedFile({ context: 'catalog.report' }))).toBe('never');
      expect(await access(await seedFile({ context: 'test', ownerType: 'catalog_runs', ownerId: newId(), access: 'public' }))).toBe('never');
    });
  });

  describe('orphanUploadsStep', () => {
    const storage = () => localStorageDriver(db.dataDir);
    const hasBlob = async (id: string) => (await storage().stat(id)) !== null;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    function stepContext(o: { now?: number; cursor?: string | null; budget?: () => number } = {}): HousekeepingStepContext {
      return {
        h: db.h,
        now: o.now ?? NOW,
        deps: { dataDir: db.dataDir, baseUrl: 'https://perpustakaan.example', keyring: [], storage: storage(), log },
        cursor: o.cursor ?? null,
        budgetLeftMs: o.budget ?? (() => 60_000),
        enqueue: async () => {
          throw new Error('the orphan step queues nothing');
        },
      };
    }

    beforeEach(async () => {
      await db.h.db.deleteFrom('files').where('owner_id', 'is', null).execute();
    });

    it('removes unclaimed catalog uploads 25 h old (blob and row) and keeps those 23 h old, owned ones and other contexts', async () => {
      const old = NOW - 25 * HOUR;
      const removed = await Promise.all(['catalog.cover', 'catalog.attachment', 'catalog.floor_plan', 'opac.page_image'].map((context) => seedFile({ context, createdAt: old })));
      const young = await seedFile({ context: 'catalog.attachment', createdAt: NOW - 23 * HOUR });
      const owned = await seedFile({ context: 'catalog.cover', createdAt: old, ownerType: 'records', ownerId: newId(), access: 'public' });
      const other = await seedFile({ context: 'test', createdAt: old });
      const report = await seedFile({ context: 'catalog.report', createdAt: old });

      expect(await orphanUploadsStep.run(stepContext())).toEqual({ done: true, cursor: null });
      for (const id of removed) {
        expect(await fileRow(id), id).toBeUndefined();
        expect(await hasBlob(id), id).toBe(false);
      }
      for (const id of [young, owned, other, report]) {
        expect(await fileRow(id), id).toBeDefined();
        expect(await hasBlob(id), id).toBe(true);
      }
    });

    it('finishes the rows a killed run had marked (their blobs gone already)', async () => {
      const marked = await seedFile({ createdAt: NOW - 30 * HOUR, ownerType: 'orphan', blob: false });
      expect(await orphanUploadsStep.run(stepContext())).toEqual({ done: true, cursor: null });
      expect(await fileRow(marked)).toBeUndefined();
    });

    it('works in batches of 200 and stops with a cursor when the budget runs out', async () => {
      const old = NOW - 2 * DAY;
      for (let i = 0; i < 450; i += 50) {
        await db.h.db
          .insertInto('files')
          .values(
            Array.from({ length: 50 }, () => ({
              id: newId(old),
              original_name: 'x.jpg',
              mime: 'image/jpeg',
              size: 1,
              sha256: '0'.repeat(64),
              context: 'catalog.cover',
              owner_type: null,
              owner_id: null,
              access: 'staff',
              status: 'ok',
              created_at: old,
              created_by: null,
            })),
          )
          .execute();
      }
      const left = async () => Number((await db.h.db.selectFrom('files').select((eb) => eb.fn.countAll().as('n')).where('owner_id', 'is', null).executeTakeFirstOrThrow()).n);
      let budget = 60_000;
      const first = await orphanUploadsStep.run(stepContext({ budget: () => budget }));
      expect(first).toEqual({ done: true, cursor: null });
      expect(await left()).toBe(0);

      // Again, with the budget spent after the first batch: one batch per slice, then the cursor carries on.
      for (let i = 0; i < 450; i += 1) {
        await db.h.db
          .insertInto('files')
          .values({ id: newId(old), original_name: 'x.jpg', mime: 'image/jpeg', size: 1, sha256: '0'.repeat(64), context: 'catalog.cover', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: old, created_by: null })
          .execute();
      }
      budget = 0;
      const slice1 = await orphanUploadsStep.run(stepContext({ budget: () => budget }));
      expect(slice1.done).toBe(false);
      expect(typeof slice1.cursor).toBe('string');
      expect(await left()).toBe(250);
      const slice2 = await orphanUploadsStep.run(stepContext({ budget: () => budget, cursor: slice1.cursor }));
      expect(slice2.done).toBe(false);
      expect(await left()).toBe(50);
      expect(await orphanUploadsStep.run(stepContext({ budget: () => budget, cursor: slice2.cursor }))).toEqual({ done: true, cursor: null });
      expect(await left()).toBe(0);
    });

    it('a file claimed before the step ran is kept; a claim after it marked the file is refused', async () => {
      const recordId = await seedRecord();
      const claimed = await seedFile({ context: 'catalog.cover', createdAt: NOW - 2 * DAY });
      await db.run((tx) => setCover(tx, recordId, claimed, 0));
      expect(await orphanUploadsStep.run(stepContext())).toEqual({ done: true, cursor: null });
      expect(await fileRow(claimed)).toMatchObject({ owner_type: 'records', owner_id: recordId });
      expect(await hasBlob(claimed)).toBe(true);
      // A row the step marked (a run killed before its blob went) can no longer be claimed by a cover or an attachment.
      const marked = await seedFile({ context: 'catalog.cover', createdAt: NOW - 2 * DAY, ownerType: 'orphan' });
      expect(await fieldErrors(db.run((tx) => setCover(tx, recordId, marked, 1)))).toEqual([{ path: 'fileId', code: 'invalid' }]);
    });
  });

  describe('uploads of the catalog contexts', () => {
    const owner = () => uploadOwner(STAFF);
    const storage = () => localStorageDriver(db.dataDir);

    /** The stored content of `fileId`. */
    async function collect(fileId: string): Promise<Buffer> {
      const parts: Buffer[] = [];
      for await (const part of (await storage().get(fileId))!) parts.push(Buffer.from(part));
      return Buffer.concat(parts);
    }

    async function upload(context: keyof typeof UPLOAD_CONTEXTS, data: Uint8Array): Promise<string> {
      const s = await withTx(db.h, (trx) =>
        createUpload(trx, { owner: owner(), context: UPLOAD_CONTEXTS[context]!, size: data.byteLength, sha256: sha(data), now: NOW, dataDir: db.dataDir }),
      );
      for (let n = 0; n * s.chunkSize < data.byteLength; n += 1) {
        await acceptChunk(db.h, { id: s.id, owner: owner(), n, data: data.subarray(n * s.chunkSize, (n + 1) * s.chunkSize), now: NOW, dataDir: db.dataDir });
      }
      const done = await completeUpload(db.h, { id: s.id, owner: owner(), originalName: 'foto.jpg', now: NOW, dataDir: db.dataDir });
      return (done as { fileId: string }).fileId;
    }

    it('catalog.attachment.maxMb lowers the 2 GiB ceiling when the upload is declared (and before the disk is probed)', async () => {
      await withTx(db.h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1 }, { now: NOW, actorId: ACTOR.id, keyring: [] }));
      const context = UPLOAD_CONTEXTS['catalog.attachment']!;
      const probe = vi.fn(async () => undefined);
      expect(await failure(prepareUpload(db.h, { context, size: 2 * MIB, dataDir: db.dataDir, now: NOW, ensureHeadroom: probe }))).toMatchObject({
        code: 'UPLOAD_TOO_LARGE',
        meta: { maxBytes: MIB },
      });
      expect(probe).not.toHaveBeenCalled();
      const declare = (size: number) =>
        withTx(db.h, (trx) => createUpload(trx, { owner: owner(), context, size, sha256: '0'.repeat(64), now: NOW, dataDir: db.dataDir }));
      expect(await failure(declare(2 * MIB))).toMatchObject({ code: 'UPLOAD_TOO_LARGE', meta: { maxBytes: MIB } });
      const ok = await declare(MIB);
      await db.h.db.deleteFrom('upload_sessions').where('id', '=', ok.id).execute();
      await withTx(db.h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 200 }, { now: NOW, actorId: ACTOR.id, keyring: [] }));
    });

    it('stores a cover without its EXIF: the size and SHA-256 of the files row are those of the stripped bytes', async () => {
      const seg = (marker: number, body: string): number[] => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...Buffer.from(body, 'latin1')];
      const jpeg = Uint8Array.from([
        0xff, 0xd8,
        ...seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
        ...seg(0xe1, 'Exif\0\0MM\0*GPS -6.2,106.8'),
        ...seg(0xdb, '\0'.repeat(65)),
        ...seg(0xda, '\x01\x01\0\0\x3f\0'),
        0x12, 0x34, 0xff, 0xd9,
      ]);
      const fileId = await upload('catalog.cover', jpeg);
      const row = await db.h.db.selectFrom('files').select(['size', 'sha256', 'mime']).where('id', '=', fileId).executeTakeFirstOrThrow();
      const stored = await collect(fileId);
      expect(stored.toString('latin1')).not.toContain('Exif');
      expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect([Number(row.size), row.sha256, row.mime]).toEqual([stored.byteLength, sha(stored), 'image/jpeg']);
      expect(stored.byteLength).toBeLessThan(jpeg.byteLength);
    });

    it('C15: a page image and a floor plan (sent as the camera wrote them) keep their EXIF orientation alone', async () => {
      const seg = (marker: number, body: number[]): number[] => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
      const ascii = (s: string): number[] => [...Buffer.from(s, 'latin1')];
      // A big-endian TIFF: an IFD0 of Make ('Pixel 8', at offset 38) and Orientation 6 (a portrait photo), no IFD1.
      const tiff = [...ascii('MM\0*\0\0\0\x08'), 0, 2, 0x01, 0x0f, 0, 2, 0, 0, 0, 8, 0, 0, 0, 38, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, ...ascii('Pixel 8\0')];
      const body = [...seg(0xdb, ascii('\0'.repeat(65))), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0xd9];
      const photo = Uint8Array.from([0xff, 0xd8, ...seg(0xe1, [...ascii('Exif\0\0'), ...tiff]), ...body]);
      const oriented = Buffer.from([0xff, 0xd8, ...seg(0xe1, [...ascii('Exif\0\0MM\0*\0\0\0\x08'), 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]), ...body]);
      for (const context of ['opac.page_image', 'catalog.floor_plan'] as const) {
        const stored = await collect(await upload(context, photo));
        expect(stored.toString('latin1'), context).not.toContain('Pixel 8');
        expect(stored, context).toEqual(oriented);
      }
    });

    it('refuses a cover whose image structure does not hold (UPLOAD_TYPE_REFUSED) and keeps an attachment as sent', async () => {
      const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x45, 0x78]);
      expect(await failure(upload('catalog.cover', broken))).toMatchObject({ code: 'UPLOAD_TYPE_REFUSED' });
      // An attachment is a document as the library got it: its bytes are not touched.
      const photo = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, ...Buffer.from('Exif\0\0MM', 'latin1'), 0xff, 0xd9]);
      const fileId = await upload('catalog.attachment', photo);
      const stored = await collect(fileId);
      expect(new Uint8Array(stored)).toEqual(photo);
    });
  });
});
