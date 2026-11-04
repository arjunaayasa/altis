import type { DB } from '@altis/db';
import { normalizeKey } from '@altis/shared';
import type { DuplicateCandidate, DuplicateCheckBody, DuplicateReason } from '@altis/shared/api/catalog/records';
import type { Kysely } from 'kysely';
import { titleCandidates } from '../../search/candidates.js';
import { agentNameKey, publisherNameKey } from '../data/keys.js';
import { diceCoefficient } from '../lib/similarity.js';
import { titleKey } from '../lib/title-key.js';
import { identifierKey } from './identifiers.js';

// The duplicate check (Phase 2 spec §3.3): while a librarian types (`POST catalog/records/duplicates`), before an SRU
// or ISBN copy is saved, and per record during an import. Only live records (not archived, not merged) are candidates.
//
// 1. A record holding an ISBN or ISSN of the input (the same `value_key`) whose qualifier is equal (compared by
//    normalizeKey) or empty on either side scores 100, reason `isbn`.
// 2. Otherwise the candidates are the top 50 of the full-text search over the title (Task 15's `titleCandidates`),
//    scored in JS: `60 × Dice(title_key)` + 15 for the same year + 15 for the same main agent (its name's key) + 10
//    for the same publisher (its name key), rounded to an integer.
// 3. At most 5 candidates at or above the threshold (`catalog.dedupe.threshold`), best first (then by id).

const TITLE_CANDIDATES = 50;
const MAX_CANDIDATES = 5;
const ID_BATCH = 500;

interface CandidateRow {
  id: string;
  title: string;
  title_key: string;
  publication_year: string | null;
  publisher_key: string | null;
}

/** What the input is compared with, its keys computed once. */
interface Probe {
  titleKey: string;
  year: string | null;
  agentKey: string | null;
  publisherKey: string | null;
}

/** The score of `row` (whose main agents' name keys are `agentKeys`) against `probe`, with the reasons that added to it. */
export function duplicateScore(probe: Probe, row: CandidateRow, agentKeys: readonly string[]): { score: number; reasons: DuplicateReason[] } {
  const reasons: DuplicateReason[] = [];
  const dice = diceCoefficient(probe.titleKey, row.title_key);
  let score = 60 * dice;
  if (dice > 0) reasons.push('title');
  if (probe.year !== null && row.publication_year === probe.year) {
    score += 15;
    reasons.push('year');
  }
  if (probe.agentKey !== null && agentKeys.includes(probe.agentKey)) {
    score += 15;
    reasons.push('agent');
  }
  if (probe.publisherKey !== null && row.publisher_key === probe.publisherKey) {
    score += 10;
    reasons.push('publisher');
  }
  return { score: Math.min(100, Math.round(score)), reasons };
}

/** The live records holding an ISBN or ISSN of the input with a matching qualifier (rule 1). */
async function identifierMatches(db: Kysely<DB>, input: DuplicateCheckBody): Promise<Map<string, { title: string; year: string | null }>> {
  const wanted = new Map<string, { type: 'isbn' | 'issn'; key: string; qualifiers: Set<string> }>();
  for (const i of input.identifiers ?? []) {
    if (i.type !== 'isbn' && i.type !== 'issn') continue;
    const { key } = identifierKey(i.type, i.value);
    if (key === '') continue;
    const entry = wanted.get(`${i.type}:${key}`) ?? { type: i.type, key, qualifiers: new Set<string>() };
    entry.qualifiers.add(normalizeKey(i.qualifier ?? ''));
    wanted.set(`${i.type}:${key}`, entry);
  }
  const found = new Map<string, { title: string; year: string | null }>();
  for (const { type, key, qualifiers } of wanted.values()) {
    let q = db
      .selectFrom('record_identifiers as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .select(['r.id', 'r.title', 'r.publication_year', 'i.qualifier'])
      .where('i.type', '=', type)
      .where('i.value_key', '=', key)
      .where('r.archived_at', 'is', null)
      .where('r.merged_into', 'is', null);
    if (input.excludeId !== undefined) q = q.where('r.id', '!=', input.excludeId);
    for (const r of await q.execute()) {
      const stored = normalizeKey(r.qualifier ?? '');
      if (stored === '' || qualifiers.has('') || qualifiers.has(stored)) found.set(r.id, { title: r.title, year: r.publication_year });
    }
  }
  return found;
}

/**
 * The likely duplicates of `input` (see the top of this file): at most 5 with a score ≥ `threshold`, best first.
 */
export async function checkDuplicates(db: Kysely<DB>, input: DuplicateCheckBody, threshold: number): Promise<DuplicateCandidate[]> {
  const out = new Map<string, DuplicateCandidate>();
  for (const [recordId, r] of await identifierMatches(db, input)) {
    out.set(recordId, { recordId, title: r.title, year: r.year, score: 100, reasons: ['isbn'] });
  }

  const text = input.subtitle === undefined || input.subtitle.trim() === '' ? input.title : `${input.title} ${input.subtitle}`;
  const ids = (await titleCandidates(db, text, TITLE_CANDIDATES)).filter((id) => !out.has(id) && id !== input.excludeId);
  if (ids.length > 0) {
    const probe: Probe = {
      titleKey: titleKey(input.title, input.subtitle),
      year: input.year ?? null,
      agentKey: input.mainAgentName === undefined || input.mainAgentName.trim() === '' ? null : agentNameKey(input.mainAgentName),
      publisherKey: input.publisherName === undefined || input.publisherName.trim() === '' ? null : publisherNameKey(input.publisherName),
    };
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const batch = ids.slice(i, i + ID_BATCH);
      const rows = await db
        .selectFrom('records as r')
        .leftJoin('publishers as p', 'p.id', 'r.publisher_id')
        .select(['r.id', 'r.title', 'r.title_key', 'r.publication_year', 'p.name_key as publisher_key'])
        .where('r.id', 'in', batch)
        .where('r.archived_at', 'is', null)
        .where('r.merged_into', 'is', null)
        .execute();
      // The main agents' names, keyed as an input name is (without their dates): `agents.name_key` holds the dates too.
      const mains = await db
        .selectFrom('record_agents as ra')
        .innerJoin('agents as a', 'a.id', 'ra.agent_id')
        .select(['ra.record_id', 'a.name_display'])
        .where('ra.record_id', 'in', batch)
        .where('ra.is_main', '=', 1)
        .execute();
      const agentKeys = new Map<string, string[]>();
      for (const m of mains) agentKeys.set(m.record_id, [...(agentKeys.get(m.record_id) ?? []), agentNameKey(m.name_display)]);
      for (const row of rows) {
        const { score, reasons } = duplicateScore(probe, row, agentKeys.get(row.id) ?? []);
        out.set(row.id, { recordId: row.id, title: row.title, year: row.publication_year, score, reasons });
      }
    }
  }

  return [...out.values()]
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}
