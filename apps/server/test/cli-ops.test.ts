import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMaintenance, readOpFile } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { start } from '../src/index.js';
import { captureIo, openInstalled, writeInput } from './cli-support.js';
import { flagOf, readOpJson, writeFlag, writeOp } from './ops-support.js';
import { bootContext, closeTestServers, httpRequest } from './support.js';

// `node app.js ops:resume` and `ops:cancel` (spec §9.4; final review OPS-ATTN-EXIT) on SQLite in a temp DATA_DIR
// installed once: the CLI way out of an op that needs attention when nobody holds its `altis_ops` cookie and the
// processes that boot meanwhile wait in `ops_wait`. `ops:resume` moves the op on to its end; `ops:cancel` ends it as
// the operations page does (refused past its point of no return), audited `ops.cancel` (actor cli); an op.json whose
// `.bak` is unreadable too is set aside, maintenance kept as a manual flag.

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };

let root: string;
let dataDir: string;
let home: string;
let h: DbHandle;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cli-ops-')));
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
  await h.db.deleteFrom('audit_log').where('action', '=', 'ops.cancel').execute();
  await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });
});

afterEach(async () => {
  await closeTestServers();
});

async function cli(argv: string[], env: Record<string, string> = {}) {
  const io = captureIo({ HOME: home, ...env });
  const code = await runCli(argv, bootContext(dataDir), io);
  return { code, io };
}

async function audits() {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'meta'])
    .where('action', '=', 'ops.cancel')
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

/** A `migrate` op that stalled into needs_attention (its flag up), as a stuck CLI or worker leaves it. */
async function stalledMigrate(o: { pointOfNoReturn?: boolean } = {}) {
  const at = Date.now() - 20 * 60_000;
  const written = await writeOp(dataDir, {
    kind: 'migrate',
    state: 'needs_attention',
    stateBefore: 'running',
    at,
    pointOfNoReturn: o.pointOfNoReturn ?? false,
    error: null,
  });
  await writeFlag(dataDir, flagOf('migrate', written.op.opId, at));
  return written.op;
}

/** Polls `/_health` until it answers `status`, for up to `ms`. */
async function healthBecomes(port: number, status: number, ms = 8000): Promise<number> {
  const deadline = Date.now() + ms;
  let reply = await httpRequest(port, '/_health');
  while (reply.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    reply = await httpRequest(port, '/_health');
  }
  return reply.status;
}

/**
 * Polls `/_health` until its body's `status` is `status`, for up to `ms`: the HTTP status alone cannot tell
 * `maintenance` from a process still `starting` (both 503).
 */
async function healthStatusBecomes(port: number, status: string, ms = 8000): Promise<{ code: number; status: unknown }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const reply = await httpRequest(port, '/_health');
    let seen: unknown;
    try {
      seen = (JSON.parse(reply.body) as { status?: unknown } | null)?.status;
    } catch {
      seen = undefined;
    }
    if (seen === status || Date.now() >= deadline) return { code: reply.status, status: seen };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('ops:resume', () => {
  it('moves a stalled op on to its end and lowers its flag; a process waiting in ops_wait then boots', async () => {
    const op = await stalledMigrate();
    const ctx = bootContext(dataDir);
    const started = start(ctx);
    const { port } = await ctx.served();
    // 1d: wait for the body's `maintenance`, not for any 503 (a process still `starting` answers 503 too).
    expect(await healthStatusBecomes(port, 'maintenance')).toEqual({ code: 503, status: 'maintenance' });

    const { code, io } = await cli(['ops:resume', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'ops:resume', opId: op.opId, kind: 'migrate', state: 'done' });
    expect(await readOpFile(dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
    expect(await readMaintenance(dataDir)).toBeNull();

    expect(await healthBecomes(port, 200)).toBe(200);
    await started;
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('refuses an op of a kind this release cannot step (a later release began it), leaving it as it is', async () => {
    // 1d Task 24 (S6): this release steps every kind it knows; the CLI's test hook leaves `update` out, standing for a
    // release that predates the kind of the op.
    const at = Date.now() - 20 * 60_000;
    const { op } = await writeOp(dataDir, { kind: 'update', state: 'needs_attention', stateBefore: 'checking', at });
    await writeFlag(dataDir, flagOf('update', op.opId, at));
    const { code, io } = await cli(['ops:resume'], { ALTIS_TEST_CLI_OP_KINDS_WITHOUT: 'update' });
    expect(code).toBe(1);
    expect(io.err).toMatch(/OPS_KIND_UNKNOWN/);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'needs_attention' });
  }, 15_000);

  it('steps an update op in checking through the CLI\'s own op kinds (S6): its prechecks refuse it, the op ends aborted', async () => {
    // The installed release is 0.1.0 (bootContext): an update to 0.1.0 is not newer.
    const entry = {
      version: '0.1.0',
      channel: 'stable',
      releasedAt: '2026-10-20',
      bootProtocol: 1,
      minUpgradeFrom: '0.0.0',
      minCodeVersionAfter: '0.0.0',
      minNode: '22.16.0',
      minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
      size: 1,
      sha256: 'c'.repeat(64),
      url: 'https://updates.example.test/stable/altis-0.1.0.zip',
      notesUrl: null,
    };
    const { op } = await writeOp(dataDir, {
      kind: 'update',
      state: 'checking',
      params: { source: 'feed', target: '0.1.0', from: '0.1.0', entry, staging: null, needsBackup: null },
    });
    const { code, io } = await cli(['ops:resume']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/UPDATE_PRECHECK_FAILED/);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'aborted', error: { code: 'UPDATE_PRECHECK_FAILED', reason: 'not_newer' } });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await h.db.selectFrom('releases_log').select(['id', 'status']).where('id', '=', op.opId).execute()).toEqual([{ id: op.opId, status: 'aborted' }]);
  }, 15_000);

  it('refuses without an op (OPS_NONE) and for an unreadable op.json (STATE_CORRUPT), exit 1', async () => {
    const none = await cli(['ops:resume']);
    expect(none.code).toBe(1);
    expect(none.io.err).toMatch(/OPS_NONE/);

    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), '{"opSchema"');
    const corrupt = await cli(['ops:resume']);
    expect(corrupt.code).toBe(1);
    expect(corrupt.io.err).toMatch(/STATE_CORRUPT/);
    expect(corrupt.io.err).toMatch(/ops:cancel/);
  });
});

