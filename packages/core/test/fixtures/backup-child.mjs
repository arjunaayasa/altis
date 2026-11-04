// Child process for backup-create.test.ts, started through `node --import tsx`: runs the slices of one `backup.create`
// job back to back, as a worker or `jobs:run` would (one process, one job session), so that a process killed in the
// middle of a part (ALTIS_TEST_FAULT=export-mid-part:<n>) can be followed by another one that takes the job over
// after its lease (P7, C12).
//
// Usage: backup-child.mjs <optionsJson>, options {config, dbDataDir, dataDir, jobId, budgetMs, offsetMs, sessionKey
// (base64url), installId}. `offsetMs` moves this process's clock (Date.now included: the named locks date their
// leases by it), so a second child stands past the first one's lease. It sends {slices, outcome} and exits 0 once
// the job is no longer continued, 1 on any error, and 2 when its parent's IPC channel closes.
import { decodeBase64Url } from '@altis/crypto';
import { connect } from '@altis/db';
import { backupCreateJob } from '../../src/backup/create-job.ts';
import { claimById } from '../../src/jobs/claim.ts';
import { createJobRegistry } from '../../src/jobs/registry.ts';
import { closeJobSessions, runSlice } from '../../src/jobs/slice.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const realNow = Date.now;
Date.now = () => realNow() + o.offsetMs;
const clock = () => Date.now();
const silent = { info() {}, warn() {}, error() {} };
const keyring = [{ kid: 'k1', key: Buffer.alloc(32, 3).toString('base64url'), active: true }];

const h = await connect(o.config, { runtime: 'standalone', purpose: 'server', dataDir: o.dbDataDir });
const deps = () => ({
  dataDir: o.dataDir,
  installId: o.installId,
  appVersion: '0.1.0',
  sessionKey: decodeBase64Url(o.sessionKey),
  kids: ['k1'],
  runtime: 'pm2',
  connectSnapshot: () => connect(o.config, { runtime: 'standalone', purpose: 'cli', dataDir: o.dbDataDir }),
  ops: {
    begin() {
      throw new Error('backup-child: no ops machine');
    },
  },
});
const reg = createJobRegistry([backupCreateJob(deps)]);

async function run() {
  let slices = 0;
  let outcome = null;
  for (;;) {
    const job = await claimById(h, reg, o.jobId, { worker: `child:${process.pid}`, now: clock() });
    if (job === null) break;
    const r = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: o.budgetMs, keyring, log: silent, clock, env: process.env });
    slices += 1;
    outcome = r.outcome;
    if (r.outcome !== 'continued') break;
  }
  return { slices, outcome };
}

run()
  .then(async (report) => {
    await closeJobSessions();
    await h.close();
    if (process.send === undefined) process.exit(0);
    else process.send(report, () => process.exit(0));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
