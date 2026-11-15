import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  cancelStocktake,
  createJobRegistry,
  createMember,
  createStocktake,
  finishStocktake,
  getStocktake,
  stocktakeCodesJob,
  stocktakeFinishJob,
  stocktakePrepareJob,
  type JobContext,
  type StocktakeJobDeps,
} from '../../src/index.js';
import { NOW, openItemsDb, seedItem, seedLocation, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Stocktake under real parallel transactions on the engine picked by ALTIS_TEST_DB: each officer, and the desk, is a
// process of its own with its own connections (fixtures/stocktake-child.mjs), started together, so on MySQL/MariaDB and
// PostgreSQL their transactions overlap and on SQLite they meet at the database's write lock. Four officers scanning
// one session at once (the same copy, two unknown codes, the same unexpected copy, over and over) all end without an
// error (no deadlock or serialisation failure escapes), and the session's counters equal what its rows say. A desk
// lending copies while the finish's batch runs never leaves a copy on loan marked missing: each copy is either lent
// before the batch (kept, `on_loan`) or marked missing first (and the loan refused).

const ctx = testDbContext();
const ROOT = path.resolve(import.meta.dirname, '../../../..');

interface ChildReport {
  outcomes?: string[];
  lent?: string[];
  refused?: Record<string, string>;
  batches?: number;
  error?: string;
}

/** One stocktake-child.mjs per entry of `options`, started together once all are ready; their exit codes and reports. */
async function runChildren(options: object[]): Promise<{ codes: (number | null)[]; reports: (ChildReport | undefined)[] }> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 50_000);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, '../fixtures/stocktake-child.mjs'), [JSON.stringify(o)], {
        cwd: ROOT,
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: ChildReport | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as ChildReport;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      const exited = new Promise<{ code: number | null; report: ChildReport | undefined }>((resolve) => child.once('close', (code) => resolve({ code, report })));
      return { child, ready, exited };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    const done = await Promise.all(runs.map((r) => r.exited));
    return { codes: done.map((d) => d.code), reports: done.map((d) => d.report) };
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

/** Runs a job handler's slices to the end with a budget that never runs out. */
async function runJob<P>(db: ItemsDb, handler: { run(ctx: JobContext, p: P): Promise<unknown> }, payload: P): Promise<void> {
  let p = payload;
  for (let n = 0; n < 100; n += 1) {
    const jc = {
      jobId: newId(),
      handle: db.h,
      db: db.h.db,
      now: () => NOW,
      budgetLeftMs: () => 60_000,
      cancelled: () => false,
      heartbeat: async () => undefined,
      audit: async () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as JobContext;
    const out = (await handler.run(jc, p)) as { done?: true; continueWith?: P };
    if (out.done === true) return;
    if (out.continueWith !== undefined) p = out.continueWith;
  }
  throw new Error('the job did not end');
}

describe.skipIf(!ctx.available)(`stocktake under parallel transactions [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let deps: StocktakeJobDeps;
  let seq = 0;
  const officer = () => newId(NOW - 5000 + seq++);

  async function copies(n: number, o: { locationId?: string; branchId?: string } = {}): Promise<{ id: string; barcode: string }[]> {
    const out: { id: string; barcode: string }[] = [];
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      const recordId = await seedRecord(db, { title: `Buku Serentak ${seq}`, callNumber: '500 SER' });
      const barcode = `SR-${seq}`;
      out.push({ id: await seedItem(db, recordId, { barcode, ...(o.locationId === undefined ? {} : { locationId: o.locationId }), ...(o.branchId === undefined ? {} : { branchId: o.branchId }) }), barcode });
    }
    return out;
  }

  async function session(name: string, locationId: string): Promise<string> {
    const s = await db.run((tx) => createStocktake(tx, db.branchId, { name, scope: { locationIds: [locationId] } }, deps));
    await runJob(db, stocktakePrepareJob(), { stocktakeId: s.id, after: null });
    return s.id;
  }

  const base = (stocktakeId: string) => ({ config: db.h.config, dataDir: db.h.dataDir, branchId: db.branchId, stocktakeId, now: NOW });

  beforeAll(async () => {
    db = await openItemsDb('stocktake-concurrency');
    deps = { registry: createJobRegistry([stocktakePrepareJob(), stocktakeFinishJob(), stocktakeCodesJob(() => ({ dataDir: db.dataDir }))]), keyring: [] };
  });

  afterAll(async () => {
    await db?.close();
  });

  it('four officers scanning the same copy, two unknown codes and the same unexpected copy at once keep the counters equal to the rows', async () => {
    const shelf = await seedLocation(db, { code: `CC${seq}`, kind: 'room' });
    const [same, a, b, c] = await copies(4, { locationId: shelf });
    const [outside] = await copies(1, { branchId: db.otherBranchId });
    const id = await session('Serentak', shelf);
    const codes = (own: string) => [same!.barcode, 'TAK-ADA-SATU', outside!.barcode, 'TAK-ADA-DUA', own];
    const { codes: exits, reports } = await runChildren(
      [a!, b!, c!, same!].map((own) => ({ ...base(id), actorId: officer(), mode: 'scan', codes: codes(own.barcode), rounds: 3 })),
    );
    expect({ exits, errors: reports.map((r) => r?.error ?? null) }).toEqual({ exits: [0, 0, 0, 0], errors: [null, null, null, null] });
    const outcomes = reports.flatMap((r) => r?.outcomes ?? []);
    expect(outcomes).toHaveLength(4 * 3 * 5);
    // Each copy of the shelf is found once, whoever scanned it first; the unexpected copy enters the session once.
    expect(outcomes.filter((o) => o === 'found')).toHaveLength(4);
    expect(outcomes.filter((o) => o === 'unexpected')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'unknown')).toHaveLength(24);

    const rows = await db.h.db.selectFrom('stocktake_items').select(['state', 'expected']).where('stocktake_id', '=', id).execute();
    const unknown = await db.h.db.selectFrom('stocktake_unknown_codes').select(['code_key', 'seen']).where('stocktake_id', '=', id).orderBy('code_key').execute();
    const counts = (await getStocktake(db.h.db, db.branchId, id)).counts;
    expect(counts).toMatchObject({
      total: rows.filter((r) => Number(r.expected) === 1).length,
      found: rows.filter((r) => r.state === 'found' || r.state === 'misplaced').length,
      unexpected: rows.filter((r) => r.state === 'unexpected').length,
      unknownCodes: unknown.length,
    });
    expect(counts).toMatchObject({ total: 4, found: 4, pending: 0, unexpected: 1, unknownCodes: 2 });
    expect(unknown.map((u) => [u.code_key, Number(u.seen)])).toEqual([
      ['TAK-ADA-DUA', 12],
      ['TAK-ADA-SATU', 12],
    ]);
    await db.run((tx) => cancelStocktake(tx, db.branchId, id));
  });

  it('lending copies while the finish’s batch runs never leaves a copy on loan marked missing', async () => {
    const shelf = await seedLocation(db, { code: `CL${seq}`, kind: 'room' });
    const shelfCopies = await copies(24, { locationId: shelf });
    const id = await session('Selesai Serentak', shelf);
    const siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const lentCopies = shelfCopies.filter((_, i) => i % 3 === 0);
    const pairs: { code: string; memberId: string }[] = [];
    for (const copy of lentCopies) {
      seq += 1;
      const member = await db.run((tx) => createMember(tx, { memberNo: `SR-M-${seq}`, memberTypeId: siswa, name: 'Pembaca' } as never));
      pairs.push({ code: copy.barcode, memberId: member.id });
    }
    await db.run((tx) => finishStocktake(tx, db.branchId, id, { confirmName: 'Selesai Serentak', markMissing: true, restoreFound: true }, deps));

    const { codes: exits, reports } = await runChildren([
      { ...base(id), actorId: officer(), mode: 'finish' },
      { ...base(id), actorId: officer(), mode: 'lend', pairs },
    ]);
    expect({ exits, errors: reports.map((r) => r?.error ?? null) }).toEqual({ exits: [0, 0], errors: [null, null] });
    const lend = reports[1]!;
    expect((lend.lent ?? []).length + Object.keys(lend.refused ?? {}).length).toBe(pairs.length);
    // A loan is refused only because the copy became missing first.
    for (const [code, error] of Object.entries(lend.refused ?? {})) expect([code, error]).toEqual([code, 'CIRC_NOT_LOANABLE']);

    const items = await db.h.db
      .selectFrom('items as i')
      .innerJoin('stocktake_items as s', (j) => j.onRef('s.item_id', '=', 'i.id').on('s.stocktake_id', '=', id))
      .leftJoin('loans as l', 'l.open_item_id', 'i.id')
      .select(['i.barcode_display', 'i.status', 's.state', 's.result', 'l.id as loan_id'])
      .execute();
    expect(items).toHaveLength(24);
    for (const it of items) {
      if (it.loan_id !== null) {
        expect([it.barcode_display, it.status, it.result], 'a copy on loan').toEqual([it.barcode_display, 'available', 'none']);
        expect(it.state).toBe('on_loan');
      } else {
        expect([it.barcode_display, it.status, it.result], 'a copy not lent').toEqual([it.barcode_display, 'missing', 'marked_missing']);
      }
    }
    expect(items.filter((it) => it.loan_id !== null).map((it) => it.barcode_display).sort()).toEqual([...(lend.lent ?? [])].sort());
    // The session's on-loan counter follows its rows, the finish done.
    const counts = (await getStocktake(db.h.db, db.branchId, id)).counts;
    expect(counts.onLoan).toBe(items.filter((it) => it.state === 'on_loan').length);
  });
});
