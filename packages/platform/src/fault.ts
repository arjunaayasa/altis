import type { Env } from './runtime.js';

// Test faults (spec §12.5, decision C27, preflight S13). The spec's `ALTIS_FAULT` is spelled
// `ALTIS_TEST_FAULT=<name>[:<arg>]`: ruling R57 gives every test hook the `ALTIS_TEST_` prefix and compiles it out of
// production builds, so `faultArmed` is null there whatever the environment says. One fault at a time.
//
// The grammar of the 1c faults (S13):
// - `kill-mid-slice:<k>`: the job runner kills the process after `run()` resolved for the slice whose payload `k` is
//   `<k>`, before the slice's result is written;
// - `export-mid-part:<n>`: the backup exporter kills the process once part `<n>`'s temp file is written;
// - `restore-mid-load:<part>[:replay]`: the restore's load throws at part `<part>` of the main load, and with
//   `:replay` at that part of the `pre_restore` replay too;
// - `disk-full:<area>:<n>`: the `<n>`-th write of the data-files helpers under DATA_DIR area `<area>` (counted from
//   the moment this fault was armed) fails with a synthetic `EDQUOT`; `<area>` = `load` is the restore loader's own
//   hook, which throws before database part `<n>`. Any DATA_DIR area counts, `releases` included (1d: the update's
//   download and extraction).
//
// The update faults of 1d (spec §12.5, decision D1d-25), read by the code each one names:
// - `migrate:<migration name>`: the migrator throws before that migration runs;
// - `migrate-slow:<seconds>`: the migrator waits until that many seconds have passed since the fault was first armed
//   in this DATA_DIR (cumulative across processes), reporting progress every 5 s: a slow migration the boot protocol
//   must survive;
// - `migrate-ddl:<k>`: the `<k>`-th DDL statement of this process throws right after it executed;
// - `health:<version>`: the update's health check of release `<version>` fails;
// - `boot-crash:<version>`: release `<version>`'s server kills its process during a pending boot;
// - `download-corrupt[:<byte offset>]`: the update's download has a byte flipped before it is hashed.
// `health` and `boot-crash` are version-scoped ({@link faultMatchesVersion}): passenger-sim gives every worker the same
// environment, so the fault must hit the release under test and not the one it reverts to; the bare name hits any.
//
// Bundled into app.js with @altis/platform (it is part of the root export), but not called by app.js's own code
// (packages/bootloader): app.js meets `boot-crash` through the server's start(). Outside the test profile every fault
// is inert (R57).

/** The faults of Phase 1c and the update faults of 1d. */
export type TestFault =
  | 'kill-mid-slice'
  | 'restore-mid-load'
  | 'disk-full'
  | 'export-mid-part'
  | 'migrate'
  | 'migrate-slow'
  | 'migrate-ddl'
  | 'health'
  | 'boot-crash'
  | 'download-corrupt';

/**
 * The argument of fault `name` when `ALTIS_TEST_FAULT` in `env` arms it: the text after `<name>:` (`'3:replay'` for
 * `restore-mid-load:3:replay`), `''` for the bare name; null when another fault or none is armed, and always null
 * outside the test profile (an undefined `__BUILD_PROFILE__` counts as production).
 */
export function faultArmed(env: Env, name: TestFault): string | null {
  // The condition stays inline: a production build folds it to false and drops the block, variable name included
  // (the release's PRODUCTION_BUILD_LEAK check). Behind a helper function it would survive.
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const value = env['ALTIS_TEST_FAULT'];
    if (typeof value !== 'string') return null;
    if (value === name) return '';
    return value.startsWith(`${name}:`) ? value.slice(name.length + 1) : null;
  }
  return null;
}

/**
 * True when the version-scoped fault `name` is armed for `version`: `<name>:<version>` with exactly this version, or
 * the bare `<name>` (any version). Always false outside the test profile, as {@link faultArmed} is.
 */
export function faultMatchesVersion(env: Env, name: 'health' | 'boot-crash', version: string): boolean {
  const arg = faultArmed(env, name);
  return arg !== null && (arg === '' || arg === version);
}

/**
 * Kills this process with SIGKILL, as a power cut, an OOM kill or Passenger's idle kill would (spec P7): no finally
 * block, no close, no exit handler runs. The way 1a's install faults end the process.
 */
export function killSelf(): never {
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL to oneself is delivered before the call returns; reaching this line means it was intercepted (a test).
  throw new Error('killSelf: the process is still alive after SIGKILL');
}

/** `<area>:<n>` of a `disk-full` fault. */
const DISK_FULL_ARG = /^([a-z]+):([1-9]\d{0,8})$/;

/** The `disk-full` fault the counter below belongs to, and how many writes under its area it has seen. */
let diskFull: { spec: string; count: number } | null = null;

/**
 * For the data-files helpers (this package only): counts one write under DATA_DIR area `area` and says whether it is
 * the one the armed `disk-full:<area>:<n>` fault makes fail. The count restarts whenever the armed fault changes
 * (and after {@link resetTestFaults}). Always false outside the test profile.
 */
export function diskFullHit(env: Env, area: string): boolean {
  const arg = faultArmed(env, 'disk-full');
  const match = arg === null ? null : DISK_FULL_ARG.exec(arg);
  if (arg === null || match === null) {
    diskFull = null;
    return false;
  }
  if (diskFull === null || diskFull.spec !== arg) diskFull = { spec: arg, count: 0 };
  if (match[1] !== area) return false;
  diskFull.count += 1;
  return diskFull.count === Number(match[2]);
}

/** Forgets the write count of the `disk-full` fault, so a test can arm the same fault again from zero. */
export function resetTestFaults(): void {
  diskFull = null;
}
