import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { moveHoldsOnMerge } from '../../circulation/holds.js';
import { afterRecordWrite, lockRecordRows, readRecordRow, recordNotFound, recordStale } from './service.js';

// Merging a duplicate record into another (Phase 2 spec §3.3; Review Focus 4, decision P2-20), in one transaction:
//
// - The source's items, attachments (after the target's, in their order), identifiers (an `(type, value_key)` the
//   target already has is dropped), agent and subject links (the union: a link the target has is kept as it is; a
//   moved agent is not main when the target already has a main one) and relations in both directions (a relation
//   between the two records is dropped, one the target already has too) move to the target.
// - The source is archived with `merged_into = target` (an archived source keeps its `archived_at`), and every record
//   merged into the source before is re-pointed to the target, so that a merge chain is always one hop: after A→B and
//   B→C, A's `merged_into` is C. The OPAC answers `/katalog/A` with a single 301 to C, and a harvester never meets an
//   archived record or a loop.
// - Both records are indexed, the merge is audited once (`catalog.record.merge`, `meta`: the source id and counts)
//   and `catalog.record.changed` is published for the source and the target.
// - Refused with 422 CATALOG_MERGE_INVALID: the same record, a target that is archived or merged, a source that was
//   merged already. Concurrency: both rows are locked first (service.ts lockRecordRows); a merge into a record being
//   merged elsewhere waits for that merge and then finds its target merged.
// - Not moved: the source's cover, MARC extra fields and custom values; they stay on the archived source.

const ID_BATCH = 500;

function invalid(detail: string): DomainError {
  return new DomainError('CATALOG_MERGE_INVALID', { detail });
}

/** The highest `sort_order` of `recordId`'s rows in `table`, or -1. */
async function topSortOrder(
  trx: Transaction<DB>,
  table: 'attachments' | 'record_identifiers' | 'record_agents' | 'record_subjects',
  recordId: string,
): Promise<number> {
  const row = await trx
    .selectFrom(table as 'attachments')
    .select((eb) => eb.fn.max('sort_order').as('top'))
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  const top = row?.top;
  return top === null || top === undefined ? -1 : Number(top);
}

/** Moves the source's identifiers; the duplicates of the target's are deleted. How many moved. */
async function moveIdentifiers(trx: Transaction<DB>, target: string, source: string): Promise<number> {
  const held = new Set(
    (await trx.selectFrom('record_identifiers').select(['type', 'value_key']).where('record_id', '=', target).execute()).map((r) => `${r.type}:${r.value_key}`),
  );
  const rows = await trx.selectFrom('record_identifiers').select(['id', 'type', 'value_key']).where('record_id', '=', source).execute();
  const dropped = rows.filter((r) => held.has(`${r.type}:${r.value_key}`)).map((r) => r.id);
  const moved = rows.filter((r) => !held.has(`${r.type}:${r.value_key}`)).map((r) => r.id);
  for (let i = 0; i < dropped.length; i += ID_BATCH) {
    await trx.deleteFrom('record_identifiers').where('id', 'in', dropped.slice(i, i + ID_BATCH)).execute();
  }
  if (moved.length > 0) {
    const offset = (await topSortOrder(trx, 'record_identifiers', target)) + 1;
    for (let i = 0; i < moved.length; i += ID_BATCH) {
      await trx
        .updateTable('record_identifiers')
        .set((eb) => ({ record_id: target, sort_order: eb('sort_order', '+', offset) }))
        .where('id', 'in', moved.slice(i, i + ID_BATCH))
        .execute();
    }
  }
  return moved.length;
}

