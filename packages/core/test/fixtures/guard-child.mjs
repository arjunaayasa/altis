// Child process for super-admin-guard.test.ts, started through `node --import tsx` (B5: a separate process on every
// engine, SQLite included, so that the two transactions really run on two connections).
//
// Usage: guard-child.mjs <optionsJson>, options {config, dataDir, disable, pauseMs}. Opens the test database
// (dataDir holds the SQLite file), sends 'ready' over IPC and waits for 'go'. Then it runs ONE transaction, in the
// shape every service that can remove a super admin has (decision D14): guardSuperAdmins(trx, fn) as the first
// statement, and inside fn first a plain SELECT of staff_users (the read that fixes a MySQL/MariaDB REPEATABLE READ
// snapshot), then `disable` set to status 'disabled', then a pause of pauseMs before fn returns. It sends
// {outcome: 'committed' | 'refused', code, attempts, startedAt, endedAt} and exits 0; 'refused' carries the
// DomainError code (LAST_SUPER_ADMIN expected). Any other failure exits 1. It exits 2 when its parent's IPC channel
// closes, so it never outlives its test.
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, withTx } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { guardSuperAdmins } from '../../src/authz/super-admin-guard.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

async function disable(h) {
  let attempts = 0;
  const startedAt = Date.now();
  try {
    await withTx(h, (trx) => {
      attempts += 1;
      return guardSuperAdmins(trx, async () => {
        await trx.selectFrom('staff_users').select(['id', 'status']).execute();
        await trx.updateTable('staff_users').set({ status: 'disabled', updated_at: Date.now() }).where('id', '=', o.disable).execute();
        await sleep(o.pauseMs);
      });
    });
    return { outcome: 'committed', code: null, attempts, startedAt, endedAt: Date.now() };
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { outcome: 'refused', code: error.code, attempts, startedAt, endedAt: Date.now() };
  }
}

// The production shape on a server engine: a Passenger worker with its small pool. SQLite is refused on Passenger,
// so it runs standalone.
const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  disable(h)
    .then((report) => new Promise((resolve) => process.send(report, resolve)))
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
