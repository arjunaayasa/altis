import type { DB } from '@altis/db';
import { newId, type ActivityKind } from '@altis/shared';
import { ActivityBody, ActivityPatchBody, type ActivityView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Selectable } from 'kysely';
import type { TxCtx } from '../../context.js';
import {
  archiveRegisterTableRow,
  auditRegister,
  changedFields,
  checkSpan,
  checkVersion,
  flag,
  givenFields,
  isFlag,
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

// The Activities register (spec §3.2, §10.6): promotion, literacy, guidance, surveys, stock-takes, … by kind and date,
// with the participants, the partner, and the two flags several indicators read ("held with the library's facilities",
// "with an outside speaker"). One row may serve several indicators. Listed latest first.

const TABLE = 'library_activities';

type Row = Selectable<DB['library_activities']>;

function toView(row: Row): ActivityView {
  return {
    id: row.id,
    kind: row.kind as ActivityKind,
    title: row.title,
    heldOn: row.held_on,
    endedOn: row.ended_on,
    participants: row.participants === null ? null : Number(row.participants),
    partner: row.partner,
    usesLibraryFacility: isFlag(row.uses_library_facility),
    externalSpeaker: isFlag(row.external_speaker),
    description: row.description,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
  };
}

/** The live activities, latest first. */
export async function listActivities(db: Db): Promise<ActivityView[]> {
  const rows = await db.selectFrom(TABLE).selectAll().where('archived_at', 'is', null).execute();
  return rows.map(toView).sort((a, b) => latestFirst(a.heldOn, b.heldOn) || newestIdFirst(a, b));
}

/** Records an activity. */
export async function createActivity(tx: TxCtx, input: ActivityBody, now: number): Promise<StoreResponse> {
  const body = parseBody(ActivityBody, input);
  checkSpan(body.heldOn, body.endedOn, 'endedOn');
  const id = newId(now);
  await tx.trx
    .insertInto(TABLE)
    .values({
      id,
      branch_id: null,
      kind: body.kind,
      title: body.title,
      held_on: body.heldOn,
      ended_on: body.endedOn ?? null,
      participants: body.participants ?? null,
      partner: textOrNull(body.partner),
      uses_library_facility: flag(body.usesLibraryFacility),
      external_speaker: flag(body.externalSpeaker),
      description: textOrNull(body.description),
      version: 0,
      ...newTrail(now, tx.actor.id),
    })
    .execute();
  await auditRegister(tx, 'accreditation.register.create', TABLE, id, givenFields(body));
  return { id, version: 0 };
}

/** Changes the fields `patch` sends (null or a blank text clears an optional one). */
export async function updateActivity(tx: TxCtx, id: string, input: ActivityPatchBody, now: number): Promise<StoreResponse> {
  const patch = parseBody(ActivityPatchBody, input);
  const { trx } = tx;
  await lockRegisterRow(trx, TABLE, id);
  const row = await trx.selectFrom(TABLE).selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(TABLE);
  checkVersion(TABLE, row, patch.version);
  const before = toView(row);
  const next = {
    kind: patch.kind,
    title: patch.title,
    heldOn: patch.heldOn,
    endedOn: patchValue(patch.endedOn),
    participants: patchValue(patch.participants),
    partner: patchText(patch.partner),
    usesLibraryFacility: patch.usesLibraryFacility,
    externalSpeaker: patch.externalSpeaker,
    description: patchText(patch.description),
  };
  checkSpan(next.heldOn ?? before.heldOn, next.endedOn === undefined ? before.endedOn : next.endedOn, 'endedOn');
  const set = {
    kind: next.kind,
    title: next.title,
    held_on: next.heldOn,
    ended_on: next.endedOn,
    participants: next.participants,
    partner: next.partner,
    uses_library_facility: next.usesLibraryFacility === undefined ? undefined : flag(next.usesLibraryFacility),
    external_speaker: next.externalSpeaker === undefined ? undefined : flag(next.externalSpeaker),
    description: next.description,
  };
  const version = await writeRegisterRow(tx, TABLE, id, patch.version, set, now);
  await auditRegister(tx, 'accreditation.register.update', TABLE, id, changedFields(next, before));
  return { id, version };
}

/** Archives an activity. */
export function archiveActivity(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return archiveRegisterTableRow(tx, TABLE, id, now);
}