describe('ops:cancel', () => {
  it('ends an op that needs attention in its failure state, lowers its flag, audits ops.cancel (actor cli); an op can begin', async () => {
    const op = await stalledMigrate();
    const { code, io } = await cli(['ops:cancel']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toMatch(/^ops:cancel: /);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'failed', params: { cancelledBy: { type: 'cli', id: null } } });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await audits()).toEqual([
      { actor_type: 'cli', actor_id: null, entity: 'op', entity_id: op.opId, meta: { opId: op.opId, kind: 'migrate' } },
    ]);
    expect((await cli(['migrate'])).code).toBe(0);
  });

  it('refuses past the point of no return (409, exit 1): the op and its flag stay, nothing is audited', async () => {
    const op = await stalledMigrate({ pointOfNoReturn: true });
    const { code, io } = await cli(['ops:cancel']);
    expect(code).toBe(1);
    expect(io.err).toMatch(/OPS_POINT_OF_NO_RETURN/);
    expect(await readOpJson(dataDir)).toMatchObject({ opId: op.opId, state: 'needs_attention' });
    expect((await readMaintenance(dataDir))?.opId).toBe(op.opId);
    expect(await audits()).toEqual([]);
  });

  it('sets an unreadable op.json and .bak aside: maintenance stays as a manual flag, audited; no process waits for it', async () => {
    const opId = '01K8XJ1V2Q3R4S5T6V7W8X9Y0Z';
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), '{"opSchema"');
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json.bak'), '');
    await writeFlag(dataDir, flagOf('restore', opId));

    const { code, io } = await cli(['ops:cancel', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const out = JSON.parse(io.out) as Record<string, unknown>;
    expect(out).toEqual({
      ok: true,
      command: 'ops:cancel',
      opId,
      kind: 'restore',
      state: null,
      setAside: expect.stringMatching(/^ops\/[0-9A-Z]{26}\/$/),
      audited: true,
    });
    expect(await fsp.readFile(path.join(dataDir, String(out['setAside']), 'op.json'), 'utf8')).toBe('{"opSchema"');
    expect(existsSync(path.join(dataDir, 'ops', 'op.json'))).toBe(false);
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'manual', opId: null });
    expect(await audits()).toEqual([
      { actor_type: 'cli', actor_id: null, entity: 'op', entity_id: opId, meta: { opId, kind: 'restore', setAside: true } },
    ]);

    // A process that boots now does not wait for the op (the manual flag only closes the routes it closes).
    const ctx = bootContext(dataDir);
    await start(ctx);
    const { port } = await ctx.served();
    expect((await httpRequest(port, '/_health')).status).toBe(200);
    expect((await cli(['maintenance:off'])).code).toBe(0);
  }, 30_000);

  it('refuses without an op that has not ended (OPS_NONE, exit 1)', async () => {
    const none = await cli(['ops:cancel']);
    expect(none.code).toBe(1);
    expect(none.io.err).toMatch(/OPS_NONE/);
    await stalledMigrate();
    expect((await cli(['ops:cancel'])).code).toBe(0);
    const again = await cli(['ops:cancel']);
    expect(again.code).toBe(1);
    expect(again.io.err).toMatch(/OPS_NONE/);
  });
});
