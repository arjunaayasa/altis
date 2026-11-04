import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, type IpTrust } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import { IP_TRUST_MIN_SESSIONS, IP_TRUST_RECOVERY_MIN_SESSIONS, ipTrustJob, refreshIpTrust } from '../../src/diagnostics/ip-trust.js';
import type { JobContext } from '../../src/jobs/types.js';
import { scheduleWindowSchema } from '../../src/scheduler/registry.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import { sha256hex } from '../../src/crypto/tokens.js';

// The P15 dominance rule of `diagnostics.ip_trust` (hourly; decision C22; 1b deferred it to 1c) on the engine picked by
// ALTIS_TEST_DB: of the staff sessions created in the last 24 h, at least 20 with one IP above 90 % → every visitor
// shares the proxy's address, `system.ip_trust = 'collapsed'` (never over `spoofable`); once that dominance is gone
// (at least 5 sessions while collapsed, so that a small library recovers) → `ok`. Otherwise the setting stays.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 27, 10, 13, 0);
const HOUR = 3_600_000;
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`ip_trust from session dominance [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let staffId: string;

  const trust = async (): Promise<IpTrust> => (await readSettings(h.db, ['system.ip_trust'], []))['system.ip_trust'] as IpTrust;
  const setTrust = (value: IpTrust) =>
    withTx(h, (trx) => writeSettings(trx, { 'system.ip_trust': value }, { keyring: [], now: NOW, actorId: null }));

  /** `count` sessions created at `at` from `ip`. */
  async function sessions(count: number, ip: string | null, at = NOW - HOUR): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await h.db
        .insertInto('sessions')
        .values({
          id: sha256hex(newId() + String(i)),
          subject_type: 'staff',
          subject_id: staffId,
          created_at: at,
          last_seen_at: at,
          expires_at: at + 12 * HOUR,
          ip,
          user_agent: null,
          reauth_at: null,
          remember_selector: null,
        })
        .execute();
    }
  }

  function jobCtx(): JobContext {
    return {
      jobId: newId(),
      mode: 'cron_cli',
      heartbeat: async () => {},
      cancelled: () => false,
      markPointOfNoReturn: async () => {},
      secretParam: async () => null,
      audit: async () => {},
      session: async () => {
        throw new Error('no session in this test');
      },
      db: h.db,
      handle: h,
      log: silent,
      now: () => NOW,
      budgetLeftMs: () => 20_000,
    };
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ip-trust-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: root, migrations: PHASE1_MIGRATIONS });
    staffId = newId();
    await h.db
      .insertInto('staff_users')
      .values({
        id: staffId,
        username_key: 'pustakawan',
        username_display: 'pustakawan',
        name: 'Pustakawan',
        email_key: null,
        email_display: null,
        password_hash: 'x',
        status: 'active',
        locale: null,
        totp_secret_enc: null,
        last_login_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('sessions').execute();
    await setTrust('ok');
  });

  it('25 sessions in 24 h, 24 of them from one IP (96 %) → collapsed', async () => {
    await sessions(24, '10.0.0.1');
    await sessions(1, '198.51.100.20');
    expect(await withTx(h, (trx) => refreshIpTrust(trx, NOW))).toBe('collapsed');
    expect(await trust()).toBe('collapsed');
  });

  it(`fewer than ${IP_TRUST_MIN_SESSIONS} sessions (10, all from one IP) → unchanged, whichever it was`, async () => {
    await sessions(10, '10.0.0.1');
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('ok');
    await setTrust('collapsed');
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('collapsed');
  });

  it(`collapsed on a small library: ${IP_TRUST_RECOVERY_MIN_SESSIONS}+ sessions with no IP above 90 % → ok (below that: unchanged)`, async () => {
    // A library with fewer than 20 sign-ins a day that collapsed once (setup day, from one desk) is not kept collapsed
    // for good: while collapsed, a smaller window is enough to show the dominance is gone.
    expect(IP_TRUST_RECOVERY_MIN_SESSIONS).toBe(5);
    await setTrust('collapsed');
    for (let i = 0; i < 4; i += 1) await sessions(1, `198.51.100.${i + 1}`);
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('collapsed');
    await h.db.deleteFrom('sessions').execute();
    for (let i = 0; i < 6; i += 1) await sessions(1, `198.51.100.${(i % 3) + 1}`);
    expect(await withTx(h, (trx) => refreshIpTrust(trx, NOW))).toBe('ok');
    expect(await trust()).toBe('ok');
    // `ok` is never turned into `collapsed` by fewer than 20 sessions, dominated or not.
    await h.db.deleteFrom('sessions').execute();
    await sessions(6, '10.0.0.1');
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('ok');
  });

  it('collapsed, later 25 sessions spread over 10 IPs → ok', async () => {
    await setTrust('collapsed');
    for (let i = 0; i < 25; i += 1) await sessions(1, `198.51.100.${(i % 10) + 1}`);
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('ok');
  });

  it('exactly 90 % is not above 90 %; sessions older than 24 h do not count', async () => {
    await sessions(18, '10.0.0.1');
    await sessions(2, '198.51.100.20');
    await sessions(30, '10.0.0.1', NOW - 25 * HOUR);
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('ok');
  });

  it('never over spoofable: dominated or not, spoofable stays (only the browser test clears it)', async () => {
    await setTrust('spoofable');
    await sessions(25, '10.0.0.1');
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('spoofable');
    await h.db.deleteFrom('sessions').execute();
    for (let i = 0; i < 25; i += 1) await sessions(1, `198.51.100.${i + 1}`);
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('spoofable');
  });

  it('sessions without an address count in the total, never as the dominant IP', async () => {
    await sessions(25, null);
    await withTx(h, (trx) => refreshIpTrust(trx, NOW));
    expect(await trust()).toBe('ok');
  });

  it('the hourly job: takes the scheduler window as its payload and applies the rule in one slice', async () => {
    const job = ipTrustJob();
    expect(job.type).toBe('diagnostics.ip_trust');
    expect(job.permission).toBe('system.diagnostics.manage');
    const window = scheduleWindowSchema.parse({ windowStart: NOW - HOUR, windowEnd: NOW });
    expect(job.payload.safeParse(window).success).toBe(true);
    await sessions(24, '10.0.0.1');
    await sessions(1, '198.51.100.20');
    expect(await job.run(jobCtx(), window)).toEqual({ done: true });
    expect(await trust()).toBe('collapsed');
  });
});
