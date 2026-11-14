import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { freezePeriod, getSnapshot } from '../../src/accreditation/evaluate/index.js';
import { evaluateNow, fakeProviders, inTx, openAccredDb, seedPeriod, type AccredDb } from './accred-results-support.js';

// A freeze racing the answers of another librarian, on the engine picked by ALTIS_TEST_DB: a second process writes
// one indicator's answer again and again (each write numbered, its letter and mode following the number) while this
// one freezes the period. Every write either commits before the freeze, which then reads it, or is refused with
// ACCRED_PERIOD_FROZEN: none commits after the freeze. The answer left in the table is the one of the last write that
// committed, and the snapshot holds that same answer.

const ctx = testDbContext();
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const CODE = 'SCH-SP1';

interface WriteReport {
  seq: number;
  ok?: true;
  frozen?: true;
  error?: string;
}

const letterOf = (seq: number): string => 'abcd'[(seq - 1) % 4]!;
const modeOf = (seq: number): string => (Math.floor((seq - 1) / 4) % 2 === 0 ? 'manual' : 'override');

describe.skipIf(!ctx.available)(`accreditation freeze racing an answer write [${engineLabel()}]`, () => {
  let db: AccredDb;

  beforeAll(async () => {
    db = await openAccredDb('accred-freeze-race');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('a write commits before the freeze or is refused as frozen; the snapshot holds the last committed answer', async () => {
    const periodId = await seedPeriod(db);
    expect(await evaluateNow(db, periodId, fakeProviders())).toEqual(['succeeded']);

    const log: WriteReport[] = [];
    let wake: (() => void) | null = null;
    const child: ChildProcess = fork(
      path.join(import.meta.dirname, '../fixtures/accred-freeze-child.mjs'),
      [JSON.stringify({ config: db.h.config, dataDir: db.h.dataDir, periodId, code: CODE, actorId: db.staffId, frozenStop: 3 })],
      { cwd: ROOT, env: process.env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
    try {
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else {
            log.push(message as WriteReport);
            wake?.();
          }
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      let closed = false;
      const exited = new Promise<number | null>((resolve) =>
        child.once('close', (code) => {
          closed = true;
          wake?.();
          resolve(code);
        }),
      );
      await ready;
      child.send('go');
      // Freeze once the other process has committed a few writes and is writing on.
      while (!closed && log.filter((r) => r.ok === true).length < 5) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const frozen = await inTx(db, (tx) => freezePeriod(tx, periodId, {}, Date.now()));
      expect(await exited).toBe(0);

      expect(log.filter((r) => r.ok !== true && r.frozen !== true)).toEqual([]);
      expect(log.map((r) => r.seq)).toEqual(log.map((_, i) => i + 1));
      const committed = log.filter((r) => r.ok === true).map((r) => r.seq);
      const refused = log.filter((r) => r.frozen === true).map((r) => r.seq);
      const last = Math.max(...committed);
      expect(committed.length).toBeGreaterThanOrEqual(5);
      expect(refused).toHaveLength(3);
      // Every write after the first refusal was refused too: the very next write after the last commit.
      expect(refused[0]).toBe(last + 1);
      expect(committed.every((seq) => seq < refused[0]!)).toBe(true);

      const row = await db.h.db.selectFrom('accred_answers').select(['answer', 'mode', 'note']).where('period_id', '=', periodId).where('indicator_code', '=', CODE).executeTakeFirstOrThrow();
      expect(row).toEqual({ answer: letterOf(last), mode: modeOf(last), note: `urutan ${last}` });
      const snapshot = await getSnapshot(db.h.db, frozen.id);
      expect({ a: snapshot.values.i[CODE]!.a, m: snapshot.values.i[CODE]!.m }).toEqual({ a: row.answer, m: row.mode });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 60_000);
});