/** Joins the source's agent links into the target's, then removes the source's. How many were added. */
async function moveAgentLinks(trx: Transaction<DB>, target: string, source: string): Promise<number> {
  const held = await trx.selectFrom('record_agents').select(['agent_id', 'role', 'is_main']).where('record_id', '=', target).execute();
  const keys = new Set(held.map((r) => `${r.agent_id}:${r.role}`));
  let hasMain = held.some((r) => Number(r.is_main) === 1);
  let next = (await topSortOrder(trx, 'record_agents', target)) + 1;
  const rows = await trx.selectFrom('record_agents').selectAll().where('record_id', '=', source).orderBy('sort_order').execute();
  const added = [];
  for (const r of rows) {
    if (keys.has(`${r.agent_id}:${r.role}`)) continue;
    keys.add(`${r.agent_id}:${r.role}`);
    const main = Number(r.is_main) === 1 && !hasMain ? 1 : 0;
    hasMain ||= main === 1;
    added.push({ record_id: target, agent_id: r.agent_id, role: r.role, is_main: main, sort_order: next++ });
  }
  await trx.deleteFrom('record_agents').where('record_id', '=', source).execute();
  for (let i = 0; i < added.length; i += ID_BATCH) await trx.insertInto('record_agents').values(added.slice(i, i + ID_BATCH)).execute();
  return added.length;
}

/** Joins the source's subject links into the target's, then removes the source's. How many were added. */
async function moveSubjectLinks(trx: Transaction<DB>, target: string, source: string): Promise<number> {
  const held = new Set((await trx.selectFrom('record_subjects').select('subject_id').where('record_id', '=', target).execute()).map((r) => r.subject_id));
  let next = (await topSortOrder(trx, 'record_subjects', target)) + 1;
  const rows = await trx.selectFrom('record_subjects').selectAll().where('record_id', '=', source).orderBy('sort_order').execute();
  const added = [];
  for (const r of rows) {
    if (held.has(r.subject_id)) continue;
    held.add(r.subject_id);
    added.push({ record_id: target, subject_id: r.subject_id, is_primary: Number(r.is_primary), sort_order: next++ });
  }
  await trx.deleteFrom('record_subjects').where('record_id', '=', source).execute();
  for (let i = 0; i < added.length; i += ID_BATCH) await trx.insertInto('record_subjects').values(added.slice(i, i + ID_BATCH)).execute();
  return added.length;
}

/**
 * Moves the relations stored on the source (source → X becomes target → X) and those naming it (Y → source becomes
 * Y → target); a relation between the two, or one the target already has, is dropped. How many were moved.
 */
async function moveRelations(trx: Transaction<DB>, target: string, source: string): Promise<number> {
  const outHeld = new Set(
    (await trx.selectFrom('record_relations').select(['related_id', 'type']).where('record_id', '=', target).execute()).map((r) => `${r.related_id}:${r.type}`),
  );
  const inHeld = new Set(
    (await trx.selectFrom('record_relations').select(['record_id', 'type']).where('related_id', '=', target).execute()).map((r) => `${r.record_id}:${r.type}`),
  );
  const outgoing = await trx.selectFrom('record_relations').select(['related_id', 'type']).where('record_id', '=', source).execute();
  const incoming = await trx.selectFrom('record_relations').select(['record_id', 'type']).where('related_id', '=', source).execute();
  const added: { record_id: string; related_id: string; type: string }[] = [];
  for (const r of outgoing) {
    const key = `${r.related_id}:${r.type}`;
    if (r.related_id === target || r.related_id === source || outHeld.has(key)) continue;
    outHeld.add(key);
    added.push({ record_id: target, related_id: r.related_id, type: r.type });
  }
  for (const r of incoming) {
    const key = `${r.record_id}:${r.type}`;
    if (r.record_id === target || r.record_id === source || inHeld.has(key)) continue;
    inHeld.add(key);
    added.push({ record_id: r.record_id, related_id: target, type: r.type });
  }
  await trx.deleteFrom('record_relations').where('record_id', '=', source).execute();
  await trx.deleteFrom('record_relations').where('related_id', '=', source).execute();
  for (let i = 0; i < added.length; i += ID_BATCH) await trx.insertInto('record_relations').values(added.slice(i, i + ID_BATCH)).execute();
  return added.length;
}

