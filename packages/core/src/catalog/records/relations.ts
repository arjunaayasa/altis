import type { DB } from '@altis/db';
import type { RelationType } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import type { Kysely, Transaction } from 'kysely';

// A record's relations to other records (Phase 2 spec §2.2 `record_relations`, §3.1): stored one way, on the record
// that names them (the OPAC and the data loader show both directions). No foreign key on `related_id` (§2.1).
//
// - The related record must exist: `{path: 'relations.<i>.relatedId', code: 'not_found'}` otherwise. A record that
//   was merged stands for the record it was merged into (one hop: merges flatten their chains, P2-20).
// - A relation to the record itself (also through a merge) → `{path: 'relations.<i>.relatedId', code: 'self'}`.
// - The same `(related, type)` twice is one relation (the table's key): the first is kept.

const ID_BATCH = 500;

type Db = Kysely<DB> | Transaction<DB>;

export interface RelationRow {
  related_id: string;
  type: RelationType;
}

/**
 * The rows of `inputs` for the record `recordId` (null for a record not created yet), or their field errors.
 */
export async function relationRows(
  db: Db,
  recordId: string | null,
  inputs: readonly { relatedId: string; type: RelationType }[],
): Promise<{ rows: RelationRow[]; errors: FieldWarning[] }> {
  const wanted = [...new Set(inputs.map((r) => r.relatedId))];
  const found = new Map<string, string | null>();
  for (let i = 0; i < wanted.length; i += ID_BATCH) {
    const rows = await db.selectFrom('records').select(['id', 'merged_into']).where('id', 'in', wanted.slice(i, i + ID_BATCH)).execute();
    for (const r of rows) found.set(r.id, r.merged_into);
  }
  const rows: RelationRow[] = [];
  const errors: FieldWarning[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, i) => {
    const path = `relations.${i}.relatedId`;
    if (!found.has(input.relatedId)) {
      errors.push({ path, code: 'not_found' });
      return;
    }
    const related = found.get(input.relatedId) ?? input.relatedId;
    if (related === recordId) {
      errors.push({ path, code: 'self' });
      return;
    }
    const key = `${related}:${input.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ related_id: related, type: input.type });
  });
  return { rows, errors };
}

/** Replaces the relations stored on `recordId` with `rows`. */
export async function writeRelations(trx: Transaction<DB>, recordId: string, rows: readonly RelationRow[]): Promise<void> {
  await trx.deleteFrom('record_relations').where('record_id', '=', recordId).execute();
  for (let i = 0; i < rows.length; i += ID_BATCH) {
    await trx
      .insertInto('record_relations')
      .values(rows.slice(i, i + ID_BATCH).map((r) => ({ record_id: recordId, related_id: r.related_id, type: r.type })))
      .execute();
  }
}
