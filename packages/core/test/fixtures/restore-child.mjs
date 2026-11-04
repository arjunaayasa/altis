// Child process for restore-failure.test.ts, started through `node --import tsx`: a process of its own that steps the
// current restore op on the parent's DATA_DIR and database, as a worker, `jobs:run`, `/_cron` or a drive would, so that
// it can be SIGKILLed in the middle of `loading` (ALTIS_TEST_RESTORE_KILL in its environment) and another process can
// resume the op from op.json (Review Focus 2, P7).
//
// Usage: restore-child.mjs <optionsJson>, options {dataDir, config, dbDataDir, installId, keyring, sessionKey
// (base64url), budgetMs}. It steps the op (each call `budgetMs`) until it ends or needs attention, sends
// {state, error, steps} over IPC and exits 0; any failure exits 1. It exits 2 when its parent's IPC channel closes, so it
// never outlives its test.
import { decodeBase64Url } from '@altis/crypto';
import { PHASE1_MIGRATIONS, connect } from '@altis/db';
import { createOpsMachine } from '../../src/ops/machine.ts';
import { restoreKind } from '../../src/restore/kind.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const silent = { info() {}, warn() {}, error() {} };
const sessionKey = decodeBase64Url(o.sessionKey);
const machine = createOpsMachine({
  dataDir: o.dataDir,
  kinds: [
    restoreKind({
      dataDir: o.dataDir,
      appVersion: '0.1.0',
      migrations: PHASE1_MIGRATIONS,
      sessionKey: () => sessionKey,
      keyring: () => o.keyring,
      installId: o.installId,
      requestRestart: async () => {},
      sqliteSwap: null,
    }),
  ],
  // A process without a live handle of its own, as one waiting in `ops_wait`: the op reaches the database through its
  // dedicated connection only.
  db: () => undefined,
  connect: () => connect(o.config, { runtime: 'standalone', purpose: 'cli', dataDir: o.dbDataDir }),
  keyring: () => o.keyring,
  clock: () => Date.now(),
  log: silent,
  snapshotBackupRunning: async () => false,
});

async function run() {
  let status = null;
  let steps = 0;
  for (let i = 0; i < 100_000; i += 1) {
    status = await machine.step(o.budgetMs);
    steps += 1;
    if (status === null || status.terminal || status.needsAttention) break;
  }
  return { state: status?.state ?? null, error: status?.error ?? null, steps };
}

run()
  .then(async (report) => {
    await machine.close();
    if (process.send === undefined) process.exit(0);
    else process.send(report, () => process.exit(0));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
