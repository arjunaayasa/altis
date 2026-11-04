import type { DB } from '@altis/db';
import type { AgentType, SubjectType } from '@altis/shared';
import type { OrphansArchiveResponse, OrphansResponse } from '@altis/shared/api/catalog/authorities';
import type { ExpressionBuilder, Kysely } from 'kysely';
import type { TxCtx } from '../../context.js';
import { ID_BATCH, cursorId, keyCursor, lockAuthorityRows, validationFailed, type AuthorityTable, type Db } from './common.js';
import { authorityUsage } from './usage.js';

// Orphan authorities (`GET catalog/orphans?kind=`, `POST catalog/orphans/archive`; Phase 2 spec §3.5, plan Task 13).
//
// - An orphan is a live authority (not archived) that no live record links to (usage 0, usage.ts). A subject that
//   stands in the thesaurus (a relation at either end) is no orphan: an entry term (`use`) has no records of its own
//   but is part of the vocabulary.
// - Listed in key order with the keyset cursor of the authority lists; each as `{id, label, type}` (`type` null for
//   publishers).
// - The bulk archive (≤ 500 ids, the contract's cap) archives the ids that are orphans when it runs and skips the
//   others (linked ones, archived ones, unknown ids); one audit entry `catalog.authority.archive` for the whole call,
//   entity = the kind, `meta {kind, count}` (count = archived), whatever the outcome.

/** No live record links to the agent `a`. */
function agentUnused(eb: ExpressionBuilder<DB, 'agents'>) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('record_agents as l')
        .innerJoin('records as r', 'r.id', 'l.record_id')
        .select('l.record_id')
        .whereRef('l.agent_id', '=', 'agents.id')
        .where('r.archived_at', 'is', null),
    ),
  );
}

/** No live record links to the subject, and no thesaurus row names it. */
function subjectUnused(eb: ExpressionBuilder<DB, 'subjects'>) {
  return eb.and([
    eb.not(
      eb.exists(
        eb
          .selectFrom('record_subjects as l')
          .innerJoin('records as r', 'r.id', 'l.record_id')
          .select('l.record_id')
          .whereRef('l.subject_id', '=', 'subjects.id')
          .where('r.archived_at', 'is', null),
      ),
    ),
    eb.not(eb.exists(eb.selectFrom('subject_relations as o').select('o.subject_id').whereRef('o.subject_id', '=', 'subjects.id'))),
    eb.not(eb.exists(eb.selectFrom('subject_relations as i').select('i.subject_id').whereRef('i.related_id', '=', 'subjects.id'))),
  ]);
}

/** No live record names the publisher. */
function publisherUnused(eb: ExpressionBuilder<DB, 'publishers'>) {
  return eb.not(
    eb.exists(eb.selectFrom('records as r').select('r.id').whereRef('r.publisher_id', '=', 'publishers.id').where('r.archived_at', 'is', null)),
  );
}

/** The row a cursor names: its key, or VALIDATION_FAILED at `cursor`. */
async function cursorKey(db: Db, kind: AuthorityTable, cursor: string): Promise<{ id: string; key: string }> {
  const id = cursorId(cursor);
  const row =
    kind === 'subjects'
      ? await db.selectFrom('subjects').select('term_key as key').where('id', '=', id).executeTakeFirst()
      : await db
          .selectFrom(kind as 'agents')
          .select('name_key as key')
          .where('id', '=', id)
          .executeTakeFirst();
  if (row === undefined) throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
  return { id, key: row.key };
}

/**
 * A page of the orphans of `kind` (see the top of this file), `limit` of them (1-200, the contract's range).
 *
 * @throws DomainError VALIDATION_FAILED at `cursor` (`invalid`)
 */
export async function listOrphans(db: Kysely<DB>, kind: AuthorityTable, cursor: string | undefined, limit: number): Promise<OrphansResponse> {
  const after = cursor === undefined ? null : await cursorKey(db, kind, cursor);
  let rows: { id: string; label: string; type: string | null }[];
  if (kind === 'agents') {
    let q = db.selectFrom('agents').select(['id', 'name_display as label', 'type']).where('archived_at', 'is', null).where(agentUnused);
    if (after !== null) q = q.where((eb) => eb.or([eb('name_key', '>', after.key), eb.and([eb('name_key', '=', after.key), eb('id', '>', after.id)])]));
    rows = await q.orderBy('name_key').orderBy('id').limit(limit + 1).execute();
  } else if (kind === 'subjects') {
    let q = db.selectFrom('subjects').select(['id', 'term_display as label', 'type']).where('archived_at', 'is', null).where(subjectUnused);
    if (after !== null) q = q.where((eb) => eb.or([eb('term_key', '>', after.key), eb.and([eb('term_key', '=', after.key), eb('id', '>', after.id)])]));
    rows = await q.orderBy('term_key').orderBy('id').limit(limit + 1).execute();
  } else {
    let q = db.selectFrom('publishers').select(['id', 'name_display as label']).where('archived_at', 'is', null).where(publisherUnused);
    if (after !== null) q = q.where((eb) => eb.or([eb('name_key', '>', after.key), eb.and([eb('name_key', '=', after.key), eb('id', '>', after.id)])]));
    rows = (await q.orderBy('name_key').orderBy('id').limit(limit + 1).execute()).map((r) => ({ ...r, type: null }));
  }
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ id: r.id, label: r.label, type: r.type as AgentType | SubjectType | null })),
    nextCursor: rows.length > limit && last !== undefined ? keyCursor(last.id) : null,
  };
}

/** The ids of `ids` that are thesaurus subjects (a row at either end). */
async function inThesaurus(db: Db, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    for (const r of await db.selectFrom('subject_relations').select('subject_id as id').where('subject_id', 'in', batch).execute()) found.add(r.id);
    for (const r of await db.selectFrom('subject_relations').select('related_id as id').where('related_id', 'in', batch).execute()) found.add(r.id);
  }
  return found;
}

/**
 * Archives those of `ids` that are orphans of `kind` now (see the top of this file), in `tx`, and audits the call
 * once. Answers how many were archived and how many skipped (each distinct id counts once).
 */
export async function archiveOrphans(tx: TxCtx, kind: AuthorityTable, ids: readonly string[]): Promise<OrphansArchiveResponse> {
  const { trx } = tx;
  const unique = [...new Set(ids)].sort();
  await lockAuthorityRows(trx, kind, unique);
  const live: string[] = [];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await trx
      .selectFrom(kind as 'agents')
      .select('id')
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .where('archived_at', 'is', null)
      .execute();
    live.push(...rows.map((r) => r.id));
  }
  const usage = await authorityUsage(trx, kind, live);
  const thesaurus = kind === 'subjects' ? await inThesaurus(trx, live) : new Set<string>();
  const orphans = live.filter((id) => (usage.get(id) ?? 0) === 0 && !thesaurus.has(id));
  let archived = 0;
  for (let i = 0; i < orphans.length; i += ID_BATCH) {
    const updated = await trx
      .updateTable(kind as 'agents')
      .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', 'in', orphans.slice(i, i + ID_BATCH))
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    archived += Number(updated.numUpdatedRows);
  }
  await tx.audit({ action: 'catalog.authority.archive', entity: kind, entityId: null, meta: { kind, count: archived } });
  return { archived, skipped: unique.length - archived };
}
