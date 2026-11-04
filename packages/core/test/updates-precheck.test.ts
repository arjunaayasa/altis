import type { ReleaseManifest } from '@altis/crypto';
import type { FeedEntry } from '@altis/crypto/feed';
import { isDomainError, type DomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { candidateOf, pickCandidate, type Candidate } from '../src/updates/candidate.js';
import { BOOT_PROTOCOL, PRECHECK_MIGRATION_MS, precheck, throwPrecheck, type PrecheckReport } from '../src/updates/precheck.js';

// The update prechecks (spec §9.6 step 2; plan Task 21; decisions D1d-32, D1d-43): SemVer above `active`,
// `minUpgradeFrom` (a stepping stone when not met), `bootProtocol`, `minNode`, `minDb` per engine (none for SQLite),
// the edition's entitlement (the seam: the community edition covers every release), no snapshot backup running; the estimate and the headroom; the "pemulihan DB
// diperlukan bila gagal" label when `active` < `minCodeVersionAfter`. And the choice of the release to offer from the
// feed (the highest one reachable from `active`, a stepping stone when a later one exists).

const MIN_DB = { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' };

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    version: '0.2.0-test',
    releasedAt: '2026-11-01',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { ...MIN_DB },
    size: 5_000_000,
    ...over,
  };
}

type Input = Parameters<typeof precheck>[0];

function input(over: Partial<Input> = {}): Input {
  return {
    active: '0.1.0-test',
    candidate: candidate(),
    nodeVersion: '22.16.0',
    db: { engine: 'mariadb', version: '10.6.21-MariaDB-ubu2004' },
    entitled: true,
    snapshotBackupRunning: false,
    backupEstimate: { bytes: 64 * 1024 * 1024, ms: 12_000 },
    pendingMigrations: 0,
    ...over,
  };
}

function entry(version: string, minUpgradeFrom: string, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    version,
    channel: 'stable',
    releasedAt: '2026-11-01',
    bootProtocol: 1,
    minUpgradeFrom,
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { ...MIN_DB },
    size: 1000,
    sha256: 'a'.repeat(64),
    url: `https://updates.example.test/stable/altis-${version}.zip`,
    notesUrl: null,
    ...over,
  };
}

