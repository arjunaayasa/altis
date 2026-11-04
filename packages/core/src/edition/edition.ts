import type { DbHandle } from '@altis/db';
import { EDITION_COMMUNITY } from '@altis/shared';
import { errorFields, type CoreLogger } from '../context.js';
import { clearClockAnomaly } from '../scheduler/clock.js';

// The edition seam (ruling R1). The community edition enforces nothing: every check answers COMMUNITY_EDITION, every
// release is entitled, and nothing reads or writes the licence state table. The server asks the edition only through
// this interface (the update precheck, the dashboard, Diagnostik, the feed's signed time), so a commercial edition
// replaces the implementation and leaves its callers alone.

/** What the running edition allows. Community: always active, unlimited, every release entitled. */
export interface EditionCheck {
  /** 'community' here; shown as "Edisi Komunitas". */
  readonly edition: string;
  /** 'active' here. A commercial edition may report other states; community code never branches on it. */
  readonly status: string;
  /** null when a release dated `releasedAt` (YYYY-MM-DD) may be installed, else why not. Community: always null. */
  notEntitled(releasedAt: string): 'no_license' | 'released_after' | null;
}

export interface EditionService {
  /** Never throws in community; needs no DB. */
  check(o?: { fresh?: boolean }): Promise<EditionCheck>;
  /** A signed time (the update feed's freshness issuedAt). Community: clears clock_anomaly only (spec §10.4). */
  observeSignedTime(t: { at: number; source: 'feed' }): Promise<void>;
  /** Drops any cached check. Community: no-op. */
  invalidate(): void;
}

export interface CommunityEditionOptions {
  db(): DbHandle | undefined;
  clock(): number;
  log: CoreLogger;
}

export const COMMUNITY_EDITION: EditionCheck = Object.freeze({
  edition: EDITION_COMMUNITY,
  status: 'active',
  notEntitled: () => null,
});

/**
 * The community edition. `check()` answers {@link COMMUNITY_EDITION} without touching the database or DATA_DIR;
 * `observeSignedTime` hands a signed time to clearClockAnomaly (spec §10.4: within ±5 minutes it clears an active
 * clock_anomaly), logging a failure instead of throwing it; `invalidate()` does nothing (there is no cache). Call
 * `observeSignedTime` outside any withTx callback (clearClockAnomaly opens its own transaction).
 */
export function createCommunityEdition(o: CommunityEditionOptions): EditionService {
  const { log } = o;

  async function check(): Promise<EditionCheck> {
    return COMMUNITY_EDITION;
  }

  /** @throws TypeError unless `t.at` is a safe non-negative integer (epoch ms) and `t.source` is 'feed' */
  async function observeSignedTime(t: { at: number; source: 'feed' }): Promise<void> {
    if (typeof t !== 'object' || t === null || !Number.isSafeInteger(t.at) || t.at < 0) {
      throw new TypeError('observeSignedTime: at must be a safe non-negative integer (epoch ms)');
    }
    if (t.source !== 'feed') throw new TypeError('observeSignedTime: source must be feed');
    const h = o.db();
    if (h === undefined) return;
    try {
      await clearClockAnomaly(h, { now: o.clock(), trustedTime: t.at, source: 'feed' });
    } catch (error) {
      log.warn('clock_anomaly could not be cleared by a signed time', { source: 'feed', error: errorFields(error) });
    }
  }

  function invalidate(): void {}

  return { check, observeSignedTime, invalidate };
}
