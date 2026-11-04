import type { DB } from '@altis/db';
import { THESAURUS_RECIPROCAL, THESAURUS_RELS, type SubjectType, type ThesaurusRel } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { SubjectRelationsBody, type SubjectView } from '@altis/shared/api/catalog/authorities';
import type { Selectable, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { resolveSubjects } from '../data/authorities.js';
import { ID_BATCH, authorityNotFound, authorityStale, lockAuthorityRows, mergedAuthority, parseOrFail, validationFailed, type Db } from './common.js';
import { authorityUsage } from './usage.js';

// The subject thesaurus (Phase 2 spec §3.5; plan Task 13): `subject_relations` holds one row per direction, and every
// row has its reciprocal (`use↔uf`, `bt↔nt`, `rt↔rt`, `sa↔sa`, THESAURUS_RECIPROCAL), written or removed in the same
// transaction as the row itself.
//
// - setSubjectRelations replaces a subject's outgoing rows (`subject_id` = it), the reciprocals that others' edits
//   wrote included: what the editor shows is what it sends back. The rows added and removed are diffed against the
//   stored ones, and each one's reciprocal follows.
// - A relation to the subject itself is `{path: 'relations.<i>.subjectId', code: 'self'}`, an unknown subject
//   `not_found`. A subject that was merged stands for its target (one hop: merges flatten their chains), so a relation
//   to a subject merged into this one is `self` too. A new relation to an archived subject that was not merged brings
//   it back, as Task 1's resolveSubjects does for a record that names it; a relation already stored is kept as it is,
//   so sending the list back never undoes an archive made since.
// - Concurrency: a subject's rows change only while its row is locked. The edit locks the subject first, then every
//   subject at the other end of a row it adds or removes, bumping their `version` (an editor holding the old one
//   reloads instead of writing back a list without the new reciprocal). Two edits that meet the other way round
//   deadlock, and the engine aborts one, which its transaction runner retries.
// - BT/NT cycles are allowed and reported in `SubjectView.cycles`: each simple cycle along the broader-term edges (a
//   `bt` row, or an `nt` row read the other way) that starts and ends at the subject. The search is bounded (a
//   subgraph of CYCLE_NODES_MAX subjects, paths of CYCLE_DEPTH_MAX, CYCLES_MAX cycles), so a pathological thesaurus
//   shows its first cycles, never a timeout.

type SubjectRow = Selectable<DB['subjects']>;

/** The most subjects of the broader-term graph read to look for cycles. */
const CYCLE_NODES_MAX = 2000;
/** The longest cycle looked for (subjects along it). */
const CYCLE_DEPTH_MAX = 16;
/** The most cycles reported for one subject. */
const CYCLES_MAX = 20;
/** The most steps of one subject's cycle search. */
const CYCLE_STEPS_MAX = 5000;

/**
 * The subject `id` (any state).
 *
 * @throws DomainError NOT_FOUND
 */
export async function readSubjectRow(db: Db, id: string): Promise<SubjectRow> {
  const row = await db.selectFrom('subjects').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw authorityNotFound('subjects');
  return row;
}

/** The outgoing relations of each of `ids`, with the related subject's term and type, in vocabulary then term order. */
async function relationsOf(db: Db, ids: readonly string[]): Promise<Map<string, SubjectView['relations']>> {
  const out = new Map<string, (SubjectView['relations'][number] & { key: string })[]>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom('subject_relations as sr')
      .innerJoin('subjects as s', 's.id', 'sr.related_id')
      .select(['sr.subject_id', 'sr.related_id', 'sr.rel', 's.term_display', 's.term_key', 's.type'])
      .where('sr.subject_id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) {
      const list = out.get(r.subject_id) ?? [];
      list.push({ rel: r.rel as ThesaurusRel, subjectId: r.related_id, term: r.term_display, type: r.type as SubjectType, key: r.term_key });
      out.set(r.subject_id, list);
    }
  }
  const order = (rel: string) => (THESAURUS_RELS as readonly string[]).indexOf(rel);
  const result = new Map<string, SubjectView['relations']>();
  for (const [id, list] of out) {
    list.sort((a, b) => order(a.rel) - order(b.rel) || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.subjectId < b.subjectId ? -1 : 1));
    result.set(
      id,
      list.map(({ rel, subjectId, term, type }) => ({ rel, subjectId, term, type })),
    );
  }
  return result;
}