function caught(fn: () => void): DomainError {
  try {
    fn();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('precheck', () => {
  it('all clear: ok, the estimate (backup + 30 s per migration), the headroom (size × 2 + backup)', () => {
    const r = precheck(input({ pendingMigrations: 3 }));
    expect(r).toEqual<PrecheckReport>({
      ok: true,
      failures: [],
      dbRestoreNeeded: false,
      estimateMs: 12_000 + 3 * PRECHECK_MIGRATION_MS,
      headroomBytes: 5_000_000 * 2 + 64 * 1024 * 1024,
      steppingStone: false,
      candidate: { version: '0.2.0-test', bootProtocol: 1, minUpgradeFrom: '0.0.0' },
      notEntitled: null,
    });
    expect(PRECHECK_MIGRATION_MS).toBe(30_000);
    expect(BOOT_PROTOCOL).toBe(1);
  });

  it('all clear with dbRestoreNeeded for active 0.2 and minCodeVersionAfter 0.3.0-test', () => {
    const r = precheck(input({ active: '0.2.0-test', candidate: candidate({ version: '0.3.0-test', minCodeVersionAfter: '0.3.0-test' }) }));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.dbRestoreNeeded).toBe(true);
    // Active at the floor already: no restore needed when the update fails.
    expect(precheck(input({ active: '0.3.0-test', candidate: candidate({ version: '0.4.0-test', minCodeVersionAfter: '0.3.0-test' }) })).dbRestoreNeeded).toBe(false);
  });

  it('candidate 0.2 against active 0.2 → not_newer; an older candidate too', () => {
    expect(precheck(input({ active: '0.2.0-test' })).failures).toEqual(['not_newer']);
    expect(precheck(input({ active: '0.3.0-test' })).failures).toEqual(['not_newer']);
    // Pre-release precedence: 0.2.0 is above 0.2.0-test.
    expect(precheck(input({ active: '0.2.0-test', candidate: candidate({ version: '0.2.0' }) })).ok).toBe(true);
  });

  it('minUpgradeFrom 0.2.0-test against active 0.1 → min_upgrade_from; met exactly or above → passes', () => {
    const r = precheck(input({ candidate: candidate({ version: '0.3.0-test', minUpgradeFrom: '0.2.0-test' }) }));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['min_upgrade_from']);
    expect(r.candidate).toEqual({ version: '0.3.0-test', bootProtocol: 1, minUpgradeFrom: '0.2.0-test' });
    expect(precheck(input({ active: '0.2.0-test', candidate: candidate({ version: '0.3.0-test', minUpgradeFrom: '0.2.0-test' }) })).ok).toBe(true);
    // A floor that is not SemVer cannot be met: refused rather than guessed.
    expect(precheck(input({ candidate: candidate({ minUpgradeFrom: 'latest' }) })).failures).toEqual(['min_upgrade_from']);
  });

  it('bootProtocol 2 → boot_protocol', () => {
    expect(precheck(input({ candidate: candidate({ bootProtocol: 2 }) })).failures).toEqual(['boot_protocol']);
  });

  it("minNode '24.0.0' on 22.16.0 → min_node; v-prefixed and equal versions pass", () => {
    expect(precheck(input({ candidate: candidate({ minNode: '24.0.0' }) })).failures).toEqual(['min_node']);
    expect(precheck(input({ nodeVersion: 'v22.16.0' })).ok).toBe(true);
    expect(precheck(input({ nodeVersion: '22.15.9' })).failures).toEqual(['min_node']);
    expect(precheck(input({ nodeVersion: '26.1.0', candidate: candidate({ minNode: '24.0.0' }) })).ok).toBe(true);
    // Numeric, not textual: 22.9 is below 22.16.
    expect(precheck(input({ nodeVersion: '22.9.0' })).failures).toEqual(['min_node']);
    // A version that cannot be read is refused, never assumed new enough.
    expect(precheck(input({ candidate: candidate({ minNode: 'lts' }) })).failures).toEqual(['min_node']);
  });

  it("minDb.mariadb '10.11.0' on MariaDB 10.6.21 → min_db; each engine reads its own floor", () => {
    const mariadb1011 = candidate({ minDb: { ...MIN_DB, mariadb: '10.11.0' } });
    expect(precheck(input({ candidate: mariadb1011, db: { engine: 'mariadb', version: '10.6.21' } })).failures).toEqual(['min_db']);
    // The 5.5.5- prefix MariaDB shows old clients is skipped.
    expect(precheck(input({ candidate: mariadb1011, db: { engine: 'mariadb', version: '5.5.5-10.11.6-MariaDB-log' } })).ok).toBe(true);
    // MySQL reads minDb.mysql, not the MariaDB floor.
    expect(precheck(input({ candidate: mariadb1011, db: { engine: 'mysql', version: '8.0.36-0ubuntu0.22.04.1' } })).ok).toBe(true);
    expect(precheck(input({ candidate: candidate({ minDb: { ...MIN_DB, mysql: '8.4.0' } }), db: { engine: 'mysql', version: '8.0.36' } })).failures).toEqual(['min_db']);
    // PostgreSQL's server_version has two numbers and maybe a distribution suffix.
    expect(precheck(input({ db: { engine: 'postgres', version: '15.10 (Debian 15.10-1.pgdg120+1)' } })).ok).toBe(true);
    expect(precheck(input({ candidate: candidate({ minDb: { ...MIN_DB, postgres: '16.0.0' } }), db: { engine: 'postgres', version: '15.10' } })).failures).toEqual(['min_db']);
    // An engine version that cannot be read is refused.
    expect(precheck(input({ db: { engine: 'mysql', version: 'unknown' } })).failures).toEqual(['min_db']);
  });

  it('SQLite has no minDb: whatever the floors say', () => {
    const odd = candidate({ minDb: { mysql: '99.0.0', mariadb: 'x', postgres: '99' } });
    expect(precheck(input({ candidate: odd, db: { engine: 'sqlite', version: '3.50.4' } })).ok).toBe(true);
  });

  it('the seam: entitled false (an edition that does not cover the release) → entitlement; released_after when signed, else no_license', () => {
    const r = precheck(input({ entitled: false }));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['entitlement']);
    expect(r.notEntitled).toBe('no_license');
    expect(precheck(input({ entitled: false, signed: true })).notEntitled).toBe('released_after');
    expect(precheck(input({ signed: true })).notEntitled).toBeNull();
  });

  it('a snapshot backup running → snapshot_backup', () => {
    expect(precheck(input({ snapshotBackupRunning: true })).failures).toEqual(['snapshot_backup']);
  });

  it('every failure at once, in the order of §9.6 (entitlement before the snapshot backup)', () => {
    const r = precheck(
      input({
        active: '0.2.0-test',
        candidate: candidate({ version: '0.2.0-test', minUpgradeFrom: '0.3.0-test', bootProtocol: 2, minNode: '24.0.0', minDb: { ...MIN_DB, mariadb: '11.4.0' } }),
        entitled: false,
        snapshotBackupRunning: true,
      }),
    );
    expect(r.failures).toEqual(['not_newer', 'min_upgrade_from', 'boot_protocol', 'min_node', 'min_db', 'entitlement', 'snapshot_backup']);
    expect(r.ok).toBe(false);
  });

  it('steppingStone: the candidate is below the latest version the last check saw', () => {
    expect(precheck(input({ latest: '0.3.0-test' })).steppingStone).toBe(true);
    expect(precheck(input({ latest: '0.2.0-test' })).steppingStone).toBe(false);
    expect(precheck(input({ latest: null })).steppingStone).toBe(false);
  });

  it('refuses malformed numbers (a programming error)', () => {
    expect(() => precheck(input({ pendingMigrations: -1 }))).toThrow(TypeError);
    expect(() => precheck(input({ backupEstimate: { bytes: Number.NaN, ms: 0 } }))).toThrow(TypeError);
    expect(() => precheck(input({ candidate: candidate({ size: -5 }) }))).toThrow(TypeError);
    expect(() => precheck(input({ active: 'not-a-version' }))).toThrow(TypeError);
  });
});

