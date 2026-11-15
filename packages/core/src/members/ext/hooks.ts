import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';

// What other modules add to a member's personal-data actions, without this module knowing them: the rows they keep
// about a member (exported with the member's data), what they erase or unlink when the member is anonymised, the
// balance a member still owes (which blocks archiving and anonymising), and what the daily history anonymisation
// unlinks besides loans and visits. Each registry is append-only, one block per module, so a module that keeps member
// rows (holds, fines and payments, bookmarks, notices, the SLiMS migration's archive) registers itself here when it
// loads and nothing else changes. This file imports no other module, so any module may register here without a cycle.

type Db = Kysely<DB> | Transaction<DB>;

/** One section of a member's data export: `name` keys it in the JSON; `read` answers its rows (no other member's data). */
export interface MemberDataSection {
  name: string;
  read(db: Db, memberId: string): Promise<unknown[]>;
}

/**
 * One step of anonymising a member, run inside the anonymisation's transaction after the member's lock: it deletes the
 * member's rows of its module that only serve the member (bookmarks, queued notices, reset tokens) and empties the
 * free text that could name the member (notes, reasons), keeping counts, dates and amounts.
 */
export interface MemberErasureStep {
  name: string;
  run(tx: TxCtx, memberId: string): Promise<void>;
}

/** What a member owes in minor units (a module with charges answers the open balance; none: 0). */
export interface MemberBalanceProvider {
  name: string;
  balanceMinor(db: Db, memberId: string): Promise<number>;
}

/** One step of the daily history anonymisation another module registers: answers how many rows it changed in this batch. */
export interface HistoryAnonymizeStep {
  name: string;
  /**
   * One batch (at most 500 rows) of rows older than the cutoffs (null: that period is off), at `now`; 0 when none is
   * left.
   */
  run(trx: Transaction<DB>, cutoffs: { loansBefore: number | null; visitsBefore: number | null; now: number }): Promise<number>;
}

const sections: MemberDataSection[] = [];
const steps: MemberErasureStep[] = [];
const balances: MemberBalanceProvider[] = [];
const historySteps: HistoryAnonymizeStep[] = [];

/** Adds a section to the member data export (by a module at load time). */
export function registerMemberDataSection(section: MemberDataSection): void {
  if (sections.some((s) => s.name === section.name)) throw new TypeError(`member data section ${section.name} is registered already`);
  sections.push(section);
}

/** Adds a step to the anonymisation of a member (by a module at load time). */
export function registerMemberErasureStep(step: MemberErasureStep): void {
  if (steps.some((s) => s.name === step.name)) throw new TypeError(`member erasure step ${step.name} is registered already`);
  steps.push(step);
}

/** Adds a balance to what a member owes (by a module at load time). */
export function registerMemberBalanceProvider(provider: MemberBalanceProvider): void {
  if (balances.some((s) => s.name === provider.name)) throw new TypeError(`member balance provider ${provider.name} is registered already`);
  balances.push(provider);
}

/** Adds a step to the daily history anonymisation (by a module at load time); the steps run after the loans. */
export function registerHistoryAnonymizeStep(step: HistoryAnonymizeStep): void {
  if (historySteps.some((s) => s.name === step.name)) throw new TypeError(`history anonymize step ${step.name} is registered already`);
  historySteps.push(step);
}

/** The registered history steps, in registration order. */
export function historyAnonymizeSteps(): readonly HistoryAnonymizeStep[] {
  return historySteps;
}

/** The registered data sections, in registration order. */
export function memberDataSections(): readonly MemberDataSection[] {
  return sections;
}

/** The registered erasure steps, in registration order. */
export function memberErasureSteps(): readonly MemberErasureStep[] {
  return steps;
}

/** What the member owes, summed over the registered providers (0 without any). */
export async function memberBalanceMinor(db: Db, memberId: string): Promise<number> {
  let total = 0;
  for (const p of balances) total += await p.balanceMinor(db, memberId);
  return total;
}
