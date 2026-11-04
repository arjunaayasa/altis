import { RDA_CARRIER_TYPES, RDA_CONTENT_TYPES, RDA_MEDIA_TYPES, type RdaTerm } from '@altis/shared';
import { cleanText } from '../source/clean-text.js';
import type { SlimsRow, SlimsSource } from '../source/types.js';

// The RDA lookups of the SLiMS migration (Phase 2 spec §11.4, preflight M13). SLiMS keeps RDA content, media and
// carrier types as rows (`mst_content_type`, `mst_media_type`, `mst_carrier_type`) that `biblio` points at by id;
// ALTIS keeps the RDA code on the record. Each row is matched against the official list (Task 4's vocabularies) by its
// `code`, else by its term; a row that matches neither stands for no code (null), and the masters stage reports it
// (`rda_unmatched`). The tables write no rows of their own: they are read again by the records stage into in-memory
// maps (legacy id → code), once per source per process (they are small; a crafted dump is cut at RDA_ROWS_MAX rows).

/** The three kinds and their SLiMS tables and term columns. */
export const RDA_KINDS = Object.freeze({
  content: Object.freeze({ table: 'mst_content_type', term: 'content_type', list: RDA_CONTENT_TYPES as readonly RdaTerm[] }),
  media: Object.freeze({ table: 'mst_media_type', term: 'media_type', list: RDA_MEDIA_TYPES as readonly RdaTerm[] }),
  carrier: Object.freeze({ table: 'mst_carrier_type', term: 'carrier_type', list: RDA_CARRIER_TYPES as readonly RdaTerm[] }),
});

export type RdaKind = keyof typeof RDA_KINDS;

/** The rows of each table read into a map at most. */
export const RDA_ROWS_MAX = 10_000;
const BATCH = 500;

/** Lower case, white space collapsed. */
function loose(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A cell as text (bytes decoded as cleanText does), '' for NULL. */
function text(v: SlimsRow[string] | undefined): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : cleanText(v).value;
}

/** The RDA code of a SLiMS row of `kind`: its `code` when the list has it, else the code of its term; null for none. */
export function rdaCodeOf(kind: RdaKind, row: SlimsRow): string | null {
  const { term, list } = RDA_KINDS[kind];
  const code = loose(text(row['code']));
  if (code !== '') {
    const byCode = list.find((e) => e.code === code);
    if (byCode !== undefined) return byCode.code;
  }
  const name = loose(text(row[term]));
  if (name === '') return null;
  return list.find((e) => e.term === name)?.code ?? null;
}

/** The legacy key of a row's id (`id`), '' for none. */
export function rdaKeyOf(row: SlimsRow): string {
  return text(row['id']).trim();
}

/** Legacy id → RDA code (null: the row matches no code), per kind. */
export type RdaMaps = Readonly<Record<RdaKind, ReadonlyMap<string, string | null>>>;

const cache = new WeakMap<SlimsSource, Promise<RdaMaps>>();

async function readMap(source: SlimsSource, kind: RdaKind, present: ReadonlySet<string>): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!present.has(RDA_KINDS[kind].table)) return map;
  let after: string | null = null;
  do {
    const batch = await source.rows(RDA_KINDS[kind].table, after, BATCH);
    for (const row of batch.rows) {
      if (map.size >= RDA_ROWS_MAX) return map;
      const key = rdaKeyOf(row);
      if (key !== '') map.set(key, rdaCodeOf(kind, row));
    }
    after = batch.rows.length === 0 ? null : batch.next;
  } while (after !== null);
  return map;
}

/** The RDA maps of `source` (read on first use, then kept for the source's life in this process). */
export function rdaMaps(source: SlimsSource): Promise<RdaMaps> {
  let maps = cache.get(source);
  if (maps === undefined) {
    maps = (async () => {
      const present = new Set((await source.tables()).map((t) => t.name));
      return {
        content: await readMap(source, 'content', present),
        media: await readMap(source, 'media', present),
        carrier: await readMap(source, 'carrier', present),
      };
    })();
    cache.set(source, maps);
    maps.catch(() => cache.delete(source));
  }
  return maps;
}
