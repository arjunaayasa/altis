import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalize } from '@altis/crypto';
import { isDomainError, isUlid, newId, ulidTime } from '@altis/shared';
import { InsertQueryNode, UpdateQueryNode, sql, type KyselyPlugin, type OperationNode, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { AUDIT_GENESIS_HASH, auditAppend, verifyAuditChain, type AuditEntry } from '../src/audit.js';
import { runMigrations } from '../src/migrator.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import type { DB } from '../src/schema.js';
import { withTx } from '../src/tx.js';
import { runChildren } from './fixtures/children.js';

// The hash-chained audit log (spec §6.3 auditAppend, §7.8): appends inside the caller's transaction, seq taken from
// audit_head under its row lock, hash = sha256hex(prevHash + canonicalize({...})), and verifyAuditChain finding the
// first broken seq. On the real Phase 1 tables, on the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const SQLITE = ctx.engine === 'sqlite';

const GENESIS = '0'.repeat(64);

/** The hash of the brief, computed independently of audit.ts. */
function expectedHash(prevHash: string, row: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash + canonicalize(row), 'utf8').digest('hex');
}

/** A branch: entries carry a non-null branch id by default, so it is hashed and stored (CHAR(26) on PostgreSQL). */
const BRANCH = newId();

function entry(extra: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: 1_767_225_600_000,
    actorType: 'staff',
    actorId: newId(),
    action: 'settings.update',
    entity: 'settings',
    entityId: 'library.name',
    branchId: BRANCH,
    ip: '203.0.113.7',
    meta: { from: 'Perpustakaan A', to: 'Perpustakaan Ñ €' },
    ...extra,
  };
}

async function expectTypeError(p: Promise<unknown>, pattern: RegExp): Promise<TypeError> {
  const error = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toMatch(pattern);
  return error as TypeError;
}

describe('audit hash constants', () => {
  it('the genesis prev_hash is 64 zeros', () => {
    expect(AUDIT_GENESIS_HASH).toBe(GENESIS);
  });
});

