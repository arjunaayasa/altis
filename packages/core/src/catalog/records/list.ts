import type { DB } from '@altis/db';
import { isUlid } from '@altis/shared';
import type { RecordCountsQuery, RecordListItem, RecordListQuery, RecordListResponse, RecordView } from '@altis/shared/api/catalog/records';
import type { ExpressionBuilder, Kysely, SelectQueryBuilder, Transaction } from 'kysely';
import { searchCatalog } from '../../search/search.js';
import type { CatalogSearchQuery } from '../../search/types.js';
import { validationFailed } from './service.js';

// The admin list of records (`GET catalog/records`; Phase 2 spec §4.5, plan Task 16, S14).
//
// - With `q`, or with `sort: 'newest'`, the list is a search (`searchCatalog`, scope `admin`): relevance pages by
//   `page` (≤ 50, §4.5) and counts `total` (to 10 000); newest-first reads the index's `created_at` order (S14). The
//   search filters by material type, hidden records and archived ones itself; the filters it does not know (only
//   hidden, only archived, has items, the change range) are applied to the page it answers, so such a page may hold
//   fewer rows than asked for and `total` counts before them.
// - Otherwise a keyset over `(changed_at, id)`, latest change first (the default), or over `(title_key, id)` (`sort:
//   'title'`), paged by an opaque `cursor`: `c.<changedAt>.<id>` or `t.<id>` (a title key can be longer than a cursor
//   may be, so the title cursor names the last row and its key is read again). A cursor of another order or that does
//   not parse is VALIDATION_FAILED at `cursor`.
// - Filters: `materialTypeId`; `hidden` `only`/`exclude` (OPAC visibility); `archived` true → only archived records,
//   otherwise only live ones; `hasItems` (an item that is not archived); `changedFrom`/`changedTo` (inclusive).
// - Each row: the main agent's name (the first main one), the count of items that are not archived, the cover.
// - The counts (`GET catalog/records/counts`) apply the same filters as the keyset list, so a count is the number of
//   rows that list holds: one for the filters asked for, and one per saved view, kept for a short while.

type Db = Kysely<DB> | Transaction<DB>;
type RecordsQuery = SelectQueryBuilder<DB, 'records', object>;

const ID_BATCH = 500;

function badCursor(): never {
  throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/** The filters every list applies (the keyset ones, and the page of a search). */
function withFilters<Q extends RecordsQuery>(query: Q, q: RecordCountsQuery): Q {
  let out = query as RecordsQuery;
  if (q.materialTypeId !== undefined) out = out.where('records.material_type_id', '=', q.materialTypeId);
  if (q.hidden === 'only') out = out.where('records.opac_visible', '=', 0);
  if (q.hidden === 'exclude') out = out.where('records.opac_visible', '=', 1);
  out = q.archived === true ? out.where('records.archived_at', 'is not', null) : out.where('records.archived_at', 'is', null);
  if (q.hasItems !== undefined) {
    const liveItem = (eb: ExpressionBuilder<DB, 'records'>) =>
      eb.exists(eb.selectFrom('items').select('items.id').whereRef('items.record_id', '=', 'records.id').where('items.archived_at', 'is', null));
    out = out.where((eb) => (q.hasItems === true ? liveItem(eb) : eb.not(liveItem(eb))));
  }
  if (q.changedFrom !== undefined) out = out.where('records.changed_at', '>=', q.changedFrom);
  if (q.changedTo !== undefined) out = out.where('records.changed_at', '<=', q.changedTo);
  return out as Q;
}

/** The list rows of `ids`, in that order (ids without a row left out). */
async function listItems(db: Db, ids: readonly string[]): Promise<RecordListItem[]> {
  if (ids.length === 0) return [];
  const rows = new Map<string, RecordListItem>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    const records = await db
      .selectFrom('records')
      .select(['id', 'title', 'subtitle', 'material_type_id', 'publication_year', 'call_number', 'cover_file_id', 'opac_visible', 'archived_at', 'changed_at'])
      .where('id', 'in', batch)
      .execute();
    const mains = await db
      .selectFrom('record_agents as ra')
      .innerJoin('agents as a', 'a.id', 'ra.agent_id')
      .select(['ra.record_id', 'a.name_display'])
      .where('ra.record_id', 'in', batch)
      .where('ra.is_main', '=', 1)
      .orderBy('ra.record_id')
      .orderBy('ra.sort_order')
      .execute();
    const mainAgent = new Map<string, string>();
    for (const m of mains) if (!mainAgent.has(m.record_id)) mainAgent.set(m.record_id, m.name_display);
    const counts = await db
      .selectFrom('items')
      .select(['record_id', (eb) => eb.fn.countAll().as('n')])
      .where('record_id', 'in', batch)
      .where('archived_at', 'is', null)
      .groupBy('record_id')
      .execute();
    const itemCount = new Map(counts.map((c) => [c.record_id, Number(c.n)]));
    for (const r of records) {
      rows.set(r.id, {
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        mainAgent: mainAgent.get(r.id) ?? null,
        materialTypeId: r.material_type_id,
        year: r.publication_year,
        callNumber: r.call_number,
        itemCount: itemCount.get(r.id) ?? 0,
        coverFileId: r.cover_file_id,
        opacVisible: Number(r.opac_visible) === 1,
        archived: r.archived_at !== null,
        changedAt: Number(r.changed_at),
      });
    }
  }
  return ids.flatMap((id) => {
    const row = rows.get(id);
    return row === undefined ? [] : [row];
  });
}

