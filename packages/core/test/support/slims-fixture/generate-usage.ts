import type { FixtureData, FixtureRow } from './generate.js';

// Stub: replaced by a later change in this milestone.
// The usage rows of the synthetic SLiMS fixture (the visitor log, the member types, the members' types and expiry,
// loans and their history over months), for the aggregate usage import, and the counts that import must find. Built
// from the plain fixture's data and merged into it before the dump is written (index.ts). Until it is written it adds
// nothing, and the fixture is the plain one.

/** What the usage rows cover (filled with the rows). */
export interface UsageFixtureOptions {
  /** The first month of the usage rows, `YYYY-MM`. */
  fromMonth?: string;
  /** How many months the usage rows cover. */
  months?: number;
}

/** What the aggregate import must count from the usage rows (filled with the rows). */
export type UsageFixtureExpected = Readonly<Record<string, unknown>>;

/** The rows to add per table, and what the import must count from them (null: no usage rows). */
export function generateUsage(
  data: FixtureData,
  o: UsageFixtureOptions,
): { rows: Readonly<Record<string, readonly FixtureRow[]>>; expected: UsageFixtureExpected | null } {
  void data;
  void o;
  return { rows: {}, expected: null };
}
