import { DomainError, ITEM_STATUSES, canTransition, type ItemStatus } from '@altis/shared';

// The item lifecycle (Phase 2 spec §2.5): only the transitions of ITEM_TRANSITIONS are allowed (409
// ITEM_STATUS_TRANSITION otherwise). Archiving an item is `withdrawn` + `archived_at`, whichever way it gets there
// (archiveItem, a status change, a bulk change, a create as `withdrawn`), and `withdrawn → processing` clears
// `archived_at`. Loanable (§2.5): `available` and the collection type `loanable = 1`; self-service when it is also
// `self_service = 1` (lent at a self-service kiosk).

/** The status an archived item has. */
export const ARCHIVED_STATUS: ItemStatus = 'withdrawn';

/** A status read back from the database, as the vocabulary type (an unknown one is a TypeError: the column is ours). */
export function itemStatusOf(value: string): ItemStatus {
  if (!(ITEM_STATUSES as readonly string[]).includes(value)) throw new TypeError(`items.status ${JSON.stringify(value)} is not an item status`);
  return value as ItemStatus;
}

/** The refusal of `from → to`. */
export function transitionRefused(from: ItemStatus, to: ItemStatus): DomainError {
  return new DomainError('ITEM_STATUS_TRANSITION', {
    detail: `Status eksemplar tidak dapat diubah dari ${from} ke ${to} / The item status cannot change from ${from} to ${to}`,
    meta: { from, to },
  });
}

/** Whether an item of status `from` may end up in `to`: staying, or a transition of ITEM_TRANSITIONS. */
export function canChangeStatus(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || canTransition(from, to);
}

/**
 * Checks a status change: none when `to` is `from` (staying is not a transition), else ITEM_TRANSITIONS.
 *
 * @throws DomainError ITEM_STATUS_TRANSITION (409, `meta {from, to}`) for any other pair
 */
export function checkTransition(from: ItemStatus, to: ItemStatus): void {
  if (!canChangeStatus(from, to)) throw transitionRefused(from, to);
}

/**
 * `archived_at` after a change of status from `from` to `to` at `now`: set when the item becomes withdrawn (kept when
 * it already was archived), cleared when it leaves withdrawn, otherwise as it was.
 */
export function archivedAtAfter(from: ItemStatus, to: ItemStatus, archivedAt: number | null, now: number): number | null {
  if (to === ARCHIVED_STATUS) return archivedAt ?? now;
  if (from === ARCHIVED_STATUS) return null;
  return archivedAt;
}

/** §2.5: whether an item may be lent, and lent at a self-service station. */
export function loanability(status: string, collection: { loanable: number | string; self_service: number | string }): { loanable: boolean; selfService: boolean } {
  const loanable = status === 'available' && Number(collection.loanable) === 1;
  return { loanable, selfService: loanable && Number(collection.self_service) === 1 };
}
