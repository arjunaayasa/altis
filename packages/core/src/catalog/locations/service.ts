import { fullTextFamily, type DB } from '@altis/db';
import { DomainError, isDomainError, newId, type LocationKind } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { LocationBody, LocationMapBody, LocationPatchBody, type LocationListQuery, type LocationView } from '@altis/shared/api/catalog/locations';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { z } from 'zod';
import type { TxCtx } from '../../context.js';
import { codeKey } from '../data/keys.js';
import { classInRange, classNumberKey } from '../lib/class-number.js';

// The locations of a branch (Phase 2 spec §2.2 `locations`, §3.6, §12.2, §12.3; plan Task 14; D2-02): rooms, the areas
// of a room and the shelves of a room or an area, with a shelf's call-number range (the shelf suggestion of §3.4) and
// the shelf map (a room's floor plan, the boxes of its areas and shelves on it).
//
// - Branch scope: every write names its branch (`branches/:branchId/…`); a location of another branch is NOT_FOUND, a
//   parent of another branch `{path: 'parentId', code: 'invalid_parent'}`.
// - Depth (§3.6, at most three levels): a room has no parent, an area's parent is a room, a shelf's a room or an area;
//   the parent must be live. A patch keeps the rules for the location's own live children too: a kind they cannot sit
//   in is `{path: 'kind', code: 'invalid'}`. These rules leave no room for a loop (each level is deeper than its parent).
// - The code is unique per branch (`code_key = codeKey(code)`; `taken`, also when the write itself loses the race).
// - An empty shelf hint is the name cut to 40 characters (§3.6). A rename refreshes a hint that was derived so, and
//   keeps one that was typed.
// - A class range has both ends or none, each holding a class number, the lower not above the upper.
// - Archiving one that still holds live children or live items is 409 CATALOG_IN_USE (Review Focus 2, P2-16).
// - The map: a room takes its floor plan, a `catalog.floor_plan` upload nobody else owns, which then belongs to the
//   room and is public; the plan it replaces loses its owner and turns `staff`, so housekeeping removes it as an orphan
//   upload and nobody fetches it meanwhile. An area or a shelf takes its box on the room's plan (per mille). A patch
//   that changes a location's room (a new parent in another room, an area turning into a room, a room turning into an
//   area) clears the box of the location and every box below it in the same write, since they were drawn on the old
//   room's plan (Task 40 T14-RUANG-PINDAH-KOTAK-PETA); `boxesCleared` names them for the screen, which asks for them
//   to be drawn again on the new room's map (not a location that became a room: a room takes no box). Every location
//   below goes up a version, a box or none, so a box saved with a version read before the move (a map editor still
//   open on the old plan) is CONFLICT_STALE; the locations below are read with a locking read, so a box save in flight
//   on one of them finishes first and is cleared too.
// - Audit: `catalog.master.create|update|archive`, entity `locations`, the branch, field names only (§12.4).
// - Concurrency: a write first locks the rows it depends on (its own, and the parent it puts a location under or whose
//   kind it relies on) with a write that changes nothing, as the records do: a child created under a room and the
//   room's archive serialize, and on MySQL/MariaDB (REPEATABLE READ) what is read afterwards is the latest commit. The
//   parent is checked by that same write (parentErrors). `version` is then compared (CONFLICT_STALE) and bumped by the
//   one UPDATE that writes the row.
// - A patch that moves a location (its parent or kind) or changes whether it is public changes the facets `lc` and
//   `av` of the records shelved below it (§4.6): it answers `reindex: true`, and the caller queues
//   enqueueLocationReindex (reindex.ts) in the same transaction.

type Db = Kysely<DB> | Transaction<DB>;
type LocationRow = Selectable<DB['locations']>;

/**
 * What a create or an update answers: the id, the new version, whether the records below need a reindex, and the
 * locations whose box the update cleared and that take one again on the new room's map (the location first, unless it
 * became a room, which takes no box; then the ones below it; see the top of this file).
 */
