// Child process for ops-machine.test.ts, started through `node --import tsx`: an OpsMachine of its own on the
// parent's DATA_DIR, so that two of them really are two processes racing for `ops/op.json` and `ops/step.lock`.
//
// Usage: ops-child.mjs <optionsJson>, options {dataDir, action: 'begin' | 'step', delayMs}. The machine knows one
// kind, `migrate`, whose step waits `delayMs` and then moves `running` to `done`. The child sends 'ready' over IPC
// and waits for 'go'; then it runs `begin('migrate', {type: 'cli', id: null}, {})` or `step(20_000)` once and sends
// {ok: true, opId, state, handlerCalls} or {ok: false, code, handlerCalls}, and exits 0. Any other failure exits 1.
// It exits 2 when its parent's IPC channel closes, so it never outlives its test.
import { setTimeout as sleep } from 'node:timers/promises';
import { isDomainError } from '@altis/shared';
import { createOpsMachine } from '../../src/ops/machine.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

let handlerCalls = 0;
const kind = {
  kind: 'migrate',
  initialState: 'running',
  maintenance: 'migrate',
  freeze: false,
  async step(_ctx, op) {
    handlerCalls += 1;
    await sleep(o.delayMs);
    return { ...op, state: 'done', progress: 100 };
  },
};

const silent = { info() {}, warn() {}, error() {} };
const machine = createOpsMachine({
  dataDir: o.dataDir,
  kinds: [kind],
  db: () => undefined,
  connect: () => Promise.reject(new Error('no database in this child')),
  keyring: () => [],
  clock: () => Date.now(),
  log: silent,
  snapshotBackupRunning: async () => false,
});

async function run() {
  try {
    if (o.action === 'begin') {
      const handle = await machine.begin('migrate', { type: 'cli', id: null }, {});
      return { ok: true, opId: handle.opId, state: null, handlerCalls };
    }
    const status = await machine.step(20_000);
    return { ok: true, opId: status?.opId ?? null, state: status?.state ?? null, handlerCalls };
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { ok: false, code: error.code, handlerCalls };
  }
}

process.on('message', (message) => {
  if (message !== 'go') return;
  run()
    .then((report) => new Promise((resolve) => process.send(report, resolve)))
    .finally(() => machine.close())
    .then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
});
process.send('ready');
