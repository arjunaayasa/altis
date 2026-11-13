import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import { RecordBulkBody, type RecordBulkResponse } from '@altis/shared/api/catalog/records';
import type { TxCtx } from '../../context.js';
import { publish } from '../../events/publish.js';
import { ACCRED_COLUMNS, ACCRED_KEYS, lockRecordRows, validationFailed, type AccredKey } from './service.js';

// The bulk change of the records' accreditation fields (`POST catalog/records/bulk`): who up to 500 records are meant
// for, who made them as local works and their kind, or the kind of reference work they are. These fields are local
// annotations, not part of the bibliographic description (service.ts, ACCRED_COLUMNS), so the change sets them and
// bumps `version`, nothing else: `updated_by`, `updated_at` and `changed_at` stay (a record migrated from SLiMS keeps
// following a re-sync, and no public datestamp moves), and the search index is not touched (none of the four is
// indexed).
//
// - The record rows are locked first, in id order (lockRecordRows: a write that changes nothing), before any read, as
//   every record writer does; then the rows are read once.
// - Each id is answered on its own: one that names no record is refused `not_found`, an archived (or merged) record
//   `archived`, and the rest are `updated`. A record already as asked counts as updated and is not written.
// - One audit entry `catalog.record.bulk_update` (`meta {count, fields}`: the records updated and the field names,
//   never values), then `catalog.record.changed {id}` for each record written, the transaction's last statements.

/** Ids per statement (an IN list). */
const ID_BATCH = 500;

/** `body` parsed with the strict contract, or VALIDATION_FAILED with its issues (as the route would answer). */
function parseBody(body: RecordBulkBody): RecordBulkBody {
  const parsed = RecordBulkBody.safeParse(body);
  if (parsed.success) return parsed.data;
  const errors: FieldWarning[] = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) }));
  throw validationFailed(errors);
}

/**
 * Sets the given accreditation fields of up to 500 records; unknown and archived records are refused one by one (see
 * the top of this file). `now` is the action's time, which none of the fields it sets carries.
 *
 * @throws DomainError VALIDATION_FAILED for a body the contract refuses (nothing written)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the signature: the change moves none of the record's times
export async function bulkUpdateRecords(tx: TxCtx, body: RecordBulkBody, now: number): Promise<RecordBulkResponse> {
  const { trx } = tx;
  const b = parseBody(body);
  const ids = [...new Set(b.ids)];
  await lockRecordRows(trx, [...ids].sort());

  const keys = ACCRED_KEYS.filter((k) => b.set[k] !== undefined);
  const rows = new Map<string, { archived: boolean; values: Record<AccredKey, string | null> }>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = await trx
      .selectFrom('records')
      .select(['id', 'archived_at', 'merged_into', 'audience', 'local_work', 'local_work_kind', 'reference_kind'])
      .where('id', 'in', ids.slice(i, i + ID_BATCH))
      .execute();
    for (const r of batch) {
      rows.set(r.id, {
        archived: r.archived_at !== null || r.merged_into !== null,
        values: { audience: r.audience, localWork: r.local_work, localWorkKind: r.local_work_kind, referenceKind: r.reference_kind },
      });
    }
  }

  const refused: RecordBulkResponse['refused'] = [];
  const written: string[] = [];
  let updated = 0;
  for (const id of ids) {
    const row = rows.get(id);
    if (row === undefined) {
      refused.push({ id, code: 'not_found' });
      continue;
    }
    if (row.archived) {
      refused.push({ id, code: 'archived' });
      continue;
    }
    updated += 1;
    if (keys.some((k) => row.values[k] !== b.set[k])) written.push(id);
  }

  // The same values for every record written: one statement per batch of ids.
  const set: Partial<Record<(typeof ACCRED_COLUMNS)[AccredKey], string | null>> = {};
  for (const k of keys) set[ACCRED_COLUMNS[k]] = b.set[k] ?? null;
  for (let i = 0; i < written.length; i += ID_BATCH) {
    await trx
      .updateTable('records')
      .set((eb) => ({ ...set, version: eb('version', '+', 1) }))
      .where('id', 'in', written.slice(i, i + ID_BATCH))
      .execute();
  }

  await tx.audit({ action: 'catalog.record.bulk_update', entity: 'records', entityId: null, meta: { count: updated, fields: [...keys].sort() } });
  for (const id of written) await publish(trx, { channel: 'catalog', type: 'catalog.record.changed', payload: { id } });
  return { updated, refused };
}