export interface LocationSaveResult {
  id: string;
  version: number;
  reindex: boolean;
  boxesCleared: string[];
}

/** §3.6: `shelf_hint` ≤ 40 characters. */
const SHELF_HINT_MAX = 40;
/** At most this many ids in one `IN (…)` list. */
const ID_BATCH = 500;
/** The kinds a location of each kind may sit in (§3.6). */
const PARENT_KINDS: Readonly<Record<LocationKind, readonly LocationKind[]>> = Object.freeze({
  room: [],
  area: ['room'],
  shelf: ['room', 'area'],
});

// ---- errors ----------------------------------------------------------------------------------------------------------

function validationFailed(errors: FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Data lokasi tidak valid / The location data is not valid', meta: { errors } });
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Lokasi tidak ditemukan di cabang ini / Location not found in this branch' });
}

function branchNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Cabang tidak ditemukan / Branch not found' });
}

function stale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Lokasi sudah diubah orang lain; muat ulang / The location was changed by someone else; reload it',
  });
}

function inUse(children: number, items: number): DomainError {
  return new DomainError('CATALOG_IN_USE', {
    detail:
      `Lokasi masih berisi ${children} lokasi aktif dan ${items} eksemplar aktif; pindahkan atau arsipkan dahulu / ` +
      `The location still holds ${children} live location(s) and ${items} live item(s); move or archive them first`,
    meta: { count: children + items, children, items },
  });
}

/** `body` parsed with `schema` (strict, as the API's), or VALIDATION_FAILED with its issues as field errors (D10). */
function parseOrFail<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
  }
  return parsed.data;
}

/** Runs a write that may lose the race for `code_key`: that UNIQUE_VIOLATION is a taken code (thrown at once, R37). */
async function takingCode<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw validationFailed([{ path: 'code', code: 'taken' }]);
    throw error;
  }
}

// ---- rows ------------------------------------------------------------------------------------------------------------

/** Locks the rows of `ids` with a write that changes nothing, in index order (see the top of this file). */
async function lockLocationRows(trx: Transaction<DB>, ids: readonly string[]): Promise<void> {
  await trx
    .updateTable('locations')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', 'in', [...new Set(ids)])
    .execute();
}

/** The location `id` of `branchId`, or NOT_FOUND (also for one of another branch). */
async function readOwnRow(trx: Transaction<DB>, branchId: string, id: string): Promise<LocationRow> {
  const row = await trx.selectFrom('locations').selectAll().where('id', '=', id).where('branch_id', '=', branchId).executeTakeFirst();
  if (row === undefined) throw notFound();
  return row;
}

/** The name cut to {@link SHELF_HINT_MAX} code points (as the column counts), without a trailing blank. */
function hintFromName(name: string): string {
  return Array.from(name).slice(0, SHELF_HINT_MAX).join('').trimEnd();
}

/** '' (or blank) and absent as null; any other text as it is. */
function textOrNull(v: string | null | undefined): string | null {
  return v === undefined || v === null || v.trim() === '' ? null : v;
}

/**
 * The field errors of putting a location of `kind` under `parentId` in `branchId` (`selfId`: the location itself).
 *
 * The parent is checked and locked by one write that changes nothing and matches only a live parent of an allowed kind
 * in the branch (matched rows: mysql2 connects with CLIENT_FOUND_ROWS). An UPDATE reads the latest commit on every
 * engine and waits for a writer of the parent, so the check cannot act on a stale parent: a shelf turning into an
 * area under a room that is at the same moment turning into an area serialize with it, and one of them is refused.
 */
async function parentErrors(trx: Transaction<DB>, branchId: string, kind: LocationKind, parentId: string | null, selfId?: string): Promise<FieldWarning[]> {
  const bad = [{ path: 'parentId', code: 'invalid_parent' }];
  const allowed = PARENT_KINDS[kind];
  if (parentId === null) return allowed.length === 0 ? [] : bad;
  if (allowed.length === 0 || parentId === selfId) return bad;
  const locked = await trx
    .updateTable('locations')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', parentId)
    .where('branch_id', '=', branchId)
    .where('archived_at', 'is', null)
    .where('kind', 'in', [...allowed])
    .executeTakeFirst();
  return Number(locked.numUpdatedRows) === 1 ? [] : bad;
}

