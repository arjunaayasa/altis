import { fork } from 'node:child_process';
import path from 'node:path';
import { withTx } from '@altis/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { __setImportSliceObserver, startCatalogImport, type ImportSliceRead } from '../../src/catalog/exchange/import-job.js';
import { txCtx } from '../../src/context.js';
import { claimById } from '../../src/jobs/claim.js';
import { runSlice } from '../../src/jobs/slice.js';
import { JOB_LEASE_MS, retryDelayMs } from '../../src/jobs/types.js';
import { KEYRING, importOptions, openExchangeDb, runOf, stageFile, type ExchangeDb } from './catalog-exchange-support.js';
import { NOW } from './catalog-records-support.js';

// The import resumes byte-accurately after a SIGKILL (Phase 2 Task 31; spec §5.3, K5; S21) on the engine picked by
// ALTIS_TEST_DB: a child process runs a 2 000-record MARCXML import whose collection declares the `marc:` prefix on its
// root; the test kills it with SIGKILL once the run's summary counts 400 records read; a fresh runner (this process)
// reclaims the job after its lease and backoff and resumes from the checkpointed byte and namespace prefixes: 2 000
// records and 2 000 `migration_map` rows in the end, none twice, and the resumed slice read only the bytes after its
// checkpoint (it never parsed the file again from byte 0, which would be quadratic over 100 000 records).

const ctx = testDbContext();
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const MARC_NS = 'http://www.loc.gov/MARC21/slim';
const RECORDS = 2000;
const silent = { info() {}, warn() {}, error() {} };

