// Child process for migrator-hooks.test.ts (the cumulative `migrate-slow` fault, preflight S22), started through
// `node --import tsx` with the fault in its environment.
//
// Usage: fixture-level-child.mjs <optionsJson>, options {config, connectDataDir, migrateDataDir, appVersion, level}.
// Opens the test database (connectDataDir holds the SQLite file), sends 'ready' over IPC, waits for 'go', runs
// runMigrations with releaseMigrations(level) and an onProgress that counts the calls, sends {outcome, startedAt,
// endedAt, progress} and exits 0. The times are Date.now() around runMigrations.
import { connect } from '../../src/connect.ts';
import { releaseMigrations } from '../../src/migrations/index.ts';
import { runMigrations } from '../../src/migrator.ts';

// The sources are run unbundled: give their test hooks (ALTIS_TEST_* in the environment) the test profile that
// Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);

async function run(h) {
  let progress = 0;
  const startedAt = Date.now();
  const outcome = await runMigrations(h, {
    appVersion: o.appVersion,
    dataDir: o.migrateDataDir,
    migrations: releaseMigrations(o.level),
    onProgress: () => {
      progress += 1;
    },
  });
  const endedAt = Date.now();
  await new Promise((resolve) => process.send({ outcome, startedAt, endedAt, progress }, resolve));
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
process.on('disconnect', () => process.exit(1));
process.send('ready');
