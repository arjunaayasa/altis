import type { ReleaseManifest } from '@altis/crypto';
import type { FeedEntry } from '@altis/crypto/feed';
import { compareSemver, isSemver } from '@altis/shared';

// The release an update would install (spec §9.6; plan Task 21; decision D1d-43).
//
// A Candidate holds what the prechecks judge: the facts the signed release manifest states and the feed entry repeats
// (version, releasedAt, bootProtocol, minUpgradeFrom, minCodeVersionAfter, minNode, minDb), plus the package's size.
// A feed entry is a Candidate as it is (§9.6: its values must equal the manifest's, which extraction checks); an
// offline package or a bundled release gets one from its verified manifest (`candidateOf`), with `schemaLatest`.

/** What the prechecks judge about one release. */
export type Candidate = {
  version: string;
  /** `YYYY-MM-DD`: what the edition's entitlement judges (EditionCheck.notEntitled; community: always entitled). */
  releasedAt: string;
  bootProtocol: number;
  minUpgradeFrom: string;
  minCodeVersionAfter: string;
  minNode: string;
  minDb: { mysql: string; mariadb: string; postgres: string };
  /** Bytes of the package (a bundled folder: the sum of its manifest's file sizes, preflight S9). */
  size: number;
  /** The manifest's `schemaLatest`; a feed entry does not carry it. */
  schemaLatest?: string;
};

/**
 * The candidate of a verified release manifest `m` whose package is `size` bytes (for a bundled folder, the sum of the
 * manifest's file sizes).
 *
 * @throws TypeError when `size` is not a non-negative safe integer
 */
export function candidateOf(m: ReleaseManifest, size: number): Candidate {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`candidateOf: size must be a whole number of bytes, got ${String(size)}`);
  return {
    version: m.version,
    releasedAt: m.releasedAt,
    bootProtocol: m.bootProtocol,
    minUpgradeFrom: m.minUpgradeFrom,
    minCodeVersionAfter: m.minCodeVersionAfter,
    minNode: m.minNode,
    minDb: { mysql: m.minDb.mysql, mariadb: m.minDb.mariadb, postgres: m.minDb.postgres },
    size,
    schemaLatest: m.schemaLatest,
  };
}

/**
 * Whether `active` meets the release's `minUpgradeFrom` (`active ≥ minUpgradeFrom`). A floor that is not SemVer cannot
 * be met: it is refused, never guessed.
 */
export function reachableFrom(minUpgradeFrom: string, active: string): boolean {
  return isSemver(minUpgradeFrom) && compareSemver(active, minUpgradeFrom) >= 0;
}

/**
 * The release of the feed to offer to an installation running `active` (spec §9.6 step 1, decision D1d-43):
 * - `latest`: the highest entry above `active`, or null when none is newer;
 * - `target`: the highest entry above `active` that `active` meets the `minUpgradeFrom` of, or null;
 * - `steppingStone`: `target` is below `latest`, so another update follows it.
 * The order of `entries` does not matter (the feed lists each version once).
 *
 * @throws TypeError when `active` is not SemVer
 */
export function pickCandidate(
  entries: readonly FeedEntry[],
  active: string,
): { target: FeedEntry | null; latest: FeedEntry | null; steppingStone: boolean } {
  if (!isSemver(active)) throw new TypeError(`pickCandidate: active must be SemVer, got ${JSON.stringify(active)}`);
  let latest: FeedEntry | null = null;
  let target: FeedEntry | null = null;
  for (const e of entries) {
    if (compareSemver(e.version, active) <= 0) continue;
    if (latest === null || compareSemver(e.version, latest.version) > 0) latest = e;
    if (reachableFrom(e.minUpgradeFrom, active) && (target === null || compareSemver(e.version, target.version) > 0)) target = e;
  }
  const steppingStone = target !== null && latest !== null && compareSemver(target.version, latest.version) < 0;
  return { target, latest, steppingStone };
}
