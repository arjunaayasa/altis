import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import { EvidenceMinutesBody, MINUTES_EVIDENCE_CODE, type EvidenceMinutesCandidate, type EvidenceMinutesListResponse } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { STOCKTAKE_MINUTES_CONTEXT, STOCKTAKE_MINUTES_OWNER } from '../../stocktake/minutes.js';
import { lockOpenPeriod } from '../periods/lock.js';
import { givenFields, parseBody, validationFailed } from '../registers/common.js';
import { evidenceItemsOf } from './checklist.js';

// The minutes of a stocktake session as evidence: the indicators whose checklist has the minutes item
// (`stocktake_minutes`) take the minutes a finished session stored at its finish, without the file being downloaded and
// uploaded again. The evidence row names the session's stored file: it stays owned by its session (never claimed, never
// released, never copied), staff only, and `/files/:id` serves it to the workspace's readers only while a period links
// it (catalog/attachments/access.ts). The dossier and its ZIPs read it as any evidence file.
//
// - The list shows the finished sessions whose minutes are stored, of the branches the caller may read the stocktake of
//   (the route passes the test); linking checks the same at the session's branch before its transaction.
// - Linking follows `createEvidence`: the period's lock first, the indicator and its minutes item checked against the
//   period's instrument, the period's `updated_at` touched, audited once as `accreditation.evidence.create` (field
//   names and codes, never the caption). The same minutes linked twice to one item of a period is `duplicate`.

const TABLE = 'accred_evidence';
/** The sessions a list shows at most. */
const LIST_MAX = 200;

type Db = Kysely<DB> | Transaction<DB>;

/** The finished sessions with stored minutes (newest first, at most 200), with `stocktakeId` when given. */
async function sessionsWithMinutes(db: Db, stocktakeId?: string): Promise<EvidenceMinutesCandidate[]> {
  let q = db
    .selectFrom('stocktakes as s')
    .innerJoin('files as f', (j) =>
      j
        .onRef('f.id', '=', 's.minutes_file_id')
        .on('f.owner_type', '=', STOCKTAKE_MINUTES_OWNER)
        .onRef('f.owner_id', '=', 's.id')
        .on('f.context', '=', STOCKTAKE_MINUTES_CONTEXT)
        .on('f.status', '=', 'ok'),
    )
    .innerJoin('branches as b', 'b.id', 's.branch_id')
    .select(['s.id', 's.name', 's.finished_at', 'b.id as branch_id', 'b.code_display', 'b.name as branch_name', 'f.id as file_id', 'f.original_name', 'f.size'])
    .where('s.status', '=', 'finished');
  if (stocktakeId !== undefined) q = q.where('s.id', '=', stocktakeId);
  const rows = await q.orderBy('s.finished_at', 'desc').orderBy('s.id', 'desc').limit(LIST_MAX).execute();
  return rows.map((r) => ({
    stocktakeId: r.id,
    name: r.name,
    branch: { id: r.branch_id, code: r.code_display, name: r.branch_name },
    finishedAt: Number(r.finished_at ?? 0),
    fileId: r.file_id,
    fileName: r.original_name,
    size: Number(r.size),
  }));
}

/** The finished sessions with stored minutes of the branches `mayRead` passes, newest first (at most 200 read). */
export async function listMinutesForEvidence(db: Kysely<DB>, mayRead: (branchId: string) => boolean): Promise<EvidenceMinutesListResponse> {
  return { items: (await sessionsWithMinutes(db)).filter((s) => mayRead(s.branch.id)) };
}

/** The branch of stocktake session `id`, or null for no such session (read before the link's transaction). */
export async function stocktakeBranchOf(db: Kysely<DB>, id: string): Promise<string | null> {
  return (await db.selectFrom('stocktakes').select('branch_id').where('id', '=', id).executeTakeFirst())?.branch_id ?? null;
}

/**
 * Links the stored minutes of the finished session `body.stocktakeId` as evidence of the period's indicator, under its
 * minutes item (see the top of this file). The caller checked the session's branch.
 *
 * @throws DomainError NOT_FOUND (the period: unknown or archived); ACCRED_PERIOD_FROZEN; VALIDATION_FAILED (the
 *   contract; `indicatorCode` `invalid`: not an indicator of the instrument with the minutes item; `stocktakeId`
 *   `not_found`: no finished session with stored minutes; `stocktakeId` `duplicate`: linked to that item already)
 */
export async function attachMinutesEvidence(tx: TxCtx, input: EvidenceMinutesBody, now: number): Promise<StoreResponse> {
  const body = parseBody(EvidenceMinutesBody, input);
  const { trx } = tx;
  await lockOpenPeriod(trx, body.periodId);
  const period = await trx.selectFrom('accred_periods').select('instrument_id').where('id', '=', body.periodId).executeTakeFirstOrThrow();
  const items = evidenceItemsOf(period.instrument_id, body.indicatorCode);
  if (items === null || !items.includes(MINUTES_EVIDENCE_CODE)) throw validationFailed([{ path: 'indicatorCode', code: 'invalid' }]);
  const session = (await sessionsWithMinutes(trx, body.stocktakeId))[0];
  if (session === undefined) throw validationFailed([{ path: 'stocktakeId', code: 'not_found' }]);
  const linked = await trx
    .selectFrom(TABLE)
    .select('id')
    .where('period_id', '=', body.periodId)
    .where('indicator_code', '=', body.indicatorCode)
    .where('evidence_code', '=', MINUTES_EVIDENCE_CODE)
    .where('file_id', '=', session.fileId)
    .executeTakeFirst();
  if (linked !== undefined) throw validationFailed([{ path: 'stocktakeId', code: 'duplicate' }]);
  const id = newId(now);
  const caption = body.caption === undefined || body.caption === '' ? Array.from(session.name).slice(0, 191).join('') : body.caption;
  await trx
    .insertInto(TABLE)
    .values({
      id,
      period_id: body.periodId,
      indicator_code: body.indicatorCode,
      evidence_code: MINUTES_EVIDENCE_CODE,
      entity: null,
      entity_id: null,
      file_id: session.fileId,
      caption,
      sort_order: body.sortOrder ?? 0,
      created_at: now,
      created_by: tx.actor.id,
    })
    .execute();
  await trx.updateTable('accred_periods').set({ updated_at: now }).where('id', '=', body.periodId).execute();
  await tx.audit({
    action: 'accreditation.evidence.create',
    entity: TABLE,
    entityId: id,
    meta: {
      entity: TABLE,
      id,
      fields: givenFields(body),
      periodId: body.periodId,
      indicatorCode: body.indicatorCode,
      evidenceCode: MINUTES_EVIDENCE_CODE,
      linkedEntity: null,
      stocktakeId: session.stocktakeId,
    },
  });
  return { id, version: 0 };
}

/**
 * Whether `/files/:id` may serve the file `f` as stocktake minutes that a period links as evidence: stored minutes of a
 * session, named by at least one evidence row.
 */
export async function minutesLinkedAsEvidence(db: Kysely<DB>, f: { id: string; context: string; owner_type: string | null }): Promise<boolean> {
  if (f.context !== STOCKTAKE_MINUTES_CONTEXT || f.owner_type !== STOCKTAKE_MINUTES_OWNER) return false;
  return (await db.selectFrom(TABLE).select('id').where('file_id', '=', f.id).limit(1).executeTakeFirst()) !== undefined;
}