/**
 * Merges `sourceId` into `targetId` (see the top of this file); `version` is the target's. Answers the target's new
 * version. Call it first in its transaction (as the route does): its first statement locks both rows, and on
 * MySQL/MariaDB (REPEATABLE READ) only reads taken after that lock see every merge into the source committed before.
 *
 * @throws DomainError NOT_FOUND (either record); CATALOG_MERGE_INVALID (422; the same record, an archived or merged
 *   target, a merged source); CONFLICT_STALE when `version` is not the target's
 */
export async function mergeRecord(tx: TxCtx, targetId: string, sourceId: string, version: number): Promise<{ version: number }> {
  const { trx } = tx;
  if (targetId === sourceId) throw invalid('Cantuman tidak dapat digabungkan ke dirinya sendiri / A record cannot be merged into itself');
  await lockRecordRows(trx, [targetId, sourceId]);
  const target = await readRecordRow(trx, targetId);
  const source = await trx.selectFrom('records').selectAll().where('id', '=', sourceId).executeTakeFirst();
  if (source === undefined) throw recordNotFound();
  if (target.archived_at !== null || target.merged_into !== null) {
    throw invalid('Cantuman tujuan sudah diarsipkan atau digabungkan / The target record is archived or merged');
  }
  if (source.merged_into !== null) throw invalid('Cantuman sumber sudah digabungkan / The source record was merged already');
  if (Number(target.version) !== version) throw recordStale();

  const items = await trx
    .updateTable('items')
    .set((eb) => ({ record_id: targetId, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('record_id', '=', sourceId)
    .executeTakeFirst();
  const attachmentOffset = (await topSortOrder(trx, 'attachments', targetId)) + 1;
  const attachments = await trx
    .updateTable('attachments')
    .set((eb) => ({
      record_id: targetId,
      sort_order: eb('sort_order', '+', attachmentOffset),
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('record_id', '=', sourceId)
    .executeTakeFirst();
  const moved = {
    items: Number(items.numUpdatedRows),
    attachments: Number(attachments.numUpdatedRows),
    identifiers: await moveIdentifiers(trx, targetId, sourceId),
    agents: await moveAgentLinks(trx, targetId, sourceId),
    subjects: await moveSubjectLinks(trx, targetId, sourceId),
    relations: await moveRelations(trx, targetId, sourceId),
  };
  // Circulation: the source's holds (one active hold per member per title kept) and loans follow its items.
  await moveHoldsOnMerge(tx, targetId, sourceId);

  await trx
    .updateTable('records')
    .set((eb) => ({
      archived_at: source.archived_at ?? tx.now,
      merged_into: targetId,
      changed_at: tx.now,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', sourceId)
    .execute();
  // Flatten the chain (P2-20): what was merged into the source now points at the target. Read after the locks, so
  // a merge into the source that committed before them is seen; none can commit after them (it would lock the source
  // as its target, and then find it merged).
  const earlier = (await trx.selectFrom('records').select('id').where('merged_into', '=', sourceId).execute()).map((r) => r.id);
  for (let i = 0; i < earlier.length; i += ID_BATCH) {
    await trx
      .updateTable('records')
      .set({ merged_into: targetId, updated_at: tx.now, updated_by: tx.actor.id })
      .where('id', 'in', earlier.slice(i, i + ID_BATCH))
      .where('merged_into', '=', sourceId)
      .execute();
  }
  const updated = await trx
    .updateTable('records')
    .set((eb) => ({ changed_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', targetId)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw recordStale();

  await afterRecordWrite(tx, [sourceId, targetId], {
    action: 'catalog.record.merge',
    entity: 'records',
    entityId: targetId,
    meta: { sourceId, moved, repointed: earlier.length },
  });
  return { version: version + 1 };
}
