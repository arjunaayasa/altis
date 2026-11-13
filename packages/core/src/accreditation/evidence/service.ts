import { fullTextFamily, type DB } from '@altis/db';
import { DomainError, EVIDENCE_ENTITIES, newId, type EvidenceEntity } from '@altis/shared';
import { EvidenceCreateBody, type EvidenceListResponse, type EvidenceView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';
import { lockOpenPeriod } from '../periods/lock.js';
import { claimUpload, releaseUpload } from '../registers/claims.js';
import { givenFields, parseBody, validationFailed } from '../registers/common.js';
import { PROFILE_PHOTO_SLOTS, emptyComponentBytes, evidenceComponentOf, evidenceItemsOf } from './checklist.js';

// The evidence files (spec §10.6, §10.9): an `accreditation.evidence` upload linked to a period's indicator and one
// item of its checklist (`SCH-K1` · `catalogue_screenshot`), to the period's profile (`SCH-PROFIL`, its four photos) or
// prerequisites, to the period alone, and/or to a register row (`entity`, `entity_id`), with a caption. The evidence
// row owns its file (`owner_type 'accred_evidence'`).
//
// - A period's evidence is the period's data: its writer takes the period's lock as the first statement of the
//   transaction (an update of the open period's row that changes nothing), before any plain read and before the
//   upload's `files` row is claimed or read, so it never commits after a freeze (409 ACCRED_PERIOD_FROZEN). A row
//   linked to a register row only takes no period lock: the registers stay editable while a period is frozen.
// - The table has no `archived_at`: archiving deletes the row and releases its file. Because a deleted row leaves no
//   time behind, the archive touches the period's `updated_at` (and the register row's), which is what tells the
//   workspace its results are stale; a create touches them too. A deleted profile photo also leaves the slot of
//   `profile.photos` that named its file empty, in the same transaction.
// - Audited once as `accreditation.evidence.create` / `.archive`, `entity` `accred_evidence`, with the field names and
//   the indicator's and item's codes, never the caption.

/** Which evidence a list shows: a period's (optionally one indicator's), or one register row's. */
export interface EvidenceListQuery {
  periodId?: string;
  indicatorCode?: string;
  entity?: EvidenceEntity;
  entityId?: string;
}

const TABLE = 'accred_evidence';

function evidenceNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Bukti tidak ditemukan / The evidence was not found' });
}

/**
 * The evidence of a period (with `indicatorCode`, of that indicator only), or of one register row, in sort order then
 * oldest first, and the size of each component's files: the sum over the whole period's evidence (whatever indicator
 * the list shows), by the component of each row's indicator, the profile's photos under `profil`; all zero for a
 * register row's list without a period.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'periodId', code: 'required'}` without a period or a register row
 */
