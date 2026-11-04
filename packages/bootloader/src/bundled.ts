import type { CurrentState } from '@altis/platform';
import { compareSemver } from '@altis/shared';

// A bundled release that differs from the one current.json runs (spec §9.8, decision D1d-24): a zip uploaded again, a
// new Docker image. At boot, app.js compares the release beside it (`bundled-release/<v>`) with `pending ?? active`:
//
//   newer, the `active` folder present, not pinned   → offer        (row 1: the server begins an update from `verified`)
//   newer, the `active` folder missing               → schema_hold  (row 3: the bundled release boots in `schemaHold`)
//   older or the same                                → none         (row 4: Diagnostik shows it)
//   the pinned version                               → none         (D1d-24: a pin blocks that version only)
//
// app.js only classifies; the precheck, the op and the generic exporter are the server's (Task 27).
//
// app.js bundles this module (ES2017, P1).

/** How the bundled release compares with `pending ?? active`. */
export type BundledRelation = 'newer' | 'same' | 'older';

/** What the boot does about it: nothing, hand it to the server as an offer, or boot it in `schemaHold`. */
export type BundledAction = 'none' | 'offer' | 'schema_hold';

/**
 * Classifies the bundled release `bundledVersion` (null: none beside app.js) against `pending ?? active` of `state`;
 * `activeDirExists` tells whether the folder of `active` exists (releaseDirExists).
 */
export function classifyBundled(
  state: CurrentState,
  bundledVersion: string | null,
  activeDirExists: boolean,
): { relation: BundledRelation | null; action: BundledAction } {
  if (bundledVersion === null) return { relation: null, action: 'none' };
  const base = state.pending !== null ? state.pending : state.active;
  const order = compareSemver(bundledVersion, base.version);
  if (order < 0) return { relation: 'older', action: 'none' };
  if (order === 0) return { relation: 'same', action: 'none' };
  if (state.pinned === bundledVersion) return { relation: 'newer', action: 'none' };
  return { relation: 'newer', action: activeDirExists ? 'offer' : 'schema_hold' };
}
