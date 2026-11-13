import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Transaction } from 'kysely';

// The lock of a period's writers (spec §10.10): every write of a period's data (its profile, population and
// facilities, the answers, the manual usage, its evidence) takes the period's row first, with an update that changes
// nothing, before any plain read. A freeze changes the status with a conditional update of the same row, so a write
// that read `open` cannot commit after the freeze: it either commits first (and the freeze sees it) or waits and then
// finds the period frozen.

/**
 * Takes the lock of the open period `periodId` as the first statement of `trx`: `UPDATE accred_periods SET version =
 * version WHERE id = ? AND status = 'open' AND archived_at IS NULL`.
 *
 * @throws DomainError `NOT_FOUND` when no live period has that id; `ACCRED_PERIOD_FROZEN` when it is frozen
 */
export async function lockOpenPeriod(trx: Transaction<DB>, periodId: string): Promise<void> {
  const r = await trx
    .updateTable('accred_periods')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', periodId)
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 1) return;
  const row = await trx.selectFrom('accred_periods').select(['status', 'archived_at']).where('id', '=', periodId).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) {
    throw new DomainError('NOT_FOUND', { detail: 'Periode akreditasi tidak ditemukan / The accreditation period was not found' });
  }
  throw new DomainError('ACCRED_PERIOD_FROZEN', {
    detail: 'Periode ini sudah dibekukan; buka kembali dulu untuk mengubahnya / This period is frozen; reopen it first to change it',
  });
}
