import type { DB } from '@altis/db';
import type { Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { ID_BATCH, authorityNotFound, authorityStale, lockAuthorityRows, mergeInvalid, mergedAuthority, type AuthorityTable } from './common.js';
import { moveSubjectRelations } from './thesaurus.js';

// Merging an authority into another (`POST catalog/{agents|subjects|publishers}/:id/merge {intoId, version}`; Phase 2
// spec §3.5, plan Task 13; Review Focus 4, decision P2-20), in the caller's transaction:
//
// - The source's links move to the target: `record_agents` (a record that already names the target in the same role
//   keeps one link, made main when either was), `record_subjects` (one link per record, primary when either was) and
//   `records.publisher_id`. For subjects the thesaurus rows move too, each with its reciprocal (thesaurus.ts).
// - The source is archived with `merged_into = target` (an archived source keeps its `archived_at`), and every
//   authority merged into the source before is re-pointed to the target, so a chain is always one hop: after A→B and
//   B→C, A's `merged_into` is C.
// - Refused with 422 CATALOG_MERGE_INVALID: the same id, a target that is archived or merged, a source that was merged
//   already, agents of different types. NOT_FOUND for an id that names nothing.
// - The records themselves are not written: their changed_at and index are the reindex's (§3.5), which the route
//   queues for the target, `catalog.reindex {agentId|subjectId|publisherId: intoId}`, since every link is the target's
//   now (S12).
// - Audited once, `catalog.authority.merge` on the source (`meta {intoId, movedLinks, droppedLinks, movedRelations,
//   repointed}`: ids and counts only).
// - Concurrency: both rows are locked first, in one statement (the records' lock pattern), so two merges of the same
//   pair serialize and a merge into an authority being merged elsewhere waits for it and then finds its target merged.
//   Call it first in its transaction: on MySQL/MariaDB (REPEATABLE READ) only reads taken after that lock see every
//   merge into the source committed before it.

/** What a merge moved: the record links now the target's, and those dropped because the target had them already. */
interface Moved {
  moved: number;
  dropped: number;
}

/** Moves the agent links of `source` to `target` (see the top of this file). */
async function moveAgentLinks(trx: Transaction<DB>, source: string, target: string): Promise<Moved> {
  const links = await trx.selectFrom('record_agents').select(['record_id', 'role', 'is_main']).where('agent_id', '=', source).execute();
  if (links.length === 0) return { moved: 0, dropped: 0 };
  const records = [...new Set(links.map((l) => l.record_id))];
  const held = new Map<string, number>();
  for (let i = 0; i < records.length; i += ID_BATCH) {
    const rows = await trx
      .selectFrom('record_agents')
      .select(['record_id', 'role', 'is_main'])
      .where('agent_id', '=', target)
      .where('record_id', 'in', records.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) held.set(`${r.record_id}|${r.role}`, Number(r.is_main));
  }
  // Per role: the records whose source link is dropped, and those whose kept target link becomes main.
  const dropped = new Map<string, string[]>();
  const promoted = new Map<string, string[]>();
  for (const l of links) {
    const kept = held.get(`${l.record_id}|${l.role}`);
    if (kept === undefined) continue;
    dropped.set(l.role, [...(dropped.get(l.role) ?? []), l.record_id]);
    if (Number(l.is_main) === 1 && kept === 0) promoted.set(l.role, [...(promoted.get(l.role) ?? []), l.record_id]);
  }
  for (const [role, ids] of dropped) {
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      await trx
        .deleteFrom('record_agents')
        .where('agent_id', '=', source)
        .where('role', '=', role)
        .where('record_id', 'in', ids.slice(i, i + ID_BATCH))
        .execute();
    }
  }
  for (const [role, ids] of promoted) {
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      await trx
        .updateTable('record_agents')
        .set({ is_main: 1 })
        .where('agent_id', '=', target)
        .where('role', '=', role)
        .where('record_id', 'in', ids.slice(i, i + ID_BATCH))
        .execute();
    }
  }
  const moved = await trx.updateTable('record_agents').set({ agent_id: target }).where('agent_id', '=', source).executeTakeFirst();
  const droppedCount = [...dropped.values()].reduce((n, ids) => n + ids.length, 0);
  return { moved: Number(moved.numUpdatedRows), dropped: droppedCount };
}

