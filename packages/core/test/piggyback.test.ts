import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreLogger } from '../src/context.js';
import { createPiggyback } from '../src/jobs/piggyback.js';
import type { Runner } from '../src/jobs/runner.js';
import { clearMaintenance, writeMaintenance } from '../src/ops/files.js';
import type { SettingsCache } from '../src/settings/service.js';

// Piggyback's order of looks (spec §10.2; final review T15-PIGGYBACK-READS-DB-IN-MAINTENANCE): the maintenance flag (a
// file) comes before the run records (the `settings` table), so a page view during a restore, whose tables are being
// emptied and loaded again, reads nothing from the database.

const T = 1_800_000_000_000;
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-piggyback-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('createPiggyback: maintenance before the run records', () => {
  it.each(['restore', 'manual'] as const)('during %s maintenance nothing is read from the database and nothing runs', async (reason) => {
    const opId = reason === 'restore' ? newId() : null;
    await writeMaintenance(dataDir, { reason, since: T, opId, exemptJobIds: [] });
    // A worker run a minute ago: once the flag is gone, the run records are read and say a runner is alive.
    const get = vi.fn(async (_db: unknown, key: string) => (key === 'system.run.worker' ? T - 60_000 : null));
    const settings = { get, invalidate() {} } as unknown as SettingsCache;
    const runFor = vi.fn(async () => []);
    const db = vi.fn(() => ({ db: {} }) as unknown as DbHandle);
    const piggyback = createPiggyback({ runner: { runFor } as unknown as Runner, db, dataDir, clock: () => T, log: silent, settings });

    expect(await piggyback.run()).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(runFor).not.toHaveBeenCalled();

    expect(await clearMaintenance(dataDir, opId)).toBe(true);
    expect(await piggyback.run()).toBeNull();
    expect(get).toHaveBeenCalled();
    expect(runFor).not.toHaveBeenCalled();
  });
});