describe('pickCandidate', () => {
  const feed = [entry('0.2.0-test', '0.1.0-test'), entry('0.3.0-test', '0.2.0-test')];

  it('[0.2 (from 0.1), 0.3 (from 0.2)] from 0.1 → target 0.2, latest 0.3, a stepping stone', () => {
    const r = pickCandidate(feed, '0.1.0-test');
    expect(r.target?.version).toBe('0.2.0-test');
    expect(r.latest?.version).toBe('0.3.0-test');
    expect(r.steppingStone).toBe(true);
  });

  it('the same feed from 0.2 → target 0.3, no stepping stone; the order of the feed does not matter', () => {
    const r = pickCandidate([...feed].reverse(), '0.2.0-test');
    expect(r.target?.version).toBe('0.3.0-test');
    expect(r.latest?.version).toBe('0.3.0-test');
    expect(r.steppingStone).toBe(false);
  });

  it('nothing newer → no target, no latest', () => {
    expect(pickCandidate(feed, '0.3.0-test')).toEqual({ target: null, latest: null, steppingStone: false });
    expect(pickCandidate([], '0.1.0-test')).toEqual({ target: null, latest: null, steppingStone: false });
  });

  it('a newer release none can reach from here → no target, but latest names it', () => {
    const r = pickCandidate([entry('0.3.0-test', '0.2.0-test')], '0.1.0-test');
    expect(r.target).toBeNull();
    expect(r.latest?.version).toBe('0.3.0-test');
    expect(r.steppingStone).toBe(false);
  });

  it('the highest reachable one wins over a lower reachable one', () => {
    const r = pickCandidate([entry('0.2.0-test', '0.0.0'), entry('0.2.1-test', '0.0.0'), entry('0.4.0-test', '0.3.0-test')], '0.1.0-test');
    expect(r.target?.version).toBe('0.2.1-test');
    expect(r.latest?.version).toBe('0.4.0-test');
    expect(r.steppingStone).toBe(true);
  });
});

