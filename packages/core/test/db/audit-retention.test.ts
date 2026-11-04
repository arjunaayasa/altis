import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalize } from '@altis/crypto';
import { AUDIT_GENESIS_HASH, PHASE1_MIGRATIONS, auditAppend, countRows, runMigrations, verifyAuditChain, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { KyselyPlugin } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { anchorAudit } from '../../src/housekeeping/audit-anchor.js';
import { housekeepingJobs } from '../../src/housekeeping/handlers.js';
import { AUDIT_RETENTION_MS, purgeAudit } from '../../src/housekeeping/audit-retention.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';

// The audit jobs of Task 18 (spec §7.8; decision C24; L39, M5, M19) on the engine picked by ALTIS_TEST_DB:
// - `audit.retention` deletes a prefix of the log by seq, entries older than 2 years only, at most 10 % of the rows per
//   run, recording the last deleted entry as `audit.anchor` in each batch's transaction, then one `audit.purge` entry;
//   the chain still verifies from the anchor;
// - `audit.anchor` appends the head to `logs/audit-anchor.log` and verifies the chain incrementally into
//   `audit.verified`; a break notifies the holders of `system.audit.read` once.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

const DAY = 86_400_000;
const YEAR = 365 * DAY;

describe.skipIf(!ctx.available)(`audit retention and anchor [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let now: number;

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-audit-retention-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const t of ['audit_log', 'settings', 'jobs', 'notifications', 'events'] as const) await h.db.deleteFrom(t).execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: AUDIT_GENESIS_HASH }).where('id', '=', 1).execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-audit-retention-')));
    now = Date.now();
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  async function runJob(type: string): Promise<string> {
    const reg = createJobRegistry(housekeepingJobs({ dataDir }));
    const { id } = await withTx(h, (trx) =>
      enqueue(trx, reg, { type, payload: { windowStart: now - DAY, windowEnd: now } }, { now, keyring }),
    );
    for (let slices = 0; ; slices += 1) {
      if (slices > 100) throw new Error(`${type}: no end after 100 slices`);
      const job = await claimById(h, reg, id, { worker: 'test', now });
      if (job === null) break;
      const result = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} });
      if (result.outcome !== 'continued') {
        expect(result, type).toMatchObject({ outcome: 'succeeded' });
        break;
      }
    }
    return (await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  }

  /**
   * Appends entries dated `ats` (in that order) as a valid chain, written in batches straight into the table (as
   * auditAppend would, without its four statements per entry), and moves audit_head to the last.
   */
  async function seedChain(ats: readonly number[]): Promise<void> {
    const head = await h.db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirstOrThrow();
    let seq = Number(head.last_seq);
    let prev = head.last_hash;
    for (let i = 0; i < ats.length; i += 500) {
      const rows = ats.slice(i, i + 500).map((at) => {
        seq += 1;
        const id = newId(at);
        const meta = { n: seq };
        const canonical = canonicalize({
          id,
          seq,
          at,
          actorType: 'system',
          actorId: null,
          action: 'settings.update',
          entity: null,
          entityId: null,
          branchId: null,
          ip: null,
          meta,
        });
        const hash = createHash('sha256').update(prev + canonical, 'utf8').digest('hex');
        const row = {
          id,
          seq,
          at,
          actor_type: 'system',
          actor_id: null,
          action: 'settings.update',
          entity: null,
          entity_id: null,
          branch_id: null,
          ip: null,
          meta: canonicalize(meta),
          prev_hash: prev,
          hash,
        };
        prev = hash;
        return row;
      });
      await h.db.insertInto('audit_log').values(rows).execute();
    }
    newId(); // the ULID clock back at the real time
    await h.db.updateTable('audit_head').set({ last_seq: seq, last_hash: prev }).where('id', '=', 1).execute();
  }

  const hashOf = async (seq: number): Promise<string> =>
    (await h.db.selectFrom('audit_log').select('hash').where('seq', '=', seq).executeTakeFirstOrThrow()).hash;
  const anchor = async () => (await readSettings(h.db, ['audit.anchor'], []))['audit.anchor'] as { seq: number; hash: string } | null;
  const verified = async () => (await readSettings(h.db, ['audit.verified'], []))['audit.verified'];
  const purges = async () =>
    (await h.db.selectFrom('audit_log').select(['meta', 'actor_type']).where('action', '=', 'audit.purge').orderBy('seq').execute()).map((r) => ({
      actor: r.actor_type,
      meta: JSON.parse(r.meta) as Record<string, unknown>,
    }));
  const minSeq = async (): Promise<number> =>
    Number((await h.db.selectFrom('audit_log').select((eb) => eb.fn.min('seq').as('m')).executeTakeFirstOrThrow()).m);

  describe('audit.retention', () => {
    it('keeps 2 years (730 days)', () => {
      expect(AUDIT_RETENTION_MS).toBe(730 * DAY);
    });

    it('5000 entries 3 years old and 5000 recent: 1000, then 900, then on until only the recent ones are left; the chain verifies from the anchor', async () => {
      await seedChain([...Array.from({ length: 5000 }, () => now - 3 * YEAR), ...Array.from({ length: 5000 }, () => now - DAY)]);
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 10_000 });
      const hash1000 = await hashOf(1000);
      const hash1900 = await hashOf(1900);

      expect(await runJob('audit.retention')).toBe('succeeded');
      expect(await countRows(h.db.selectFrom('audit_log').where('action', '=', 'settings.update'))).toBe(9000);
      expect(await minSeq()).toBe(1001);
      expect(await anchor()).toEqual({ seq: 1000, hash: hash1000 });
      const a = (await anchor())!;
      expect(await verifyAuditChain(h, { anchor: a })).toEqual({ ok: true, head: 10_001 });
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
      expect(await purges()).toEqual([{ actor: 'system', meta: { deleted: 1000, anchorSeq: 1000 } }]);

      // 10 % of the 9001 rows left (9000 and the purge entry): 900.
      expect(await runJob('audit.retention')).toBe('succeeded');
      expect(await minSeq()).toBe(1901);
      expect(await anchor()).toEqual({ seq: 1900, hash: hash1900 });
      expect((await purges()).map((p) => p.meta)).toEqual([
        { deleted: 1000, anchorSeq: 1000 },
        { deleted: 900, anchorSeq: 1900 },
      ]);

      for (let run = 0; run < 30 && (await minSeq()) <= 5000; run += 1) {
        expect(await runJob('audit.retention')).toBe('succeeded');
        expect(await countRows(h.db.selectFrom('audit_log').where('at', '=', now - DAY))).toBe(5000);
      }
      expect(await minSeq()).toBe(5001);
      expect(await anchor()).toMatchObject({ seq: 5000 });
      expect(await verifyAuditChain(h, { anchor: (await anchor())! })).toMatchObject({ ok: true });
      // Nothing old left: a run deletes nothing and writes no purge entry.
      const before = (await purges()).length;
      expect(await runJob('audit.retention')).toBe('succeeded');
      expect(await purges()).toHaveLength(before);
      expect(await minSeq()).toBe(5001);
    });

    it('deletes a prefix only: it stops at the first entry not older than 2 years (exactly 2 years is kept)', async () => {
      const cutoff = now - AUDIT_RETENTION_MS;
      await seedChain([
        ...Array.from({ length: 10 }, () => cutoff - 1),
        cutoff,
        ...Array.from({ length: 9 }, () => cutoff - YEAR),
        ...Array.from({ length: 80 }, () => now - DAY),
      ]);
      expect(await runJob('audit.retention')).toBe('succeeded'); // 10 % of 100
      expect(await minSeq()).toBe(11);
      expect(await runJob('audit.retention')).toBe('succeeded');
      expect(await minSeq()).toBe(11);
      expect(await anchor()).toMatchObject({ seq: 10 });
      expect(await purges()).toHaveLength(1);
    });

    // 25 000 entries 3 years old: a run may delete 2500 (10 %), in batches of 1000.
    const bigOldLog = () => seedChain(Array.from({ length: 25_000 }, () => now - 3 * YEAR));
    const passed = () => Date.now() - 1; // a slice deadline already passed: the slice runs its first batch only

    it('each slice that deleted entries records them in its last batch, so a run stopped early (clock_anomaly) loses none', async () => {
      await bigOldLog();
      const first = await purgeAudit(h, { now, from: null, deadline: passed() });
      expect(first).toMatchObject({ deleted: 1000, anchorSeq: 1000, next: { limit: 2500, deleted: 1000 } });
      expect(await purges()).toEqual([{ actor: 'system', meta: { deleted: 1000, anchorSeq: 1000 } }]);
      // The clock looks wrong now: the next slice of the run ends without deleting. The 1000 stay recorded.
      await withTx(h, (trx) =>
        writeSettings(trx, { 'system.clock_anomaly': { detectedAt: now, maxSeen: now + DAY } }, { keyring, now, actorId: null }),
      );
      const reg = createJobRegistry(housekeepingJobs({ dataDir }));
      const { id } = await withTx(h, (trx) =>
        enqueue(trx, reg, { type: 'audit.retention', payload: { windowStart: now - DAY, windowEnd: now, purge: first.next } }, { now, keyring }),
      );
      const job = await claimById(h, reg, id, { worker: 'test', now });
      expect(await runSlice(h, reg, job!, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} })).toMatchObject({
        outcome: 'succeeded',
      });
      expect(await minSeq()).toBe(1001);
      expect(await purges()).toEqual([{ actor: 'system', meta: { deleted: 1000, anchorSeq: 1000 } }]);
    });

    it('a slice replayed from its checkpoint (killed after its batches committed) never takes the run past its 10 %', async () => {
      await bigOldLog();
      const first = await purgeAudit(h, { now, from: null, deadline: passed() });
      expect(await minSeq()).toBe(1001);
      // Slice 2 commits a batch, and the process dies before the slice's result is stored ...
      await purgeAudit(h, { now, from: first.next, deadline: passed() });
      expect(await minSeq()).toBe(2001);
      // ... so the slice runs again from the same checkpoint, to the end of the run.
      expect(await purgeAudit(h, { now, from: first.next })).toMatchObject({ next: null });
      expect(await minSeq()).toBe(2501);
      expect(await anchor()).toMatchObject({ seq: 2500 });
      expect((await purges()).map((p) => p.meta)).toEqual([
        { deleted: 1000, anchorSeq: 1000 },
        { deleted: 1000, anchorSeq: 2000 },
        { deleted: 500, anchorSeq: 2500 },
      ]);
      expect(await verifyAuditChain(h, { anchor: (await anchor())! })).toMatchObject({ ok: true });
    });

    // 1d T18-AUDIT-RETENTION-CAP: a slice killed after its batches committed (P7: after run() resolved, before its
    // result was written, as the kill-mid-slice fault does) is run again from the checkpoint stored before it. The
    // run's cap is stored before any entry is deleted, so no replay recounts the log it has already shortened.
    it('10 000 old entries, every slice killed once after it ran: the run deletes exactly 1000 in all, with one audit.purge', async () => {
      await seedChain(Array.from({ length: 10_000 }, () => now - 3 * YEAR));
      const reg = createJobRegistry(housekeepingJobs({ dataDir }));
      const { id } = await withTx(h, (trx) =>
        enqueue(trx, reg, { type: 'audit.retention', payload: { windowStart: now - DAY, windowEnd: now } }, { now, keyring }),
      );
      const slice = async () => {
        const job = await claimById(h, reg, id, { worker: 'test', now });
        if (job === null) return null;
        return runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} });
      };
      const outcomes: string[] = [];
      for (let slices = 0; slices < 20; slices += 1) {
        // The slice runs, and its result is lost with the process: the job row is back as it was before the claim.
        const before = await h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
        const killed = await slice();
        expect(killed?.outcome).toMatch(/^(continued|succeeded)$/);
        await h.db.updateTable('jobs').set(before).where('id', '=', id).execute();
        // The slice runs again from that checkpoint, and this time its result is written.
        const r = await slice();
        outcomes.push(r!.outcome);
        if (r!.outcome !== 'continued') break;
      }
      expect(outcomes.at(-1)).toBe('succeeded');
      expect(await countRows(h.db.selectFrom('audit_log').where('action', '=', 'settings.update'))).toBe(9000);
      expect(await minSeq()).toBe(1001);
      expect(await anchor()).toEqual({ seq: 1000, hash: expect.any(String) });
      expect(await purges()).toEqual([{ actor: 'system', meta: { deleted: 1000, anchorSeq: 1000 } }]);
    });

    it('with system.clock_anomaly set it deletes nothing', async () => {
      await seedChain(Array.from({ length: 50 }, () => now - 3 * YEAR));
      await withTx(h, (trx) =>
        writeSettings(trx, { 'system.clock_anomaly': { detectedAt: now, maxSeen: now + DAY } }, { keyring, now, actorId: null }),
      );
      expect(await runJob('audit.retention')).toBe('succeeded');
      expect(await countRows(h.db.selectFrom('audit_log'))).toBe(50);
      expect(await anchor()).toBeNull();
    });
  });

  describe('audit.anchor', () => {
    const anchorLog = (): Promise<string> => fsp.readFile(path.join(dataDir, 'logs', 'audit-anchor.log'), 'utf8').catch(() => '');
    const append = (n: number) =>
      withTx(h, async (trx) => {
        for (let i = 0; i < n; i += 1) {
          await auditAppend(trx, { at: now, actorType: 'system', actorId: null, action: 'settings.update', entity: null, entityId: null, branchId: null, ip: null, meta: { i } });
        }
      });
    const broken = () =>
      h.db.selectFrom('notifications').select(['type', 'title_key', 'audience_permission', 'params', 'link']).where('type', '=', 'audit.broken').execute();

    it('one log line per run with the head’s seq and hash; audit.verified = {ok: true, head}; a tampered entry → ok: false and one notification', async () => {
      await append(5);
      const head5 = await hashOf(5);
      expect(await runJob('audit.anchor')).toBe('succeeded');
      expect((await anchorLog()).trim().split('\n').map((l) => JSON.parse(l) as unknown)).toEqual([{ at: now, seq: 5, hash: head5 }]);
      expect(await verified()).toEqual({ at: now, ok: true, head: 5, headHash: head5, brokenAt: null });

      expect(await runJob('audit.anchor')).toBe('succeeded');
      expect((await anchorLog()).trim().split('\n')).toHaveLength(2);
      expect(await broken()).toEqual([]);

      // New entries, one of them changed afterwards: the incremental walk from seq 5 finds it.
      await append(3);
      await h.db.updateTable('audit_log').set({ meta: '{"i":99}' }).where('seq', '=', 7).execute();
      expect(await runJob('audit.anchor')).toBe('succeeded');
      const lines = (await anchorLog()).trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[2]!)).toEqual({ at: now, seq: 8, hash: await hashOf(8) });
      expect(await verified()).toEqual({ at: now, ok: false, head: 5, headHash: head5, brokenAt: 7 });
      expect(await broken()).toEqual([
        {
          type: 'audit.broken',
          title_key: 'notification.audit_broken.title',
          audience_permission: 'system.audit.read',
          params: '{"seq":7}',
          link: '/admin/audit',
        },
      ]);
      // Still broken at the same entry: no second notification.
      expect(await runJob('audit.anchor')).toBe('succeeded');
      expect(await broken()).toHaveLength(1);
    });

    it('is a heavy job (never piggybacked; one process at a time) that keeps its lease through a long walk', async () => {
      const handler = housekeepingJobs({ dataDir }).find((j) => j.type === 'audit.anchor');
      expect(handler).toMatchObject({ cpuHeavy: true });
      await seedChain(Array.from({ length: 250 }, () => now - DAY));
      let beats = 0;
      const { verified: v } = await anchorAudit(h, { dataDir, now, heartbeat: async () => void (beats += 1) });
      expect(v).toMatchObject({ ok: true, head: 250 });
      expect(beats).toBe(2); // between the batches of 100 rows
    });

    // 1d T18-AUDIT-ANCHOR-BUDGET: a first walk (or one after a break or a restore) of a long log fits P9's slices. A
    // fake performance.now moves 1 s with every batch of 100 entries the walk reads (the job's handle counts them;
    // other readers of the clock do not move it): the job sets its deadline 18 s ahead (a 20 s slice less its
    // margin), and the walk stops after the batch that passes it, so a slice walks 1800 entries.
    describe('in slices', () => {
      let batches: number;
      const counting: KyselyPlugin = {
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (result.rows.length > 0 && Object.hasOwn(result.rows[0]!, 'prev_hash')) batches += 1;
          return result;
        },
      };
      beforeEach(() => {
        batches = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => 1000 * batches);
      });
      afterEach(() => {
        vi.restoreAllMocks();
      });

      /** The anchor job run slice by slice to its end: each slice's outcome and the payload it left. */
      async function anchorSlices(): Promise<{ outcomes: string[]; payloads: unknown[]; verifiedBetween: unknown[] }> {
        const reg = createJobRegistry(housekeepingJobs({ dataDir }));
        const { id } = await withTx(h, (trx) =>
          enqueue(trx, reg, { type: 'audit.anchor', payload: { windowStart: now - DAY, windowEnd: now } }, { now, keyring }),
        );
        const outcomes: string[] = [];
        const payloads: unknown[] = [];
        const verifiedBetween: unknown[] = [];
        for (;;) {
          if (outcomes.length > 20) throw new Error('audit.anchor: no end after 20 slices');
          const job = await claimById(h, reg, id, { worker: 'test', now });
          if (job === null) break;
          const walking = { ...h, db: h.db.withPlugin(counting) };
          const r = await runSlice(walking, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} });
          outcomes.push(r.outcome);
          if (r.outcome !== 'continued') break;
          const row = await h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow();
          payloads.push(JSON.parse(row.payload) as unknown);
          verifiedBetween.push(await verified());
        }
        return { outcomes, payloads, verifiedBetween };
      }

      it('5000 entries: three slices, each continuing from the last entry it verified; audit.verified = {ok: true, head: 5000} only after the third', async () => {
        await seedChain(Array.from({ length: 5000 }, () => now - DAY));
        const run = await anchorSlices();
        expect(run.outcomes).toEqual(['continued', 'continued', 'succeeded']);
        const window = { windowStart: now - DAY, windowEnd: now };
        expect(run.payloads).toEqual([
          { ...window, from: { seq: 1800, hash: await hashOf(1800) }, walk: 'anchor' },
          { ...window, from: { seq: 3600, hash: await hashOf(3600) }, walk: 'anchor' },
        ]);
        expect(run.verifiedBetween).toEqual([null, null]);
        expect(await verified()).toEqual({ at: now, ok: true, head: 5000, headHash: await hashOf(5000), brokenAt: null });
        // One log line for the run (written by its first slice).
        expect((await anchorLog()).trim().split('\n')).toHaveLength(1);
        expect(await broken()).toEqual([]);
      });

      it('entry 4000 tampered: the third slice finds it, brokenAt 4000 and one notification; the next run finds it again without a second one', async () => {
        await seedChain(Array.from({ length: 5000 }, () => now - DAY));
        await h.db.updateTable('audit_log').set({ meta: '{"n":-1}' }).where('seq', '=', 4000).execute();
        const first = await anchorSlices();
        expect(first.outcomes).toEqual(['continued', 'continued', 'succeeded']);
        // The last good entry is where the slice that found the break started.
        expect(await verified()).toEqual({ at: now, ok: false, head: 3600, headHash: await hashOf(3600), brokenAt: 4000 });
        expect(await broken()).toHaveLength(1);
        // The next run walks from entry 3600 (four batches, the last with the break), and in the same slice again from
        // the start of the chain, alone (the rest of the slice: 14 batches); the same break, no second notification.
        const second = await anchorSlices();
        expect(second.outcomes).toEqual(['continued', 'continued', 'succeeded']);
        expect(second.payloads).toMatchObject([
          { from: { seq: 1400 }, walk: 'anchor' },
          { from: { seq: 3200 }, walk: 'anchor' },
        ]);
        expect(await verified()).toEqual({ at: now, ok: false, head: 3600, headHash: await hashOf(3600), brokenAt: 4000 });
        expect(await broken()).toHaveLength(1);
      });
    });

    it('after a retention purge the walk starts at the anchor', async () => {
      await seedChain([...Array.from({ length: 100 }, () => now - 3 * YEAR), ...Array.from({ length: 10 }, () => now - DAY)]);
      expect(await runJob('audit.retention')).toBe('succeeded');
      expect(await anchor()).toMatchObject({ seq: 11 });
      expect(await runJob('audit.anchor')).toBe('succeeded');
      expect(await verified()).toMatchObject({ ok: true, head: 111, brokenAt: null });
    });
  });
});
