import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';

// Where a location is (Phase 2 spec §3.6): room › area › shelf, at most three levels. Items, the OPAC record detail
// (the shelf map: the room's floor plan with the shelf's box highlighted) and the search index's location facet read a
// location through its path.

/** A location's path: its room, area and shelf, the room's floor plan and the location's box on it. */
export interface LocationPath {
  /** The top of the chain (a room). */
  roomId: string;
  roomName: string;
  areaName: string | null;
  shelfName: string | null;
  /** The location's own hint (≤ 40), or its name cut to 40 characters (§3.6). */
  shelfHint: string | null;
  /** The room's floor plan. */
  mapFileId: string | null;
  /** The box (per mille of the plan) of the location, or of its area when it has none; null for a room. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Every level of the chain is public and none is archived. */
  isPublic: boolean;
}

interface LocationRow {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  shelf_hint: string | null;
  map_file_id: string | null;
  map_x: number | null;
  map_y: number | null;
  map_w: number | null;
  map_h: number | null;
  is_public: number;
  archived_at: number | null;
}

/** §3.6: room › area › shelf. */
const MAX_DEPTH = 3;
const SHELF_HINT_MAX = 40;
const ID_BATCH = 500;

type Db = Kysely<DB> | Transaction<DB>;

function boxOf(r: LocationRow): LocationPath['box'] {
  if (r.map_x === null || r.map_y === null || r.map_w === null || r.map_h === null) return null;
  return { x: r.map_x, y: r.map_y, w: r.map_w, h: r.map_h };
}

/**
 * The paths of the locations `ids`, keyed by id; an id that names no location is absent. The chain is read up through
 * `parent_id` (at most three levels; a longer or looping chain stops there).
 */
export async function locationPaths(db: Db, ids: readonly string[]): Promise<Map<string, LocationPath>> {
  const rows = new Map<string, LocationRow>();
  let wanted = [...new Set(ids)];
  for (let level = 0; level < MAX_DEPTH && wanted.length > 0; level += 1) {
    const next = new Set<string>();
    for (let i = 0; i < wanted.length; i += ID_BATCH) {
      const batch = await db
        .selectFrom('locations')
        .select(['id', 'parent_id', 'kind', 'name', 'shelf_hint', 'map_file_id', 'map_x', 'map_y', 'map_w', 'map_h', 'is_public', 'archived_at'])
        .where('id', 'in', wanted.slice(i, i + ID_BATCH))
        .execute();
      for (const r of batch) {
        rows.set(r.id, r);
        if (r.parent_id !== null && !rows.has(r.parent_id)) next.add(r.parent_id);
      }
    }
    wanted = [...next].filter((id) => !rows.has(id));
  }

  const paths = new Map<string, LocationPath>();
  for (const id of new Set(ids)) {
    const own = rows.get(id);
    if (own === undefined) continue;
    // The chain from the location up to its room.
    const chain: LocationRow[] = [own];
    for (let at = own; at.parent_id !== null && chain.length < MAX_DEPTH; ) {
      const parent = rows.get(at.parent_id);
      if (parent === undefined || chain.includes(parent)) break;
      chain.push(parent);
      at = parent;
    }
    const room = chain[chain.length - 1] as LocationRow;
    const area = chain.find((r) => r.kind === 'area') ?? null;
    const shelf = chain.find((r) => r.kind === 'shelf') ?? null;
    const box = chain.slice(0, -1).map(boxOf).find((b) => b !== null) ?? null;
    paths.set(id, {
      roomId: room.id,
      roomName: room.name,
      areaName: area?.name ?? null,
      shelfName: shelf?.name ?? null,
      shelfHint: own.shelf_hint ?? Array.from(own.name).slice(0, SHELF_HINT_MAX).join('').trimEnd(),
      mapFileId: room.map_file_id,
      box,
      isPublic: chain.every((r) => r.is_public === 1 && r.archived_at === null),
    });
  }
  return paths;
}