describe.skipIf(!ctx.available)(`auditAppend / verifyAuditChain (spec §6.3, §7.8) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  /**
   * Server engines: h and one more handle, two pools of 8: up to 16 transactions at once, about what production
   * reaches (6 Passenger workers x 3 connections). SQLite: h only.
   */
  let handles: TestDbHandle[];
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    handles = [h];
    if (!SQLITE) handles.push(await testDb({ reset: false }));
  });

  afterAll(async () => {
    for (const x of (handles ?? []).slice(1)) await x.close();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: GENESIS }).where('id', '=', 1).execute();
  });

  const append = (e: AuditEntry, handle: TestDbHandle = h) => withTx(handle, (trx) => auditAppend(trx, e));

  async function rows() {
    return h.db.selectFrom('audit_log').selectAll().orderBy('seq').execute();
  }

  async function head() {
    return h.db.selectFrom('audit_head').select(['id', 'last_seq', 'last_hash']).execute();
  }

  async function appendMany(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await append(entry({ meta: { i } }));
  }

  // -------------------------------------------------------------------------------------------------------------
  describe('auditAppend', () => {
    it('writes seq 1 chained to the genesis hash, with the hash of the brief, and moves audit_head', async () => {
      const e = entry();
      const result = await append(e);
      expect(result.seq).toBe(1);
      expect(isUlid(result.id)).toBe(true);
      expect(ulidTime(result.id)).toBe(e.at); // id = newId(at)
      const hashed = {
        id: result.id,
        seq: 1,
        at: e.at,
        actorType: e.actorType,
        actorId: e.actorId,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        branchId: e.branchId,
        ip: e.ip,
        meta: e.meta,
      };
      expect(result.hash).toBe(expectedHash(GENESIS, hashed));
      expect(await rows()).toEqual([
        {
          id: result.id,
          seq: 1,
          at: e.at,
          actor_type: 'staff',
          actor_id: e.actorId,
          action: 'settings.update',
          entity: 'settings',
          entity_id: 'library.name',
          branch_id: BRANCH,
          ip: '203.0.113.7',
          meta: canonicalize(e.meta),
          prev_hash: GENESIS,
          hash: result.hash,
        },
      ]);
      expect(await head()).toEqual([{ id: 1, last_seq: 1, last_hash: result.hash }]);
    });

    it('chains each entry to the previous one', async () => {
      const first = await append(entry());
      const second = await append(entry({ actorId: null, entity: null, entityId: null, ip: null, meta: {} }));
      expect(second.seq).toBe(2);
      const [, row] = await rows();
      expect(row!.prev_hash).toBe(first.hash);
      expect(second.hash).toBe(
        expectedHash(first.hash, {
          id: second.id,
          seq: 2,
          at: row!.at,
          actorType: 'staff',
          actorId: null,
          action: 'settings.update',
          entity: null,
          entityId: null,
          branchId: BRANCH,
          ip: null,
          meta: {},
        }),
      );
      expect(await head()).toEqual([{ id: 1, last_seq: 2, last_hash: second.hash }]);
    });

    it("runs inside the caller's transaction: rolled back with it, no seq consumed", async () => {
      await append(entry());
      await expect(
        withTx(h, async (trx) => {
          await auditAppend(trx, entry());
          throw new Error('the action failed');
        }),
      ).rejects.toThrow('the action failed');
      expect(await rows()).toHaveLength(1);
      expect((await append(entry())).seq).toBe(2);
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 2 });
    });

    it('stores meta as canonical JSON (sorted keys, undefined members dropped) and the chain verifies', async () => {
      const meta = { z: 1, a: { y: [1, 'dua', null, true], b: 'ß' }, gone: undefined, emoji: '📚', n: -0, big: 1e21 };
      await append(entry({ meta }));
      const [row] = await rows();
      expect(row!.meta).toBe('{"a":{"b":"ß","y":[1,"dua",null,true]},"big":1e+21,"emoji":"📚","n":0,"z":1}');
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 1 });
    });

    it('accepts a non-ULID entityId of up to 191 characters (a settings key, a schedule name)', async () => {
      await append(entry({ entityId: 'é'.repeat(191) }));
      expect((await rows())[0]!.entity_id).toBe('é'.repeat(191));
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 1 });
    });

    it('needs a transaction', async () => {
      await expectTypeError(auditAppend(h.db as unknown as Transaction<DB>, entry()), /transaction/);
    });

    it('20 parallel appends, each in its own transaction on separate connections: seq exactly 1..20, chain ok', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => append(entry({ meta: { i } }), handles[i % handles.length])),
      );
      expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect((await rows()).map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 20 });
    });

    it('4 processes x 5 appends: seq exactly 1..20 with no gaps or duplicates, chain ok', async () => {
      const run = await runChildren<{ results: { id: string; seq: number; hash: string }[] }>(
        'audit-child.mjs',
        ['p0', 'p1', 'p2', 'p3'].map((tag) => ({ config: h.config, dataDir: h.dataDir, count: 5, tag, branchId: BRANCH })),
      );
      expect(run.codes).toEqual([0, 0, 0, 0]);
      const seqs = run.reports.flatMap((r) => r?.results.map((x) => x.seq) ?? []);
      expect(seqs.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      const stored = await rows();
      expect(stored.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(new Set(stored.map((r) => r.entity_id)).size).toBe(20);
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 20 });
    });

    it('throws STATE_CORRUPT when audit_head is missing, writing nothing', async () => {
      await h.db.deleteFrom('audit_head').execute();
      try {
        const error = await append(entry()).catch((e: unknown) => e);
        expect(isDomainError(error) && error.code === 'STATE_CORRUPT').toBe(true);
        expect((error as { meta?: unknown }).meta).toEqual({ reason: 'audit_head_missing' });
        expect(await rows()).toEqual([]);
      } finally {
        await h.db.insertInto('audit_head').values({ id: 1, last_seq: 0, last_hash: GENESIS }).execute();
      }
    });

    /** A plugin making the first statement matching `is` fail before it is sent. */
    const failing = (is: (node: OperationNode) => boolean): KyselyPlugin => {
      let failed = false;
      return {
        transformQuery({ node }) {
          if (!failed && is(node)) {
            failed = true;
            throw new Error('forced failure');
          }
          return node;
        },
        transformResult: async ({ result }) => result,
      };
    };
    const isAuditInsert = (n: OperationNode) => InsertQueryNode.is(n) && JSON.stringify(n.into).includes('audit_log');
    /** Step 4: the second UPDATE of audit_head in the call (the first is step 1). */
    const secondHeadUpdate = () => {
      let updates = 0;
      return (n: OperationNode) => UpdateQueryNode.is(n) && (updates += 1) === 2;
    };

    it.each([
      ['step 3 (the INSERT)', () => isAuditInsert],
      ['step 4 (moving last_hash)', secondHeadUpdate],
    ])(
      'a failure at %s caught by the caller, who then commits, leaves audit_head unchanged and the chain ok (R51)',
      async (_name, matcher) => {
        await append(entry());
        const [before] = await head();
        await withTx(h, async (trx) => {
          const error = await auditAppend(trx.withPlugin(failing(matcher())), entry()).catch((e: unknown) => e);
          expect((error as Error).message).toBe('forced failure');
          // "Best-effort audit": the action goes on and commits.
          await trx.insertInto('settings').values({ key: 'marker', value: '1', scope: 'data', updated_at: 1 }).execute();
        });
        expect(await head()).toEqual([before]);
        expect(await rows()).toHaveLength(1);
        expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 1 });
        expect((await append(entry())).seq).toBe(2);
        expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 2 });
        await h.db.deleteFrom('settings').execute();
      },
    );

    it('several appends at once on one transaction run one after another (item 7): seq 1..3, chain ok', async () => {
      const results = await withTx(h, (trx) => Promise.all([0, 1, 2].map((i) => auditAppend(trx, entry({ meta: { i } })))));
      expect(results.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 3 });
    });

    it('accepts an at up to 5 minutes ahead of the clock (R51)', async () => {
      await append(entry({ at: Date.now() + 4 * 60_000 }));
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 1 });
    });

    describe('entries are checked before anything is written (R40/R40b)', () => {
      const deep = (levels: number): Record<string, unknown> => {
        let v: Record<string, unknown> = {};
        for (let i = 0; i < levels; i += 1) v = { v };
        return v;
      };
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      it.each<[string, Partial<AuditEntry> | Record<string, unknown>, RegExp]>([
        ['an actorId that is not a ULID', { actorId: 'user-1' }, /actorId/],
        ['a lower-case ULID actorId', { actorId: newId().toLowerCase() }, /actorId/],
        ['a branchId that is not a ULID', { branchId: 'main' }, /branchId/],
        ['an undefined actorId (null is required)', { actorId: undefined }, /actorId/],
        ['an undefined entity', { entity: undefined }, /entity/],
        ['an entityId over 191 characters', { entityId: 'x'.repeat(192) }, /entityId/],
        ['an entityId ending in a blank', { entityId: 'key ' }, /entityId.*blank/],
        ['an empty action', { action: '' }, /action/],
        ['an action over 64 characters', { action: 'a'.repeat(65) }, /action/],
        ['an action holding NUL', { action: 'a\u0000b' }, /action/],
        ['an entity over 64 characters', { entity: 'e'.repeat(65) }, /entity/],
        ['an empty actorType', { actorType: '' }, /actorType/],
        ['an actorType over 32 characters', { actorType: 't'.repeat(33) }, /actorType/],
        ['an ip over 45 characters', { ip: '1'.repeat(46) }, /ip/],
        ['an at that is not an integer', { at: 1.5 }, /at/],
        ['a negative at', { at: -1 }, /at/],
        ['an at beyond the ULID range', { at: 2 ** 48 }, /at/],
        ['meta with NaN', { meta: { n: Number.NaN } }, /meta/],
        ['meta with Infinity', { meta: { n: Number.POSITIVE_INFINITY } }, /meta/],
        ['meta with a BigInt', { meta: { n: 1n } }, /meta/],
        ['meta with a function', { meta: { f: () => 1 } }, /meta/],
        ['meta with a Date', { meta: { d: new Date(0) } }, /meta/],
        ['meta with a lone surrogate', { meta: { s: '\uD800' } }, /meta/],
        ['meta that is an array', { meta: [1, 2] }, /meta/],
        ['meta that is null', { meta: null }, /meta/],
        ['meta nested deeper than 64 levels', { meta: deep(64) }, /meta/],
        ['a cyclic meta', { meta: cyclic }, /meta/],
        ['meta over 65535 bytes as JSON (MySQL TEXT)', { meta: { s: 'é'.repeat(32_766) } }, /meta.*65535/],
        ['meta with a Map', { meta: { m: new Map() } }, /meta/],
        ['meta with a Uint8Array', { meta: { b: new Uint8Array(1) } }, /meta/],
        ["an empty entity ('' is refused, null means none; R50)", { entity: '' }, /entity/],
        ["an empty entityId (R50)", { entityId: '' }, /entityId/],
        ["an empty ip (R50)", { ip: '' }, /ip/],
        ['an at more than 5 minutes ahead of the clock (R51)', { at: Date.now() + 10 * 60_000 }, /at/],
      ])('TypeError for %s', async (_name, extra, pattern) => {
        // Caught inside the transaction, which then commits: a write made before the TypeError would stay.
        await withTx(h, async (trx) => {
          await expectTypeError(auditAppend(trx, entry(extra as Partial<AuditEntry>)), pattern);
          expect(await trx.selectFrom('audit_head').select(['last_seq', 'last_hash']).execute()).toEqual([
            { last_seq: 0, last_hash: GENESIS },
          ]);
          expect(await trx.selectFrom('audit_log').select('seq').execute()).toEqual([]);
        });
        expect(await rows()).toEqual([]);
        expect(await head()).toEqual([{ id: 1, last_seq: 0, last_hash: GENESIS }]);
      });

      it('error messages never repeat a refused value, only its type and length (item 12)', async () => {
        const error = await expectTypeError(append(entry({ actorId: 'budi.santoso@example.com' })), /actorId/);
        expect(error.message).not.toContain('budi');
        expect(error.message).toContain('a string of 24 characters');
      });

      it('accepts meta nested exactly 63 levels deep (64 with meta itself) and meta of exactly 65535 bytes', async () => {
        await append(entry({ meta: deep(63) }));
        const filler = 65_535 - canonicalize({ s: '' }).length;
        await append(entry({ meta: { s: 'x'.repeat(filler) } }));
        expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 2 });
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('verifyAuditChain', () => {
    it('an empty log is ok at head 0', async () => {
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 0 });
    });

    it('a log of 7 is ok, also when walked in batches of 3', async () => {
      await appendMany(7);
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 7 });
      expect(await verifyAuditChain(h, { batchSize: 3 })).toEqual({ ok: true, head: 7 });
      expect(await verifyAuditChain(h, { batchSize: 1 })).toEqual({ ok: true, head: 7 });
    });

    const tamper = (seq: number, set: Record<string, unknown>) =>
      h.db.updateTable('audit_log').set(set).where('seq', '=', seq).execute();

    it("tampering with one row's meta: brokenAt is that seq (also across batch edges)", async () => {
      await appendMany(7);
      await tamper(4, { meta: '{"i":40}' });
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 4 });
      expect(await verifyAuditChain(h, { batchSize: 3 })).toEqual({ ok: false, brokenAt: 4 });
      expect(await verifyAuditChain(h, { batchSize: 4 })).toEqual({ ok: false, brokenAt: 4 });
    });

    it.each<[string, Record<string, unknown>]>([
      ['id', { id: newId() }],
      ['actor_type', { actor_type: 'system' }],
      ['entity', { entity: 'branches' }],
      ['branch_id, to another branch', { branch_id: newId() }],
      ['branch_id, to null', { branch_id: null }],
      ['action', { action: 'settings.delete' }],
      ['at', { at: 1_767_225_600_001 }],
      ['actor_id', { actor_id: null }],
      ['entity_id', { entity_id: 'library.other' }],
      ['ip', { ip: '198.51.100.1' }],
      ['meta, an extra member', { meta: '{"i":2,"x":1}' }],
      ['meta, the same JSON value written differently (every stored byte counts)', { meta: '{ "i": 2 }' }],
      ['meta, not JSON at all', { meta: '{"i":' }],
      ['meta, a duplicate member', { meta: '{"i":2,"i":2}' }],
      ['hash', { hash: 'f'.repeat(64) }],
      ['prev_hash', { prev_hash: 'e'.repeat(64) }],
    ])('tampering with %s: brokenAt is that seq', async (_name, set) => {
      await appendMany(5);
      await tamper(3, set);
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 3 });
    });

    it('a row rewritten with a hash recomputed over the tampered data still breaks the link of the next row', async () => {
      await appendMany(5);
      const [, , third] = await rows();
      const forged = { ...third!, action: 'forged' };
      const hash = expectedHash(forged.prev_hash, {
        id: forged.id,
        seq: forged.seq,
        at: forged.at,
        actorType: forged.actor_type,
        actorId: forged.actor_id,
        action: forged.action,
        entity: forged.entity,
        entityId: forged.entity_id,
        branchId: forged.branch_id,
        ip: forged.ip,
        meta: JSON.parse(forged.meta) as unknown,
      });
      await tamper(3, { action: 'forged', hash });
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 4 });
    });

    it('a deleted row in the middle: brokenAt is the missing seq', async () => {
      await appendMany(5);
      await h.db.deleteFrom('audit_log').where('seq', '=', 3).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 3 });
    });

    it('the first row deleted: brokenAt 1', async () => {
      await appendMany(3);
      await h.db.deleteFrom('audit_log').where('seq', '=', 1).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
    });

    it('the last row deleted (audit_head still names it): brokenAt is that seq', async () => {
      await appendMany(5);
      await h.db.deleteFrom('audit_log').where('seq', '=', 5).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 5 });
    });

    it('audit_head.last_hash tampered: brokenAt is last_seq', async () => {
      await appendMany(4);
      await h.db.updateTable('audit_head').set({ last_hash: 'a'.repeat(64) }).where('id', '=', 1).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 4 });
    });

    it('audit_head moved back to an earlier row (rows beyond the head): brokenAt is the first seq beyond it', async () => {
      await appendMany(5);
      const [, , third] = await rows();
      await h.db.updateTable('audit_head').set({ last_seq: 3, last_hash: third!.hash }).where('id', '=', 1).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 4 });
    });

    it('audit_head reset to the genesis while rows exist: brokenAt 1', async () => {
      await appendMany(2);
      await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: GENESIS }).where('id', '=', 1).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
    });

    it('audit_head missing: brokenAt 1', async () => {
      await appendMany(2);
      await h.db.deleteFrom('audit_head').execute();
      try {
        expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
      } finally {
        await h.db.insertInto('audit_head').values({ id: 1, last_seq: 0, last_hash: GENESIS }).execute();
      }
    });

    it('a foreign row with seq 0 before the chain: brokenAt 1', async () => {
      await appendMany(2);
      const [first] = await rows();
      await h.db.insertInto('audit_log').values({ ...first!, id: newId(), seq: 0 }).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
    });

    it('stays ok while appends commit during the walk (an append after every batch read)', async () => {
      await appendMany(6);
      const writer = handles[handles.length - 1]!;
      let appended = 0;
      const appendingBetweenBatches: KyselyPlugin = {
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          // After every SELECT of rows (the batches): another entry commits.
          if (result.rows.length > 0 && Object.hasOwn(result.rows[0]!, 'prev_hash')) {
            await append(entry({ meta: { late: appended } }), writer);
            appended += 1;
          }
          return result;
        },
      };
      const walking = { ...h, db: h.db.withPlugin(appendingBetweenBatches) };
      expect(await verifyAuditChain(walking, { batchSize: 2 })).toEqual({ ok: true, head: 6 });
      expect(appended).toBe(3); // 3 batches of the 6 rows of the head read first
      expect(await verifyAuditChain(h)).toEqual({ ok: true, head: 9 });
    });

    it('two rows whose seq were swapped: brokenAt the lower seq', async () => {
      await appendMany(4);
      await h.db.updateTable('audit_log').set({ seq: 100 }).where('seq', '=', 2).execute();
      await h.db.updateTable('audit_log').set({ seq: 2 }).where('seq', '=', 3).execute();
      await h.db.updateTable('audit_log').set({ seq: 3 }).where('seq', '=', 100).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 2 });
    });

    it('audit_head.last_seq moved one past the last row: brokenAt the missing seq', async () => {
      await appendMany(3);
      await h.db.updateTable('audit_head').set({ last_seq: 4 }).where('id', '=', 1).execute();
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 4 });
    });

    it('a row whose at no longer decodes as a safe integer: brokenAt that seq, no exception (item 11)', async () => {
      // MySQL/MariaDB hand an unsafe BIGINT back as a string; PostgreSQL's int8 parser and node:sqlite throw while
      // reading the batch, which is then read row by row.
      await appendMany(5);
      await sql`UPDATE audit_log SET at = 9007199254740993 WHERE seq = 3`.execute(h.db);
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 3 });
      expect(await verifyAuditChain(h, { batchSize: 2 })).toEqual({ ok: false, brokenAt: 3 });
      expect(await verifyAuditChain(h, { batchSize: 1 })).toEqual({ ok: false, brokenAt: 3 });
    });

    it.skipIf(!SQLITE)('SQLite: a text column turned into a BLOB: brokenAt that seq, no exception (item 11)', async () => {
      await appendMany(3);
      await sql`UPDATE audit_log SET action = x'6869' WHERE seq = 2`.execute(h.db);
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 2 });
    });

    it('rejects a batchSize that is not a positive integer', async () => {
      await expectTypeError(verifyAuditChain(h, { batchSize: 0 }), /batchSize/);
    });

    // A long walk (the anchor job's first run, or one after a break) keeps its job's lease through onBatch.
    it('calls onBatch after every batch read but the last, and stops with its error', async () => {
      await appendMany(7);
      const seen: number[] = [];
      expect(await verifyAuditChain(h, { batchSize: 3, onBatch: async () => void seen.push(seen.length) })).toEqual({ ok: true, head: 7 });
      expect(seen).toEqual([0, 1]); // rows 1–3, 4–6; the third batch (row 7) is the last
      const lost = new Error('lease lost');
      await expect(verifyAuditChain(h, { batchSize: 3, onBatch: () => Promise.reject(lost) })).rejects.toBe(lost);
    });

    // 1d T18-AUDIT-ANCHOR-BUDGET: the anchor job walks a long log in slices. With a deadline (a performance.now()
    // reading) the walk stops after the batch that passes it and says where it stands; the next slice walks on `from`
    // there.
    describe('with a deadline', () => {
      const passed = (): number => performance.now() - 1;

      it('stops after the batch that passes it with {ok, head, headHash, brokenAt: null, complete: false}; from there it goes on to the end', async () => {
        await appendMany(7);
        const [, , third, , , sixth] = await rows();
        expect(await verifyAuditChain(h, { batchSize: 3, deadline: passed() })).toEqual({
          ok: true,
          head: 3,
          headHash: third!.hash,
          brokenAt: null,
          complete: false,
        });
        expect(await verifyAuditChain(h, { batchSize: 3, deadline: passed(), from: { seq: 3, hash: third!.hash } })).toEqual({
          ok: true,
          head: 6,
          headHash: sixth!.hash,
          brokenAt: null,
          complete: false,
        });
        // The last batch (row 7) is short: the walk is complete, whatever the deadline.
        expect(await verifyAuditChain(h, { batchSize: 3, deadline: passed(), from: { seq: 6, hash: sixth!.hash } })).toEqual({ ok: true, head: 7 });
      });

      it('a deadline still ahead walks the whole log; a break is reported where it is found, deadline passed or not', async () => {
        await appendMany(7);
        expect(await verifyAuditChain(h, { batchSize: 3, deadline: performance.now() + 60_000 })).toEqual({ ok: true, head: 7 });
        await tamper(2, { meta: '{"i":20}' });
        expect(await verifyAuditChain(h, { batchSize: 3, deadline: passed() })).toEqual({ ok: false, brokenAt: 2 });
      });

      it('is read on the performance.now() clock after each batch: a clock that passes it during the second batch stops there', async () => {
        await appendMany(7);
        const [, , , , , sixth] = await rows();
        // A fake performance.now that moves 10 ms with every batch of rows read (whoever else reads it meanwhile).
        let batches = 0;
        const counting: KyselyPlugin = {
          transformQuery: ({ node }) => node,
          async transformResult({ result }) {
            if (result.rows.length > 0 && Object.hasOwn(result.rows[0]!, 'prev_hash')) batches += 1;
            return result;
          },
        };
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => 1000 + 10 * batches);
        try {
          // After the first batch the clock reads 1010, before the deadline; after the second 1020, past it.
          const walking = { ...h, db: h.db.withPlugin(counting) };
          expect(await verifyAuditChain(walking, { batchSize: 3, deadline: 1015 })).toMatchObject({ head: 6, headHash: sixth!.hash, complete: false });
          expect(batches).toBe(2);
        } finally {
          clock.mockRestore();
        }
      });

      it('rejects a deadline that is not a finite number', async () => {
        await expectTypeError(verifyAuditChain(h, { deadline: Number.NaN }), /deadline/);
        await expectTypeError(verifyAuditChain(h, { deadline: '5' as unknown as number }), /deadline/);
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('verifyAuditChain from a starting point (anchor after a purge, L39; from for incremental checks)', () => {
    /** The {seq, hash} of row `seq`. */
    async function point(seq: number): Promise<{ seq: number; hash: string }> {
      const row = await h.db.selectFrom('audit_log').select(['seq', 'hash']).where('seq', '=', seq).executeTakeFirstOrThrow();
      return { seq: row.seq, hash: row.hash };
    }

    /** A handle whose audit_log batches are recorded: the seq of every row the walk reads. */
    function spied(): { handle: TestDbHandle; seqs: number[] } {
      const seqs: number[] = [];
      const batchReader: KyselyPlugin = {
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          for (const row of result.rows) if (Object.hasOwn(row, 'prev_hash')) seqs.push(row['seq'] as number);
          return result;
        },
      };
      return { handle: { ...h, db: h.db.withPlugin(batchReader) }, seqs };
    }

    const purgeUpTo = (seq: number) => h.db.deleteFrom('audit_log').where('seq', '<=', seq).execute();

    it('a chain of 10 with rows 1–4 deleted: brokenAt 1 without an anchor, ok at head 10 from the anchor of row 4', async () => {
      await appendMany(10);
      const anchor = await point(4);
      await purgeUpTo(4);
      expect(await verifyAuditChain(h)).toEqual({ ok: false, brokenAt: 1 });
      expect(await verifyAuditChain(h, { anchor })).toEqual({ ok: true, head: 10 });
      expect(await verifyAuditChain(h, { anchor, batchSize: 3 })).toEqual({ ok: true, head: 10 });
    });

    it('from the row 7 already verified: reads only rows 8–10 (the batch reader sees nothing else)', async () => {
      await appendMany(10);
      const { handle, seqs } = spied();
      expect(await verifyAuditChain(handle, { from: await point(7) })).toEqual({ ok: true, head: 10 });
      expect(seqs).toEqual([8, 9, 10]);
      seqs.length = 0;
      expect(await verifyAuditChain(handle, { from: await point(7), batchSize: 2 })).toEqual({ ok: true, head: 10 });
      expect(seqs).toEqual([8, 9, 10]);
    });

    it('rows after the starting point are verified as before: a tampered row, a missing row, a moved head', async () => {
      await appendMany(10);
      const anchor = await point(4);
      await purgeUpTo(4);
      await h.db.updateTable('audit_log').set({ meta: '{"i":60}' }).where('seq', '=', 6).execute();
      expect(await verifyAuditChain(h, { anchor })).toEqual({ ok: false, brokenAt: 6 });
      await h.db.deleteFrom('audit_log').where('seq', '=', 6).execute();
      expect(await verifyAuditChain(h, { anchor })).toEqual({ ok: false, brokenAt: 6 });
      expect(await verifyAuditChain(h, { from: await point(8) })).toEqual({ ok: true, head: 10 });
      await h.db.updateTable('audit_head').set({ last_hash: 'a'.repeat(64) }).where('id', '=', 1).execute();
      expect(await verifyAuditChain(h, { from: await point(8) })).toEqual({ ok: false, brokenAt: 10 });
    });

    it('a starting hash that is not the hash of its row breaks the chain at the next seq', async () => {
      await appendMany(10);
      const anchor = await point(4);
      await purgeUpTo(4);
      expect(await verifyAuditChain(h, { anchor: { seq: 4, hash: 'b'.repeat(64) } })).toEqual({ ok: false, brokenAt: 5 });
      expect(await verifyAuditChain(h, { anchor: { ...anchor, seq: 3 } })).toEqual({ ok: false, brokenAt: 4 });
      expect(await verifyAuditChain(h, { from: { seq: 7, hash: anchor.hash } })).toEqual({ ok: false, brokenAt: 8 });
    });

    it('rows at or before the anchor are not read, whether they are gone or still there', async () => {
      await appendMany(6);
      const { handle, seqs } = spied();
      // A foreign row before the chain is ignored too: the chain starts after the anchor.
      const [first] = await rows();
      await h.db.insertInto('audit_log').values({ ...first!, id: newId(), seq: 0 }).execute();
      expect(await verifyAuditChain(handle, { anchor: await point(2) })).toEqual({ ok: true, head: 6 });
      expect(seqs).toEqual([3, 4, 5, 6]);
    });

    it('anchor and from together: the later of the two is where the walk starts', async () => {
      await appendMany(10);
      const anchor = await point(4);
      const verified = await point(7);
      const early = await point(2);
      await purgeUpTo(4);
      const { handle, seqs } = spied();
      expect(await verifyAuditChain(handle, { anchor, from: verified })).toEqual({ ok: true, head: 10 });
      expect(seqs).toEqual([8, 9, 10]);
      seqs.length = 0;
      // A verified point the purge has passed since: the anchor is the start.
      expect(await verifyAuditChain(handle, { anchor, from: early })).toEqual({ ok: true, head: 10 });
      expect(seqs).toEqual([5, 6, 7, 8, 9, 10]);
    });

    it('a starting point at the head: ok when its hash is the head’s; beyond the head: brokenAt the first seq after it', async () => {
      await appendMany(5);
      const last = await point(5);
      expect(await verifyAuditChain(h, { from: last })).toEqual({ ok: true, head: 5 });
      expect(await verifyAuditChain(h, { from: { seq: 5, hash: 'c'.repeat(64) } })).toEqual({ ok: false, brokenAt: 5 });
      // audit_head moved back below a seq already verified.
      const third = await point(3);
      await h.db.updateTable('audit_head').set({ last_seq: 3, last_hash: third.hash }).where('id', '=', 1).execute();
      expect(await verifyAuditChain(h, { from: last })).toEqual({ ok: false, brokenAt: 4 });
    });

    it('an anchor of seq 0 and the genesis hash is the whole chain', async () => {
      await appendMany(3);
      expect(await verifyAuditChain(h, { anchor: { seq: 0, hash: GENESIS } })).toEqual({ ok: true, head: 3 });
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['a negative seq', { seq: -1, hash: GENESIS }],
      ['a fractional seq', { seq: 1.5, hash: GENESIS }],
      ['an unsafe seq', { seq: 2 ** 53, hash: GENESIS }],
      ['a seq as text', { seq: '4', hash: GENESIS }],
      ['a short hash', { seq: 4, hash: 'abc' }],
      ['an upper-case hash', { seq: 4, hash: 'A'.repeat(64) }],
      ['no hash', { seq: 4 }],
    ])('rejects %s as anchor or from with a TypeError', async (_name, value) => {
      await expectTypeError(verifyAuditChain(h, { anchor: value as { seq: number; hash: string } }), /anchor/);
      await expectTypeError(verifyAuditChain(h, { from: value as { seq: number; hash: string } }), /from/);
    });
  });
});