/**
 * The broader-term edges reachable from `starts` (subject → its broader subjects, sorted), read breadth first up to
 * CYCLE_NODES_MAX subjects and CYCLE_DEPTH_MAX steps away (a longer path cannot close a cycle that is looked for).
 */
async function broaderGraph(db: Db, starts: readonly string[]): Promise<Map<string, string[]>> {
  const graph = new Map<string, Set<string>>();
  let frontier = [...new Set(starts)];
  const seen = new Set(frontier);
  for (let depth = 0; frontier.length > 0 && depth < CYCLE_DEPTH_MAX; depth += 1) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += ID_BATCH) {
      const batch = frontier.slice(i, i + ID_BATCH);
      const bt = await db.selectFrom('subject_relations').select(['subject_id', 'related_id']).where('rel', '=', 'bt').where('subject_id', 'in', batch).execute();
      // `X nt Y` says that X is broader than Y: the edge Y → X.
      const nt = await db.selectFrom('subject_relations').select(['subject_id', 'related_id']).where('rel', '=', 'nt').where('related_id', 'in', batch).execute();
      const edges = [...bt.map((r) => [r.subject_id, r.related_id] as const), ...nt.map((r) => [r.related_id, r.subject_id] as const)];
      for (const [from, to] of edges) {
        const set = graph.get(from) ?? new Set<string>();
        set.add(to);
        graph.set(from, set);
        if (!seen.has(to) && seen.size < CYCLE_NODES_MAX) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return new Map([...graph].map(([from, to]) => [from, [...to].sort()]));
}

/** The simple cycles through `start` along `graph` (bounded, see the top of this file). */
function cyclesThrough(graph: ReadonlyMap<string, readonly string[]>, start: string): string[][] {
  const cycles: string[][] = [];
  const path = [start];
  const onPath = new Set(path);
  let steps = 0;
  const walk = (node: string): void => {
    for (const next of graph.get(node) ?? []) {
      if (cycles.length >= CYCLES_MAX || steps >= CYCLE_STEPS_MAX) return;
      steps += 1;
      if (next === start) {
        cycles.push([...path, start]);
        continue;
      }
      if (onPath.has(next) || path.length >= CYCLE_DEPTH_MAX) continue;
      path.push(next);
      onPath.add(next);
      walk(next);
      path.pop();
      onPath.delete(next);
    }
  };
  walk(start);
  return cycles;
}

/** The views of `rows` (usage, outgoing relations, BT/NT cycles), in their order. */
export async function subjectViews(db: Db, rows: readonly SubjectRow[]): Promise<SubjectView[]> {
  const ids = rows.map((r) => r.id);
  const usage = await authorityUsage(db, 'subjects', ids);
  const relations = await relationsOf(db, ids);
  const graph = await broaderGraph(db, ids);
  return rows.map((r) => ({
    id: r.id,
    type: r.type as SubjectType,
    term: r.term_display,
    classification: r.classification,
    scopeNote: r.scope_note,
    authoritySource: r.authority_source,
    relations: relations.get(r.id) ?? [],
    cycles: cyclesThrough(graph, r.id),
    usage: usage.get(r.id) ?? 0,
    mergedInto: r.merged_into,
    archived: r.archived_at !== null,
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));
}

/**
 * The subject `id` in any state, with its relations and cycles.
 *
 * @throws DomainError NOT_FOUND
 */
export async function getSubject(db: Db, id: string): Promise<SubjectView> {
  const [view] = await subjectViews(db, [await readSubjectRow(db, id)]);
  return view as SubjectView;
}

interface RelationRow {
  subject_id: string;
  related_id: string;
  rel: string;
}

const rowKey = (r: RelationRow): string => `${r.subject_id}|${r.related_id}|${r.rel}`;

/** Bumps the version of `ids` (other subjects whose rows an edit changes), locking them in index order. */
async function touchSubjects(tx: TxCtx, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    await tx.trx
      .updateTable('subjects')
      .set((eb) => ({ updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
  }
}

/** Deletes `rows` (grouped by subject and relation, the related ids in batches). */
async function deleteRows(trx: Transaction<DB>, rows: readonly RelationRow[]): Promise<void> {
  const groups = new Map<string, { subject: string; rel: string; related: string[] }>();
  for (const r of rows) {
    const key = `${r.subject_id}|${r.rel}`;
    const g = groups.get(key) ?? { subject: r.subject_id, rel: r.rel, related: [] };
    g.related.push(r.related_id);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.related.length; i += ID_BATCH) {
      await trx
        .deleteFrom('subject_relations')
        .where('subject_id', '=', g.subject)
        .where('rel', '=', g.rel)
        .where('related_id', 'in', g.related.slice(i, i + ID_BATCH))
        .execute();
    }
  }
}

async function insertRows(trx: Transaction<DB>, rows: readonly RelationRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ID_BATCH) await trx.insertInto('subject_relations').values(rows.slice(i, i + ID_BATCH)).execute();
}

/** The stored rows that name `id` at either end. */
async function rowsAround(db: Db, id: string): Promise<{ outgoing: RelationRow[]; incoming: RelationRow[] }> {
  const outgoing = await db.selectFrom('subject_relations').select(['subject_id', 'related_id', 'rel']).where('subject_id', '=', id).execute();
  const incoming = await db.selectFrom('subject_relations').select(['subject_id', 'related_id', 'rel']).where('related_id', '=', id).execute();
  return { outgoing, incoming };
}

/**
 * Replaces the outgoing relations of the subject `id` with `rels` and writes or removes the reciprocal of each one
 * added or removed, in `tx` (see the top of this file). Bumps the subject's version, audits `catalog.authority.update`
 * once (`meta {fields: ['relations'], added, removed}`) and answers the subject's view.
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged subject; CONFLICT_STALE; VALIDATION_FAILED with
 *   `relations.<i>.subjectId` `self` or `not_found` (nothing written)
 */
export async function setSubjectRelations(
  tx: TxCtx,
  id: string,
  rels: readonly { rel: ThesaurusRel; subjectId: string }[],
  version: number,
): Promise<SubjectView> {
  const { trx } = tx;
  const body = parseOrFail(SubjectRelationsBody, { relations: rels, version });
  await lockAuthorityRows(trx, 'subjects', [id]);
  const subject = await readSubjectRow(trx, id);
  if (subject.merged_into !== null) throw mergedAuthority();
  if (Number(subject.version) !== body.version) throw authorityStale();

  // Check every relation before anything is written.
  const others = [...new Set(body.relations.map((r) => r.subjectId).filter((s) => s !== id))];
  const found = new Map<string, string | null>();
  for (let i = 0; i < others.length; i += ID_BATCH) {
    const rows = await trx.selectFrom('subjects').select(['id', 'merged_into']).where('id', 'in', others.slice(i, i + ID_BATCH)).execute();
    for (const r of rows) found.set(r.id, r.merged_into);
  }
  const errors: FieldWarning[] = [];
  body.relations.forEach((r, i) => {
    const path = `relations.${i}.subjectId`;
    if (r.subjectId === id || found.get(r.subjectId) === id) errors.push({ path, code: 'self' });
    else if (!found.has(r.subjectId)) errors.push({ path, code: 'not_found' });
  });
  if (errors.length > 0) throw validationFailed(errors);

  const { outgoing, incoming } = await rowsAround(trx, id);
  const stored = new Set(outgoing.map(rowKey));
  const storedIncoming = new Set(incoming.map(rowKey));

  // A relation already stored stays as it is: the editor sends the whole list back, and saving it again must not
  // bring back a subject archived since (that would undo the archive without an audit entry of its own). Each new
  // relation is resolved as a record's subject is (resolveSubjects): a merged subject stands for its target, an
  // archived one comes back.
  const asStored = (r: { rel: string; subjectId: string }): RelationRow => ({ subject_id: id, related_id: r.subjectId, rel: r.rel });
  const kept = (r: { rel: string; subjectId: string }): boolean => stored.has(rowKey(asStored(r))) && found.get(r.subjectId) === null;
  const fresh = [...new Set(body.relations.filter((r) => !kept(r)).map((r) => r.subjectId))];
  const resolved = new Map<string, string>();
  if (fresh.length > 0) {
    const { ids } = await resolveSubjects(
      tx,
      fresh.map((s) => ({ id: s })),
    );
    fresh.forEach((s, i) => resolved.set(s, ids[i] as string));
  }
  const wanted = new Map<string, RelationRow>();
  for (const r of body.relations) {
    const row = kept(r) ? asStored(r) : { ...asStored(r), related_id: resolved.get(r.subjectId) as string };
    wanted.set(rowKey(row), row);
  }
  const removed = outgoing.filter((r) => !wanted.has(rowKey(r)));
  const added = [...wanted.values()].filter((r) => !stored.has(rowKey(r)));
  const reciprocal = (r: RelationRow): RelationRow => ({
    subject_id: r.related_id,
    related_id: r.subject_id,
    rel: THESAURUS_RECIPROCAL[r.rel as ThesaurusRel],
  });

  await touchSubjects(
    tx,
    [...removed, ...added].map((r) => r.related_id).filter((s) => s !== id),
  );
  await deleteRows(trx, [...removed, ...removed.map(reciprocal)]);
  // A reciprocal already stored (rows written without one by an older import) is not written twice.
  const addedBack = added.map(reciprocal).filter((r) => !storedIncoming.has(rowKey(r)));
  await insertRows(trx, [...added, ...addedBack]);

  const updated = await trx
    .updateTable('subjects')
    .set((eb) => ({ updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', body.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw authorityStale();
  await tx.audit({
    action: 'catalog.authority.update',
    entity: 'subjects',
    entityId: id,
    meta: { fields: ['relations'], added: added.length, removed: removed.length },
  });
  return getSubject(trx, id);
}

/**
 * Moves the thesaurus rows of `sourceId` to `targetId` in a subject merge (merge.ts): `source → X` becomes
 * `target → X` and `Y → source` becomes `Y → target`, so every row keeps its reciprocal. A row between the two, or one
 * the target already has, is dropped. The subjects at the other ends are touched (version + 1, see the top of this
 * file), and the target too whenever the source had rows. Answers how many rows were moved.
 */
export async function moveSubjectRelations(tx: TxCtx, sourceId: string, targetId: string): Promise<number> {
  const { trx } = tx;
  const source = await rowsAround(trx, sourceId);
  if (source.outgoing.length === 0 && source.incoming.length === 0) return 0;
  const partners = [...source.outgoing.map((r) => r.related_id), ...source.incoming.map((r) => r.subject_id)].filter(
    (s) => s !== sourceId && s !== targetId,
  );
  await touchSubjects(tx, [...partners, targetId]);
  const target = await rowsAround(trx, targetId);
  const held = new Set([...target.outgoing, ...target.incoming].map(rowKey));
  const moved = new Map<string, RelationRow>();
  for (const r of source.outgoing) {
    if (r.related_id === sourceId || r.related_id === targetId) continue;
    const row = { subject_id: targetId, related_id: r.related_id, rel: r.rel };
    if (!held.has(rowKey(row))) moved.set(rowKey(row), row);
  }
  for (const r of source.incoming) {
    if (r.subject_id === sourceId || r.subject_id === targetId) continue;
    const row = { subject_id: r.subject_id, related_id: targetId, rel: r.rel };
    if (!held.has(rowKey(row))) moved.set(rowKey(row), row);
  }
  await trx.deleteFrom('subject_relations').where('subject_id', '=', sourceId).execute();
  await trx.deleteFrom('subject_relations').where('related_id', '=', sourceId).execute();
  await insertRows(trx, [...moved.values()]);
  return moved.size;
}
