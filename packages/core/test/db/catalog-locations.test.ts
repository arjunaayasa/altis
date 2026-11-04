import { withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { LocationBody } from '@altis/shared/api/catalog/locations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext } from '../../../../tools/test/test-db.js';
import {
  archiveLocation,
  createLocation,
  enqueueLocationReindex,
  listLocations,
  setLocationMap,
  updateLocation,
} from '../../src/catalog/locations/index.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import * as core from '../../src/index.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { searchJobs } from '../../src/search/jobs.js';
import { txCtx } from '../../src/context.js';
import { ACTOR, NOW, audits, failure, fieldErrors, openRecordsDb, seedFile, seedItem, type RecordsDb } from './catalog-records-support.js';

// Phase 2 Task 14: the locations of a branch (spec §2.2 `locations`, §3.6, §12.3; Review Focus 2) on the engine picked
// by ALTIS_TEST_DB: room › area › shelf, codes per branch, the empty shelf hint, archiving one still in use, the shelf
// map (the room's floor plan, the boxes of its areas and shelves), the branch scope, the tree list and the reindex a
// change of placement queues.

const ctx = testDbContext();
/** A server engine: two connections write side by side (on SQLite BEGIN IMMEDIATE serializes the writers). */
const SERVER = ctx.engine !== 'sqlite';
/** How long a box save's transaction stays open while a move runs on the second connection. */
const HOLD_MS = 500;
const KEYRING = [{ kid: 'k1', key: Buffer.alloc(32, 7).toString('base64url'), active: true }];

describe('the locations barrel (M14)', () => {
  it('exports the names of the Task 14 interface through @altis/core', () => {
    for (const name of ['listLocations', 'createLocation', 'updateLocation', 'archiveLocation', 'setLocationMap', 'enqueueLocationReindex']) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe.skipIf(!ctx.available)(`locations [${engineLabel()}]`, () => {
  let db: RecordsDb;
  /** A second branch: its objects are invisible from the first one. */
  let otherBranch: string;
  let serial = 0;

  /** A body of `kind` with a code of its own. */
  const body = (kind: 'room' | 'area' | 'shelf', o: Partial<LocationBody> = {}): LocationBody => {
    serial += 1;
    return { parentId: null, kind, code: `L-${serial}`, name: `Lokasi ${serial}`, isPublic: true, sortOrder: 0, ...o };
  };
  const create = (b: LocationBody, branchId = db.branchId) => db.run((tx) => createLocation(tx, branchId, b));
  const row = (id: string) => db.h.db.selectFrom('locations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  /** A record of its own, straight into the table (Task 16 writes them through its service). */
  async function seedRecord(): Promise<string> {
    const id = newId();
    await db.h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: await db.materialTypeId('BUKU'),
        title: 'Cantuman Lokasi',
        subtitle: null,
        responsibility: null,
        title_key: 'cantuman lokasi',
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
        changed_at: NOW,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  beforeAll(async () => {
    db = await openRecordsDb('locations');
    otherBranch = newId();
    await db.h.db
      .insertInto('branches')
      .values({ id: otherBranch, code_key: 'TIMUR', code_display: 'Timur', name: 'Timur', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('depth rules (§3.6): room › area › shelf; a violation is invalid_parent', () => {
    it('a room has no parent; an area sits in a room; a shelf in a room or an area', async () => {
      const room = await create(body('room'));
      expect(room).toEqual({ id: expect.any(String), version: 0, reindex: false, boxesCleared: [] });
      const area = await create(body('area', { parentId: room.id }));
      const shelfInArea = await create(body('shelf', { parentId: area.id }));
      const shelfInRoom = await create(body('shelf', { parentId: room.id }));
      expect((await row(area.id)).parent_id).toBe(room.id);
      expect((await row(shelfInArea.id)).kind).toBe('shelf');
      expect((await row(shelfInRoom.id)).parent_id).toBe(room.id);

      const bad = [{ path: 'parentId', code: 'invalid_parent' }];
      // A room with a parent; an area or a shelf without one.
      expect(await fieldErrors(create(body('room', { parentId: room.id })))).toEqual(bad);
      expect(await fieldErrors(create(body('area')))).toEqual(bad);
      expect(await fieldErrors(create(body('shelf')))).toEqual(bad);
      // An area in an area or a shelf; a shelf in a shelf.
      expect(await fieldErrors(create(body('area', { parentId: area.id })))).toEqual(bad);
      expect(await fieldErrors(create(body('area', { parentId: shelfInRoom.id })))).toEqual(bad);
      expect(await fieldErrors(create(body('shelf', { parentId: shelfInArea.id })))).toEqual(bad);
      // A parent that does not exist, or of another branch.
      expect(await fieldErrors(create(body('shelf', { parentId: newId() })))).toEqual(bad);
      const roomB = await create(body('room'), otherBranch);
      expect(await fieldErrors(create(body('shelf', { parentId: roomB.id })))).toEqual(bad);
      expect(await fieldErrors(create(body('shelf', { parentId: room.id }), otherBranch))).toEqual(bad);
    });

    it('an archived parent is invalid_parent; a branch that does not exist or is archived is NOT_FOUND', async () => {
      const room = await create(body('room'));
      await db.run((tx) => archiveLocation(tx, db.branchId, room.id, 0));
      expect(await fieldErrors(create(body('area', { parentId: room.id })))).toEqual([{ path: 'parentId', code: 'invalid_parent' }]);
      expect(await failure(create(body('room'), newId()))).toMatchObject({ code: 'NOT_FOUND' });
      // An archived branch takes no new location (as items: Task 17's checkBranch).
      const closed = newId();
      await db.h.db
        .insertInto('branches')
        .values({ id: closed, code_key: 'TUTUP', code_display: 'Tutup', name: 'Tutup', address: null, timezone: 'Asia/Jakarta', archived_at: NOW, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
        .execute();
      expect(await failure(create(body('room'), closed))).toMatchObject({ code: 'NOT_FOUND' });
      expect(await db.h.db.selectFrom('locations').select('id').where('branch_id', '=', closed).execute()).toEqual([]);
    });

    it('a patch keeps the rules: its own parent, a room under a room, a kind its live children cannot sit in', async () => {
      const room = await create(body('room'));
      const otherRoom = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const shelf = await create(body('shelf', { parentId: area.id }));
      const patch = (id: string, p: Record<string, unknown>) => db.run((tx) => updateLocation(tx, db.branchId, id, { version: 0, ...p }));

      expect(await fieldErrors(patch(area.id, { parentId: area.id }))).toEqual([{ path: 'parentId', code: 'invalid_parent' }]);
      expect(await fieldErrors(patch(otherRoom.id, { parentId: room.id }))).toEqual([{ path: 'parentId', code: 'invalid_parent' }]);
      expect(await fieldErrors(patch(area.id, { kind: 'room' }))).toEqual([{ path: 'parentId', code: 'invalid_parent' }]);
      // The area holds a shelf: it can be neither a shelf (a shelf holds nothing) nor sit in a shelf.
      expect(await fieldErrors(patch(area.id, { kind: 'shelf' }))).toEqual([{ path: 'kind', code: 'invalid' }]);
      // A room holding an area cannot become an area (an area holds shelves only).
      expect(await fieldErrors(patch(room.id, { kind: 'area', parentId: otherRoom.id }))).toEqual([{ path: 'kind', code: 'invalid' }]);

      // Moving the shelf into the other room, and the area becoming a room of its own (no parent), are fine.
      expect(await patch(shelf.id, { parentId: otherRoom.id })).toEqual({ id: shelf.id, version: 1, reindex: true, boxesCleared: [] });
      expect(await patch(area.id, { kind: 'room', parentId: null })).toEqual({ id: area.id, version: 1, reindex: true, boxesCleared: [] });
      expect(await row(area.id)).toMatchObject({ kind: 'room', parent_id: null });
    });
  });

  describe('codes, the shelf hint, the class range, version', () => {
    it('a code is unique per branch (normalizeKey), free in another branch', async () => {
      await create(body('room', { code: 'Lt-2' }));
      expect(await fieldErrors(create(body('room', { code: ' lt-2 ' })))).toEqual([{ path: 'code', code: 'taken' }]);
      const other = await create(body('room', { code: 'LT-2' }), otherBranch);
      expect(await row(other.id)).toMatchObject({ code_display: 'LT-2', code_key: normalizeKey('LT-2'), branch_id: otherBranch });
      const mine = await create(body('room', { code: 'Lt-3' }));
      expect(await fieldErrors(db.run((tx) => updateLocation(tx, db.branchId, mine.id, { version: 0, code: 'LT-2' })))).toEqual([
        { path: 'code', code: 'taken' },
      ]);
    });

    it('an empty shelf hint is the name cut to 40 characters; a typed one stays; a rename refreshes only a derived one', async () => {
      const room = await create(body('room'));
      const name = 'Rak Referensi Umum Lantai Dua Sayap Timur Gedung Utama';
      const derived = name.slice(0, 40).trimEnd();
      expect(derived).toHaveLength(40);
      const a = await create(body('shelf', { parentId: room.id, name }));
      const b = await create(body('shelf', { parentId: room.id, name, shelfHint: '' }));
      const c = await create(body('shelf', { parentId: room.id, name, shelfHint: 'Rak 800-899' }));
      expect([(await row(a.id)).shelf_hint, (await row(b.id)).shelf_hint, (await row(c.id)).shelf_hint]).toEqual([derived, derived, 'Rak 800-899']);
      // Four-byte characters count once each, as the column counts them.
      const wide = await create(body('shelf', { parentId: room.id, name: '𝔸'.repeat(45) }));
      expect((await row(wide.id)).shelf_hint).toBe('𝔸'.repeat(40));

      await db.run((tx) => updateLocation(tx, db.branchId, a.id, { version: 0, name: 'Rak Baru' }));
      await db.run((tx) => updateLocation(tx, db.branchId, c.id, { version: 0, name: 'Rak Baru' }));
      expect([(await row(a.id)).shelf_hint, (await row(c.id)).shelf_hint]).toEqual(['Rak Baru', 'Rak 800-899']);
      await db.run((tx) => updateLocation(tx, db.branchId, c.id, { version: 1, shelfHint: null }));
      expect((await row(c.id)).shelf_hint).toBe('Rak Baru');
    });

    it('a class range needs both ends, each with a class number, the lower not above the upper', async () => {
      const room = await create(body('room'));
      const shelf = await create(body('shelf', { parentId: room.id, classFrom: '800', classTo: '899.99' }));
      expect(await row(shelf.id)).toMatchObject({ class_from: '800', class_to: '899.99' });
      expect(await fieldErrors(create(body('shelf', { parentId: room.id, classFrom: '800' })))).toEqual([{ path: 'classTo', code: 'required' }]);
      expect(await fieldErrors(create(body('shelf', { parentId: room.id, classTo: '899' })))).toEqual([{ path: 'classFrom', code: 'required' }]);
      expect(await fieldErrors(create(body('shelf', { parentId: room.id, classFrom: 'Fiksi', classTo: '899' })))).toEqual([
        { path: 'classFrom', code: 'invalid' },
      ]);
      expect(await fieldErrors(create(body('shelf', { parentId: room.id, classFrom: '900', classTo: '899' })))).toEqual([
        { path: 'classTo', code: 'invalid' },
      ]);
      // Clearing both ends through a patch.
      await db.run((tx) => updateLocation(tx, db.branchId, shelf.id, { version: 0, classFrom: '', classTo: null }));
      expect(await row(shelf.id)).toMatchObject({ class_from: null, class_to: null });
    });

    it('a stale version is CONFLICT_STALE; the audit entry is catalog.master.* of entity locations with field names', async () => {
      const room = await create(body('room'));
      expect(await failure(db.run((tx) => updateLocation(tx, db.branchId, room.id, { version: 3, name: 'X' })))).toMatchObject({ code: 'CONFLICT_STALE' });
      await db.run((tx) => updateLocation(tx, db.branchId, room.id, { version: 0, name: 'Lantai Dua', isPublic: false }));
      expect(await audits(db, 'catalog.master.create', room.id)).toEqual([{ entity: 'locations', meta: { kind: 'room', fields: expect.any(Array) } }]);
      expect(await audits(db, 'catalog.master.update', room.id)).toEqual([{ entity: 'locations', meta: { fields: ['name', 'shelfHint', 'isPublic'] } }]);
      const entry = await db.h.db.selectFrom('audit_log').select('branch_id').where('entity_id', '=', room.id).where('action', '=', 'catalog.master.update').executeTakeFirstOrThrow();
      expect(entry.branch_id).toBe(db.branchId);
    });
  });

  describe('archive (Review Focus 2): one still in use is 409 CATALOG_IN_USE', () => {
    it('a shelf holding a live item, a room holding a shelf → 409; once emptied both archive', async () => {
      const room = await create(body('room'));
      const shelf = await create(body('shelf', { parentId: room.id }));
      const record = await seedRecord();
      const item = await seedItem(db, record, { locationId: shelf.id });
      await seedItem(db, record, { locationId: shelf.id, archived: true }); // an archived item does not count

      expect(await failure(db.run((tx) => archiveLocation(tx, db.branchId, shelf.id, 0)))).toEqual({
        code: 'CATALOG_IN_USE',
        meta: { count: 1, children: 0, items: 1 },
      });
      expect(await failure(db.run((tx) => archiveLocation(tx, db.branchId, room.id, 0)))).toEqual({
        code: 'CATALOG_IN_USE',
        meta: { count: 1, children: 1, items: 0 },
      });

      await db.h.db.updateTable('items').set({ archived_at: NOW }).where('id', '=', item).execute();
      expect(await db.run((tx) => archiveLocation(tx, db.branchId, shelf.id, 0))).toEqual({ version: 1 });
      expect(await db.run((tx) => archiveLocation(tx, db.branchId, room.id, 0))).toEqual({ version: 1 });
      expect((await row(room.id)).archived_at).toBe(NOW);
      // Again: answered as it is, one more entry that says so.
      expect(await db.run((tx) => archiveLocation(tx, db.branchId, room.id, 1))).toEqual({ version: 1 });
      expect(await audits(db, 'catalog.master.archive', room.id)).toEqual([
        { entity: 'locations', meta: {} },
        { entity: 'locations', meta: { alreadyArchived: true } },
      ]);
      expect(await failure(db.run((tx) => archiveLocation(tx, db.branchId, shelf.id, 0)))).toMatchObject({ code: 'CONFLICT_STALE' });
    });
  });

  describe('the shelf map', () => {
    it('box bounds: x + w ≤ 1000 and y + h ≤ 1000; an area or a shelf takes a box, a room does not', async () => {
      const room = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const map = (id: string, b: Record<string, unknown>) => db.run((tx) => setLocationMap(tx, db.branchId, id, b as never));

      expect(await fieldErrors(map(area.id, { version: 0, box: { x: 900, y: 0, w: 101, h: 10 } }))).toEqual([{ path: 'box.w', code: 'too_big' }]);
      expect(await fieldErrors(map(area.id, { version: 0, box: { x: 0, y: 950, w: 10, h: 51 } }))).toEqual([{ path: 'box.h', code: 'too_big' }]);
      expect(await fieldErrors(map(area.id, { version: 0, box: { x: -1, y: 0, w: 10, h: 10 } }))).toEqual([{ path: 'box.x', code: 'too_small' }]);
      expect(await fieldErrors(map(area.id, { version: 0 }))).toEqual([{ path: 'box', code: 'required' }]);
      expect(await fieldErrors(map(area.id, { version: 0, box: { x: 0, y: 0, w: 10, h: 10 }, floorPlanFileId: newId() }))).toEqual([
        { path: 'floorPlanFileId', code: 'invalid' },
      ]);
      expect(await fieldErrors(map(room.id, { version: 0, box: { x: 0, y: 0, w: 10, h: 10 } }))).toEqual([
        { path: 'box', code: 'invalid' },
        { path: 'floorPlanFileId', code: 'required' },
      ]);

      expect(await map(area.id, { version: 0, box: { x: 900, y: 600, w: 100, h: 400 } })).toEqual({ version: 1 });
      expect(await row(area.id)).toMatchObject({ map_x: 900, map_y: 600, map_w: 100, map_h: 400, version: 1 });
      expect(await audits(db, 'catalog.master.update', area.id)).toEqual([{ entity: 'locations', meta: { fields: ['box'] } }]);
      expect(await map(area.id, { version: 1, box: null })).toEqual({ version: 2 });
      expect(await row(area.id)).toMatchObject({ map_x: null, map_y: null, map_w: null, map_h: null });
    });

    it('a floor plan becomes the room’s public file; a new plan orphans the old one; refusals', async () => {
      const room = await create(body('room'));
      const otherRoom = await create(body('room'));
      const plan1 = await seedFile(db, { context: 'catalog.floor_plan', mime: 'image/png' });
      const plan2 = await seedFile(db, { context: 'catalog.floor_plan', mime: 'image/png' });
      const file = (id: string) => db.h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', id).executeTakeFirstOrThrow();
      const map = (id: string, version: number, floorPlanFileId: string | null) =>
        db.run((tx) => setLocationMap(tx, db.branchId, id, { version, floorPlanFileId }));

      expect(await map(room.id, 0, plan1)).toEqual({ version: 1 });
      expect(await file(plan1)).toEqual({ owner_type: 'locations', owner_id: room.id, access: 'public' });
      expect((await row(room.id)).map_file_id).toBe(plan1);
      expect(await audits(db, 'catalog.master.update', room.id)).toEqual([{ entity: 'locations', meta: { fields: ['floorPlan'] } }]);

      // Another room cannot take a plan the first one owns; a cover upload is no plan; an unknown file is not_found.
      expect(await fieldErrors(map(otherRoom.id, 0, plan1))).toEqual([{ path: 'floorPlanFileId', code: 'invalid' }]);
      const cover = await seedFile(db, { context: 'catalog.cover' });
      expect(await fieldErrors(map(otherRoom.id, 0, cover))).toEqual([{ path: 'floorPlanFileId', code: 'invalid' }]);
      expect(await fieldErrors(map(otherRoom.id, 0, newId()))).toEqual([{ path: 'floorPlanFileId', code: 'not_found' }]);
      expect(await file(cover)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });

      // Setting the same plan again keeps it; a new plan orphans the old one (housekeeping removes it).
      expect(await map(room.id, 1, plan1)).toEqual({ version: 2 });
      expect(await file(plan1)).toEqual({ owner_type: 'locations', owner_id: room.id, access: 'public' });
      expect(await map(room.id, 2, plan2)).toEqual({ version: 3 });
      expect(await file(plan1)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
      expect(await file(plan2)).toEqual({ owner_type: 'locations', owner_id: room.id, access: 'public' });
      // The orphaned plan is free again; null removes the room's plan.
      expect(await map(otherRoom.id, 0, plan1)).toEqual({ version: 1 });
      expect(await map(room.id, 3, null)).toEqual({ version: 4 });
      expect(await file(plan2)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
      expect((await row(room.id)).map_file_id).toBeNull();
    });

    it('a room that becomes an area gives its plan up; an area that becomes a room loses its box', async () => {
      const room = await create(body('room'));
      const host = await create(body('room'));
      const plan = await seedFile(db, { context: 'catalog.floor_plan', mime: 'image/png' });
      await db.run((tx) => setLocationMap(tx, db.branchId, room.id, { version: 0, floorPlanFileId: plan }));
      await db.run((tx) => updateLocation(tx, db.branchId, room.id, { version: 1, kind: 'area', parentId: host.id }));
      expect(await row(room.id)).toMatchObject({ kind: 'area', map_file_id: null });
      expect(await db.h.db.selectFrom('files').select(['owner_type', 'access']).where('id', '=', plan).executeTakeFirstOrThrow()).toEqual({
        owner_type: null,
        access: 'staff',
      });
      await db.run((tx) => setLocationMap(tx, db.branchId, room.id, { version: 2, box: { x: 1, y: 2, w: 3, h: 4 } }));
      await db.run((tx) => updateLocation(tx, db.branchId, room.id, { version: 3, kind: 'room', parentId: null }));
      expect(await row(room.id)).toMatchObject({ kind: 'room', map_x: null, map_y: null, map_w: null, map_h: null });
      expect((await audits(db, 'catalog.master.update', room.id)).map((a) => a.meta['fields'])).toEqual([
        ['floorPlan'],
        ['parentId', 'kind', 'floorPlan'],
        ['box'],
        ['parentId', 'kind', 'box'],
      ]);
    });
  });

  describe('branch scope (D2-02): an object of another branch is NOT_FOUND', () => {
    it('update, archive and map of a branch-A location through branch B → NOT_FOUND, nothing changed', async () => {
      const room = await create(body('room', { name: 'Ruang A' }));
      expect(await failure(db.run((tx) => updateLocation(tx, otherBranch, room.id, { version: 0, name: 'Diambil' })))).toMatchObject({ code: 'NOT_FOUND' });
      expect(await failure(db.run((tx) => archiveLocation(tx, otherBranch, room.id, 0)))).toMatchObject({ code: 'NOT_FOUND' });
      expect(await failure(db.run((tx) => setLocationMap(tx, otherBranch, room.id, { version: 0, floorPlanFileId: null })))).toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await row(room.id)).toMatchObject({ name: 'Ruang A', version: 0, archived_at: null });
    });
  });

  describe('listLocations: the tree of a branch', () => {
    it('each room, then its areas and shelves depth first, by sort order then code; item counts; archived only on request', async () => {
      const branch = newId();
      await db.h.db
        .insertInto('branches')
        .values({ id: branch, code_key: 'POHON', code_display: 'Pohon', name: 'Pohon', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
        .execute();
      const mk = (b: LocationBody) => create(b, branch);
      const r2 = await mk(body('room', { code: 'R2', sortOrder: 2 }));
      const r1 = await mk(body('room', { code: 'R1', sortOrder: 1 }));
      const a1b = await mk(body('area', { parentId: r1.id, code: 'A1B' }));
      const a1a = await mk(body('area', { parentId: r1.id, code: 'A1A' }));
      const s1 = await mk(body('shelf', { parentId: a1a.id, code: 'S1', classFrom: '800', classTo: '899' }));
      const s0 = await mk(body('shelf', { parentId: r1.id, code: 'S0', sortOrder: 9 }));
      const gone = await mk(body('shelf', { parentId: r2.id, code: 'GONE' }));
      await db.run((tx) => archiveLocation(tx, branch, gone.id, 0));
      const record = await seedRecord();
      await db.h.db.updateTable('items').set({ branch_id: branch }).where('id', '=', await seedItem(db, record, { locationId: s1.id })).execute();
      await db.h.db.updateTable('items').set({ branch_id: branch }).where('id', '=', await seedItem(db, record, { locationId: s1.id })).execute();

      const live = await listLocations(db.h.db, { branchId: branch });
      expect(live.map((l) => l.code)).toEqual(['R1', 'A1A', 'S1', 'A1B', 'S0', 'R2']);
      expect(live.find((l) => l.id === s1.id)).toEqual({
        id: s1.id,
        branchId: branch,
        parentId: a1a.id,
        kind: 'shelf',
        code: 'S1',
        name: expect.any(String),
        shelfHint: expect.any(String),
        classFrom: '800',
        classTo: '899',
        mapFileId: null,
        box: null,
        isPublic: true,
        sortOrder: 0,
        itemCount: 2,
        archived: false,
        version: 0,
      });
      expect(live.find((l) => l.id === a1b.id)?.itemCount).toBe(0);
      const all = await listLocations(db.h.db, { branchId: branch, includeArchived: true });
      expect(all.map((l) => l.code)).toEqual(['R1', 'A1A', 'S1', 'A1B', 'S0', 'R2', 'GONE']);
      expect(all.at(-1)).toMatchObject({ archived: true, version: 1 });
      // Without a branch: every branch's tree, this one among them; no other branch's location in this branch's list.
      await create(body('room'), otherBranch);
      const everything = await listLocations(db.h.db, {});
      expect(everything.filter((l) => l.branchId === branch).map((l) => l.code)).toEqual(['R1', 'A1A', 'S1', 'A1B', 'S0', 'R2']);
      expect(new Set(everything.map((l) => l.branchId))).toContain(otherBranch);
      expect(live.every((l) => l.branchId === branch)).toBe(true);
      void s0;
    });
  });

  describe('a change of placement queues the reindex of the records shelved below (§4.6 facets lc, av)', () => {
    it('isPublic of a room with an item in one of its shelves → reindex: true and one catalog.reindex job of that record', async () => {
      const room = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const shelf = await create(body('shelf', { parentId: area.id }));
      const record = await seedRecord();
      await seedItem(db, record, { locationId: shelf.id });
      await seedItem(db, record, { locationId: area.id });

      // A rename changes no facet.
      expect(await db.run((tx) => updateLocation(tx, db.branchId, room.id, { version: 0, name: 'Ruang Baru' }))).toEqual({
        id: room.id,
        version: 1,
        reindex: false,
        boxesCleared: [],
      });
      expect(await db.run((tx) => updateLocation(tx, db.branchId, room.id, { version: 1, isPublic: false }))).toEqual({
        id: room.id,
        version: 2,
        reindex: true,
        boxesCleared: [],
      });

      const deps = {} as CatalogJobDeps;
      const registry = createJobRegistry(searchJobs(() => deps));
      const before = await db.h.db.selectFrom('jobs').select('id').where('type', '=', 'catalog.reindex').execute();
      const queued = await db.run((tx) => enqueueLocationReindex(tx.trx, registry, db.branchId, room.id, { now: NOW, keyring: KEYRING, createdBy: null }));
      expect(queued).toBe(1);
      const jobs = await db.h.db
        .selectFrom('jobs')
        .select(['id', 'payload', 'status'])
        .where('type', '=', 'catalog.reindex')
        .where('id', 'not in', before.length === 0 ? [newId()] : before.map((j) => j.id))
        .execute();
      expect(jobs.map((j) => [JSON.parse(j.payload), j.status])).toEqual([[{ recordIds: [record] }, 'queued']]);

      // A location with nothing below it queues nothing.
      const empty = await create(body('room'));
      expect(await db.run((tx) => enqueueLocationReindex(tx.trx, registry, db.branchId, empty.id, { now: NOW, keyring: KEYRING, createdBy: null }))).toBe(0);
    });
  });

  // Task 40 T14-RUANG-PINDAH-KOTAK-PETA (task-14 concern 2, task-27 concern 1): a box is drawn on its room's floor plan,
  // so a location that changes room (a new parent in another room, or a kind that makes it, or its parent, another
  // room) loses its box and the boxes below it, in the same write, and the answer names them for the screen.
  describe('a move to another room clears the boxes drawn on the old room’s plan', () => {
    const drawn = (ids: readonly string[]) =>
      db.h.db.updateTable('locations').set({ map_x: 10, map_y: 20, map_w: 30, map_h: 40 }).where('id', 'in', [...ids]).execute();
    const boxOf = async (id: string): Promise<{ box: boolean; version: number }> => {
      const r = await row(id);
      return { box: r.map_x !== null || r.map_y !== null || r.map_w !== null || r.map_h !== null, version: Number(r.version) };
    };
    const patch = (id: string, p: Record<string, unknown>) => db.run((tx) => updateLocation(tx, db.branchId, id, { version: 0, ...p }));

    it('an area moved to another room: its box and its shelves’ boxes are cleared, and named', async () => {
      const room = await create(body('room'));
      const other = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const shelf = await create(body('shelf', { parentId: area.id }));
      const bare = await create(body('shelf', { parentId: area.id }));
      await drawn([area.id, shelf.id]);
      expect(await patch(area.id, { parentId: other.id })).toEqual({ id: area.id, version: 1, reindex: true, boxesCleared: [area.id, shelf.id] });
      expect(await boxOf(area.id)).toEqual({ box: false, version: 1 });
      expect(await boxOf(shelf.id)).toEqual({ box: false, version: 1 });
      // A shelf below that had no box changes room too: its version goes up, so a map editor still open on the old
      // room's plan (or a box save that read it before the move) cannot draw it there any more.
      expect(await boxOf(bare.id)).toEqual({ box: false, version: 1 });
      expect(await audits(db, 'catalog.master.update', area.id)).toEqual([{ entity: 'locations', meta: { fields: ['parentId', 'box'], boxesCleared: 2 } }]);
      expect(await failure(db.run((tx) => setLocationMap(tx, db.branchId, bare.id, { version: 0, box: { x: 1, y: 2, w: 3, h: 4 } })))).toEqual({
        code: 'CONFLICT_STALE',
      });
      expect(await boxOf(bare.id)).toEqual({ box: false, version: 1 });
    });

    // A box saved on the old room's plan while the move runs on another connection: the move waits for that save, then
    // clears the box and names it, and a save with the version the box save answered is stale. On SQLite the writers
    // serialize (BEGIN IMMEDIATE), so the second connection would only wait for the first.
    it.skipIf(!SERVER)('a box save in flight on a shelf below is waited for, then cleared and named (two connections)', async () => {
      const room = await create(body('room'));
      const other = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const bare = await create(body('shelf', { parentId: area.id }));
      const h2 = await testDb({ reset: false });
      try {
        let move: Promise<unknown> = Promise.resolve('not started');
        let saved: { version: number } | undefined;
        await withTx(
          db.h,
          async (trx) => {
            saved = await setLocationMap(txCtx(trx, NOW, ACTOR), db.branchId, bare.id, { version: 0, box: { x: 1, y: 2, w: 3, h: 4 } });
            move = withTx(h2, (trx2) => updateLocation(txCtx(trx2, NOW, ACTOR), db.branchId, area.id, { version: 0, parentId: other.id }), { retry: false });
            // The move runs up to the shelf's row while this box save stays open.
            await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
          },
          { retry: false },
        );
        expect(saved).toEqual({ version: 1 });
        expect(await move).toEqual({ id: area.id, version: 1, reindex: true, boxesCleared: [bare.id] });
        expect(await boxOf(bare.id)).toEqual({ box: false, version: 2 });
        expect(await failure(db.run((tx) => setLocationMap(tx, db.branchId, bare.id, { version: 1, box: { x: 5, y: 6, w: 7, h: 8 } })))).toEqual({
          code: 'CONFLICT_STALE',
        });
        expect(await boxOf(bare.id)).toEqual({ box: false, version: 2 });
      } finally {
        await h2.close();
      }
    });

    it('a shelf moved to another area of the same room keeps its box', async () => {
      const room = await create(body('room'));
      const a1 = await create(body('area', { parentId: room.id }));
      const a2 = await create(body('area', { parentId: room.id }));
      const shelf = await create(body('shelf', { parentId: a1.id }));
      await drawn([shelf.id]);
      expect(await patch(shelf.id, { parentId: a2.id })).toEqual({ id: shelf.id, version: 1, reindex: true, boxesCleared: [] });
      expect(await boxOf(shelf.id)).toEqual({ box: true, version: 1 });
      // Out of the area into the room itself: still the same plan.
      expect(await db.run((tx) => updateLocation(tx, db.branchId, shelf.id, { version: 1, parentId: room.id }))).toMatchObject({ boxesCleared: [] });
      expect(await boxOf(shelf.id)).toEqual({ box: true, version: 2 });
    });

    it('a shelf moved straight into another room loses its box', async () => {
      const room = await create(body('room'));
      const other = await create(body('room'));
      const shelf = await create(body('shelf', { parentId: room.id }));
      await drawn([shelf.id]);
      expect(await patch(shelf.id, { parentId: other.id })).toMatchObject({ boxesCleared: [shelf.id] });
      expect(await boxOf(shelf.id)).toEqual({ box: false, version: 1 });
    });

    it('an area that becomes a room: its own box and its shelves’ boxes (drawn on the old room’s plan) are cleared', async () => {
      const room = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const shelf = await create(body('shelf', { parentId: area.id }));
      await drawn([area.id, shelf.id]);
      // A room takes no box: the answer names only the shelves to draw again on its own map; the audit counts both.
      expect(await patch(area.id, { kind: 'room', parentId: null })).toEqual({ id: area.id, version: 1, reindex: true, boxesCleared: [shelf.id] });
      expect(await boxOf(area.id)).toEqual({ box: false, version: 1 });
      expect(await boxOf(shelf.id)).toEqual({ box: false, version: 1 });
      expect(await audits(db, 'catalog.master.update', area.id)).toEqual([
        { entity: 'locations', meta: { fields: ['parentId', 'kind', 'box'], boxesCleared: 2 } },
      ]);
    });

    it('a room that becomes an area of another room: the boxes of its shelves are cleared', async () => {
      const room = await create(body('room'));
      const host = await create(body('room'));
      const shelf = await create(body('shelf', { parentId: room.id }));
      await drawn([shelf.id]);
      expect(await patch(room.id, { kind: 'area', parentId: host.id })).toMatchObject({ boxesCleared: [shelf.id] });
      expect(await boxOf(shelf.id)).toEqual({ box: false, version: 1 });
    });

    it('a change that moves nothing keeps every box', async () => {
      const room = await create(body('room'));
      const area = await create(body('area', { parentId: room.id }));
      const shelf = await create(body('shelf', { parentId: area.id }));
      await drawn([area.id, shelf.id]);
      expect(await patch(area.id, { name: 'Area Baru', parentId: room.id })).toMatchObject({ boxesCleared: [] });
      expect(await boxOf(area.id)).toEqual({ box: true, version: 1 });
      expect(await boxOf(shelf.id)).toEqual({ box: true, version: 0 });
    });
  });
});
