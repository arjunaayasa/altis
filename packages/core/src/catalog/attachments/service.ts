import { fullTextFamily, increment, withTx, type DB, type DbHandle } from '@altis/db';
import { DomainError, isUlid, newId } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import { AttachmentCreateBody, AttachmentPatchBody, type AttachmentView } from '@altis/shared/api/catalog/attachments';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import type { AttachmentAccess, AttachmentKind } from '@altis/shared';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { z } from 'zod';
import type { TxCtx } from '../../context.js';
import { afterRecordWrite, lockRecordRows, mergedRecord, readRecordRow } from '../records/service.js';

// The attachments of bibliographic records (Phase 2 spec §8, §12.2; plan Task 18): a stored file (a completed upload
// of the context `catalog.attachment`) or a link, with a title, a description and who may open it.
//
// - A file attachment claims its upload: the `files` row must be of the context `catalog.attachment` and have no owner
//   yet (`{path: 'fileId', code: 'not_found' | 'invalid'}` otherwise; a row the orphan cleanup has marked counts as
//   owned). The claim re-checks the owner in its UPDATE, so two attachments can never take the same upload. The file
//   then belongs to the attachment (`owner_type 'attachments'`, `owner_id` = the attachment's id).
// - `files.access` always follows `attachments.access`, in the same transaction; archiving makes both `staff`. Whether
//   `/files/:id` serves a file publicly also depends on its record (access.ts).
// - Every change moves the record's `changed_at` (its public representation changed; its `version` stays, so the
//   editor's own save does not turn stale), indexes the record and publishes `catalog.record.changed` as the
//   transaction's last statement (records/service.ts `afterRecordWrite`), after one audit entry
//   (`catalog.attachment.create|update|archive`, entity `attachments`; `meta` holds the record id and field names, never
//   a title or a link).
// - Concurrency: a change first locks the record's row with a write that changes nothing (records/service.ts
//   `lockRecordRows`), so the writers of one record's attachments serialize, and on MySQL/MariaDB the reads that follow
//   see the latest commit. A create locks the record first, as a record merge does; an update or an archive first
//   reads its attachment's record with a locking read (lockedAttachment), so a deadlock with a merge is possible and is
//   TX_CONFLICT, which withTx runs again. `version` is compared (CONFLICT_STALE) and bumped by the one UPDATE that
//   writes the row.
// - An archived attachment is gone for the librarian and the OPAC: it is in no list, and editing it is NOT_FOUND.

type Db = Kysely<DB> | Transaction<DB>;
type AttachmentRow = Selectable<DB['attachments']>;

/** The fields a patch may change, in the order an audit entry names them. */
const PATCH_FIELDS = ['title', 'description', 'access', 'sortOrder'] as const;

// ---- errors ----------------------------------------------------------------------------------------------------------

function validationFailed(errors: FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data lampiran tidak valid / The attachment data is not valid',
    meta: { errors },
  });
}

function attachmentNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Lampiran tidak ditemukan / Attachment not found' });
}

function attachmentStale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Lampiran sudah diubah orang lain; muat ulang / The attachment was changed by someone else; reload it',
  });
}

/** `body` parsed with `schema` (a body from a caller other than the API meets the same widths), or VALIDATION_FAILED. */
function parseOrFail<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
  }
  return parsed.data;
}

// ---- reading ---------------------------------------------------------------------------------------------------------

/** The attachments with their file's type and size (none for a link). */
function viewQuery(db: Db) {
  return db
    .selectFrom('attachments as a')
    .leftJoin('files as f', 'f.id', 'a.file_id')
    .select([
      'a.id',
      'a.record_id',
      'a.kind',
      'a.file_id',
      'a.url',
      'a.title',
      'a.description',
      'a.access',
      'a.read_count',
      'a.sort_order',
      'a.version',
      'f.mime',
      'f.size',
    ]);
}

type ViewRow = Awaited<ReturnType<ReturnType<typeof viewQuery>['executeTakeFirstOrThrow']>>;

function viewOf(r: ViewRow): AttachmentView {
  return {
    id: r.id,
    recordId: r.record_id,
    kind: r.kind as AttachmentKind,
    fileId: r.file_id,
    url: r.url,
    title: r.title,
    description: r.description,
    access: r.access as AttachmentAccess,
    mime: r.mime ?? null,
    size: r.size === null || r.size === undefined ? null : Number(r.size),
    readCount: Number(r.read_count),
    sortOrder: Number(r.sort_order),
    version: Number(r.version),
  };
}

async function readView(db: Db, id: string): Promise<AttachmentView> {
  return viewOf(await viewQuery(db).where('a.id', '=', id).executeTakeFirstOrThrow());
}

/**
 * The attachments of `recordId` that are not archived, in `sort_order` (then id); with `publicOnly` (the OPAC), the
 * `public` ones only. Whether the record itself may be shown is the caller's to decide.
 *
 * @throws DomainError NOT_FOUND for an unknown record
 */
