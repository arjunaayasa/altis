import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DbHandle } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { captureIo, openInstalled, writeInput } from './cli-support.js';
import { bootContext } from './support.js';

// `node app.js backup:create [--files] [--json]` (spec §9.9, §13.6; plan Task 20) on SQLite in a temp DATA_DIR
// installed once: a snapshot backup whose slices run back to back in this process (one session), the backup's id
// printed, its manifest on disk.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB; the job's own test checks the size it asks for.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };

let root: string;
let dataDir: string;
let home: string;
let h: DbHandle;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cli-backup-')));
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
  for (const table of ['jobs', 'locks'] as const) await h.db.deleteFrom(table).execute();
});

async function backupCreate(argv: string[], dir = dataDir) {
  const io = captureIo({ HOME: home });
  const code = await runCli(['backup:create', ...argv], bootContext(dir), io);
  return { code, io };
}

const manifestOf = async (id: string) =>
  JSON.parse(await fsp.readFile(path.join(dataDir, 'backups', id, 'manifest.json'), 'utf8')) as { backupId: string; consistency: string; kind: string; includesFiles: boolean };

describe('backup:create', () => {
  it('--json → exit 0, {ok, command, backupId}, a snapshot manifest on disk and the row ok', async () => {
    const { code, io } = await backupCreate(['--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const out = JSON.parse(io.out) as { ok: boolean; command: string; backupId: string };
    expect(out).toEqual({ ok: true, command: 'backup:create', backupId: expect.any(String) });
    expect(await manifestOf(out.backupId)).toMatchObject({ backupId: out.backupId, consistency: 'snapshot', kind: 'manual', includesFiles: false });
    const row = await h.db.selectFrom('backups').select(['status', 'consistency', 'kind']).where('id', '=', out.backupId).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'ok', consistency: 'snapshot', kind: 'manual' });
    const job = await h.db.selectFrom('jobs').select(['status', 'type']).execute();
    expect(job).toEqual([{ status: 'succeeded', type: 'backup.create' }]);
  });

  it('--files → the uploads too; without --json a human line naming the backup', async () => {
    const { code, io } = await backupCreate(['--files']);
    expect(code).toBe(0);
    const match = /^backup:create: ([0-9A-HJKMNP-TV-Z]{26}) /.exec(io.out);
    expect(match, io.out).not.toBeNull();
    expect(await manifestOf(match![1]!)).toMatchObject({ includesFiles: true });
  });

  it('refuses an unknown option; before the install → NOT_INSTALLED', async () => {
    const usage = await backupCreate(['--all']);
    expect(usage.code).toBe(1);
    expect(usage.io.err).toMatch(/USAGE/);
    const fresh = path.join(root, 'fresh-data');
    await fsp.mkdir(fresh, { recursive: true });
    const none = await backupCreate(['--json'], fresh);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.io.out)).toMatchObject({ ok: false, command: 'backup:create', code: 'NOT_INSTALLED' });
  });
});
