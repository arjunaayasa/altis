import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, newId } from '@altis/shared';
import { EXPOSURE_READ_MAX_BYTES, INSTALL_STEPS, INSTALL_STEP_STATES, WIZARD_INSTALL_STATES } from '@altis/shared/api/install';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CRON_SEEN_FRESH_MS,
  assertInstallStep,
  cronStatus,
  ensureInstallProbe,
  exposedBy,
  exposureTargets,
  migrationCounts,
  panelWarningFor,
  removeInstallProbe,
} from '../src/install/steps.js';

// What the wizard's steps decide without a framework (plan Task 27; spec §9.5): the step order, the exposure verdict
// (§9.5 step 1.2), the scheduler test (step 6: required on Passenger/LiteSpeed), the aaPanel warning, the migrations'
// progress. The steps themselves run end to end in apps/server/test/db/install-wizard.test.ts.

const NOW = 1_767_225_600_000;
const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

let root: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-install-steps-')));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('assertInstallStep', () => {
  it('lets each step run only at its installState; 409 INSTALL_STEP_ORDER otherwise', () => {
    expect(() => assertInstallStep('config', null)).not.toThrow();
    expect(() => assertInstallStep('config', 'migrate')).not.toThrow();
    expect(() => assertInstallStep('migrate', 'migrate')).not.toThrow();
    expect(() => assertInstallStep('finish', 'cron')).not.toThrow();
    for (const [step, installState] of [
      ['config', 'profile'],
      ['migrate', null],
      ['profile', 'migrate'],
      ['admin', 'profile'],
      ['admin', 'cron'],
      ['cron_test', 'admin'],
      ['finish', 'admin'],
      ['exposure', 'complete'],
    ] as const) {
      let error: unknown;
      try {
        assertInstallStep(step, installState);
      } catch (e) {
        error = e;
      }
      expect(isDomainError(error) && error.code === 'INSTALL_STEP_ORDER' && error.status === 409, `${step} at ${String(installState)}`).toBe(true);
    }
    expect(Object.keys(INSTALL_STEP_STATES)).toEqual(['exposure', 'db_test', 'config', 'migrate', 'profile', 'admin', 'cron_test', 'finish']);
    expect(() => assertInstallStep('admin', 'admin')).not.toThrow();
    expect(() => assertInstallStep('cron_test', 'cron')).not.toThrow();
  });

  it('the community edition has no licence step: the wizard goes admin → cron', () => {
    expect([...WIZARD_INSTALL_STATES]).toEqual(['migrate', 'profile', 'admin', 'cron']);
    expect([...INSTALL_STEPS]).toEqual(['exposure', 'db_test', 'config', 'migrate', 'profile', 'admin', 'cron_test', 'finish']);
    expect((INSTALL_STEPS as readonly string[]).includes('license')).toBe(false);
    expect((WIZARD_INSTALL_STATES as readonly string[]).includes('license')).toBe(false);
  });
});

