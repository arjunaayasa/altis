// Child process for migrator.test.ts, started through `node --import tsx`.
//
// Usage: migrate-child.mjs <optionsJson>, options {config, connectDataDir, migrateDataDir, appVersion, delayMs?,
// busyMs?} (see fixture-migrations.ts for delayMs/busyMs). Opens the test database (connectDataDir holds the
// SQLite file), sends 'ready' over IPC, waits for 'go' (so that both children start together), runs
// runMigrations with the fixture migrations, sends {outcome, invoked, startedAt, endedAt} and exits 0. `invoked`
// lists every `up` this process started, whether or not its transaction was kept; the times are Date.now()
// around runMigrations.
import { connect } from '../../src/connect.ts';
import { runMigrations } from '../../src/migrator.ts';
import { fixtureMigrations } from './fixture-migrations.ts';

// The sources are run unbundled: give their test hooks (ALTIS_TEST_* in the environment) the test profile that
// Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
const invoked = [];

async function run(h) {
  const migrations = fixtureMigrations({ delayMs: o.delayMs, busyMs: o.busyMs, onUp: (name) => invoked.push(name) });
  const startedAt = Date.now();
  const outcome = await runMigrations(h, { appVersion: o.appVersion, dataDir: o.migrateDataDir, migrations });
  const endedAt = Date.now();
  await new Promise((resolve) => process.send({ outcome, invoked, startedAt, endedAt }, resolve));
}

const h = await connect(o.config, { runtime: 'standalone', purpose: 'cli', dataDir: o.connectDataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  run(h)
    .finally(() => h.close())
    .then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
});
process.send('ready');