/** The page of a search (see the top of this file). */
async function searchPage(db: Kysely<DB>, q: RecordListQuery, now: number): Promise<RecordListResponse> {
  const sort: CatalogSearchQuery['sort'] = q.sort === 'newest' ? 'newest' : q.sort === 'title' ? 'title' : q.q === undefined || q.q === '' ? 'newest' : 'relevance';
  const page = q.page ?? 1;
  const result = await searchCatalog(
    db,
    {
      text: q.q ?? '',
      scope: 'admin',
      filters: {
        ...(q.materialTypeId === undefined ? {} : { materialTypeIds: [q.materialTypeId] }),
        includeArchived: q.archived === true,
        includeHidden: q.hidden !== 'exclude',
      },
      sort,
      page,
      pageSize: q.limit,
    },
    { now },
  );
  // The filters the search does not know, applied to its page.
  const kept = new Set<string>();
  for (let i = 0; i < result.recordIds.length; i += ID_BATCH) {
    const batch = result.recordIds.slice(i, i + ID_BATCH);
    const rows = await withFilters(db.selectFrom('records').select('records.id').where('records.id', 'in', batch), q).execute();
    for (const r of rows) kept.add(r.id);
  }
  const items = await listItems(
    db,
    result.recordIds.filter((id) => kept.has(id)),
  );
  return { items, total: result.total, nextCursor: null, page };
}

/** The records of the admin list (see the top of this file). `o.now` is the clock the search reads (default now). */
export async function listRecords(db: Kysely<DB>, q: RecordListQuery, o: { now?: number } = {}): Promise<RecordListResponse> {
  if ((q.q !== undefined && q.q.trim() !== '') || q.sort === 'newest') return searchPage(db, q, o.now ?? Date.now());

  const limit = q.limit;
  const byTitle = q.sort === 'title';
  let query = withFilters(db.selectFrom('records').select(['records.id', 'records.changed_at', 'records.title_key']), q);
  if (q.cursor !== undefined) {
    if (byTitle) {
      const m = /^t\.([0-9A-Z]{26})$/.exec(q.cursor);
      const id = m?.[1];
      if (id === undefined || !isUlid(id)) badCursor();
      const last = await db.selectFrom('records').select('title_key').where('id', '=', id).executeTakeFirst();
      if (last === undefined) badCursor();
      query = query.where((eb) =>
        eb.or([eb('records.title_key', '>', last.title_key), eb.and([eb('records.title_key', '=', last.title_key), eb('records.id', '>', id)])]),
      );
    } else {
      const m = /^c\.(\d{1,16})\.([0-9A-Z]{26})$/.exec(q.cursor);
      const at = m?.[1] === undefined ? Number.NaN : Number(m[1]);
      const id = m?.[2];
      if (id === undefined || !isUlid(id) || !Number.isSafeInteger(at)) badCursor();
      query = query.where((eb) => eb.or([eb('records.changed_at', '<', at), eb.and([eb('records.changed_at', '=', at), eb('records.id', '<', id)])]));
    }
  }
  query = byTitle
    ? query.orderBy('records.title_key').orderBy('records.id')
    : query.orderBy('records.changed_at', 'desc').orderBy('records.id', 'desc');
  const rows = await query.limit(limit + 1).execute();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? (byTitle ? `t.${last.id}` : `c.${Number(last.changed_at)}.${last.id}`) : null;
  return { items: await listItems(db, page.map((r) => r.id)), total: null, nextCursor, page: null };
}

/** How many records the keyset list holds for the filters of `q` (the same conditions, counted and not loaded). */
export async function countRecords(db: Db, q: RecordCountsQuery): Promise<number> {
  const row = await withFilters(
    db.selectFrom('records').select((eb) => eb.fn.countAll().as('n')),
    q,
  ).executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** The filter each saved view of the list stands for. */
const VIEW_FILTERS: Readonly<Record<RecordView, RecordCountsQuery>> = Object.freeze({
  all: {},
  no_items: { hasItems: false },
  hidden: { hidden: 'only' },
  archived: { archived: true },
});

/** How many records each saved view lists with no other filter. */
export async function recordViewCounts(db: Db): Promise<Record<RecordView, number>> {
  const out: Record<RecordView, number> = { all: 0, no_items: 0, hidden: 0, archived: 0 };
  for (const view of Object.keys(VIEW_FILTERS) as RecordView[]) out[view] = await countRecords(db, VIEW_FILTERS[view]);
  return out;
}

/** How long the counts of the saved views are kept before they are read again. */
export const RECORD_VIEW_COUNTS_TTL_MS = 30_000;

/** The view counts read per database, with the time (a monotonic clock) they were read at; a pending read is shared. */
const viewCountsCache = new WeakMap<object, { at: number; value: Promise<Record<RecordView, number>> }>();

/**
 * {@link recordViewCounts}, kept for {@link RECORD_VIEW_COUNTS_TTL_MS} per database: every opening of the list asks
 * for them, and a count that is half a minute late is fine on a tab. A failed read is not kept.
 */
export function cachedRecordViewCounts(db: Kysely<DB>, clock: () => number = () => performance.now()): Promise<Record<RecordView, number>> {
  const now = clock();
  const hit = viewCountsCache.get(db);
  if (hit !== undefined && now - hit.at < RECORD_VIEW_COUNTS_TTL_MS) return hit.value;
  const value = recordViewCounts(db);
  viewCountsCache.set(db, { at: now, value });
  value.catch(() => {
    if (viewCountsCache.get(db)?.value === value) viewCountsCache.delete(db);
  });
  return value;
}
