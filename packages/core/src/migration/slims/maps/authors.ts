import type { DB } from '@altis/db';
import { normalizeKey, type RelatorRole } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { agentNameKey } from '../../../catalog/data/keys.js';
import type { CatalogAgentType } from '../../../catalog/data/authorities.js';

// SLiMS authors (Phase 2 spec §11.4; plan Task 37):
//
// - `biblio_author.level` 1–10 as relator roles: 1 and 2 are authors (`aut`; the first level-1 author of a record is
//   its main entry), then editor, translator, director, producer, composer, illustrator, creator and contributor. A
//   level outside 1–10 is an author too (`aut`, never the main entry), reported.
// - `mst_author` keeps one row per (name, type) (its unique key ignores `author_year`), so two SLiMS rows whose names
//   only differ in spacing or case are one person even when only one of them has dates. ALTIS keys an agent by its
//   name and dates (agentNameKey), so an author is looked for by its full key first, then by its name alone among the
//   agents of its type: one without dates, or (for a row without dates) one with any. Two rows with different dates
//   stay two people.

/** The role and rank of a `biblio_author.level`; `valid: false` for a level outside 1–10. */
export function authorRole(level: number): { role: RelatorRole; rank: number; mainCandidate: boolean; valid: boolean } {
  const roles: readonly RelatorRole[] = ['aut', 'aut', 'edt', 'trl', 'drt', 'pro', 'cmp', 'ill', 'cre', 'ctb'];
  if (Number.isSafeInteger(level) && level >= 1 && level <= 10) return { role: roles[level - 1]!, rank: level, mainCandidate: level === 1, valid: true };
  return { role: 'aut', rank: 11, mainCandidate: false, valid: false };
}

/** The most agents of one name read as candidates (people of one name with different dates). */
const CANDIDATES_MAX = 50;

/**
 * The id of the agent a SLiMS author `name` (with `dates`) of `type` already is (see the top of this file), or null.
 * The id may be of an agent merged into another or archived: the caller settles it (resolveAgents with `{id}`).
 */
export async function findSlimsAuthor(
  db: Kysely<DB> | Transaction<DB>,
  type: CatalogAgentType,
  name: string,
  dates: string | null,
): Promise<string | null> {
  const full = agentNameKey(name, dates);
  const exact = await db.selectFrom('agents').select('id').where('type', '=', type).where('name_key', '=', full).executeTakeFirst();
  if (exact !== undefined) return exact.id;
  const bare = agentNameKey(name, null);
  // The keys `<name>` and `<name> <dates>` (a binary range: the key columns compare byte-wise on every engine).
  const candidates = await db
    .selectFrom('agents')
    .select(['id', 'name_display', 'dates'])
    .where('type', '=', type)
    .where((eb) => eb.or([eb('name_key', '=', bare), eb.and([eb('name_key', '>=', `${bare} `), eb('name_key', '<', `${bare}!`)])]))
    .orderBy('name_key')
    .limit(CANDIDATES_MAX)
    .execute();
  const sameName = candidates.filter((a) => normalizeKey(a.name_display) === normalizeKey(name));
  const undated = sameName.find((a) => a.dates === null || a.dates === '');
  if (undated !== undefined) return undated.id;
  return dates === null ? (sameName[0]?.id ?? null) : null;
}
