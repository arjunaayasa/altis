import type { DB } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import {
  PublisherBody,
  PublisherPatchBody,
  type AuthorityListQuery,
  type PublisherListResponse,
  type PublisherView,
} from '@altis/shared/api/catalog/authorities';
import type { Kysely, Selectable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { publisherNameKey } from '../data/keys.js';
import type { AuthorityCreateResult, AuthorityUpdateResult } from './agents.js';
import {
  authorityNotFound,
  authorityStale,
  cursorId,
  isUniqueViolation,
  keyContains,
  keyCursor,
  lockAuthorityRows,
  revivalConflict,
  mergedAuthority,
  oneLine,
  optionalLine,
  parseOrFail,
  validationFailed,
  type Db,
} from './common.js';
import { authorityUsage } from './usage.js';

// Publishers (Phase 2 spec §2.2, §3.5; plan Task 13): list, read, create, update, as agents.ts does for names. The key
// is publisherNameKey(name), unique; a taken one is `{path: 'name', code: 'taken'}`. A change of the name or the place
// answers `reindex: true` (the route queues `catalog.reindex {publisherId}`): the linked records' documents hold the
// publisher's name and place beside their own `publication_place` (search/doc.ts `t_rest`, C08).

type PublisherRow = Selectable<DB['publishers']>;

function toView(r: PublisherRow, usage: number): PublisherView {
  return {
    id: r.id,
    name: r.name_display,
    place: r.place,
    usage,
    mergedInto: r.merged_into,
    archived: r.archived_at !== null,
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function views(db: Db, rows: readonly PublisherRow[]): Promise<PublisherView[]> {
  const usage = await authorityUsage(
    db,
    'publishers',
    rows.map((r) => r.id),
  );
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

async function readRow(db: Db, id: string): Promise<PublisherRow> {
  const row = await db.selectFrom('publishers').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw authorityNotFound('publishers');
  return row;
}

/**
 * The publisher `id` in any state.
 *
 * @throws DomainError NOT_FOUND
 */
export async function getPublisher(db: Db, id: string): Promise<PublisherView> {
  const [view] = await views(db, [await readRow(db, id)]);
  return view as PublisherView;
}

/**
 * A page of publishers in key order (`GET catalog/publishers`), as listAgents. Publishers have no type.
 *
 * @throws DomainError VALIDATION_FAILED at `type` (`invalid_value`) or `cursor` (`invalid`)
 */
export async function listPublishers(db: Kysely<DB>, q: AuthorityListQuery): Promise<PublisherListResponse> {
  if (q.type !== undefined) throw validationFailed([{ path: 'type', code: 'invalid_value' }]);
  let query = db.selectFrom('publishers').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  const needle = q.q === undefined ? '' : normalizeKey(q.q);
  if (needle !== '') query = query.where((eb) => keyContains(eb.ref('name_key'), needle));
  if (q.cursor !== undefined) {
    const id = cursorId(q.cursor);
    const last = await db.selectFrom('publishers').select('name_key').where('id', '=', id).executeTakeFirst();
    if (last === undefined) throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
    query = query.where((eb) => eb.or([eb('name_key', '>', last.name_key), eb.and([eb('name_key', '=', last.name_key), eb('id', '>', id)])]));
  }
  const rows = await query.orderBy('name_key').orderBy('id').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: await views(db, page), nextCursor: rows.length > q.limit && last !== undefined ? keyCursor(last.id) : null };
}

const taken = () => validationFailed([{ path: 'name', code: 'taken' }]);

/**
 * Creates a publisher, or brings back the archived (unmerged) one of the same key, as createAgent does.
 *
 * @throws DomainError VALIDATION_FAILED (`name` `taken`, or the contract's field errors)
 */
export async function createPublisher(tx: TxCtx, body: PublisherBody): Promise<AuthorityCreateResult<PublisherView>> {
  const { trx } = tx;
  const b = parseOrFail(PublisherBody, body);
  const name = oneLine(b.name);
  const place = optionalLine(b.place);
  const key = publisherNameKey(name);
  const fields = Object.keys(b).filter((k) => b[k as keyof PublisherBody] !== undefined);

  let existing = await trx.selectFrom('publishers').selectAll().where('name_key', '=', key).executeTakeFirst();
  if (existing !== undefined) {
    await lockAuthorityRows(trx, 'publishers', [existing.id]);
    existing = await readRow(trx, existing.id);
    if (existing.archived_at === null || existing.merged_into !== null) throw taken();
    const reindex = existing.name_display !== name;
    // The WHERE sees the latest commit on every engine (L01): a merge, revival or rename after our read matches nothing.
    const revived = await trx
      .updateTable('publishers')
      .set((eb) => ({
        name_display: name,
        ...(place === undefined ? {} : { place }),
        archived_at: null,
        updated_at: tx.now,
        updated_by: tx.actor.id,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', existing.id)
      .where('name_key', '=', key)
      .where('archived_at', 'is not', null)
      .where('merged_into', 'is', null)
      .executeTakeFirst();
    if (Number(revived.numUpdatedRows) !== 1) throw revivalConflict();
    await tx.audit({ action: 'catalog.authority.create', entity: 'publishers', entityId: existing.id, meta: { fields, revived: true } });
    return { view: await getPublisher(trx, existing.id), revived: true, reindex };
  }

  const id = newId(tx.now);
  try {
    await trx
      .insertInto('publishers')
      .values({
        id,
        name_display: name,
        name_key: key,
        place: place ?? null,
        merged_into: null,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) throw taken();
    throw error;
  }
  await tx.audit({ action: 'catalog.authority.create', entity: 'publishers', entityId: id, meta: { fields, revived: false } });
  return { view: toView(await readRow(trx, id), 0), revived: false, reindex: false };
}

/**
 * Changes the fields `patch` sends, as updateAgent does.
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged publisher; CONFLICT_STALE; VALIDATION_FAILED
 */
export async function updatePublisher(tx: TxCtx, id: string, patch: PublisherPatchBody): Promise<AuthorityUpdateResult<PublisherView>> {
  const { trx } = tx;
  const p = parseOrFail(PublisherPatchBody, patch);
  await lockAuthorityRows(trx, 'publishers', [id]);
  const before = await readRow(trx, id);
  if (before.merged_into !== null) throw mergedAuthority();
  if (Number(before.version) !== p.version) throw authorityStale();

  const changed: string[] = [];
  const set: Partial<Pick<PublisherRow, 'name_display' | 'name_key' | 'place'>> = {};
  if (p.name !== undefined && oneLine(p.name) !== before.name_display) {
    changed.push('name');
    set.name_display = oneLine(p.name);
    const key = publisherNameKey(set.name_display);
    if (key !== before.name_key) {
      const holder = await trx.selectFrom('publishers').select('id').where('name_key', '=', key).executeTakeFirst();
      if (holder !== undefined && holder.id !== id) throw taken();
      set.name_key = key;
    }
  }
  const place = optionalLine(p.place);
  if (place !== undefined && place !== before.place) {
    changed.push('place');
    set.place = place;
  }
  try {
    const updated = await trx
      .updateTable('publishers')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw authorityStale();
  } catch (error) {
    if (isUniqueViolation(error)) throw taken();
    throw error;
  }
  await tx.audit({ action: 'catalog.authority.update', entity: 'publishers', entityId: id, meta: { fields: changed } });
  return { view: await getPublisher(trx, id), reindex: changed.includes('name') || changed.includes('place') };
}
