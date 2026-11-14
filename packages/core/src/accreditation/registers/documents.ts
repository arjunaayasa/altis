import type { DB } from '@altis/db';
import { DOCUMENT_ASPECTS, DOCUMENT_KINDS, newId, type DocumentKind } from '@altis/shared';
import { DocumentBody, DocumentPatchBody, type DocumentView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Selectable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { claimUpload, replaceUpload } from './claims.js';
import {
  archiveRegisterTableRow,
  auditRegister,
  changedFields,
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
  validationFailed,
  writeRegisterRow,
  type Db,
} from './common.js';

// The Documents register (spec §3.2, §10.6): rules, procedures, programmes, reports, decrees, … by kind, with their
// number, date, issuer, validity and file (an `accreditation.evidence` upload owned by the row, `owner_type
// 'library_documents'`). A kind with aspects (the collection policy, the library programme, the head's performance
// report) records which of its aspects the document covers, from `DOCUMENT_ASPECTS[kind]` only: a code outside that
// list (any code for a kind without aspects) is the field error `{path: 'aspectCodes.<i>', code: 'invalid'}`. A patch
// is checked against the kind it leaves the row with (its own `kind`, else the stored one). The codes are stored once
// each, in the list's order. Listed by kind (in the vocabulary's order), then latest issue first.

const TABLE = 'library_documents';

type Row = Selectable<DB['library_documents']>;

/** The stored aspect codes (a JSON list, or null) as a list. */
function storedAspects(json: string | null): string[] {
  if (json === null || json === '') return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function toView(row: Row, names: ReadonlyMap<string, string>): DocumentView {
  return {
    id: row.id,
    kind: row.kind as DocumentKind,
    title: row.title,
    reference: row.reference,
    issuedOn: row.issued_on,
    issuedBy: row.issued_by,
    aspectCodes: storedAspects(row.aspect_codes),
    validUntil: row.valid_until,
    fileId: row.file_id,
    fileName: row.file_id === null ? null : (names.get(row.file_id) ?? null),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  };
}

/**
 * The aspect codes of a `kind` document as stored: once each, in `DOCUMENT_ASPECTS[kind]`'s order (an empty list for
 * none).
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'aspectCodes.<i>', code: 'invalid'}` for each code outside the kind's list
 */
function checkedAspects(kind: DocumentKind, codes: readonly string[]): string[] {
  const allowed = DOCUMENT_ASPECTS[kind];
  const errors = codes.flatMap((code, i) => (allowed.includes(code) ? [] : [{ path: `aspectCodes.${i}`, code: 'invalid' }]));
  if (errors.length > 0) throw validationFailed(errors);
  return allowed.filter((code) => codes.includes(code));
}

const aspectsJson = (codes: readonly string[]): string | null => (codes.length === 0 ? null : JSON.stringify(codes));

const kindRank = (kind: string): number => {
  const i = (DOCUMENT_KINDS as readonly string[]).indexOf(kind);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

/** The live documents by kind, then latest issue first. */
export async function listDocuments(db: Db): Promise<DocumentView[]> {
  const rows = await db.selectFrom(TABLE).selectAll().where('archived_at', 'is', null).execute();
  const names = await fileNames(db, rows.map((r) => r.file_id));
  return rows.map((r) => toView(r, names)).sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || latestFirst(a.issuedOn, b.issuedOn) || newestIdFirst(a, b));
}

/** Records a document, claiming its file upload when one is named. */
export async function createDocument(tx: TxCtx, input: DocumentBody, now: number): Promise<StoreResponse> {
  const body = parseBody(DocumentBody, input);
  const aspects = checkedAspects(body.kind, body.aspectCodes ?? []);
  const id = newId(now);
  const file =
    body.fileUploadId === undefined || body.fileUploadId === null ? null : (await claimUpload(tx.trx, body.fileUploadId, { ownerType: TABLE, ownerId: id })).fileId;
  await tx.trx
    .insertInto(TABLE)
    .values({
      id,
      branch_id: null,
      kind: body.kind,
      title: body.title,
      reference: textOrNull(body.reference),
      issued_on: body.issuedOn ?? null,
      issued_by: textOrNull(body.issuedBy),
      aspect_codes: aspectsJson(aspects),
      valid_until: body.validUntil ?? null,
      file_id: file,
      version: 0,
      ...newTrail(now, tx.actor.id),
    })
    .execute();
  await auditRegister(tx, 'accreditation.register.create', TABLE, id, givenFields(body));
  return { id, version: 0 };
}

/**
 * Changes the fields `patch` sends; the aspect codes are checked against the kind the row ends with, and a new
 * `fileUploadId` replaces the file (null removes it).
 */
export async function updateDocument(tx: TxCtx, id: string, input: DocumentPatchBody, now: number): Promise<StoreResponse> {
  const patch = parseBody(DocumentPatchBody, input);
  const { trx } = tx;
  await lockRegisterRow(trx, TABLE, id);
  const row = await trx.selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(TABLE);
  checkVersion(TABLE, row, patch.version);
  const before = toView(row, new Map());
  const kind = patch.kind ?? before.kind;
  const aspects =
    patch.aspectCodes === undefined && patch.kind === undefined ? undefined : checkedAspects(kind, patch.aspectCodes === undefined ? before.aspectCodes : (patch.aspectCodes ?? []));
  const next = {
    kind: patch.kind,
    title: patch.title,
    reference: patchText(patch.reference),
    issuedOn: patchValue(patch.issuedOn),
    issuedBy: patchText(patch.issuedBy),
    aspectCodes: aspects,
    validUntil: patchValue(patch.validUntil),
  };
  const file = await replaceUpload(trx, row.file_id, patch.fileUploadId, { ownerType: TABLE, ownerId: id });
  const set = {
    kind: next.kind,
    title: next.title,
    reference: next.reference,
    issued_on: next.issuedOn,
    issued_by: next.issuedBy,
    aspect_codes: aspects === undefined ? undefined : aspectsJson(aspects),
    valid_until: next.validUntil,
    file_id: file,
  };
  const version = await writeRegisterRow(tx, TABLE, id, patch.version, set, now);
  const fields = changedFields(next, before);
  if (file !== undefined) fields.push('fileUploadId');
  await auditRegister(tx, 'accreditation.register.update', TABLE, id, fields);
  return { id, version };
}

/** Archives a document (its file stays with it). */
export function archiveDocument(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return archiveRegisterTableRow(tx, TABLE, id, now);
}
