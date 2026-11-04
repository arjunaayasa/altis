import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { withTx } from '@altis/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { LOCK_FOREVER } from '../../src/catalog/items/patterns.js';
import { writeSettings } from '../../src/settings/service.js';
import { NOW, STAFF, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Phase 2 Task 17 (K4, M8): two processes batch items with one barcode pattern at the same time, each the way the
// batch route does it (ensureBarcodeLockRow outside the transaction, then the batch in its own). The pattern's lock row
// serialises the numbering, so the barcodes never repeat, on every engine (SQLite too: two processes, two connections).

const ctx = testDbContext();
const ROOT = path.resolve(import.meta.dirname, '../../../..');

interface ChildReport {
  created?: string[];
  skipped?: string[];
  attempts?: number;
  error?: string;
}

/** One items-batch-child.mjs per entry of `options`, started together once all are ready; their exit codes and reports. */
async function runChildren(options: object[]): Promise<{ codes: (number | null)[]; reports: (ChildReport | undefined)[] }> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 25_000);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, '../fixtures/items-batch-child.mjs'), [JSON.stringify(o)], {
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
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<{ code: number | null; report: ChildReport | undefined }>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
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

describe.skipIf(!ctx.available)(`items: two processes batch at once (K4, M8) [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let recordId: string;
  let base: Record<string, unknown>;

  beforeAll(async () => {
    db = await openItemsDb('items-concurrency');
    recordId = await seedRecord(db);
    await withTx(db.h, (trx) =>
      writeSettings(
        trx,
        {
          'catalog.barcode.patterns': [
            { id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' },
            { id: 'serentak', name: 'Serentak', prefix: 'SR', digits: 6, suffix: '' },
          ],
        },
        { keyring: [], now: NOW, actorId: null },
      ),
    );
    base = {
      config: db.h.config,
      dataDir: db.h.dataDir,
      branchId: db.branchId,
      recordId,
      collectionTypeId: await db.collectionTypeId('UMUM'),
      actorId: STAFF,
      now: NOW,
      count: 50,
    };
  });

  afterAll(async () => {
    await db?.close();
  });

  const barcodesOf = async (prefix: string): Promise<string[]> =>
    (await db.h.db.selectFrom('items').select('barcode_key').where('barcode_key', 'like', `${prefix}%`).orderBy('barcode_key').execute()).map((r) => r.barcode_key);

  it('two first batches of 50 of a new pattern (no lock row yet) both succeed → 100 distinct contiguous barcodes', async () => {
    expect(await db.h.db.selectFrom('locks').select('name').where('name', '=', 'catalog.barcode:serentak').execute()).toEqual([]);
    const { codes, reports } = await runChildren([
      { ...base, patternId: 'serentak' },
      { ...base, patternId: 'serentak' },
    ]);
    expect({ codes, errors: reports.map((r) => r?.error ?? null) }).toEqual({ codes: [0, 0], errors: [null, null] });
    const created = reports.flatMap((r) => r?.created ?? []);
    expect(new Set(created).size).toBe(100);
    expect(created.sort()).toEqual(Array.from({ length: 100 }, (_, i) => `SR${String(i + 1).padStart(6, '0')}`));
    expect(reports.flatMap((r) => r?.skipped ?? [])).toEqual([]);
    expect(await barcodesOf('SR')).toHaveLength(100);
    expect(await db.h.db.selectFrom('locks').select(['name', 'until']).where('name', '=', 'catalog.barcode:serentak').execute()).toEqual([
      { name: 'catalog.barcode:serentak', until: LOCK_FOREVER },
    ]);
  });

  it('two batches of 50 of the default pattern after B0000005 → B0000006…B0000105, no barcode twice', async () => {
    await seedItem(db, recordId, { barcode: 'B0000005' });
    const { codes, reports } = await runChildren([
      { ...base, patternId: 'default' },
      { ...base, patternId: 'default' },
    ]);
    expect({ codes, errors: reports.map((r) => r?.error ?? null) }).toEqual({ codes: [0, 0], errors: [null, null] });
    const created = reports.flatMap((r) => r?.created ?? []);
    expect(new Set(created).size).toBe(100);
    expect(created.sort()).toEqual(Array.from({ length: 100 }, (_, i) => `B${String(i + 6).padStart(7, '0')}`));
    // Each batch got one contiguous run: the lock serialised the two numberings.
    for (const r of reports) {
      const mine = (r?.created ?? []).map((b) => Number(b.slice(1)));
      expect(mine).toEqual(Array.from({ length: 50 }, (_, i) => mine[0]! + i));
    }
  });
});
