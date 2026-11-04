import { withTx, type DbHandle } from '@altis/db';
import type { KyselyPlugin, QueryId } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { archiveAuthority, createAgent, createPublisher, createSubject, mergeAuthority } from '../../src/catalog/authorities/index.js';
import { txCtx, type TxCtx } from '../../src/context.js';
import { ACTOR, NOW, fieldErrors, openRecordsDb, type RecordsDb } from './catalog-records-support.js';

// L01 (Phase 2 big review): creating an authority whose key an archived one holds brings that one back, but only while
// it is still archived and unmerged at the moment of the write. Two connections: A merges the archived authority X
// into T and waits before its COMMIT; B creates X's key again while A is open. Once B waits on a lock, A commits. B must
// answer `taken` (X is merged), and X must stay archived and merged. On MySQL/MariaDB a create that read X before A's
// COMMIT and locked it only then kept seeing X unmerged from its snapshot and revived it. SQLite has one writer at a
// time, so there the cases pass by construction.

const ctx = testDbContext();
const SQLITE = ctx.engine === 'sqlite';

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!ctx.available)(`reviving an authority while it is merged (L01) [${engineLabel()}]`, () => {
  let db: RecordsDb;
  let serial = 0;
  const unique = (base: string): string => `${base} ${(serial += 1)}`;

  beforeAll(async () => {
    db = await openRecordsDb('authorities-race');
  });

  afterAll(async () => {
    await db?.close();
  });

  /** A view of the test handle whose statements are watched: `waiting()` once one has run for 300 ms (a lock wait). */
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

  async function untilWaiting(w: { waiting(): boolean }): Promise<void> {
    if (SQLITE) return pause(200);
    for (let n = 0; n < 200; n += 1) {
      if (w.waiting()) return;
      await pause(50);
    }
    throw new Error('the create never waited on a lock');
  }

  /** A merges `source` into `target` and waits before its COMMIT; `create` runs on a watched handle meanwhile. */
  async function race(kind: 'agents' | 'subjects' | 'publishers', source: string, target: string, create: (tx: TxCtx) => Promise<unknown>): Promise<unknown> {
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = db.run(async (tx) => {
      await mergeAuthority(tx, kind, source, target, 1);
      reached();
      await gate;
    }, NOW + 1000);
    await atGate;
    const w = watched();
    const b = fieldErrors(withTx(w.h, (trx) => create(txCtx(trx, NOW + 2000, ACTOR))));
    try {
      await untilWaiting(w);
    } finally {
      open();
    }
    await a;
    return b;
  }

  const rowOf = (table: 'agents' | 'subjects' | 'publishers', id: string) =>
    db.h.db
      .selectFrom(table as 'agents')
      .select(['merged_into', 'archived_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('an agent: the create answers taken, the merged agent stays archived and merged', async () => {
    const name = unique('Rendra, W.S.');
    const x = (await db.run((tx) => createAgent(tx, { type: 'person', name }))).view.id;
    const t = (await db.run((tx) => createAgent(tx, { type: 'person', name: unique('Rendra, Willibrordus Surendra') }))).view.id;
    await db.run((tx) => archiveAuthority(tx, 'agents', x, 0));
    expect(await race('agents', x, t, (tx) => createAgent(tx, { type: 'person', name }))).toEqual([{ path: 'name', code: 'taken' }]);
    expect(await rowOf('agents', x)).toMatchObject({ merged_into: t, archived_at: expect.anything() });
  });

  it('a subject: the create answers taken, the merged subject stays archived and merged', async () => {
    const term = unique('Puisi Indonesia');
    const x = (await db.run((tx) => createSubject(tx, { type: 'topic', term }))).view.id;
    const t = (await db.run((tx) => createSubject(tx, { type: 'topic', term: unique('Sajak Indonesia') }))).view.id;
    await db.run((tx) => archiveAuthority(tx, 'subjects', x, 0));
    expect(await race('subjects', x, t, (tx) => createSubject(tx, { type: 'topic', term }))).toEqual([{ path: 'term', code: 'taken' }]);
    expect(await rowOf('subjects', x)).toMatchObject({ merged_into: t, archived_at: expect.anything() });
  });

  it('a publisher: the create answers taken, the merged publisher stays archived and merged', async () => {
    const name = unique('Balai Pustaka');
    const x = (await db.run((tx) => createPublisher(tx, { name }))).view.id;
    const t = (await db.run((tx) => createPublisher(tx, { name: unique('PN Balai Pustaka') }))).view.id;
    await db.run((tx) => archiveAuthority(tx, 'publishers', x, 0));
    expect(await race('publishers', x, t, (tx) => createPublisher(tx, { name }))).toEqual([{ path: 'name', code: 'taken' }]);
    expect(await rowOf('publishers', x)).toMatchObject({ merged_into: t, archived_at: expect.anything() });
  });
});
