import { cleanText } from '../source/clean-text.js';
import type { SlimsRow, SlimsSource } from '../source/types.js';

// The places of publication of the SLiMS migration (Phase 2 spec §11.4 `mst_place` → `records.publication_place`,
// preflight M13). SLiMS points at a place row by id; ALTIS keeps the place's name on the record. `mst_place` writes no
// rows of its own: the records stage reads it into an in-memory map (legacy id → name, cleaned and cut to the
// column's 191 characters), once per source per process. A crafted dump is cut at PLACE_ROWS_MAX rows; a record whose
// place lies beyond them is reported as a missing place.

/** The most places kept in the map. */
export const PLACE_ROWS_MAX = 200_000;
/** `records.publication_place` is VARCHAR(191). */
export const PLACE_MAX = 191;
const BATCH = 500;

/** A cell as text (bytes decoded as cleanText does), '' for NULL. */
function text(v: SlimsRow[string] | undefined): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : cleanText(v).value;
}

/** A place name as stored: control characters as spaces, trimmed, cut to {@link PLACE_MAX} code points; null for blank. */
export function placeNameOf(row: SlimsRow): string | null {
  const name = text(row['place_name']).replace(/\p{Cc}+/gu, ' ').trim();
  if (name === '') return null;
  const points = Array.from(name);
  return points.length <= PLACE_MAX ? name : points.slice(0, PLACE_MAX).join('').trimEnd();
}

/** The legacy key of a place row (`place_id`), '' for none. */
export function placeKeyOf(row: SlimsRow): string {
  return text(row['place_id']).trim();
}

const cache = new WeakMap<SlimsSource, Promise<ReadonlyMap<string, string | null>>>();

/** Legacy id → place name of `source` (read on first use, then kept for the source's life in this process). */
export function placeMap(source: SlimsSource): Promise<ReadonlyMap<string, string | null>> {
  let map = cache.get(source);
  if (map === undefined) {
    map = (async () => {
      const out = new Map<string, string | null>();
      if (!(await source.tables()).some((t) => t.name === 'mst_place')) return out;
      let after: string | null = null;
      do {
        const batch = await source.rows('mst_place', after, BATCH);
        for (const row of batch.rows) {
          if (out.size >= PLACE_ROWS_MAX) return out;
          const key = placeKeyOf(row);
          if (key !== '') out.set(key, placeNameOf(row));
        }
        after = batch.rows.length === 0 ? null : batch.next;
      } while (after !== null);
      return out;
    })();
    cache.set(source, map);
    map.catch(() => cache.delete(source));
  }
  return map;
}