/** Moves the subject links of `source` to `target` (see the top of this file). */
async function moveSubjectLinks(trx: Transaction<DB>, source: string, target: string): Promise<Moved> {
  const links = await trx.selectFrom('record_subjects').select(['record_id', 'is_primary']).where('subject_id', '=', source).execute();
  if (links.length === 0) return { moved: 0, dropped: 0 };
  const held = new Map<string, number>();
  for (let i = 0; i < links.length; i += ID_BATCH) {
    const rows = await trx
      .selectFrom('record_subjects')
      .select(['record_id', 'is_primary'])
      .where('subject_id', '=', target)
      .where(
        'record_id',
        'in',
        links.slice(i, i + ID_BATCH).map((l) => l.record_id),
      )
      .execute();
    for (const r of rows) held.set(r.record_id, Number(r.is_primary));
  }
  const dropped = links.filter((l) => held.has(l.record_id)).map((l) => l.record_id);
  const promoted = links.filter((l) => Number(l.is_primary) === 1 && held.get(l.record_id) === 0).map((l) => l.record_id);
  for (let i = 0; i < dropped.length; i += ID_BATCH) {
    await trx
      .deleteFrom('record_subjects')
      .where('subject_id', '=', source)
      .where('record_id', 'in', dropped.slice(i, i + ID_BATCH))
      .execute();
  }
  for (let i = 0; i < promoted.length; i += ID_BATCH) {
    await trx
      .updateTable('record_subjects')
      .set({ is_primary: 1 })
      .where('subject_id', '=', target)
      .where('record_id', 'in', promoted.slice(i, i + ID_BATCH))
      .execute();
  }
  const moved = await trx.updateTable('record_subjects').set({ subject_id: target }).where('subject_id', '=', source).executeTakeFirst();
  return { moved: Number(moved.numUpdatedRows), dropped: dropped.length };
}

/** Moves the records of the publisher `source` to `target`. */
async function movePublisherLinks(trx: Transaction<DB>, source: string, target: string): Promise<Moved> {
  const moved = await trx.updateTable('records').set({ publisher_id: target }).where('publisher_id', '=', source).executeTakeFirst();
  return { moved: Number(moved.numUpdatedRows), dropped: 0 };
}

interface MergeRow {
  id: string;
  merged_into: string | null;
  archived_at: number | null;
  version: number;
  type: string | null;
}

/**
 * Merges the authority `sourceId` of `kind` into `intoId` (see the top of this file); `version` is the source's.
 * Answers the record links moved to the target and the source's new version.
 *
 * @throws DomainError NOT_FOUND (either id); CATALOG_MERGE_INVALID (422); CONFLICT_STALE when `version` is not the
 *   source's
 */
export async function mergeAuthority(
  tx: TxCtx,
  kind: AuthorityTable,
  sourceId: string,
  intoId: string,
  version: number,
): Promise<{ movedLinks: number; version: number }> {
  const { trx } = tx;
  if (sourceId === intoId) throw mergeInvalid('Otoritas tidak dapat digabungkan ke dirinya sendiri / An authority cannot be merged into itself');
  await lockAuthorityRows(trx, kind, [sourceId, intoId]);
  // The three tables share these columns (`type` only agents and subjects); Kysely cannot narrow a union of tables.
  const rows = await trx
    .selectFrom(kind as 'agents')
    .select(['id', 'merged_into', 'archived_at', 'version'])
    .where('id', 'in', [sourceId, intoId])
    .execute();
  const types =
    kind === 'agents'
      ? new Map((await trx.selectFrom('agents').select(['id', 'type']).where('id', 'in', [sourceId, intoId]).execute()).map((r) => [r.id, r.type]))
      : new Map<string, string>();
  const byId = new Map<string, MergeRow>(rows.map((r) => [r.id, { ...r, archived_at: r.archived_at, version: Number(r.version), type: types.get(r.id) ?? null }]));
  const source = byId.get(sourceId);
  const target = byId.get(intoId);
  if (source === undefined || target === undefined) throw authorityNotFound(kind);
  if (target.archived_at !== null || target.merged_into !== null) {
    throw mergeInvalid('Otoritas tujuan sudah diarsipkan atau digabungkan / The target authority is archived or merged');
  }
  if (source.merged_into !== null) throw mergedAuthority();
  if (source.type !== target.type) {
    throw mergeInvalid('Nama berjenis lain tidak dapat digabungkan / Names of different types cannot be merged');
  }
  if (source.version !== version) throw authorityStale();

  const links =
    kind === 'agents'
      ? await moveAgentLinks(trx, sourceId, intoId)
      : kind === 'subjects'
        ? await moveSubjectLinks(trx, sourceId, intoId)
        : await movePublisherLinks(trx, sourceId, intoId);
  const movedRelations = kind === 'subjects' ? await moveSubjectRelations(tx, sourceId, intoId) : 0;

  const updated = await trx
    .updateTable(kind as 'agents')
    .set((eb) => ({
      archived_at: source.archived_at ?? tx.now,
      merged_into: intoId,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', sourceId)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw authorityStale();
  // Flatten the chain (P2-20): what was merged into the source now points at the target. Read after the locks, by
  // primary key (there is no index on merged_into, and an UPDATE scanning the table would lock every row on InnoDB).
  const earlier = (
    await trx
      .selectFrom(kind as 'agents')
      .select('id')
      .where('merged_into', '=', sourceId)
      .execute()
  ).map((r) => r.id);
  for (let i = 0; i < earlier.length; i += ID_BATCH) {
    await trx
      .updateTable(kind as 'agents')
      .set({ merged_into: intoId, updated_at: tx.now, updated_by: tx.actor.id })
      .where('id', 'in', earlier.slice(i, i + ID_BATCH))
      .where('merged_into', '=', sourceId)
      .execute();
  }
  await tx.audit({
    action: 'catalog.authority.merge',
    entity: kind,
    entityId: sourceId,
    meta: { intoId, movedLinks: links.moved, droppedLinks: links.dropped, movedRelations, repointed: earlier.length },
  });
  return { movedLinks: links.moved, version: version + 1 };
}
