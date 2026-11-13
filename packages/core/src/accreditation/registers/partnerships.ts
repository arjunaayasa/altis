import type { DB } from '@altis/db';
import { newId, type PartnershipKind } from '@altis/shared';
import { PartnershipBody, PartnershipPatchBody, type PartnershipView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Selectable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { claimUpload, replaceUpload } from './claims.js';
import {
  archiveRegisterTableRow,
  auditRegister,
  changedFields,
  checkSpan,
  checkVersion,
  fileNames,
  givenFields,
  latestFirst,
  lockRegisterRow,
  newTrail,
  newestIdFirst,
  parseBody,
  patchText,
  patchValue,
  registerNotFound,
  textOrNull,
  writeRegisterRow,
  type Db,
} from './common.js';

// The Partnerships register (spec §3.2, §10.6): agreements (MoU, PKS, other) with a partner, the span they run and
// their scope, with the signed agreement as a file (an `accreditation.evidence` upload owned by the row,
// `owner_type 'library_partnerships'`). Listed by start, latest first.

const TABLE = 'library_partnerships';

type Row = Selectable<DB['library_partnerships']>;

function toView(row: Row, names: ReadonlyMap<string, string>): PartnershipView {
  return {
    id: row.id,
    partner: row.partner,
    kind: row.kind as PartnershipKind,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    scope: row.scope,
    documentFileId: row.document_file_id,
    documentFileName: row.document_file_id === null ? null : (names.get(row.document_file_id) ?? null),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  };
}

/** The live partnerships, latest start first. */
export async function listPartnerships(db: Db): Promise<PartnershipView[]> {
  const rows = await db.selectFrom(TABLE).selectAll().where('archived_at', 'is', null).execute();
  const names = await fileNames(db, rows.map((r) => r.document_file_id));
  return rows.map((r) => toView(r, names)).sort((a, b) => latestFirst(a.startsOn, b.startsOn) || newestIdFirst(a, b));
}

/** Records a partnership, claiming its agreement upload when one is named. */
export async function createPartnership(tx: TxCtx, input: PartnershipBody, now: number): Promise<StoreResponse> {
  const body = parseBody(PartnershipBody, input);
  checkSpan(body.startsOn, body.endsOn, 'endsOn');
  const id = newId(now);
  const document =
    body.documentUploadId === undefined || body.documentUploadId === null
      ? null
      : (await claimUpload(tx.trx, body.documentUploadId, { ownerType: TABLE, ownerId: id })).fileId;
  await tx.trx
    .insertInto(TABLE)
    .values({
      id,
      branch_id: null,
      partner: body.partner,
      kind: body.kind,
      starts_on: body.startsOn,
      ends_on: body.endsOn ?? null,
      scope: textOrNull(body.scope),
      document_file_id: document,
      version: 0,
      ...newTrail(now, tx.actor.id),
    })
    .execute();
  await auditRegister(tx, 'accreditation.register.create', TABLE, id, givenFields(body));
  return { id, version: 0 };
}

/** Changes the fields `patch` sends; a new `documentUploadId` replaces the agreement file (null removes it). */
export async function updatePartnership(tx: TxCtx, id: string, input: PartnershipPatchBody, now: number): Promise<StoreResponse> {
  const patch = parseBody(PartnershipPatchBody, input);
  const { trx } = tx;
  await lockRegisterRow(trx, TABLE, id);
  const row = await trx.selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(TABLE);
  checkVersion(TABLE, row, patch.version);
  const before = toView(row, new Map());
  const next = {
    partner: patch.partner,
    kind: patch.kind,
    startsOn: patch.startsOn,
    endsOn: patchValue(patch.endsOn),
    scope: patchText(patch.scope),
  };
  checkSpan(next.startsOn ?? before.startsOn, next.endsOn === undefined ? before.endsOn : next.endsOn, 'endsOn');
  const document = await replaceUpload(trx, row.document_file_id, patch.documentUploadId, { ownerType: TABLE, ownerId: id });
  const set = { partner: next.partner, kind: next.kind, starts_on: next.startsOn, ends_on: next.endsOn, scope: next.scope, document_file_id: document };
  const version = await writeRegisterRow(tx, TABLE, id, patch.version, set, now);
  const fields = changedFields(next, before);
  if (document !== undefined) fields.push('documentUploadId');
  await auditRegister(tx, 'accreditation.register.update', TABLE, id, fields);
  return { id, version };
}

/** Archives a partnership (its agreement file stays with it). */
export function archivePartnership(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return archiveRegisterTableRow(tx, TABLE, id, now);
}
