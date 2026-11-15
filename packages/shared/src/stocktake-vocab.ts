/**
 * The fixed vocabularies of stocktake (inventarisasi): a session's status, a copy's state in a session, what the
 * finish did to a copy, what a scan found, and where a session came from. Each list has a shared label
 * `vocab.<list>.<value>` in both languages: {@link STOCKTAKE_VOCAB_LISTS} is joined into `VOCAB_LISTS`
 * (catalog-vocab.ts), so `i18n/id.ts` checks at compile time that none is missing.
 *
 * No Node built-ins here: the browser bundles this module.
 */

/**
 * A session's status: `preparing` (the job lists the copies of its scope), `active` (scanning), `finishing` (the job
 * applies the finish), `finished`, `cancelled`. One session per branch may be preparing, active or finishing.
 */
export const STOCKTAKE_STATUSES = Object.freeze(['preparing', 'active', 'finishing', 'finished', 'cancelled'] as const);

export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];

/** The live statuses: one session of a branch at a time. */
export const STOCKTAKE_LIVE_STATUSES: readonly StocktakeStatus[] = Object.freeze(['preparing', 'active', 'finishing']);

/**
 * A copy's state in a session: `pending` (expected, not scanned yet), `on_loan` (expected, out on loan), `found`,
 * `misplaced` (found at another shelf than its own), `unexpected` (scanned, outside the scope).
 */
export const STOCKTAKE_STATES = Object.freeze(['pending', 'on_loan', 'found', 'misplaced', 'unexpected'] as const);

export type StocktakeState = (typeof STOCKTAKE_STATES)[number];

/**
 * What the finish did to a copy: `marked_missing` (pending, now missing), `restored` (found while missing or lost, now
 * available), `status_kept` (its status could not change that way), `none` (nothing to do).
 */
export const STOCKTAKE_RESULTS = Object.freeze(['marked_missing', 'restored', 'status_kept', 'none'] as const);

export type StocktakeResult = (typeof STOCKTAKE_RESULTS)[number];

/**
 * What one scan found: a pending copy now `found` or `misplaced`, a copy scanned before (`already_found`), a copy
 * recorded on loan (`on_loan`, nothing changes), a copy outside the scope (`unexpected`), a code that names no copy
 * (`unknown`).
 */
export const STOCKTAKE_SCAN_OUTCOMES = Object.freeze(['found', 'misplaced', 'already_found', 'on_loan', 'unexpected', 'unknown'] as const);

export type StocktakeScanOutcome = (typeof STOCKTAKE_SCAN_OUTCOMES)[number];

/** Where a session came from: made in ALTIS, or carried over by the SLiMS migration. */
export const STOCKTAKE_SOURCES = Object.freeze(['altis', 'migrated'] as const);

export type StocktakeSource = (typeof STOCKTAKE_SOURCES)[number];

/** The copy statuses a session's scope takes in (on order and withdrawn copies are not on the shelves). */
export const STOCKTAKE_ITEM_STATUSES = Object.freeze(['available', 'not_for_loan', 'repair', 'missing', 'lost', 'processing'] as const);

/** The lists with shared labels; spread into `VOCAB_LISTS` after the visits lists. */
export const STOCKTAKE_VOCAB_LISTS = Object.freeze({
  stocktake_status: STOCKTAKE_STATUSES,
  stocktake_state: STOCKTAKE_STATES,
  stocktake_result: STOCKTAKE_RESULTS,
  stocktake_scan: STOCKTAKE_SCAN_OUTCOMES,
  stocktake_source: STOCKTAKE_SOURCES,
});