describe('the exposure verdict', () => {
  it('a fetched body whose digest is the probe file, app.js or altis-data-dir.txt (any status) → that file; else null', async () => {
    const dataDir = path.join(root, 'altis-data');
    const appRoot = path.join(root, 'app');
    await fsp.mkdir(dataDir);
    await fsp.mkdir(appRoot);
    await fsp.writeFile(path.join(appRoot, 'app.js'), 'bootloader');
    const probeId = newId(NOW);
    const probe = await ensureInstallProbe(dataDir, probeId);
    expect(probe.toString('utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(await ensureInstallProbe(dataDir, probeId)).toEqual(probe); // made once
    if (process.platform !== 'win32') expect((await fsp.stat(path.join(dataDir, 'tmp', probeId))).mode & 0o777).toBe(0o644);

    const targets = await exposureTargets({ dataDir, appRoot, probeId });
    expect(targets).toEqual([
      { kind: 'probe', sha256: sha256(probe) },
      { kind: 'app', sha256: sha256('bootloader') },
    ]);
    const miss = { path: '/x', status: 404, sha256: null };
    expect(exposedBy([miss, { path: '/y', status: 200, sha256: sha256('something else') }], targets)).toBeNull();
    expect(exposedBy([miss, { path: `/tmp/${probeId}`, status: 200, sha256: sha256(probe) }], targets)).toEqual({ kind: 'probe', path: `/tmp/${probeId}` });
    expect(exposedBy([{ path: '/app.js', status: 206, sha256: sha256('bootloader') }], targets)).toEqual({ kind: 'app', path: '/app.js' });

    await fsp.writeFile(path.join(appRoot, 'altis-data-dir.txt'), dataDir);
    expect((await exposureTargets({ dataDir, appRoot, probeId: null })).map((t) => t.kind)).toEqual(['app', 'pointer']);
    await removeInstallProbe(dataDir, probeId);
    expect((await exposureTargets({ dataDir, appRoot, probeId })).map((t) => t.kind)).toEqual(['app', 'pointer']);
    await expect(ensureInstallProbe(dataDir, '../x')).rejects.toThrow(TypeError);
  });

  it('an app.js over 64 KiB: its target is the digest of its first 64 KiB, all the browser reads of a served file', async () => {
    const dataDir = path.join(root, 'altis-data');
    const appRoot = path.join(root, 'app');
    await fsp.mkdir(dataDir);
    await fsp.mkdir(appRoot);
    expect(EXPOSURE_READ_MAX_BYTES).toBe(64 * 1024);
    const app = Buffer.alloc(123_126);
    for (let i = 0; i < app.length; i += 1) app[i] = (i * 31 + 7) % 251;
    await fsp.writeFile(path.join(appRoot, 'app.js'), app);

    const targets = await exposureTargets({ dataDir, appRoot, probeId: null });
    const prefix = sha256(app.subarray(0, EXPOSURE_READ_MAX_BYTES));
    expect(targets).toEqual([{ kind: 'app', sha256: prefix }]);
    expect(exposedBy([{ path: '/app.js', status: 200, sha256: prefix }], targets)).toEqual({ kind: 'app', path: '/app.js' });
    expect(exposedBy([{ path: '/app.js', status: 200, sha256: sha256(app) }], targets)).toBeNull();
  });
});

describe('cronStatus (spec §9.5 step 6)', () => {
  const base = {
    now: NOW,
    execPath: '/home/u/nodevenv/altis/22/bin/node',
    appRoot: '/home/u/altis/app',
    baseUrl: 'https://perpus.example.sch.id',
    cronToken: 'TOKEN_abc',
  };

  it('Passenger: required, not detected until a cron call of the last 15 minutes; the two lines to paste', () => {
    const none = cronStatus({ ...base, runtime: 'passenger', worker: false, seen: null });
    expect(none).toEqual({
      required: true,
      detected: false,
      mode: null,
      at: null,
      cronLine: '*/5 * * * * /home/u/nodevenv/altis/22/bin/node /home/u/altis/app/app.js jobs:run',
      // Ruling R1c-14: curl retries a 503 (a process that could not finish its boot in time), on the now warm process.
      curlLine: 'curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer TOKEN_abc" https://perpus.example.sch.id/_cron',
    });
    const seen = cronStatus({ ...base, runtime: 'litespeed', worker: false, seen: { mode: 'cron_cli', at: NOW - CRON_SEEN_FRESH_MS } });
    expect(seen).toMatchObject({ required: true, detected: true, mode: 'cron_cli', at: NOW - CRON_SEEN_FRESH_MS });
    const stale = cronStatus({ ...base, runtime: 'passenger', worker: false, seen: { mode: 'cron_http', at: NOW - CRON_SEEN_FRESH_MS - 1 } });
    expect(stale).toMatchObject({ required: true, detected: false, mode: null, at: null });
    const future = cronStatus({ ...base, runtime: 'passenger', worker: false, seen: { mode: 'cron_http', at: NOW + 3_600_000 } });
    expect(future.detected).toBe(false);
  });

  it('a worker runtime is detected by its worker and requires nothing; a path with a space is quoted', () => {
    expect(cronStatus({ ...base, runtime: 'pm2', worker: true, seen: null })).toMatchObject({ required: false, detected: true, mode: 'worker', at: null });
    expect(cronStatus({ ...base, runtime: 'standalone', worker: false, seen: null })).toMatchObject({ required: false, detected: false });
    const spaced = cronStatus({ ...base, runtime: 'standalone', worker: true, seen: null, execPath: 'C:\\Program Files\\nodejs\\node.exe', appRoot: "/srv/it's/app/" });
    expect(spaced.cronLine).toBe("*/5 * * * * 'C:\\Program Files\\nodejs\\node.exe' '/srv/it'\\''s/app/app.js' jobs:run");
  });
});

describe('panelWarningFor and migrationCounts', () => {
  it('aaPanel without PM2 → aapanel_default (spec §9.5 step 1: the project of type Default)', () => {
    expect(panelWarningFor('standalone', ['/www/server/panel'])).toBe('aapanel_default');
    expect(panelWarningFor('pm2', ['/www/server/panel'])).toBeNull();
    expect(panelWarningFor('passenger', ['/usr/local/cpanel'])).toBeNull();
    expect(panelWarningFor('standalone', [])).toBeNull();
  });

  it('counts the applied migrations this code knows', () => {
    expect(migrationCounts(['0001_a', '0002_b', '9999_foreign'], ['0001_a', '0002_b', '0003_c'])).toEqual({ applied: 2, total: 3 });
    expect(migrationCounts([], ['0001_a'])).toEqual({ applied: 0, total: 1 });
  });
});