/**
 * The room a location of `kind` under `parentId` in `branchId` belongs to (`selfId` for a room): its parent when that
 * is a room, else the parent's parent (an area's room); null for none.
 */
async function roomOf(trx: Transaction<DB>, branchId: string, selfId: string, kind: LocationKind, parentId: string | null): Promise<string | null> {
  if (kind === 'room') return selfId;
  if (parentId === null) return null;
  const parent = await trx.selectFrom('locations').select(['kind', 'parent_id']).where('id', '=', parentId).where('branch_id', '=', branchId).executeTakeFirst();
  if (parent === undefined) return null;
  return parent.kind === 'room' ? parentId : parent.parent_id;
}

/**
 * The locations below `id` (archived ones too), level by level, each level in id order, locked and as they are on the
 * latest commit: on the server engines a locking read (FOR UPDATE), which waits for a box save in flight on one of
 * them and then reads its box (a plain read would read the MySQL/MariaDB snapshot, or on PostgreSQL miss a box not yet
 * committed). SQLite serializes the writers.
 */
async function descendantsOf(trx: Transaction<DB>, branchId: string, id: string): Promise<{ id: string; boxed: boolean }[]> {
  const out: { id: string; boxed: boolean }[] = [];
  const seen = new Set<string>([id]);
  const locking = fullTextFamily(trx) !== 'fts5';
  // Level by level without recursion: hand-made data could chain far deeper than the three levels of §3.6.
  for (let level = [id]; level.length > 0; ) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += ID_BATCH) {
      const query = trx
        .selectFrom('locations')
        .select(['id', 'map_x', 'map_y', 'map_w', 'map_h'])
        .where('branch_id', '=', branchId)
        .where('parent_id', 'in', level.slice(i, i + ID_BATCH))
        .orderBy('id');
      const rows = await (locking ? query.forUpdate() : query).execute();
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        next.push(r.id);
        out.push({ id: r.id, boxed: r.map_x !== null || r.map_y !== null || r.map_w !== null || r.map_h !== null });
      }
    }
    level = next;
  }
  return out;
}

/** The field errors of a call-number range: both ends or none, each with a class number, `from` not above `to`. */
function classErrors(from: string | null, to: string | null): FieldWarning[] {
  if (from === null && to === null) return [];
  if (from === null) return [{ path: 'classFrom', code: 'required' }];
  if (to === null) return [{ path: 'classTo', code: 'required' }];
  const errors: FieldWarning[] = [];
  if (classNumberKey(from) === null) errors.push({ path: 'classFrom', code: 'invalid' });
  if (classNumberKey(to) === null) errors.push({ path: 'classTo', code: 'invalid' });
  // `from` lies in its own range exactly when the range is not empty (classInRange's precision rules).
  if (errors.length === 0 && !classInRange(from, from, to)) errors.push({ path: 'classTo', code: 'invalid' });
  return errors;
}

