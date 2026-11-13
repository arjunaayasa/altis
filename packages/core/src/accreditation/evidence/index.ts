// Stub: replaced by a later change in this milestone.
// The evidence files: a period's indicator evidence and a register row's attachments, their checklist per indicator
// and the size of each component. The signatures are final; every body throws until the evidence is written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type { EvidenceEntity } from '@altis/shared';
import type { EvidenceCreateBody, EvidenceListResponse } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely } from 'kysely';
import type { TxCtx } from '../../context.js';
import type { AccredInstrument } from '../types.js';

/** Which evidence a list shows: a period's (optionally one indicator's), or one register row's. */
export interface EvidenceListQuery {
  periodId?: string;
  indicatorCode?: string;
  entity?: EvidenceEntity;
  entityId?: string;
}

/** One item of an indicator's checklist: present or not, and its files. */
export interface EvidenceChecklistItem {
  code: string;
  present: boolean;
  files: { id: string; name: string; caption: string }[];
}

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** The evidence of a period or a register row, and the size of each component's files. */
export async function listEvidence(db: Kysely<DB>, q: EvidenceListQuery): Promise<EvidenceListResponse> {
  return notImplemented();
}

/** Links an `accreditation.evidence` upload (the period lock first for a period's evidence). */
export async function createEvidence(tx: TxCtx, body: EvidenceCreateBody, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** Removes an evidence row and releases its file. */
export async function archiveEvidence(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** Per indicator catalogue code (`SCH-K1`), its checklist items in the instrument's order. */
export async function evidenceChecklist(db: Kysely<DB>, periodId: string, instrument: AccredInstrument): Promise<Map<string, EvidenceChecklistItem[]>> {
  return notImplemented();
}
