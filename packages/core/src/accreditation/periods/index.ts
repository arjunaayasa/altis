// Stub: replaced by a later change in this milestone.
// Periods and answers: the instruments as the workspace lists them, the periods, their writers (each takes the period
// lock first) and the last change a period's results depend on. The signatures are final; every body throws until
// the periods are written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type {
  AnswerPutBody,
  InstrumentsResponse,
  PeriodCreateBody,
  PeriodListResponse,
  PeriodPatchBody,
  PeriodView,
} from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { Kysely } from 'kysely';
import type { TxCtx } from '../../context.js';
import type { AccredSettings } from '../../settings/accreditation.js';

export { lockOpenPeriod } from './lock.js';

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** The instruments of this build and the accreditation settings the workspace needs. */
export function listInstruments(db: Kysely<DB>, settings: AccredSettings): InstrumentsResponse {
  return notImplemented();
}

/** The live periods, newest first. */
export async function listPeriods(db: Kysely<DB>): Promise<PeriodListResponse> {
  return notImplemented();
}

/** One live period. */
export async function getPeriod(db: Kysely<DB>, id: string, now: number): Promise<PeriodView> {
  return notImplemented();
}

export async function createPeriod(tx: TxCtx, body: PeriodCreateBody, settings: AccredSettings, now: number): Promise<StoreResponse> {
  return notImplemented();
}

export async function updatePeriod(tx: TxCtx, id: string, body: PeriodPatchBody, settings: AccredSettings, now: number): Promise<StoreResponse> {
  return notImplemented();
}

export async function archivePeriod(tx: TxCtx, id: string, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** Stores, replaces or removes the answer of indicator `code` (a catalogue code, `SCH-K1`). */
export async function putAnswer(tx: TxCtx, periodId: string, code: string, body: AnswerPutBody, now: number): Promise<StoreResponse> {
  return notImplemented();
}

/** The latest change a period's results depend on (answers excluded), or null. */
export async function lastChangeOf(db: Kysely<DB>, periodId: string): Promise<number | null> {
  return notImplemented();
}

/** When the catalogue was last synchronised from SLiMS, or null. */
export async function catalogSyncedAt(db: Kysely<DB>): Promise<number | null> {
  return notImplemented();
}