/** True when a location of `branchId` other than `exceptId` holds `key`. */
async function keyTaken(trx: Transaction<DB>, branchId: string, key: string, exceptId?: string): Promise<boolean> {
  let q = trx.selectFrom('locations').select('id').where('branch_id', '=', branchId).where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** The live children of `id`: how many, and of which kinds. */
async function liveChildren(trx: Transaction<DB>, branchId: string, id: string): Promise<{ count: number; kinds: Set<LocationKind> }> {
  const rows = await trx
    .selectFrom('locations')
    .select(['kind', (eb) => eb.fn.countAll<number | string | bigint>().as('n')])
    .where('branch_id', '=', branchId)
    .where('parent_id', '=', id)
    .where('archived_at', 'is', null)
    .groupBy('kind')
    .execute();
  return { count: rows.reduce((sum, r) => sum + Number(r.n), 0), kinds: new Set(rows.map((r) => r.kind as LocationKind)) };
}

/**
 * The live items placed directly on `id`. Items sit in the branch of their location (Task 17 refuses another one), so
 * the count reads through `ix_items_branch_id_location_id`.
 */
async function liveItemCount(trx: Transaction<DB>, branchId: string, id: string): Promise<number> {
  const row = await trx
    .selectFrom('items')
    .select((eb) => eb.fn.countAll<number | string | bigint>().as('n'))
    .where('branch_id', '=', branchId)
    .where('location_id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Gives a room's floor plan up: the file loses its owner and turns `staff` (housekeeping removes the orphan). */
async function releasePlan(trx: Transaction<DB>, fileId: string, ownerId: string): Promise<void> {
  await trx
    .updateTable('files')
    .set({ owner_type: null, owner_id: null, access: 'staff' })
    .where('id', '=', fileId)
    .where('owner_type', '=', 'locations')
    .where('owner_id', '=', ownerId)
    .execute();
}

// ---- reads -----------------------------------------------------------------------------------------------------------

function toView(row: LocationRow, itemCount: number): LocationView {
  const box =
    row.map_x === null || row.map_y === null || row.map_w === null || row.map_h === null
      ? null
      : { x: Number(row.map_x), y: Number(row.map_y), w: Number(row.map_w), h: Number(row.map_h) };
  return {
    id: row.id,
    branchId: row.branch_id,
    parentId: row.parent_id,
    kind: row.kind as LocationKind,
    code: row.code_display,
    name: row.name,
    shelfHint: row.shelf_hint,
    classFrom: row.class_from,
    classTo: row.class_to,
    mapFileId: row.map_file_id,
    box,
    isPublic: Number(row.is_public) === 1,
    sortOrder: Number(row.sort_order),
    itemCount,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

/** Siblings: by `sort_order`, then code key, then id (byte order: the keys are binary). */
function bySortThenCode(a: LocationRow, b: LocationRow): number {
  const sa = Number(a.sort_order);
  const sb = Number(b.sort_order);
  if (sa !== sb) return sa - sb;
  if (a.code_key !== b.code_key) return a.code_key < b.code_key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `rows` (of one branch) depth first: each root, then its subtree. A row whose parent is not listed is a root. */
function treeOrder(rows: readonly LocationRow[]): LocationRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, LocationRow[]>();
  const roots: LocationRow[] = [];
  for (const r of rows) {
    if (r.parent_id === null || !ids.has(r.parent_id) || r.parent_id === r.id) roots.push(r);
    else {
      const list = children.get(r.parent_id) ?? [];
      list.push(r);
      children.set(r.parent_id, list);
    }
  }
  const out: LocationRow[] = [];
  const seen = new Set<string>();
  // Depth first without recursion: hand-made data could chain far deeper than the three levels of §3.6.
  const visit = (start: LocationRow): void => {
    const stack = [start];
    for (let r = stack.pop(); r !== undefined; r = stack.pop()) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      const kids = (children.get(r.id) ?? []).sort(bySortThenCode);
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as LocationRow);
    }
  };
  for (const r of roots.sort(bySortThenCode)) visit(r);
  // A loop in hand-made data (no row reaches a root): listed after the tree rather than dropped.
  for (const r of [...rows].sort(bySortThenCode)) visit(r);
  return out;
}

/**
 * The locations of `q.branchId` (or of every branch, branch by branch in code order), in tree order: each room, then
 * its areas and shelves depth first, siblings by `sort_order` then code. Archived ones only with `q.includeArchived`.
 * `itemCount` counts the live items placed directly on each. `db` is the handle's `db` or a transaction.
 */
export async function listLocations(db: Db, q: LocationListQuery): Promise<LocationView[]> {
  let rowsQuery = db.selectFrom('locations').selectAll();
  if (q.branchId !== undefined) rowsQuery = rowsQuery.where('branch_id', '=', q.branchId);
  if (q.includeArchived !== true) rowsQuery = rowsQuery.where('archived_at', 'is', null);
  const rows = await rowsQuery.execute();
  if (rows.length === 0) return [];

  let countQuery = db
    .selectFrom('items')
    .select(['location_id', (eb) => eb.fn.countAll<number | string | bigint>().as('n')])
    .where('location_id', 'is not', null)
    .where('archived_at', 'is', null);
  if (q.branchId !== undefined) countQuery = countQuery.where('branch_id', '=', q.branchId);
  const counts = new Map<string, number>();
  for (const c of await countQuery.groupBy('location_id').execute()) {
    if (c.location_id !== null) counts.set(c.location_id, Number(c.n));
  }

  const byBranch = new Map<string, LocationRow[]>();
  for (const r of rows) {
    const list = byBranch.get(r.branch_id) ?? [];
    list.push(r);
    byBranch.set(r.branch_id, list);
  }
  const branchIds = [...byBranch.keys()];
  if (branchIds.length > 1) {
    const codes = new Map(
      (await db.selectFrom('branches').select(['id', 'code_key']).where('id', 'in', branchIds).execute()).map((b) => [b.id, b.code_key]),
    );
    branchIds.sort((a, b) => {
      const ca = codes.get(a) ?? '';
      const cb = codes.get(b) ?? '';
      return ca !== cb ? (ca < cb ? -1 : 1) : a < b ? -1 : 1;
    });
  }
  return branchIds.flatMap((b) => treeOrder(byBranch.get(b) ?? []).map((r) => toView(r, counts.get(r.id) ?? 0)));
}

// ---- writes ----------------------------------------------------------------------------------------------------------

/**
 * Creates a location of `branchId` and audits `catalog.master.create` (`meta {kind, fields}`). Answers version 0;
 * `reindex` is false (nothing is shelved there yet).
 *
 * @throws DomainError NOT_FOUND for a branch that does not exist or is archived; VALIDATION_FAILED for the strict
 *   body, `parentId` `invalid_parent`, `code` `taken`, a class range (`required`, `invalid`)
 */
export async function createLocation(tx: TxCtx, branchId: string, body: LocationBody): Promise<LocationSaveResult> {
  const b = parseOrFail(LocationBody, body);
  const { trx } = tx;
  // The parent is checked and locked first (parentErrors): a child created under a room and the room's archive
  // serialize, and what is read afterwards is the latest commit.
  const errors = await parentErrors(trx, branchId, b.kind, b.parentId);
  const branch = await trx.selectFrom('branches').select('archived_at').where('id', '=', branchId).executeTakeFirst();
  if (branch === undefined || branch.archived_at !== null) throw branchNotFound();

  const classFrom = textOrNull(b.classFrom);
  const classTo = textOrNull(b.classTo);
  const key = codeKey(b.code);
  if (await keyTaken(trx, branchId, key)) errors.push({ path: 'code', code: 'taken' });
  errors.push(...classErrors(classFrom, classTo));
  if (errors.length > 0) throw validationFailed(errors);

  const id = newId();
  await takingCode(() =>
    trx
      .insertInto('locations')
      .values({
        id,
        branch_id: branchId,
        parent_id: b.parentId,
        kind: b.kind,
        code_display: b.code,
        code_key: key,
        name: b.name,
        shelf_hint: textOrNull(b.shelfHint) ?? hintFromName(b.name),
        class_from: classFrom,
        class_to: classTo,
        map_file_id: null,
        map_x: null,
        map_y: null,
        map_w: null,
        map_h: null,
        is_public: b.isPublic ? 1 : 0,
        sort_order: b.sortOrder,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  const fields = Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined);
  await tx.audit({ action: 'catalog.master.create', entity: 'locations', entityId: id, branchId, meta: { kind: b.kind, fields } });
  return { id, version: 0, reindex: false, boxesCleared: [] };
}

/**
 * Changes the fields `patch` sends (not `version`, which only guards) and audits `catalog.master.update` with the
 * names of the fields whose value changed (and `boxesCleared`, the count of boxes cleared, when there are any). A
 * location that stops being a room gives its floor plan up; one that becomes a room, or changes room, loses its box,
 * and every location below one that changes room loses its box and goes up a version (a box or none). The answer's
 * `boxesCleared` names the locations whose box was cleared, but not one that became a room (a room takes no box, so
 * nothing of it is drawn again). `version` + 1.
 * `reindex` is true when the parent, the kind or `isPublic` changed.
 *
 * @throws DomainError NOT_FOUND (also for a location of another branch); CONFLICT_STALE; VALIDATION_FAILED for the
 *   strict body, `parentId` `invalid_parent`, `kind` `invalid` (a kind its live children cannot sit in), `code` `taken`,
 *   a class range
 */
export async function updateLocation(tx: TxCtx, branchId: string, id: string, patch: LocationPatchBody): Promise<LocationSaveResult> {
  const p = parseOrFail(LocationPatchBody, patch);
  const { trx } = tx;
  await lockLocationRows(trx, typeof p.parentId === 'string' ? [id, p.parentId] : [id]);
  const before = await readOwnRow(trx, branchId, id);
  if (Number(before.version) !== p.version) throw stale();

  const oldKind = before.kind as LocationKind;
  const kind = p.kind ?? oldKind;
  const parentId = p.parentId !== undefined ? p.parentId : before.parent_id;
  const errors: FieldWarning[] = [];
  if (p.kind !== undefined || p.parentId !== undefined) errors.push(...(await parentErrors(trx, branchId, kind, parentId, id)));
  if (kind !== oldKind) {
    const { kinds } = await liveChildren(trx, branchId, id);
    if ([...kinds].some((child) => !PARENT_KINDS[child].includes(kind))) errors.push({ path: 'kind', code: 'invalid' });
  }
  const key = p.code === undefined ? before.code_key : codeKey(p.code);
  if (key !== before.code_key && (await keyTaken(trx, branchId, key, id))) errors.push({ path: 'code', code: 'taken' });
  const classFrom = p.classFrom === undefined ? before.class_from : textOrNull(p.classFrom);
  const classTo = p.classTo === undefined ? before.class_to : textOrNull(p.classTo);
  if (p.classFrom !== undefined || p.classTo !== undefined) errors.push(...classErrors(classFrom, classTo));
  if (errors.length > 0) throw validationFailed(errors);

  const name = p.name ?? before.name;
  let shelfHint = before.shelf_hint;
  if (p.shelfHint !== undefined) shelfHint = textOrNull(p.shelfHint) ?? hintFromName(name);
  // A hint derived from the old name follows the new one; a typed hint stays.
  else if (p.name !== undefined && (before.shelf_hint === null || before.shelf_hint === hintFromName(before.name))) shelfHint = hintFromName(name);
  const isPublic = p.isPublic === undefined ? Number(before.is_public) : p.isPublic ? 1 : 0;
  const sortOrder = p.sortOrder ?? Number(before.sort_order);

  const changed: string[] = [];
  const note = (field: string, differs: boolean): void => {
    if (differs) changed.push(field);
  };
  note('parentId', parentId !== before.parent_id);
  note('kind', kind !== oldKind);
  note('code', p.code !== undefined && p.code !== before.code_display);
  note('name', name !== before.name);
  note('shelfHint', shelfHint !== before.shelf_hint);
  note('classFrom', classFrom !== before.class_from);
  note('classTo', classTo !== before.class_to);
  note('isPublic', isPublic !== Number(before.is_public));
  note('sortOrder', sortOrder !== Number(before.sort_order));

  const set: Partial<{
    parent_id: string | null;
    kind: string;
    code_display: string;
    code_key: string;
    map_file_id: null;
    map_x: null;
    map_y: null;
    map_w: null;
    map_h: null;
  }> = { parent_id: parentId, kind };
  if (p.code !== undefined) {
    set.code_display = p.code;
    set.code_key = key;
  }
  // A room takes no box; a location that changes room takes none drawn on the old room's plan, nor does anything below it.
  const moved = (p.kind !== undefined || p.parentId !== undefined) && (await roomOf(trx, branchId, id, oldKind, before.parent_id)) !== (await roomOf(trx, branchId, id, kind, parentId));
  const boxed = before.map_x !== null || before.map_y !== null || before.map_w !== null || before.map_h !== null;
  // The boxes this write clears (the audit counts them all) and, of them, those to draw again on the new room's map
  // (the answer names them): a location that became a room takes no box, so it is not drawn again.
  let cleared = 0;
  const boxesCleared: string[] = [];
  if ((kind !== oldKind && kind === 'room') || moved) {
    note('box', boxed);
    if (boxed) {
      cleared += 1;
      if (kind !== 'room') boxesCleared.push(id);
    }
    Object.assign(set, { map_x: null, map_y: null, map_w: null, map_h: null });
  }
  if (moved) {
    // Every location below changes room, a box or none: each one's version goes up, so a box drawn on the old room's
    // plan with a version read before the move (a map editor still open there) is stale, not stored in the new room.
    const below = await descendantsOf(trx, branchId, id);
    const belowIds = below.map((d) => d.id);
    for (let i = 0; i < belowIds.length; i += ID_BATCH) {
      await trx
        .updateTable('locations')
        .set((eb) => ({ map_x: null, map_y: null, map_w: null, map_h: null, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
        .where('id', 'in', belowIds.slice(i, i + ID_BATCH))
        .where('branch_id', '=', branchId)
        .execute();
    }
    const boxedBelow = below.filter((d) => d.boxed).map((d) => d.id);
    cleared += boxedBelow.length;
    boxesCleared.push(...boxedBelow);
  }
  if (kind !== oldKind && oldKind === 'room' && before.map_file_id !== null) {
    note('floorPlan', true);
    await releasePlan(trx, before.map_file_id, id);
    set.map_file_id = null;
  }
  const updated = await takingCode(() =>
    trx
      .updateTable('locations')
      .set((eb) => ({
        ...set,
        name,
        shelf_hint: shelfHint,
        class_from: classFrom,
        class_to: classTo,
        is_public: isPublic,
        sort_order: sortOrder,
        updated_at: tx.now,
        updated_by: tx.actor.id,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw stale();
  const meta = cleared === 0 ? { fields: changed } : { fields: changed, boxesCleared: cleared };
  await tx.audit({ action: 'catalog.master.update', entity: 'locations', entityId: id, branchId, meta });
  const reindex = changed.includes('parentId') || changed.includes('kind') || changed.includes('isPublic');
  return { id, version: p.version + 1, reindex, boxesCleared };
}

/**
 * Archives a location (`archived_at = now`, `version` + 1) and audits `catalog.master.archive`. One already archived
 * is answered as it is, with `meta.alreadyArchived` (a route that audits writes exactly one entry).
 *
 * @throws DomainError NOT_FOUND (also for a location of another branch); CONFLICT_STALE; CATALOG_IN_USE (409,
 *   `meta {count, children, items}`) while it holds live locations or live items (Review Focus 2)
 */
export async function archiveLocation(tx: TxCtx, branchId: string, id: string, version: number): Promise<{ version: number }> {
  const { trx } = tx;
  await lockLocationRows(trx, [id]);
  const before = await readOwnRow(trx, branchId, id);
  if (Number(before.version) !== version) throw stale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'catalog.master.archive', entity: 'locations', entityId: id, branchId, meta: { alreadyArchived: true } });
    return { version };
  }
  const children = (await liveChildren(trx, branchId, id)).count;
  const items = await liveItemCount(trx, branchId, id);
  if (children + items > 0) throw inUse(children, items);
  const updated = await trx
    .updateTable('locations')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw stale();
  await tx.audit({ action: 'catalog.master.archive', entity: 'locations', entityId: id, branchId, meta: {} });
  return { version: version + 1 };
}

/**
 * Sets the shelf map of a location and audits `catalog.master.update` (`meta.fields`: `['floorPlan']` or `['box']`):
 * a room takes `floorPlanFileId` (null removes the plan), an area or a shelf takes `box` (null removes it). `version`
 * + 1.
 *
 * @throws DomainError NOT_FOUND (also for a location of another branch); CONFLICT_STALE; VALIDATION_FAILED for the
 *   strict body (a box outside the plan: `box.w`/`box.h` `too_big`), the field the kind does not take (`invalid`) or
 *   lacks (`required`), and at `floorPlanFileId` `not_found`, or `invalid` for a file of another context or owner
 */
export async function setLocationMap(tx: TxCtx, branchId: string, id: string, body: LocationMapBody): Promise<{ version: number }> {
  const b = parseOrFail(LocationMapBody, body);
  const { trx } = tx;
  await lockLocationRows(trx, [id]);
  const before = await readOwnRow(trx, branchId, id);
  if (Number(before.version) !== b.version) throw stale();

  const isRoom = before.kind === 'room';
  const errors: FieldWarning[] = [];
  if (isRoom) {
    if (b.box !== undefined && b.box !== null) errors.push({ path: 'box', code: 'invalid' });
    if (b.floorPlanFileId === undefined) errors.push({ path: 'floorPlanFileId', code: 'required' });
  } else {
    if (b.box === undefined) errors.push({ path: 'box', code: 'required' });
    if (b.floorPlanFileId !== undefined && b.floorPlanFileId !== null) errors.push({ path: 'floorPlanFileId', code: 'invalid' });
  }
  if (errors.length > 0) throw validationFailed(errors);

  let set: { map_file_id: string | null } | { map_x: number | null; map_y: number | null; map_w: number | null; map_h: number | null };
  if (isRoom) {
    const fileId = b.floorPlanFileId ?? null;
    if (fileId !== null) await claimPlan(trx, fileId, id);
    if (before.map_file_id !== null && before.map_file_id !== fileId) await releasePlan(trx, before.map_file_id, id);
    set = { map_file_id: fileId };
  } else {
    const box = b.box ?? null;
    set = { map_x: box?.x ?? null, map_y: box?.y ?? null, map_w: box?.w ?? null, map_h: box?.h ?? null };
  }
  const updated = await trx
    .updateTable('locations')
    .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', b.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw stale();
  await tx.audit({ action: 'catalog.master.update', entity: 'locations', entityId: id, branchId, meta: { fields: [isRoom ? 'floorPlan' : 'box'] } });
  return { version: b.version + 1 };
}

/**
 * Makes `fileId` the floor plan of room `roomId`: a `catalog.floor_plan` upload that nobody owns (or this room
 * already does) becomes the room's (`owner_type 'locations'`) and public. The claim re-checks the owner in its UPDATE:
 * two rooms claiming the same upload at once cannot both win.
 */
async function claimPlan(trx: Transaction<DB>, fileId: string, roomId: string): Promise<void> {
  const file = await trx.selectFrom('files').select(['context', 'owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirst();
  if (file === undefined) throw validationFailed([{ path: 'floorPlanFileId', code: 'not_found' }]);
  const ownedHere = file.owner_type === 'locations' && file.owner_id === roomId;
  const unowned = file.owner_type === null && file.owner_id === null;
  if (file.context !== 'catalog.floor_plan' || !(ownedHere || unowned)) throw validationFailed([{ path: 'floorPlanFileId', code: 'invalid' }]);
  const claimed = await trx
    .updateTable('files')
    .set({ owner_type: 'locations', owner_id: roomId, access: 'public' })
    .where('id', '=', fileId)
    .where('context', '=', 'catalog.floor_plan')
    .where((eb) =>
      eb.or([eb.and([eb('owner_type', 'is', null), eb('owner_id', 'is', null)]), eb.and([eb('owner_type', '=', 'locations'), eb('owner_id', '=', roomId)])]),
    )
    .executeTakeFirst();
  // Claimed meanwhile by another room (a plan this room holds already may change nothing; some drivers count only
  // changed rows).
  if (unowned && Number(claimed.numUpdatedRows) !== 1) throw validationFailed([{ path: 'floorPlanFileId', code: 'invalid' }]);
}
