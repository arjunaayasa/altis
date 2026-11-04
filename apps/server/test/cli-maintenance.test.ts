import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpsMachine, readMaintenance, resetKind, type OpsMachine } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { start } from '../src/index.js';
import { captureIo, openInstalled, writeInput } from './cli-support.js';
import { bootContext, closeTestServers, httpRequest, recordingLogger } from './support.js';

// `node app.js maintenance:on [--reason <text>]` and `maintenance:off [--force]` (spec §9.4, §13.6; 1c Task 24) on
// SQLite in a temp DATA_DIR installed once: the manual flag `ops/maintenance.json` {reason: 'manual', since, opId:
// null, exemptJobIds: []}, its audit entries (actor `cli`, written when the database answers), `off` refused while an
// op has not ended unless `--force`, and a running app answering a `deny` route with 503 once its fence has looked.

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };

let root: string;
let dataDir: string;
let home: string;
let h: DbHandle;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-maintenance-')));
  dataDir = path.join(root, 'altis-data');
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  const input = await writeInput(path.join(root, 'input'), { baseUrl: 'https://perpus.example.sch.id', db: { dialect: 'sqlite' }, admin: ADMIN });
  const io = captureIo({ HOME: home }, { hostPanels: () => [] });
  const code = await runCli(['install', '--config', input], bootContext(dataDir), io);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
  h = await openInstalled(dataDir);
}, 60_000);

afterAll(async () => {
  await h?.close();
  if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await h.db.deleteFrom('audit_log').where('action', 'in', ['maintenance.on', 'maintenance.off']).execute();
  await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });
});

afterEach(async () => {
  await closeTestServers();
});

async function cli(argv: string[], dir = dataDir) {
  const io = captureIo({ HOME: home });
  const code = await runCli(argv, bootContext(dir), io);
  return { code, io };
}

async function audits(action: string) {
  const rows = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id', 'meta']).where('action', '=', action).orderBy('seq').execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

const flagFile = () => path.join(dataDir, 'ops', 'maintenance.json');

/** An OpsMachine of DATA_DIR with the reset kind and no database: what a CLI that began an op leaves behind. */
function machine(dir = dataDir): OpsMachine {
  return createOpsMachine({
    dataDir: dir,
    kinds: [resetKind()],
    db: () => undefined,
    connect: () => Promise.reject(new Error('no database here')),
    keyring: () => [],
    clock: () => Date.now(),
    log: recordingLogger(),
    snapshotBackupRunning: async () => false,
  });
}

describe('maintenance:on', () => {
  it('writes the manual flag and audits maintenance.on (actor cli) with the reason', async () => {
    const before = Date.now();
    const { code, io } = await cli(['maintenance:on', '--reason', 'Pindah server']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/^maintenance:on: /);
    const flag = JSON.parse(await fsp.readFile(flagFile(), 'utf8')) as Record<string, unknown>;
    expect(flag).toEqual({ reason: 'manual', since: expect.any(Number), opId: null, exemptJobIds: [] });
    expect(flag['since']).toBeGreaterThanOrEqual(before);
    expect(await audits('maintenance.on')).toEqual([{ actor_type: 'cli', actor_id: null, meta: { reason: 'Pindah server' } }]);
  });

  it('--json; a flag already up is kept as it is and not audited again', async () => {
    const first = await cli(['maintenance:on', '--json']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.io.out)).toEqual({ ok: true, command: 'maintenance:on', alreadyOn: false, audited: true });
    const flag = await fsp.readFile(flagFile(), 'utf8');

    const again = await cli(['maintenance:on', '--json', '--reason=lagi']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.io.out)).toEqual({ ok: true, command: 'maintenance:on', alreadyOn: true, audited: false });
    expect(await fsp.readFile(flagFile(), 'utf8')).toBe(flag);
    expect(await audits('maintenance.on')).toEqual([{ actor_type: 'cli', actor_id: null, meta: { reason: null } }]);
  });

  it('refuses a reason that is empty, longer than 100 characters or holds control characters', async () => {
    for (const reason of ['', 'x'.repeat(101), 'baris\nbaru']) {
      const { code, io } = await cli(['maintenance:on', '--reason', reason]);
      expect(code, JSON.stringify(reason)).toBe(1);
      expect(io.err).toMatch(/USAGE/);
    }
    expect((await cli(['maintenance:on', '--reason', 'x'.repeat(100)])).code).toBe(0);
    await expect(fsp.stat(flagFile())).resolves.toBeTruthy();
  });

  it('works when the database does not answer (not installed): the flag is written, nothing audited', async () => {
    const bare = path.join(root, 'bare-data');
    await fsp.mkdir(bare, { recursive: true });
    const { code, io } = await cli(['maintenance:on', '--json'], bare);
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'maintenance:on', alreadyOn: false, audited: false });
    expect(await readMaintenance(bare)).toMatchObject({ reason: 'manual', opId: null });
    const off = await cli(['maintenance:off'], bare);
    expect(off.code).toBe(0);
    expect(await readMaintenance(bare)).toBeNull();
  });
});