export async function listAttachments(db: Db, recordId: string, o: { publicOnly: boolean }): Promise<AttachmentView[]> {
  if (!isUlid(recordId) || (await db.selectFrom('records').select('id').where('id', '=', recordId).executeTakeFirst()) === undefined) {
    throw new DomainError('NOT_FOUND', { detail: 'Cantuman tidak ditemukan / Record not found' });
  }
  let q = viewQuery(db).where('a.record_id', '=', recordId).where('a.archived_at', 'is', null);
  if (o.publicOnly) q = q.where('a.access', '=', 'public');
  return (await q.orderBy('a.sort_order').orderBy('a.id').execute()).map(viewOf);
}

// ---- writing ---------------------------------------------------------------------------------------------------------

/** `files.access` of the attachment's file = `access` (only while the file is the attachment's). */
async function syncFileAccess(trx: Transaction<DB>, fileId: string, attachmentId: string, access: AttachmentAccess): Promise<void> {
  await trx
    .updateTable('files')
    .set({ access })
    .where('id', '=', fileId)
    .where('owner_type', '=', 'attachments')
    .where('owner_id', '=', attachmentId)
    .execute();
}

/** The record's public representation changed (OAI datestamp, sitemap, RSS); its version stays. */
async function touchRecord(trx: Transaction<DB>, recordId: string, now: number): Promise<void> {
  await trx.updateTable('records').set({ changed_at: now }).where('id', '=', recordId).execute();
}

/**
 * Locks the record of attachment `id` (see the top of this file: the lock comes before any plain read), then reads the
 * attachment, archived or not. Its record id comes from a locking read of the attachment (FOR UPDATE; SQLite has one
 * writer), which sees the latest commit (a merge that moved it) and starts no snapshot, and the record is locked by its
 * id; the attachment's lock keeps `record_id` fixed until the commit. Never one UPDATE with a subquery: MariaDB before
 * 11.1 runs that as a dependent subquery over the whole `records` table and keeps every row locked until the COMMIT.
 *
 * @throws DomainError NOT_FOUND for an unknown attachment
 */
async function lockedAttachment(trx: Transaction<DB>, id: string): Promise<AttachmentRow> {
  if (!isUlid(id)) throw attachmentNotFound();
  const q = trx.selectFrom('attachments').select('record_id').where('id', '=', id);
  const owner = await (fullTextFamily(trx) === 'fts5' ? q : q.forUpdate()).executeTakeFirst();
  if (owner === undefined) throw attachmentNotFound();
  await lockRecordRows(trx, [owner.record_id]);
  const row = await trx.selectFrom('attachments').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw attachmentNotFound();
  return row;
}

/**
 * Adds an attachment to `recordId`, after the record's attachments in `sort_order` (see the top of this file).
 *
 * @throws DomainError NOT_FOUND (the record); CATALOG_MERGE_INVALID for a merged record; VALIDATION_FAILED for a body
 *   the contract refuses, or at `fileId` (`not_found`; `invalid`: another context, owned already, not stored)
 */
export async function createAttachment(tx: TxCtx, recordId: string, body: AttachmentCreateBody): Promise<AttachmentView> {
  const input = parseOrFail(AttachmentCreateBody, body);
  const { trx } = tx;
  if (!isUlid(recordId)) throw new DomainError('NOT_FOUND', { detail: 'Cantuman tidak ditemukan / Record not found' });
  await lockRecordRows(trx, [recordId]);
  const record = await readRecordRow(trx, recordId);
  if (record.merged_into !== null) throw mergedRecord();

  const id = newId(tx.now);
  if (input.kind === 'file') {
    const file = await trx.selectFrom('files').select(['context', 'owner_type', 'owner_id', 'status']).where('id', '=', input.fileId).executeTakeFirst();
    if (file === undefined) throw validationFailed([{ path: 'fileId', code: 'not_found' }]);
    const claimable = file.context === 'catalog.attachment' && file.owner_type === null && file.owner_id === null && file.status === 'ok';
    if (!claimable) throw validationFailed([{ path: 'fileId', code: 'invalid' }]);
    const claimed = await trx
      .updateTable('files')
      .set({ owner_type: 'attachments', owner_id: id, access: input.access })
      .where('id', '=', input.fileId)
      .where('context', '=', 'catalog.attachment')
      .where('owner_type', 'is', null)
      .where('owner_id', 'is', null)
      .executeTakeFirst();
    // Claimed meanwhile by another attachment (or marked by the orphan cleanup).
    if (Number(claimed.numUpdatedRows) !== 1) throw validationFailed([{ path: 'fileId', code: 'invalid' }]);
  }

  const last = await trx
    .selectFrom('attachments')
    .select((eb) => eb.fn.max('sort_order').as('top'))
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  const top = last?.top;
  await trx
    .insertInto('attachments')
    .values({
      id,
      record_id: recordId,
      kind: input.kind,
      file_id: input.kind === 'file' ? input.fileId : null,
      url: input.kind === 'url' ? input.url : null,
      title: input.title,
      description: input.description === undefined || input.description === null || input.description === '' ? null : input.description,
      access: input.access,
      legacy_access_limit: null,
      read_count: 0,
      sort_order: top === null || top === undefined ? 0 : Number(top) + 1,
      archived_at: null,
      created_at: tx.now,
      created_by: tx.actor.id,
      updated_at: tx.now,
      updated_by: tx.actor.id,
    })
    .execute();
  await touchRecord(trx, recordId, tx.now);
  const view = await readView(trx, id);
  await afterRecordWrite(tx, [recordId], {
    action: 'catalog.attachment.create',
    entity: 'attachments',
    entityId: id,
    meta: { recordId, kind: input.kind, access: input.access },
  });
  return view;
}