export async function listEvidence(db: Kysely<DB>, q: EvidenceListQuery): Promise<EvidenceListResponse> {
  const byEntity = q.entity !== undefined && q.entityId !== undefined;
  if (q.periodId === undefined && !byEntity) throw validationFailed([{ path: 'periodId', code: 'required' }]);
  let query = db
    .selectFrom('accred_evidence as e')
    .innerJoin('files as f', 'f.id', 'e.file_id')
    .select([
      'e.id',
      'e.period_id',
      'e.indicator_code',
      'e.evidence_code',
      'e.entity',
      'e.entity_id',
      'e.file_id',
      'e.caption',
      'e.sort_order',
      'e.created_at',
      'f.original_name',
      'f.size',
      'f.mime',
    ]);
  if (q.periodId !== undefined) query = query.where('e.period_id', '=', q.periodId);
  if (byEntity) query = query.where('e.entity', '=', q.entity!).where('e.entity_id', '=', q.entityId!);
  const rows = await query.execute();
  const componentBytes = emptyComponentBytes();
  if (q.periodId !== undefined) {
    for (const r of rows) {
      const component = evidenceComponentOf(r.indicator_code);
      if (component !== null) componentBytes[component] += Number(r.size);
    }
  }
  const evidence: EvidenceView[] = rows
    .filter((r) => q.indicatorCode === undefined || r.indicator_code === q.indicatorCode)
    .map((r) => ({
      id: r.id,
      periodId: r.period_id,
      indicatorCode: r.indicator_code,
      evidenceCode: r.evidence_code,
      entity: r.entity as EvidenceEntity | null,
      entityId: r.entity_id,
      fileId: r.file_id,
      fileName: r.original_name,
      size: Number(r.size),
      mime: r.mime,
      caption: r.caption,
      sortOrder: Number(r.sort_order),
      createdAt: Number(r.created_at),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { evidence, componentBytes };
}

/**
 * Touches the live register row `entityId` of `entity` (`updated_at = now`), which also tells that it is live.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'entityId', code: 'not_found'}` for an unknown or archived row
 */
async function touchLiveEntity(trx: Transaction<DB>, entity: EvidenceEntity, entityId: string, now: number): Promise<void> {
  // Every register table has `id`, `archived_at` and `updated_at`; Kysely cannot narrow a union of table names.
  const r = await trx
    .updateTable(entity as 'library_activities')
    .set({ updated_at: now })
    .where('id', '=', entityId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw validationFailed([{ path: 'entityId', code: 'not_found' }]);
}

/** Checks the indicator and item an evidence row of a period with instrument `instrumentId` names. */
function checkCodes(instrumentId: string, indicatorCode: string | null, evidenceCode: string | null): void {
  if (indicatorCode === null) return;
  const items = evidenceItemsOf(instrumentId, indicatorCode);
  if (items === null) throw validationFailed([{ path: 'indicatorCode', code: 'invalid' }]);
  if (evidenceCode !== null && !items.includes(evidenceCode)) throw validationFailed([{ path: 'evidenceCode', code: 'invalid' }]);
}

/**
 * Links the completed `accreditation.evidence` upload `body.uploadId` as evidence. For a period's evidence the period's
 * lock comes first, then the upload's claim, the insert and the period's `updated_at`; a row of a register row only
 * claims first. `indicatorCode` must be one of the period instrument's indicators (its catalogue code), `SCH-PROFIL` or
 * `SCH-PRASYARAT`; `evidenceCode` one of that indicator's items (the four photos for the profile, none for the
 * prerequisites); `entity` a live register row (its `updated_at` moves too).
 *
 * @throws DomainError NOT_FOUND (the period: unknown or archived); ACCRED_PERIOD_FROZEN; VALIDATION_FAILED (the
 *   contract; `indicatorCode` or `evidenceCode` `invalid`; `uploadId` `not_found`; `entityId` `not_found`)
 */
export async function createEvidence(tx: TxCtx, input: EvidenceCreateBody, now: number): Promise<StoreResponse> {
  const body = parseBody(EvidenceCreateBody, input);
  const { trx } = tx;
  const periodId = body.periodId ?? null;
  const indicatorCode = body.indicatorCode ?? null;
  const evidenceCode = body.evidenceCode ?? null;
  const entity = body.entity ?? null;
  const entityId = body.entityId ?? null;
  if (periodId !== null) {
    await lockOpenPeriod(trx, periodId);
    const period = await trx.selectFrom('accred_periods').select('instrument_id').where('id', '=', periodId).executeTakeFirstOrThrow();
    checkCodes(period.instrument_id, indicatorCode, evidenceCode);
  }
  const id = newId(now);
  await claimUpload(trx, body.uploadId, { ownerType: TABLE, ownerId: id });
  if (entity !== null && entityId !== null) await touchLiveEntity(trx, entity, entityId, now);
  await trx
    .insertInto(TABLE)
    .values({
      id,
      period_id: periodId,
      indicator_code: indicatorCode,
      evidence_code: evidenceCode,
      entity,
      entity_id: entityId,
      file_id: body.uploadId,
      caption: body.caption,
      sort_order: body.sortOrder ?? 0,
      created_at: now,
      created_by: tx.actor.id,
    })
    .execute();
  if (periodId !== null) await trx.updateTable('accred_periods').set({ updated_at: now }).where('id', '=', periodId).execute();
  await tx.audit({
    action: 'accreditation.evidence.create',
    entity: TABLE,
    entityId: id,
    meta: { entity: TABLE, id, fields: givenFields(body), periodId, indicatorCode, evidenceCode, linkedEntity: entity },
  });
  return { id, version: 0 };
}

/**
 * The period's profile without the photo slots that name `fileId` (null), or null when no slot names it (or the
 * profile cannot be read).
 */
function profileWithoutPhoto(profileJson: string, fileId: string): string | null {
  let profile: unknown;
  try {
    profile = JSON.parse(profileJson);
  } catch {
    return null;
  }
  if (typeof profile !== 'object' || profile === null) return null;
  const photos = (profile as { photos?: unknown }).photos;
  if (typeof photos !== 'object' || photos === null) return null;
  const slots = photos as Record<string, unknown>;
  let changed = false;
  for (const slot of Object.values(PROFILE_PHOTO_SLOTS)) {
    if (slots[slot] === fileId) {
      slots[slot] = null;
      changed = true;
    }
  }
  return changed ? JSON.stringify(profile) : null;
}

/**
 * Removes evidence row `id` and releases its file. A period's row first takes the period's lock: the first statement
 * locks the open period of the row, found through the row itself (an update of the period whose id is the row's
 * `period_id`), so nothing is read before it. Then the row is read, its file released and the row deleted, and the
 * period's `updated_at` (and a register row's) moves; a profile photo slot that named the file is emptied, which also
 * moves the period's `version` (its profile changed).
 *
 * @throws DomainError NOT_FOUND (the row, or its period archived); ACCRED_PERIOD_FROZEN
 */
export async function archiveEvidence(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  const { trx } = tx;
  const locked = await trx
    .updateTable('accred_periods')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', (eb) => eb.selectFrom('accred_evidence').select('period_id').where('id', '=', id))
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  // A locking read (FOR UPDATE; SQLite has one writer): it reads the latest commit and starts no snapshot, so the plain
  // reads below come after every lock, also when the period lock is taken only on the next line.
  const read = trx.selectFrom(TABLE).selectAll().where('id', '=', id);
  const row = await (fullTextFamily(trx) === 'fts5' ? read : read.forUpdate()).executeTakeFirst();
  if (row === undefined) throw evidenceNotFound();
  // Not locked: the period is frozen or archived (lockOpenPeriod says which), or it was reopened in between (then this
  // takes the lock).
  if (row.period_id !== null && Number(locked.numUpdatedRows) !== 1) await lockOpenPeriod(trx, row.period_id);

  await releaseUpload(trx, row.file_id, { ownerType: TABLE, ownerId: id });
  const deleted = await trx.deleteFrom(TABLE).where('id', '=', id).executeTakeFirst();
  if (Number(deleted.numDeletedRows) !== 1) throw evidenceNotFound();
  // The stored entity is one of the register tables (the contract's list); anything else names no table to touch.
  if (row.entity !== null && row.entity_id !== null && (EVIDENCE_ENTITIES as readonly string[]).includes(row.entity)) {
    await trx
      .updateTable(row.entity as 'library_activities')
      .set({ updated_at: now })
      .where('id', '=', row.entity_id)
      .execute();
  }
  if (row.period_id !== null) {
    const period = await trx.selectFrom('accred_periods').select('profile').where('id', '=', row.period_id).executeTakeFirstOrThrow();
    const profile = profileWithoutPhoto(period.profile, row.file_id);
    await trx
      .updateTable('accred_periods')
      .set((eb) => (profile === null ? { updated_at: now } : { profile, updated_at: now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', row.period_id!)
      .execute();
  }
  await tx.audit({
    action: 'accreditation.evidence.archive',
    entity: TABLE,
    entityId: id,
    meta: {
      entity: TABLE,
      id,
      fields: [],
      periodId: row.period_id,
      indicatorCode: row.indicator_code,
      evidenceCode: row.evidence_code,
      linkedEntity: row.entity,
    },
  });
  return { id, version: 0 };
}