/** The test file: `marc:`-prefixed records under a root that declares the prefix, titles with multibyte characters. */
function prefixedCollection(): Buffer {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>\n<marc:collection xmlns:marc="${MARC_NS}">\n`];
  for (let i = 1; i <= RECORDS; i += 1) {
    parts.push(
      '<marc:record><marc:leader>00000nam a2200000 i 4500</marc:leader>' +
        `<marc:controlfield tag="001">RES-${i}</marc:controlfield>` +
        `<marc:datafield tag="245" ind1="1" ind2="0"><marc:subfield code="a">Judul \u00fcj\u00ee \u4e66 ke-${i}</marc:subfield></marc:datafield>` +
        '</marc:record>\n',
    );
  }
  parts.push('</marc:collection>\n');
  return Buffer.from(parts.join(''), 'utf8');
}

interface Summary {
  read: number;
  created: number;
  resume?: { position: { byteOffset: number; recordNo: number; xmlPrefixes?: Record<string, string> }; done: number };
}

describe.skipIf(!ctx.available)(`catalog import: SIGKILL in a slice, resumed from the checkpointed byte (S21) [${engineLabel()}]`, () => {
  let db: ExchangeDb;

  beforeAll(async () => {
    db = await openExchangeDb('import-resume');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  afterEach(() => {
    __setImportSliceObserver(null);
  });

  const summaryOf = async (runId: string): Promise<Summary> =>
    JSON.parse((await db.h.db.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirstOrThrow()).summary) as Summary;

  it(
    'a 2 000-record MARCXML import killed after 400 records resumes from its byte and prefixes: 2 000 records, none twice',
    async () => {
      const file = prefixedCollection();
      const stagingId = await stageFile(db, file);
      const started = await withTx(db.h, (trx) =>
        startCatalogImport(txCtx(trx, NOW, db.staff), db.reg, { body: importOptions({ uploadId: stagingId }), stagingId }, { keyring: KEYRING }),
      );

      // The child runs the import, pausing after every batch; it is killed as soon as 400 records are counted.
      const child = fork(
        path.join(import.meta.dirname, '../fixtures/import-child.mjs'),
        [JSON.stringify({ config: db.h.config, dbDataDir: db.h.dataDir, dataDir: db.dataDir, jobId: started.jobId, now: NOW, pauseMs: 300 })],
        { cwd: ROOT, env: process.env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
      );
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
      await new Promise<void>((resolve, reject) => {
        child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(`unexpected ${String(m)}`))));
        child.once('exit', (code) => reject(new Error(`the child exited (${String(code)}) before it was ready`)));
      });
      child.send('go');
      let atKill: Summary | null = null;
      const deadline = Date.now() + 90_000;
      try {
        while (Date.now() < deadline && child.exitCode === null) {
          const s = await summaryOf(started.runId);
          if (s.read >= 400) {
            child.kill('SIGKILL');
            atKill = s;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
      expect(atKill).not.toBeNull();
      const killed = await summaryOf(started.runId);
      // The kill came between two batches of 200: what the summary counts is what was committed.
      expect(killed.read).toBeGreaterThanOrEqual(400);
      expect(killed.read).toBeLessThan(RECORDS);
      expect(await db.h.db.selectFrom('records').select('id').execute()).toHaveLength(killed.created);
      const checkpoint = killed.resume!.position;
      expect(checkpoint.byteOffset).toBeGreaterThan(0);
      expect(checkpoint.recordNo).toBeLessThanOrEqual(killed.resume!.done);
      expect(checkpoint.xmlPrefixes).toMatchObject({ marc: MARC_NS, '#open': 'marc:collection' });

      // A fresh runner reclaims the job once the dead child's lease and the backoff have passed, and resumes.
      const reads: ImportSliceRead[] = [];
      __setImportSliceObserver((r) => reads.push(r));
      const later = NOW + JOB_LEASE_MS + retryDelayMs(1) + 1_000;
      // The dead child's `jobs:heavy` lease is renewed on the wall clock, which stands months after this test's clock:
      // it is let run out here, as it would 50 s after the kill.
      await db.h.db.updateTable('locks').set({ until: NOW }).where('name', '=', 'jobs:heavy').execute();
      const outcomes: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const job = await claimById(db.h, db.reg, started.jobId, { worker: 'resumer', now: later });
        expect(job, 'the job can be reclaimed').not.toBeNull();
        const r = await runSlice(db.h, db.reg, job!, { mode: 'worker', budgetMs: 20_000, keyring: KEYRING, log: silent, clock: () => later, env: {} });
        outcomes.push(r.outcome);
        if (r.outcome !== 'continued') break;
      }
      // One slice of 20 s usually reads the rest; a slow machine (each batch is indexed twice since review X1) may need
      // more, each going on from its own checkpoint.
      expect(outcomes.at(-1)).toBe('succeeded');
      expect(outcomes.slice(0, -1).every((o) => o === 'continued')).toBe(true);
      const done = await runOf(db, started.runId, started.jobId);
      expect(done.run.status).toBe('succeeded');
      expect(done.summary).toMatchObject({ read: RECORDS, created: RECORDS, errors: 0 });
      const titles = await db.h.db.selectFrom('records').select('title').execute();
      expect(titles).toHaveLength(RECORDS);
      expect(new Set(titles.map((t) => t.title)).size).toBe(RECORDS);
      const mapped = await db.h.db.selectFrom('migration_map').select('legacy_key').where('source', '=', `import:${started.runId}`).execute();
      expect(mapped).toHaveLength(RECORDS);
      expect(new Set(mapped.map((m) => m.legacy_key)).size).toBe(RECORDS);
      // The resumed slice started at the checkpointed byte and read only the bytes after it. A later slice (a slow machine)
      // starts further on, inside what the one before it read (its reader may have read past its last batch), and the
      // last one reads to the end.
      expect(reads).toHaveLength(outcomes.length);
      expect(reads[0]).toMatchObject({ runId: started.runId, startByte: checkpoint.byteOffset });
      for (let i = 1; i < reads.length; i += 1) {
        expect(reads[i]!.startByte).toBeGreaterThan(reads[i - 1]!.startByte);
        expect(reads[i]!.startByte).toBeLessThanOrEqual(reads[i - 1]!.startByte + reads[i - 1]!.bytesRead);
      }
      expect(reads.at(-1)!.startByte + reads.at(-1)!.bytesRead).toBe(file.byteLength);
    },
    180_000,
  );

  it('slices too short for a second batch still move on: a 2 000-record import in 400 ms slices ends, none twice', async () => {
    // A cron pass may hand a job the last 250 ms of its budget (runner.ts MIN_SLICE_MS), below the import's save margin:
    // the slice then writes one batch. The MARCXML reader can resume only at its chunk edges, so the next slice starts
    // at the same byte and reads the records it already wrote again before it reaches new ones; those it skips do not
    // count as its batch, or no slice would ever write another.
    const file = prefixedCollection();
    const stagingId = await stageFile(db, file);
    const started = await withTx(db.h, (trx) =>
      startCatalogImport(txCtx(trx, NOW, db.staff), db.reg, { body: importOptions({ uploadId: stagingId }), stagingId }, { keyring: KEYRING }),
    );
    const outcomes: string[] = [];
    const reads: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const job = await claimById(db.h, db.reg, started.jobId, { worker: 'short', now: NOW });
      expect(job, 'the job can be claimed').not.toBeNull();
      const r = await runSlice(db.h, db.reg, job!, { mode: 'worker', budgetMs: 400, keyring: KEYRING, log: silent, clock: () => NOW, env: {} });
      outcomes.push(r.outcome);
      if (r.outcome !== 'continued') break;
      reads.push((await summaryOf(started.runId)).read);
    }
    expect(outcomes.at(-1)).toBe('succeeded');
    // Every slice that went on wrote records: the count read grows with each (a batch, or the part of one past the
    // records the slice passed over).
    for (let i = 1; i < reads.length; i += 1) expect(reads[i]!, `slice ${i + 1}`).toBeGreaterThan(reads[i - 1]!);
    const done = await runOf(db, started.runId, started.jobId);
    expect(done.summary).toMatchObject({ read: RECORDS, created: RECORDS, errors: 0 });
    const mapped = await db.h.db.selectFrom('migration_map').select('legacy_key').where('source', '=', `import:${started.runId}`).execute();
    expect(new Set(mapped.map((m) => m.legacy_key)).size).toBe(RECORDS);
    expect(mapped).toHaveLength(RECORDS);
  }, 180_000);
});
