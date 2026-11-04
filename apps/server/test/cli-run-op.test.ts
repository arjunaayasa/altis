import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpsMachine, readOpFile, type OpFile, type OpKindHandler, type OpsMachine } from '@altis/core';
import { DomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_OP_ACTOR, runOpToEnd } from '../src/cli/migrate.js';
import { recordingLogger } from './support.js';

// runOpToEnd (cli/migrate.ts), the loop `migrate` and `install:reset` step their op with: when it cannot finish its own
// op it cancels it, but never an op somebody else began after its own ended (final review T24).

let dataDir: string;
let machines: OpsMachine[];

beforeEach(async () => {
  dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-run-op-')));
  machines = [];
});

afterEach(async () => {
  for (const m of machines) await m.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

/** A kind that never ends by itself (`running`, progress unchanged). */
function stuck(kind: 'migrate' | 'reset'): OpKindHandler {
  return { kind, initialState: 'running', maintenance: kind, freeze: false, step: async (_ctx, op: OpFile) => op };
}

function machine(kinds: OpKindHandler[]): OpsMachine {
  const m = createOpsMachine({
    dataDir,
    kinds,
    db: () => undefined,
    connect: () => Promise.reject(new Error('no database')),
    keyring: () => [],
    clock: () => Date.now(),
    log: recordingLogger(),
    snapshotBackupRunning: async () => false,
  });
  machines.push(m);
  return m;
}

describe('runOpToEnd', () => {
  it('a step that finds another op (its own ended meanwhile) throws OPS_NONE and cancels nothing', async () => {
    const done: OpKindHandler = { ...stuck('migrate'), step: async (_ctx, op) => ({ ...op, state: 'done' }) };
    const m = machine([done, stuck('reset')]);
    const mine = await m.begin('migrate', CLI_OP_ACTOR, {});
    await m.step(1000); // ended by another process
    const theirs = await m.begin('reset', { type: 'staff', id: '01K8XJ1V2Q3R4S5T6V7W8X9Y0Z' }, {});
    const error = await runOpToEnd(m, mine.opId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('OPS_NONE');
    expect(await readOpFile(dataDir)).toMatchObject({ opId: theirs.opId, state: 'running' });
  });
});
