import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readOpFile, type OpFile, type UpdateKindDeps } from '@altis/core';
import { connect, type DbHandle } from '@altis/db';
import { readCurrentState, updateCurrentState, type CurrentState } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { runCli } from '../../src/cli/index.js';
import { opKinds } from '../../src/jobs/runtime.js';
import { captureIo, writeInput, type CapturedIo } from '../cli-support.js';
import { bootContext, useDataDir, type TestBootContext } from '../support.js';

// `node app.js release:list [--json]`, `release:rollback [--force] [--json]` and `release:unpin [--json]` (spec §9.7,
// §13.6; plan Task 26; decision D1d-33; preflight 1D-02, 1D-03) against the engine picked by ALTIS_TEST_DB, on a
// DATA_DIR installed by the headless install. current.json, the release folders, schema-meta.json and op.json are
// fixtures written here (a test has no app.js to make them). `release:rollback` reverts a pending release when one is
// set (op.json first, then `pending = null`), and otherwise runs the manual rollback op to its end.

const engine = testDbContext();
const dirs = useDataDir();
const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const SERVER_DIR = path.resolve(import.meta.dirname, '..', '..');
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const V3 = '0.3.0-test';

let ctx: TestBootContext;
let children: ChildProcessWithoutNullStreams[];

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // empties the worker's database
  await fsp.mkdir(path.join(dirs.root, 'home'));
  ctx = bootContext(dirs.dataDir);
  children = [];
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

const env = () => ({ HOME: path.join(dirs.root, 'home') });

async function cli(argv: string[]): Promise<{ code: number; io: CapturedIo }> {
  const io = captureIo(env(), { hostPanels: () => [] });
  const code = await runCli(argv, ctx, io);
  return { code, io };
}

