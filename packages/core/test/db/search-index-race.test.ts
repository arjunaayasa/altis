import { randomBytes } from 'node:crypto';
import { fullTextFamily, withTx, type DB, type DbHandle } from '@altis/db';
import { sql, type KyselyPlugin, type QueryId, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { archiveAttachment, createAttachment, updateAttachment } from '../../src/catalog/attachments/service.js';
import { archiveItem, updateItem } from '../../src/catalog/items/service.js';
import { bulkUpdateItems } from '../../src/catalog/items/bulk.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { createRecord, lockRecordRows, updateRecord } from '../../src/catalog/records/service.js';
import { txCtx, type CoreLogger, type TxCtx } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import type { StorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { enqueueReindex, searchJobs } from '../../src/search/jobs.js';
import { ACTOR, NOW, openRecordsDb, seedItem, type RecordsDb } from './catalog-records-support.js';

// C05 (Phase 2 big review): an index writer builds a record's document only after it holds the record's row lock, so
// it never saves a document older than one another writer committed meanwhile. Two connections: A saves record R with
// a new author and waits before its COMMIT; B (an item update, an item archive, a bulk item change, or a reindex
// batch) starts while A is open. Once B is waiting on a lock, A commits, and B ends. R's document must hold A's author.
// On MySQL/MariaDB a writer whose first plain read came before A's COMMIT reads A's links from its old snapshot; on
// PostgreSQL a writer that built its documents before A's COMMIT writes them again after its UNIQUE_VIOLATION retry.
// SQLite has one writer at a time (B waits for A's COMMIT whole), so there the cases pass by construction.

const ctx = testDbContext();
const SQLITE = ctx.engine === 'sqlite';
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!ctx.available)(`index writers and a concurrent record save (C05) [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let buku: string;
  const deps = (): CatalogJobDeps => ({ dataDir: db.dataDir, baseUrl: 'https://perpus.example.sch.id', keyring, storage: {} as StorageDriver, log: silent });

  beforeAll(async () => {
    db = await openRecordsDb('search-index-race');
    buku = await db.materialTypeId('BUKU');
  });

  afterAll(async () => {
    await db?.close();
  });

  /**
   * A view of the test handle whose statements are watched: `waiting()` is true while one of them has been running
   * for 300 ms (on these few-row statements, a lock wait). On SQLite a second writer waits for the connection before
   * it compiles anything, so there a fixed pause stands in.
   */
  function watched(): { h: DbHandle; waiting(): boolean } {
    const started = new Map<QueryId, number>();
    const plugin: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        started.set(queryId, Date.now());
        return node;
      },
      async transformResult({ queryId, result }) {
        started.delete(queryId);
        return result;
      },
    };
    return { h: { ...db.h, db: db.h.db.withPlugin(plugin) }, waiting: () => [...started.values()].some((t) => Date.now() - t >= 300) };
  }

  /** Waits until `w` waits on a lock (at most 10 s; on SQLite a fixed pause). */
  async function untilWaiting(w: { waiting(): boolean }): Promise<void> {
    if (SQLITE) return pause(200);
    for (let n = 0; n < 200; n += 1) {
      if (w.waiting()) return;
      await pause(50);
    }
    throw new Error('the second writer never waited on a lock');
  }

  /** A record by author `Lama, Penulis` with one item (the record's id made at `now`); their ids. */
  async function seed(title: string, now = NOW): Promise<{ recordId: string; itemId: string }> {
    const { id: recordId } = await db.run(
      (tx) => createRecord(tx, { materialTypeId: buku, title, agents: [{ ref: { type: 'person', name: 'Lama, Penulis' }, role: 'aut', isMain: true }] }),
      now,
    );
    const itemId = await seedItem(db, recordId);
    return { recordId, itemId };
  }

  /** `fn` in a transaction of `h` at `now`, as the staff actor. */
  const runOn = <T>(h: DbHandle, fn: (tx: TxCtx) => Promise<T>, now = NOW + 2000) => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR)));

  /**
   * A: updateRecord adds the author `Kebaruan, Pengarang` to `recordId` and waits before its COMMIT; `second` starts
   * once A has written, A commits once `second` waits on a lock; both end. The record's stored `t_agents`.
   */
  async function race(recordId: string, second: (h: DbHandle) => Promise<unknown>): Promise<string> {
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = db.run(async (tx) => {
      await updateRecord(tx, recordId, {
        version: 0,
        agents: [
          { ref: { type: 'person', name: 'Lama, Penulis' }, role: 'aut', isMain: true },
          { ref: { type: 'person', name: 'Kebaruan, Pengarang' }, role: 'aut', isMain: false },
        ],
      });
      reached();
      await gate;
    }, NOW + 1000);
    await atGate;
    const w = watched();
    const b = second(w.h);
    try {
      await untilWaiting(w);
    } finally {
      open();
    }
    await Promise.all([a, b]);
    return (await db.h.db.selectFrom('search_doc').select('t_agents').where('record_id', '=', recordId).executeTakeFirstOrThrow()).t_agents;
  }

  it('an item status change (B read its item before A committed) keeps the new author in the document', async () => {
    const { recordId, itemId } = await seed('Gelombang pertama');
    const agents = await race(recordId, (h) => runOn(h, (tx) => updateItem(tx, db.branchId, itemId, { version: 0, status: 'repair' })));
    expect(agents).toContain('kebaruan');
  });

  it('an item note change (B never touches the record) keeps the new author in the document', async () => {
    const { recordId, itemId } = await seed('Gelombang kedua');
    const agents = await race(recordId, (h) => runOn(h, (tx) => updateItem(tx, db.branchId, itemId, { version: 0, note: 'Sampul robek' })));
    expect(agents).toContain('kebaruan');
  });

  it('an item archive keeps the new author in the document', async () => {
    const { recordId, itemId } = await seed('Gelombang ketiga');
    const agents = await race(recordId, (h) => runOn(h, (tx) => archiveItem(tx, db.branchId, itemId, 0)));
    expect(agents).toContain('kebaruan');
  });

  it('a bulk item change keeps the new author in the document', async () => {
    const { recordId, itemId } = await seed('Gelombang keempat');
    const agents = await race(recordId, (h) => runOn(h, (tx) => bulkUpdateItems(tx, db.branchId, { ids: [itemId], set: { status: 'not_for_loan' } })));
    expect(agents).toContain('kebaruan');
  });

  it('a reindex {recordIds} batch keeps the new author in the document', async () => {
    const { recordId } = await seed('Gelombang kelima');
    const reg = createJobRegistry(searchJobs(deps));
    const { jobId } = await withTx(db.h, (trx) => enqueueReindex(trx, reg, { recordIds: [recordId] }, { now: NOW, keyring, createdBy: null }));
    const agents = await race(recordId, async (h) => {
      const job = await claimById(h, reg, jobId, { worker: 'test', now: NOW + 2000 });
      if (job === null) throw new Error('the reindex cannot be claimed');
      return runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW + 2000, env: {} });
    });
    expect(agents).toContain('kebaruan');
    expect((await db.h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status).toBe('succeeded');
  });

  /**
   * `fn` in a transaction of its own connection that gives up any lock wait after 2 s (MySQL/MariaDB
   * `innodb_lock_wait_timeout`, PostgreSQL `lock_timeout`), run once (no withTx retry): a lock the open writer holds
   * on a row `fn` touches makes it throw.
   */
  async function shortWaits(fn: (trx: Transaction<DB>) => Promise<void>): Promise<void> {
    const mysql = fullTextFamily(db.h.db) === 'innodb';
    await db.h.db.connection().execute(async (conn) => {
      if (mysql) await sql`SET SESSION innodb_lock_wait_timeout = 2`.execute(conn);
      try {
        await conn.transaction().execute(async (trx) => {
          if (!mysql) await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
          await fn(trx);
        });
      } finally {
        if (mysql) await sql`SET SESSION innodb_lock_wait_timeout = DEFAULT`.execute(conn);
      }
    });
  }

  /**
   * C05 lock scope: `writer` runs in a transaction that stays open; meanwhile, on another connection, a lock of an
   * unrelated record's row and a bulk record create (an import's) must not wait on it. MariaDB before 11.1 runs a
   * single-table UPDATE … WHERE id IN (SELECT …) as a dependent subquery over the whole `records` table, which keeps
   * every row (and the gap after the last) locked until the writer's COMMIT. The unrelated record's id sorts after the
   * writer's record and before the new one: InnoDB's next-key locks of the writer's own index rows reach up to the next
   * id, so a new record right after the writer's would wait for that short transaction by design.
   */
  async function lockScope(writer: (tx: TxCtx) => Promise<unknown>): Promise<void> {
    const unrelated = await seed('Gelombang lain', NOW + 500);
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = db.run(async (tx) => {
      await writer(tx);
      reached();
      await gate;
    }, NOW + 1000);
    await atGate;
    try {
      await shortWaits(async (trx) => {
        await lockRecordRows(trx, [unrelated.recordId]);
        await createRecord(txCtx(trx, NOW + 2000, ACTOR), { materialTypeId: buku, title: 'Cantuman impor' }, { mode: 'bulk' });
      });
    } finally {
      open();
      await a;
    }
  }

  it.skipIf(SQLITE)('C05 lock scope: an open item update locks only its own record (an unrelated lock and a bulk create do not wait)', async () => {
    const { itemId } = await seed('Gelombang kesembilan');
    await lockScope((tx) => updateItem(tx, db.branchId, itemId, { version: 0, note: 'Halaman lepas' }));
  });

  it.skipIf(SQLITE)('C05 lock scope: an open item archive locks only its own record', async () => {
    const { itemId } = await seed('Gelombang kesepuluh');
    await lockScope((tx) => archiveItem(tx, db.branchId, itemId, 0));
  });

  it.skipIf(SQLITE)('C05 lock scope: an open bulk item change locks only its own records', async () => {
    const { itemId } = await seed('Gelombang kesebelas');
    await lockScope((tx) => bulkUpdateItems(tx, db.branchId, { ids: [itemId], set: { status: 'not_for_loan' } }));
  });

  it.skipIf(SQLITE)('C05 lock scope: an open attachment update or archive locks only its own record', async () => {
    const { recordId } = await seed('Gelombang keduabelas');
    const made = await db.run((tx) => createAttachment(tx, recordId, { kind: 'url', url: 'https://contoh.example.org/a.pdf', title: 'Tautan', access: 'public' }));
    await lockScope((tx) => updateAttachment(tx, made.id, { version: made.version, title: 'Tautan baru' }));
    await lockScope((tx) => archiveAttachment(tx, made.id, made.version + 1));
  });

  it('C04: a claim of the joined, not yet started reindex waits for the joining transaction to commit (FOR UPDATE)', async () => {
    await seed('Gelombang keenam');
    const agent = (await db.h.db.selectFrom('agents').select('id').where('name_display', '=', 'Lama, Penulis').executeTakeFirstOrThrow()).id;
    const reg = createJobRegistry(searchJobs(deps));
    const { jobId } = await withTx(db.h, (trx) => enqueueReindex(trx, reg, { agentId: agent }, { now: NOW, keyring, createdBy: null }));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let committedAt = 0;
    const a = withTx(db.h, async (trx) => {
      const joined = await enqueueReindex(trx, reg, { agentId: agent }, { now: NOW, keyring, createdBy: null });
      reached();
      await gate;
      return joined;
    }).then((r) => {
      committedAt = performance.now();
      return r;
    });
    await atGate;
    const w = watched();
    let claimedAt = 0;
    const b = claimById(w.h, reg, jobId, { worker: 'test', now: NOW + 2000 }).then((job) => {
      claimedAt = performance.now();
      return job;
    });
    try {
      await untilWaiting(w);
    } finally {
      open();
    }
    const [joined, job] = await Promise.all([a, b]);
    expect(joined).toEqual({ jobId, existing: true });
    expect(job?.id).toBe(jobId);
    expect(claimedAt).toBeGreaterThanOrEqual(committedAt);
  });
});