describe('maintenance:off', () => {
  it('removes the manual flag and audits maintenance.off {force: false}; with no flag: exit 0, nothing audited', async () => {
    expect((await cli(['maintenance:on'])).code).toBe(0);
    const { code, io } = await cli(['maintenance:off', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'maintenance:off', wasOn: true, audited: true });
    await expect(fsp.stat(flagFile())).rejects.toThrow();
    await expect(fsp.stat(`${flagFile()}.bak`)).rejects.toThrow();
    expect(await audits('maintenance.off')).toEqual([{ actor_type: 'cli', actor_id: null, meta: { force: false } }]);

    const again = await cli(['maintenance:off']);
    expect(again.code).toBe(0);
    expect(again.io.out).toMatch(/^maintenance:off: /);
    expect(await audits('maintenance.off')).toHaveLength(1);
  });

  it('refuses while an op has not ended (exit 1, OPS_IN_PROGRESS); --force removes the flag, audited {force: true}', async () => {
    const ops = machine();
    const handle = await ops.begin('reset', { type: 'cli', id: null }, {});
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'reset', opId: handle.opId });

    const refused = await cli(['maintenance:off']);
    expect(refused.code).toBe(1);
    expect(refused.io.err).toMatch(/OPS_IN_PROGRESS/);
    expect(refused.io.err).toMatch(/--force/);
    expect(await readMaintenance(dataDir)).toMatchObject({ opId: handle.opId });
    expect(await audits('maintenance.off')).toEqual([]);

    const forced = await cli(['maintenance:off', '--force', '--json']);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.io.out)).toEqual({ ok: true, command: 'maintenance:off', wasOn: true, audited: true });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await audits('maintenance.off')).toEqual([{ actor_type: 'cli', actor_id: null, meta: { force: true } }]);

    await ops.cancel({ type: 'cli', id: null });
    await ops.close();
  });

  it('a flag left up by an op that ended is removed without --force', async () => {
    const ops = machine();
    await ops.begin('reset', { type: 'cli', id: null }, {});
    await ops.cancel({ type: 'cli', id: null }); // ends the op and lowers its flag
    await ops.close();
    expect((await cli(['maintenance:on'])).code).toBe(0);
    const { code } = await cli(['maintenance:off']);
    expect(code).toBe(0);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('refuses options it does not know', async () => {
    const { code, io } = await cli(['maintenance:off', '--reason', 'x']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/USAGE/);
  });
});

describe('a running app (Task 15 gate)', () => {
  it('answers a deny route with 503 MAINTENANCE once its fence has looked, and again normally after off', async () => {
    const ctx = bootContext(dataDir);
    await start(ctx);
    const { port } = await ctx.served();
    const branches = () => httpRequest(port, '/api/v1/branches');
    expect((await branches()).status).toBe(401);

    expect((await cli(['maintenance:on'])).code).toBe(0);
    const deadline = Date.now() + 6000;
    let reply = await branches();
    while (reply.status !== 503 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      reply = await branches();
    }
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ code: 'MAINTENANCE' });

    expect((await cli(['maintenance:off'])).code).toBe(0);
    const until = Date.now() + 6000;
    reply = await branches();
    while (reply.status === 503 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      reply = await branches();
    }
    expect(reply.status).toBe(401);
  }, 30_000);
});
