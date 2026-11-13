import type { FixtureData } from './generate.js';

// Stub: replaced by a later change in this milestone.
// The changes a SLiMS library makes to its catalogue after a first migration (a changed record, a copy lost or weeded,
// a new title), applied to the plain fixture's data before the dump is written (index.ts), so a second run with the
// catalogue re-sync finds them; and how many source records and copies changed. Until it is written it changes
// nothing.

/** What the re-sync must find. */
export interface CatalogMutationExpected {
  /** The source records and copies that are new, changed or gone. */
  catalogChanges: number;
}

/** `data` after the library's later changes to its catalogue, and what the re-sync must find. */
export function mutateCatalogAfterFirstRun(data: FixtureData): { data: FixtureData; expected: CatalogMutationExpected } {
  return { data, expected: { catalogChanges: 0 } };
}