/** The one JSON line of a `--json` run. */
function jsonLine(io: CapturedIo): Record<string, unknown> {
  const lines = io.out.split('\n').filter((l) => l !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function installed(): Promise<void> {
  const input = await writeInput(path.join(dirs.root, 'input'), { baseUrl: 'https://perpus.example', db: testDbConfig(), library: { name: 'Pustaka Rilis' }, admin: ADMIN });
  const { code, io } = await cli(['install', '--config', input]);
  expect(io.err).toBe('');
  expect(code).toBe(0);
}

function open(): Promise<DbHandle> {
  return connect(testDbConfig(), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
}

async function audit(action: string): Promise<{ actor: string; meta: Record<string, unknown> }[]> {
  const h = await open();
  try {
    const rows = await h.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', action).orderBy('seq').execute();
    return rows.map((r) => ({ actor: r.actor_type, meta: JSON.parse(r.meta) as Record<string, unknown> }));
  } finally {
    await h.close();
  }
}

async function setState(s: Omit<CurrentState, 'schema' | 'pendingSince'>): Promise<void> {
  await readCurrentState(dirs.dataDir, s.active.version);
  await updateCurrentState(dirs.dataDir, () => ({ schema: 1, pendingSince: s.pending === null ? null : Date.now(), ...s }));
}

const currentText = (): Promise<string> => fsp.readFile(path.join(dirs.dataDir, 'releases', 'current.json'), 'utf8');
const current = async (): Promise<CurrentState> => JSON.parse(await currentText()) as CurrentState;
const opText = (): Promise<string> => fsp.readFile(path.join(dirs.dataDir, 'ops', 'op.json'), 'utf8');

async function opJson(): Promise<OpFile> {
  const op = await readOpFile(dirs.dataDir);
  if (op === null || op === 'corrupt') throw new Error('op.json');
  return op;
}

/** A release folder with `.complete`: DATA_DIR/releases/<v>, or <appRoot>/bundled-release/<v>. */
async function release(version: string, source: 'data' | 'bundled', o: { complete?: boolean } = {}): Promise<void> {
  const dir = source === 'data' ? path.join(dirs.dataDir, 'releases', version) : path.join(ctx.appRoot, 'bundled-release', version);
  await fsp.mkdir(dir, { recursive: true });
  if (o.complete !== false) await fsp.writeFile(path.join(dir, '.complete'), '');
}

async function mirror(minCodeVersion: string): Promise<void> {
  await fsp.writeFile(path.join(dirs.dataDir, 'releases', 'schema-meta.json'), JSON.stringify({ schemaVersion: '0009', minCodeVersion }));
}

/** The update op to 0.3 past its point of no return, in `state` (a process that died while booting it). */
async function updateOp(state: string, o: Partial<OpFile> = {}): Promise<OpFile> {
  const now = Date.now();
  const op: OpFile = {
    opSchema: 1,
    opId: newId(now),
    kind: 'update',
    actor: { type: 'cli', id: null },
    state,
    version: V3,
    backupId: null,
    heartbeatAt: now,
    startedAt: now - 60_000,
    finishedAt: null,
    error: null,
    opsTokenHash: null,
    pointOfNoReturn: true,
    params: { source: 'feed', target: V3, from: V2, entry: null, staging: null, needsBackup: false, pendingWritten: true },
    progress: 95,
    message: null,
    ...o,
  };
  await fsp.mkdir(path.join(dirs.dataDir, 'ops'), { recursive: true });
  await fsp.writeFile(path.join(dirs.dataDir, 'ops', 'op.json'), `${JSON.stringify(op, null, 2)}\n`);
  return op;
}

async function pending(): Promise<void> {
  await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' }, pending: { version: V3, source: 'data' }, pinned: null });
}

/**
 * A live child process that holds `releases/boot.lock` with the platform's own lock (refreshed by its heartbeat), as
 * the process booting the pending release does. Resolves once it holds it.
 */
async function bootLockHolder(): Promise<ChildProcessWithoutNullStreams> {
  const script = [
    "const { acquireFileLock } = await import('@altis/platform');",
    'const lock = await acquireFileLock(process.argv[1], { staleMs: 60000 });',
    "process.stdout.write(lock === null ? 'busy\\n' : 'ready\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path.join(dirs.dataDir, 'releases', 'boot.lock')], {
    cwd: SERVER_DIR,
    env: { PATH: process.env['PATH'] ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const first = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      if (out.includes('\n')) resolve(out.trim());
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the boot.lock holder exited (${String(code)})`)));
  });
  expect(first).toBe('ready');
  return child;
}

describe.skipIf(!engine.available)(`release:list, release:rollback and release:unpin [${engineLabel()}]`, () => {
  it('opKinds registers the rollback kind from the update option, beside the update kind (S6)', () => {
    const kinds = (update?: () => UpdateKindDeps): string[] =>
      opKinds({ appVersion: '0.1.0', ...(update === undefined ? {} : { update }) }).map((k) => k.kind);
    expect(kinds()).not.toContain('rollback');
    const update = (): UpdateKindDeps => {
      throw new Error('not called');
    };
    expect(kinds(update)).toEqual(expect.arrayContaining(['update', 'rollback']));
  });

  it('release:rollback with pending 0.3 and the update op in switched → op reverting, then pending null; exit 0', async () => {
    await installed();
    await pending();
    const op = await updateOp('switched');
    await fsp.mkdir(path.join(dirs.dataDir, 'releases', 'boot', V3), { recursive: true });

    const { code, io } = await cli(['release:rollback', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(jsonLine(io)).toEqual({ ok: true, command: 'release:rollback', reverted: V3 });
    expect(await opJson()).toMatchObject({ opId: op.opId, state: 'reverting', stateBefore: 'switched', error: { code: 'UPDATE_BOOT_FAILED', detail: 'operator' } });
    expect(await current()).toMatchObject({ active: { version: V2, source: 'data' }, pending: null, pendingSince: null, pinned: null });
    await expect(fsp.stat(path.join(dirs.dataDir, 'releases', 'boot', V3))).rejects.toThrow();
    expect(ctx.requestRestart).toHaveBeenCalledWith('rollback');
  });

  it('1D-02: the op in needs_attention (stateBefore migrating) → reverting, pending null', async () => {
    await installed();
    await pending();
    await updateOp('needs_attention', { stateBefore: 'migrating', error: { code: 'INTERNAL' } });

    const { code, io } = await cli(['release:rollback']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toContain(V3);
    expect(await opJson()).toMatchObject({ state: 'reverting', stateBefore: 'migrating', error: { code: 'UPDATE_BOOT_FAILED', detail: 'operator' } });
    expect((await current()).pending).toBeNull();
  });

  it('1D-03: a live process refreshing boot.lock → exit 1 RELEASE_PENDING, nothing changed; --force waits and completes once it exits', async () => {
    await installed();
    await pending();
    await updateOp('migrating');
    const beforeState = await currentText();
    const beforeOp = await opText();
    const holder = await bootLockHolder();

    const refused = await cli(['release:rollback', '--json']);
    expect(refused.code).toBe(1);
    expect(jsonLine(refused.io)).toMatchObject({ ok: false, command: 'release:rollback', code: 'RELEASE_PENDING' });
    expect(await currentText()).toBe(beforeState);
    expect(await opText()).toBe(beforeOp);

    const forced = cli(['release:rollback', '--force', '--json']).then((r) => ({ ...r, at: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await currentText()).toBe(beforeState); // still waiting for the holder
    expect(await opText()).toBe(beforeOp);
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    const killedAt = Date.now();
    holder.kill('SIGKILL');
    await exited;
    const done = await forced;
    expect(done.code).toBe(0);
    expect(done.at).toBeGreaterThanOrEqual(killedAt);
    expect(jsonLine(done.io)).toEqual({ ok: true, command: 'release:rollback', reverted: V3 });
    expect(await opJson()).toMatchObject({ state: 'reverting', stateBefore: 'migrating', error: { detail: 'operator' } });
    expect((await current()).pending).toBeNull();
  }, 30_000);

  it('release:rollback without pending runs the manual rollback: active 0.1, previous null, pinned 0.2; one update.rollback (cli)', async () => {
    await installed();
    await mirror('0.0.0');
    await release(V1, 'data');
    await release(V2, 'data');
    await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });

    const { code, io } = await cli(['release:rollback', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(jsonLine(io)).toEqual({ ok: true, command: 'release:rollback', active: V1 });
    expect(await current()).toEqual({ schema: 1, active: { version: V1, source: 'data' }, previous: null, pending: null, pendingSince: null, pinned: V2 });
    expect(await audit('update.rollback')).toEqual([{ actor: 'cli', meta: { from: V2, to: V1 } }]);
    expect(await opJson()).toMatchObject({ kind: 'rollback', state: 'done', actor: { type: 'cli', id: null } });
    expect(ctx.requestRestart).toHaveBeenCalledWith('rollback');

    // Nothing to go back to now: exit 1 with the reason.
    const again = await cli(['release:rollback', '--json']);
    expect(again.code).toBe(1);
    expect(jsonLine(again.io)).toMatchObject({ ok: false, command: 'release:rollback', code: 'ROLLBACK_UNAVAILABLE' });
    expect(await audit('update.rollback')).toHaveLength(1);
  });

  it('release:rollback refused for an incompatible previous → exit 1 ROLLBACK_UNAVAILABLE, current.json unchanged', async () => {
    await installed();
    await mirror(V3);
    await release(V2, 'data');
    await setState({ active: { version: V3, source: 'data' }, previous: { version: V2, source: 'data' }, pending: null, pinned: null });
    const before = await currentText();

    const { code, io } = await cli(['release:rollback']);
    expect(code).toBe(1);
    expect(io.err).toContain('ROLLBACK_UNAVAILABLE');
    expect(io.err).toContain(V3);
    expect(await currentText()).toBe(before);
    expect(await audit('update.rollback')).toEqual([]);
  });

  it('release:unpin → pinned null and one release.unpin row; nothing pinned → nothing written', async () => {
    await installed();
    await setState({ active: { version: V1, source: 'data' }, previous: null, pending: null, pinned: V2 });

    const { code, io } = await cli(['release:unpin', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(jsonLine(io)).toEqual({ ok: true, command: 'release:unpin', unpinned: V2, audited: true });
    expect((await current()).pinned).toBeNull();
    expect(await audit('release.unpin')).toEqual([{ actor: 'cli', meta: { version: V2 } }]);

    const again = await cli(['release:unpin', '--json']);
    expect(again.code).toBe(0);
    expect(jsonLine(again.io)).toEqual({ ok: true, command: 'release:unpin', unpinned: null, audited: false });
    expect(await audit('release.unpin')).toHaveLength(1);
  });

  it('release:list --json → one line: the pointers, installed and bundled releases, the last 10 releases_log rows', async () => {
    await installed();
    await mirror('0.0.0');
    await release(V1, 'bundled');
    await release(V2, 'data');
    await release(V3, 'data', { complete: false }); // a copy cut short is not installed
    await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' }, pending: null, pinned: null });
    // A rollback, so that the log has a row.
    expect((await cli(['release:rollback'])).code).toBe(0);

    const { code, io } = await cli(['release:list', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const line = jsonLine(io);
    expect(Object.keys(line)).toEqual(['ok', 'command', 'active', 'previous', 'pending', 'pinned', 'installed', 'bundled', 'log']);
    expect(line).toMatchObject({
      ok: true,
      command: 'release:list',
      active: { version: V1, source: 'bundled' },
      previous: null,
      pending: null,
      pinned: V2,
      installed: [V2],
      bundled: [V1],
    });
    const log = line['log'] as Record<string, unknown>[];
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({
      id: expect.any(String),
      action: 'rollback',
      version: V1,
      fromVersion: V2,
      status: 'done',
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
      backupId: null,
    });

    // At most 10 rows, newest first.
    const h = await open();
    try {
      for (let i = 0; i < 12; i += 1) {
        const at = 1_800_000_000_000 + i;
        await h.db
          .insertInto('releases_log')
          .values({ id: newId(at), version: V3, action: 'update', from_version: V2, status: 'aborted', started_at: at, finished_at: at, backup_id: null, detail: null })
          .execute();
      }
    } finally {
      await h.close();
    }
    const listed = jsonLine((await cli(['release:list', '--json'])).io)['log'] as { startedAt: number }[];
    expect(listed).toHaveLength(10);
    expect(listed.map((r) => r.startedAt)).toEqual([...listed.map((r) => r.startedAt)].sort((a, b) => b - a));

    const human = await cli(['release:list']);
    expect(human.code).toBe(0);
    expect(human.io.out).toContain(V1);
    expect(human.io.out).toContain(V2);
  });

  it('the manual rollback notifies system.update.run of the version it left', async () => {
    await installed();
    await mirror('0.0.0');
    await release(V1, 'data');
    await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
    expect((await cli(['release:rollback'])).code).toBe(0);
    const h = await open();
    try {
      const rows = await h.db.selectFrom('notifications').select(['type', 'audience_permission', 'params']).where('type', '=', 'update.rolled_back').execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ audience_permission: 'system.update.run' });
      expect(JSON.parse(rows[0]!.params)).toEqual({ version: V2 });
    } finally {
      await h.close();
    }
  });
});