describe('throwPrecheck', () => {
  const report = (over: Partial<PrecheckReport>): PrecheckReport => ({
    ok: false,
    failures: [],
    dbRestoreNeeded: false,
    estimateMs: 0,
    headroomBytes: 0,
    steppingStone: false,
    candidate: { version: '0.3.0-test', bootProtocol: 1, minUpgradeFrom: '0.2.0-test' },
    notEntitled: null,
    ...over,
  });

  it('a report without failures passes', () => {
    expect(() => throwPrecheck(report({ ok: true }))).not.toThrow();
  });

  it('the seam: an entitlement failure → 409 UPDATE_NOT_ENTITLED with the reason the edition named, worded for the edition', () => {
    const after = caught(() => throwPrecheck(precheck(input({ entitled: false, signed: true }))));
    expect(after.code).toBe('UPDATE_NOT_ENTITLED');
    expect(after.status).toBe(409);
    expect(after.meta).toMatchObject({ reason: 'released_after', failures: ['entitlement'] });
    const none = caught(() => throwPrecheck(precheck(input({ entitled: false }))));
    expect(none.meta).toMatchObject({ reason: 'no_license', failures: ['entitlement'] });
    for (const e of [after, none]) {
      expect(e.detail).toContain('0.2.0-test');
      expect(e.detail).not.toMatch(/lisensi|licen[cs]e/i);
    }
  });

  it('min_upgrade_from → 409 UPDATE_PRECHECK_FAILED whose detail names the stepping stone 0.2.0-test', () => {
    const r = precheck(input({ candidate: candidate({ version: '0.3.0-test', minUpgradeFrom: '0.2.0-test' }) }));
    const e = caught(() => throwPrecheck(r));
    expect(e.code).toBe('UPDATE_PRECHECK_FAILED');
    expect(e.status).toBe(409);
    expect(e.meta).toMatchObject({ reason: 'min_upgrade_from', failures: ['min_upgrade_from'] });
    expect(e.detail).toContain('0.2.0-test');
    expect(e.detail).toContain('0.3.0-test');
  });

  it('boot_protocol → the detail names the manual zip upgrade', () => {
    const e = caught(() => throwPrecheck(precheck(input({ candidate: candidate({ bootProtocol: 2 }) }))));
    expect(e.code).toBe('UPDATE_PRECHECK_FAILED');
    expect(e.meta).toMatchObject({ reason: 'boot_protocol', failures: ['boot_protocol'] });
    expect(e.detail).toMatch(/zip/);
    expect(e.detail).toMatch(/manual/i);
  });

  it('the first failure is the reason and meta.failures lists them all; entitlement first → UPDATE_NOT_ENTITLED', () => {
    const e = caught(() => throwPrecheck(report({ failures: ['min_node', 'entitlement', 'snapshot_backup'] })));
    expect(e.code).toBe('UPDATE_PRECHECK_FAILED');
    expect(e.meta).toMatchObject({ reason: 'min_node', failures: ['min_node', 'entitlement', 'snapshot_backup'] });
    const n = caught(() => throwPrecheck(report({ failures: ['entitlement', 'snapshot_backup'], notEntitled: 'released_after' })));
    expect(n.code).toBe('UPDATE_NOT_ENTITLED');
    expect(n.meta).toMatchObject({ reason: 'released_after', failures: ['entitlement', 'snapshot_backup'] });
  });
});

describe('candidateOf', () => {
  const manifest: ReleaseManifest = {
    version: '0.2.0-test',
    buildId: 'abc123',
    bootProtocol: 1,
    releasedAt: '2026-11-01',
    schemaLatest: '9001',
    minCodeVersionAfter: '0.0.0',
    minUpgradeFrom: '0.0.0',
    minNode: '22.16.0',
    minDb: { ...MIN_DB },
    files: [{ path: 'server.mjs', sha256: 'b'.repeat(64), size: 10 }],
  };

  it('takes the manifest’s facts, its schemaLatest and the given size', () => {
    expect(candidateOf(manifest, 1234)).toEqual<Candidate>({
      version: '0.2.0-test',
      releasedAt: '2026-11-01',
      bootProtocol: 1,
      minUpgradeFrom: '0.0.0',
      minCodeVersionAfter: '0.0.0',
      minNode: '22.16.0',
      minDb: { ...MIN_DB },
      size: 1234,
      schemaLatest: '9001',
    });
  });

  it('a feed entry is a Candidate as it is (no schemaLatest)', () => {
    const c: Candidate = entry('0.2.0-test', '0.0.0');
    expect(precheck(input({ candidate: c })).ok).toBe(true);
  });

  it('refuses a size that is not a whole number of bytes', () => {
    expect(() => candidateOf(manifest, -1)).toThrow(TypeError);
    expect(() => candidateOf(manifest, 1.5)).toThrow(TypeError);
  });
});
