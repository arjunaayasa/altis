import type { TxCtx } from '../context.js';
import type { Db } from '../members/common.js';

// The seams the circulation core leaves for the modules that book charges (fines, replacement and processing fees,
// payments) and keep holds (reservations and the hold shelf). The core calls them at the moments those modules care
// about; until a module registers itself, the calls do nothing and answer "none", so the desk works without them.
//
// - Charges: a loan declared lost books the overdue fine up to that day, the replacement charge and the processing fee
//   (each a charge of its own); an item recorded lost that comes back cancels the unpaid part of its lost charge; a loan
//   with any charge cannot be voided; a clearance letter needs a balance of zero.
// - Holds: voiding a loan that fulfilled a hold gives the hold back (ready again, with its item and pickup day); a
//   clearance letter is refused while a hold of the member waits on the hold shelf.
//
// Every call runs inside the caller's transaction, after the caller's locks (item, record, member), so a module that
// writes charges or holds there keeps the global lock order.

/** What the circulation core asks of the charges module. */
export interface CirculationChargeSeam {
  /**
   * Books the overdue fine of the loan `loanId` for the days late up to `until` (a loan declared lost); 0 days or a rule
   * without fines books nothing.
   */
  bookOverdue(tx: TxCtx, input: { loanId: string; until: string }): Promise<void>;
  /** Books the replacement charge of a loan closed as lost, and the processing fee as a charge of its own when > 0. */
  bookLost(
    tx: TxCtx,
    input: { loanId: string; memberId: string; branchId: string; itemId: string; replacementMinor: number; processingFeeMinor: number; currency: string },
  ): Promise<void>;
  /** Cancels the unpaid part of the lost charge of the loan `loanId`: its item came back. */
  cancelLost(tx: TxCtx, input: { loanId: string; reason: 'item_returned' }): Promise<void>;
  /** Whether the loan `loanId` has any charge. */
  loanHasCharges(db: Db, loanId: string): Promise<boolean>;
  /** The unpaid balance (minor units) of each of the members `memberIds` that has one. */
  balances(db: Db, memberIds: readonly string[]): Promise<Map<string, number>>;
}

/** What the circulation core asks of the holds module. */
export interface CirculationHoldSeam {
  /** A voided loan gives back the hold it fulfilled (ready again); the hold's id, or null when it fulfilled none. */
  restoreFulfilledHold(tx: TxCtx, input: { loanId: string }): Promise<string | null>;
  /** The members among `memberIds` that have a hold ready on the hold shelf. */
  membersWithReadyHolds(db: Db, memberIds: readonly string[]): Promise<Set<string>>;
}

const NO_CHARGES: CirculationChargeSeam = Object.freeze({
  bookOverdue: async () => undefined,
  bookLost: async () => undefined,
  cancelLost: async () => undefined,
  loanHasCharges: async () => false,
  balances: async () => new Map<string, number>(),
});

const NO_HOLDS: CirculationHoldSeam = Object.freeze({
  restoreFulfilledHold: async () => null,
  membersWithReadyHolds: async () => new Set<string>(),
});

let charges: CirculationChargeSeam | null = null;
let holds: CirculationHoldSeam | null = null;

/** Plugs the charges module in (null takes it out again, for tests). */
export function registerCirculationChargeSeam(seam: CirculationChargeSeam | null): void {
  charges = seam;
}

/** Plugs the holds module in (null takes it out again, for tests). */
export function registerCirculationHoldSeam(seam: CirculationHoldSeam | null): void {
  holds = seam;
}

/** The charges module, or the stand-in that books nothing and sees no charge. */
export function chargeSeam(): CirculationChargeSeam {
  return charges ?? NO_CHARGES;
}

/** Whether a charges module is plugged in (the lost route says whether the charges were booked). */
export function chargesInstalled(): boolean {
  return charges !== null;
}

/** The holds module, or the stand-in that sees no hold. */
export function holdSeam(): CirculationHoldSeam {
  return holds ?? NO_HOLDS;
}