/**
 * Changes the fields `patch` sends (title, description, access, sort order); `patch.version` is the attachment's. A
 * file attachment's file takes the new access in the same transaction.
 *
 * @throws DomainError NOT_FOUND (unknown or archived); CONFLICT_STALE; VALIDATION_FAILED for a patch the contract
 *   refuses
 */
export async function updateAttachment(tx: TxCtx, id: string, patch: AttachmentPatchBody): Promise<AttachmentView> {
  const input = parseOrFail(AttachmentPatchBody, patch);
  const { trx } = tx;
  const row = await lockedAttachment(trx, id);
  if (row.archived_at !== null) throw attachmentNotFound();
  if (Number(row.version) !== input.version) throw attachmentStale();

  const fields = PATCH_FIELDS.filter((f) => input[f] !== undefined);
  const access = input.access ?? (row.access as AttachmentAccess);
  const updated = await trx
    .updateTable('attachments')
    .set((eb) => ({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description === null || input.description === '' ? null : input.description }),
      ...(input.access === undefined ? {} : { access: input.access }),
      ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .where('version', '=', input.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw attachmentStale();
  if (row.file_id !== null) await syncFileAccess(trx, row.file_id, id, access);
  await touchRecord(trx, row.record_id, tx.now);
  const view = await readView(trx, id);
  await afterRecordWrite(tx, [row.record_id], {
    action: 'catalog.attachment.update',
    entity: 'attachments',
    entityId: id,
    meta: { recordId: row.record_id, fields },
  });
  return view;
}

/**
 * Archives an attachment (`archived_at = now`, access `staff`, version + 1); its file turns `staff` too and keeps its
 * owner (it stays for the staff, and the orphan cleanup leaves it). One archived already, asked with its current
 * version, is answered as it is (its entry says `meta.alreadyArchived`); the version it had before archiving is stale
 * (a retry of the same request replays through its Idempotency-Key instead).
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE
 */
export async function archiveAttachment(tx: TxCtx, id: string, version: number): Promise<AttachmentView> {
  const { trx } = tx;
  const row = await lockedAttachment(trx, id);
  if (Number(row.version) !== version) throw attachmentStale();
  if (row.archived_at !== null) {
    await tx.audit({ action: 'catalog.attachment.archive', entity: 'attachments', entityId: id, meta: { recordId: row.record_id, alreadyArchived: true } });
    return readView(trx, id);
  }
  const updated = await trx
    .updateTable('attachments')
    .set((eb) => ({ archived_at: tx.now, access: 'staff', updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw attachmentStale();
  if (row.file_id !== null) await syncFileAccess(trx, row.file_id, id, 'staff');
  await touchRecord(trx, row.record_id, tx.now);
  const view = await readView(trx, id);
  await afterRecordWrite(tx, [row.record_id], {
    action: 'catalog.attachment.archive',
    entity: 'attachments',
    entityId: id,
    meta: { recordId: row.record_id },
  });
  return view;
}

/**
 * Counts one opening of the OPAC viewer of attachment `attachmentId` (spec §8, D2-19): `read_count + 1` through
 * `increment()`, in a short transaction of its own. Best effort: an unknown id changes nothing (no row is created), and
 * a failure is swallowed (the reader's page is served already; Task 34 calls this from `afterResponse`).
 */
export async function incrementReadCount(h: DbHandle, attachmentId: string): Promise<void> {
  if (!isUlid(attachmentId)) return;
  try {
    await withTx(h, async (trx) => {
      const found = await trx.selectFrom('attachments').select('id').where('id', '=', attachmentId).executeTakeFirst();
      if (found === undefined) return;
      await increment(trx, 'attachments', { id: attachmentId }, 'read_count', {});
    });
  } catch {
    // Best effort (D2-19): a lost count is not worth an error.
  }
}
