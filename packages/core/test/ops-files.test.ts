import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeOp,
  bumpDataEpoch,
  clearCorruptReported,
  clearMaintenance,
  corruptReported,
  markCorruptReported,
  readDataEpoch,
  readMaintenance,
  readOpFile,
  writeMaintenance,
  type MaintenanceFlag,
  type OpFile,
} from '../src/ops/files.js';

// The DATA_DIR files of the ops machine (spec §9.4, decision C8): `ops/op.json` (with its `.bak`), the maintenance
// flag `ops/maintenance.json` and the data epoch `ops/data-epoch`.

const T0 = 1_800_000_000_000;

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ops-files-'));
  await fsp.mkdir(path.join(dataDir, 'ops'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function opFile(over: Partial<OpFile> = {}): OpFile {
  return {
    opSchema: 1,
    opId: newId(T0),
    kind: 'migrate',
    actor: { type: 'cli', id: null },
    state: 'running',
    version: '0.1.0',
    backupId: null,
    heartbeatAt: T0,
    startedAt: T0,
    finishedAt: null,
    error: null,
    opsTokenHash: 'a'.repeat(64),
    pointOfNoReturn: false,
    params: {},
    progress: 0,
    message: null,
    ...over,
  };
}

const opJson = (): string => path.join(dataDir, 'ops', 'op.json');

describe('maintenance flag', () => {
  const flag = (opId: string | null): MaintenanceFlag => ({ reason: 'backup', since: T0, opId, exemptJobIds: [] });

  it('round-trips through writeMaintenance and readMaintenance', async () => {
    expect(await readMaintenance(dataDir)).toBeNull();
    const f: MaintenanceFlag = { reason: 'restore', since: T0, opId: newId(), exemptJobIds: [newId()], sqliteRelease: null };
    await writeMaintenance(dataDir, f);
    expect(await readMaintenance(dataDir)).toEqual(f);
  });

  it('clearMaintenance removes only a flag of that op, or a manual one for null', async () => {
    const mine = newId();
    await writeMaintenance(dataDir, flag(mine));
    await clearMaintenance(dataDir, newId());
    expect((await readMaintenance(dataDir))?.opId).toBe(mine);
    await clearMaintenance(dataDir, null);
    expect((await readMaintenance(dataDir))?.opId).toBe(mine);
    await clearMaintenance(dataDir, mine);
    expect(await readMaintenance(dataDir)).toBeNull();

    await writeMaintenance(dataDir, { ...flag(null), reason: 'manual' });
    await clearMaintenance(dataDir, mine);
    expect(await readMaintenance(dataDir)).not.toBeNull();
    await clearMaintenance(dataDir, null);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a cleared flag does not come back from its .bak', async () => {
    const a = newId();
    const b = newId();
    await writeMaintenance(dataDir, flag(a));
    await writeMaintenance(dataDir, flag(b)); // the second write keeps the first flag in maintenance.json.bak
    await clearMaintenance(dataDir, b);
    expect(await readMaintenance(dataDir)).toBeNull();
    await expect(fsp.stat(path.join(dataDir, 'ops', 'maintenance.json.bak'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to write a flag that is not well formed', async () => {
    await expect(writeMaintenance(dataDir, { ...flag(null), reason: 'party' as never })).rejects.toThrow(TypeError);
    await expect(writeMaintenance(dataDir, { ...flag('nope') })).rejects.toThrow(TypeError);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('reads a flag whose file and .bak are both unreadable as a manual flag, which maintenance:off can clear', async () => {
    await fsp.writeFile(path.join(dataDir, 'ops', 'maintenance.json'), '{"reason":');
    const f = await readMaintenance(dataDir);
    expect(f).toMatchObject({ reason: 'manual', opId: null, exemptJobIds: [] });
    await clearMaintenance(dataDir, null);
    expect(await readMaintenance(dataDir)).toBeNull();
  });
});

describe('data epoch', () => {
  it('is 0 when absent and follows bumpDataEpoch', async () => {
    expect(await readDataEpoch(dataDir)).toBe(0);
    expect(await bumpDataEpoch(dataDir)).toBe(1);
    expect(await readDataEpoch(dataDir)).toBe(1);
    expect(await bumpDataEpoch(dataDir)).toBe(2);
    expect(await readDataEpoch(dataDir)).toBe(2);
  });

  it('creates the ops folder when it is missing', async () => {
    await fsp.rm(path.join(dataDir, 'ops'), { recursive: true });
    expect(await bumpDataEpoch(dataDir)).toBe(1);
  });

  it('refuses an epoch file that is not a number', async () => {
    await fsp.writeFile(path.join(dataDir, 'ops', 'data-epoch'), 'twelve\n');
    await expect(readDataEpoch(dataDir)).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });
});

describe('op.json', () => {
  it('is null when absent', async () => {
    expect(await readOpFile(dataDir)).toBeNull();
    expect(await activeOp(dataDir)).toBeNull();
  });

  it('reads the .bak when op.json is truncated', async () => {
    const first = opFile({ progress: 10 });
    await atomicWriteJson(opJson(), first);
    await atomicWriteJson(opJson(), { ...first, progress: 20 }); // .bak = progress 10
    const text = await fsp.readFile(opJson(), 'utf8');
    await fsp.writeFile(opJson(), text.slice(0, 40));
    expect(await readOpFile(dataDir)).toEqual(first);
  });

  it("is 'corrupt' when op.json and its .bak are both unusable", async () => {
    await fsp.writeFile(opJson(), '{"opSchema": 1');
    await fsp.writeFile(`${opJson()}.bak`, 'not json');
    expect(await readOpFile(dataDir)).toBe('corrupt');
    expect(await activeOp(dataDir)).toBe('corrupt');
  });

  it("is 'corrupt' for JSON that is not an opSchema 1 op", async () => {
    await atomicWriteJson(opJson(), { ...opFile(), opSchema: 2 });
    expect(await readOpFile(dataDir)).toBe('corrupt');
    await atomicWriteJson(opJson(), { ...opFile(), state: 'exporting' }); // a backup state on a migrate op
    // The .bak (opSchema 2) is unusable too.
    expect(await readOpFile(dataDir)).toBe('corrupt');
  });

  it('keeps fields a later release added inside opSchema 1', async () => {
    const op = { ...opFile(), futureField: { x: 1 } };
    await atomicWriteJson(opJson(), op);
    expect(await readOpFile(dataDir)).toEqual(op);
  });

  it('activeOp is the running op, and null once it ended', async () => {
    const op = opFile();
    await atomicWriteJson(opJson(), op);
    expect(await activeOp(dataDir)).toEqual(op);
    await atomicWriteJson(opJson(), { ...op, state: 'needs_attention', stateBefore: 'running' });
    expect(await activeOp(dataDir)).toMatchObject({ state: 'needs_attention' });
    await atomicWriteJson(opJson(), { ...op, state: 'done', finishedAt: T0 + 1 });
    expect(await activeOp(dataDir)).toBeNull();
    expect(await readOpFile(dataDir)).toMatchObject({ state: 'done' });
  });
});

describe('corrupt-reported', () => {
  it('remembers which unreadable op was reported, until it is cleared; an unreadable marker counts as none', async () => {
    const id = newId(T0);
    expect(await corruptReported(dataDir, id)).toBe(false);
    await markCorruptReported(dataDir, id);
    expect(await corruptReported(dataDir, id)).toBe(true);
    expect(await corruptReported(dataDir, newId(T0 + 1))).toBe(false);
    expect(await corruptReported(dataDir, null)).toBe(false);
    await markCorruptReported(dataDir, null);
    expect(await corruptReported(dataDir, null)).toBe(true);
    await clearCorruptReported(dataDir);
    expect(await corruptReported(dataDir, null)).toBe(false);
    await clearCorruptReported(dataDir); // nothing to clear

    await fsp.mkdir(path.join(dataDir, 'ops', 'corrupt-reported'));
    expect(await corruptReported(dataDir, null)).toBe(false);
  });
});
