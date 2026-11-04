// Child process for install-code.test.ts, started through `node --import tsx`: two of them call ensureInstallCode on
// one DATA_DIR at the same moment (spec §7.7: every process ends up with the same code).
//
// Usage: install-code-child.mjs <optionsJson>, options {dataDir, now}. Sends 'ready' over IPC and waits for 'go', then
// runs ensureInstallCode(dataDir, {now, env: {}}), sends {code, fresh} and exits 0 (1 on any failure). It exits 2 when
// its parent's IPC channel closes, so it never outlives its test.
import { ensureInstallCode } from '../../src/install/code.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

process.on('message', (message) => {
  if (message !== 'go') return;
  ensureInstallCode(o.dataDir, { now: o.now, env: {} })
    .then((r) => new Promise((resolve) => process.send({ code: r.code, fresh: r.fresh }, resolve)))
    .then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`install-code-child: ${String(error?.stack ?? error)}\n`);
        process.exit(1);
      },
    );
});
process.send('ready');
