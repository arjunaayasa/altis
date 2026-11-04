import fsp from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { CLI_WHILE_PENDING, cliAllowedWhilePending } from '../src/boot.js';
import { BUNDLED_VERSION, releasesPath, useHarness, type AppProcess, type Exit, type Sandbox } from './helpers/harness.js';
import { makeRelease } from './helpers/make-release.js';

// The command line while `pending` is set (spec §9.2 step 4, 1d Task 13): "CLI diteruskan ke `runCli`, tidak
// menyentuh penanda boot, dan menolak berjalan saat `pending` terisi (kecuali `release:rollback`, `doctor`,
// `maintenance:*`)". An allowed command runs the `active` release (with the 1a fallback to `previous`), never the
// pending one; any other command exits 1 with a bilingual message naming `release:rollback`; `jobs:run` (cPanel's
// cron, every 5 min) prints one line and exits 0 without running anything (preflight 1D-27).

const h = useHarness();

const PENDING = '0.2.0-test';
/** What the pending release's runCli returns: never seen, since it never runs. */
const PENDING_CLI_EXIT = 9;
/** What the active (bundled) release's runCli returns (make-release's default). */
const ACTIVE_CLI_EXIT = 7;

interface StateOptions {
  active?: { version: string; source: 'bundled' | 'data' };
  previous?: { version: string; source: 'bundled' | 'data' } | null;
  pending?: string;
}

/** A sandbox whose current.json names a pending release (a valid one in DATA_DIR/releases, ready to be booted). */
async function pendingSandbox(o: StateOptions = {}): Promise<Sandbox> {
  const sb = await h.sandbox();
  const pending = o.pending ?? PENDING;
  await makeRelease(releasesPath(sb, pending), { version: pending, cliExitCode: PENDING_CLI_EXIT });
  const state = {
    schema: 1,
    active: o.active ?? { version: BUNDLED_VERSION, source: 'bundled' },
    previous: o.previous ?? null,
    pending: { version: pending, source: 'data' },
    pendingSince: Date.now(),
    pinned: null,
  };
  await fsp.writeFile(releasesPath(sb, 'current.json'), `${JSON.stringify(state)}\n`);
  return sb;
}

/** Runs `node app.js <args>` to its end, its output read to the last byte. */
async function run(sb: Sandbox, args: string[]): Promise<{ app: AppProcess; exit: Exit; stdout: string; stderr: string; lines: string[] }> {
  const app = h.spawn(sb, { args });
  const exit = await app.exited;
  await Promise.all([app.child.stdout, app.child.stderr].map((stream) => (stream === null ? undefined : finished(stream))));
  const stdout = app.stdout();
  return { app, exit, stdout, stderr: app.stderr(), lines: stdout.split('\n').filter((line) => line !== '') };
}

/** The files below DATA_DIR/releases/boot/ (none: a command never touches a boot marker). */
async function bootMarkers(sb: Sandbox): Promise<string[]> {
  try {
    return await fsp.readdir(releasesPath(sb, 'boot'), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

describe('cliAllowedWhilePending', () => {
  it('lets through release:rollback, doctor and maintenance:* only, judged by the command word', () => {
    expect(CLI_WHILE_PENDING).toEqual(['release:rollback', 'doctor', 'maintenance:*']);
    for (const command of ['release:rollback', 'doctor', 'maintenance:on', 'maintenance:off']) {
      expect(cliAllowedWhilePending([command])).toBe(true);
      expect(cliAllowedWhilePending([command, '--json'])).toBe(true);
    }
    // The spec's `maintenance:*`: a maintenance command a later release adds runs too (app.js is frozen with v1).
    expect(cliAllowedWhilePending(['maintenance:status'])).toBe(true);
    expect(cliAllowedWhilePending(['doctor', '--smoke'])).toBe(true);
    expect(cliAllowedWhilePending(['maintenance:off', '--force', '--json'])).toBe(true);
    for (const argv of [['migrate'], ['jobs:run'], ['install', '--config', 'x.json'], ['help'], ['--help'], ['config:set', 'port', '3000'], ['backup:restore', 'x']]) {
      expect(cliAllowedWhilePending(argv)).toBe(false);
    }
    // The command is the first word (as runCli parses it), never an operand or an option that names one.
    expect(cliAllowedWhilePending(['--json', 'doctor'])).toBe(false);
    expect(cliAllowedWhilePending(['config:set', 'doctor', 'x'])).toBe(false);
    expect(cliAllowedWhilePending(['Doctor'])).toBe(false);
    expect(cliAllowedWhilePending(['maintenance:'])).toBe(false);
    expect(cliAllowedWhilePending(['maintenance'])).toBe(false);
    expect(cliAllowedWhilePending(['maintenance:*'])).toBe(false);
    expect(cliAllowedWhilePending(['Maintenance:on'])).toBe(false);
    expect(cliAllowedWhilePending(['maintenancex:on'])).toBe(false);
    expect(cliAllowedWhilePending(['doctor:x'])).toBe(false);
    expect(cliAllowedWhilePending([])).toBe(false);
  });
});

describe('a command while pending is set (spec §9.2 step 4)', { timeout: 30_000 }, () => {
  it('migrate is refused: exit 1, a bilingual message naming release:rollback, runCli not called', async () => {
    const sb = await pendingSandbox();
    const { exit, stdout, stderr } = await run(sb, ['migrate']);
    expect(exit.code).toBe(1);
    expect(stdout).toBe(''); // runCli (which prints its argv and version) never ran
    expect(stderr).toContain('RELEASE_PENDING');
    expect(stderr).toContain('node app.js release:rollback');
    expect(stderr).toContain(PENDING);
    expect(stderr).toContain('sedang'); // Indonesian first
    expect(stderr).toContain('is being installed'); // then English
    expect(stderr.indexOf('sedang')).toBeLessThan(stderr.indexOf('is being installed'));
    expect(stderr).toContain('release:rollback, doctor, maintenance:*.'); // the commands that do run, as the spec names them
    expect(await bootMarkers(sb)).toEqual([]);
  });

  it('migrate --json prints exactly one JSON line {ok:false, code:RELEASE_PENDING} on stdout', async () => {
    const sb = await pendingSandbox();
    const { exit, lines, stderr } = await run(sb, ['migrate', '--json']);
    expect(exit.code).toBe(1);
    expect(lines, stderr).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    // runCli's --json failure contract (apps/server cli/index.ts): {ok:false, command, code, detail}.
    expect(line).toEqual({ ok: false, command: 'migrate', code: 'RELEASE_PENDING', detail: expect.any(String) });
    expect(line['detail']).toContain('release:rollback');
    expect(line['detail']).not.toContain(sb.root);
    expect(stderr).toContain('release:rollback'); // the message for humans stays on stderr
  });

  it.each([['install', '--config', 'input.json'], ['help'], ['user:reset-password', 'admin'], ['backup:restore', 'x']])(
    '%s is refused the same way',
    async (...args: string[]) => {
      const sb = await pendingSandbox();
      const { exit, stdout, stderr } = await run(sb, args);
      expect(exit.code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('release:rollback');
    },
  );

  it('doctor runs the active release, never the pending one, and touches no boot marker', async () => {
    const sb = await pendingSandbox();
    const { exit, lines, stderr } = await run(sb, ['doctor', '--json']);
    expect(exit.code).toBe(ACTIVE_CLI_EXIT);
    expect(lines, stderr).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ argv: ['doctor', '--json'], version: BUNDLED_VERSION, runtime: 'service', serve: 'refused' });
    expect(await bootMarkers(sb)).toEqual([]);
    await expect(fsp.stat(releasesPath(sb, 'boot.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    // current.json still names the pending release: a command neither boots, promotes nor reverts it.
    expect(JSON.parse(await fsp.readFile(releasesPath(sb, 'current.json'), 'utf8'))).toMatchObject({ pending: { version: PENDING, source: 'data' } });
  });

  it.each([['release:rollback'], ['maintenance:on', '--reason', 'pembaruan'], ['maintenance:off', '--force'], ['maintenance:status']])(
    '%s runs the active release too',
    async (...args: string[]) => {
      const sb = await pendingSandbox();
      const { exit, lines, stderr } = await run(sb, args);
      expect(exit.code).toBe(ACTIVE_CLI_EXIT);
      expect(lines, stderr).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ argv: args, version: BUNDLED_VERSION });
      expect(await bootMarkers(sb)).toEqual([]);
    },
  );

  it('an allowed command whose active release fails falls back to previous (1a), never to pending', async () => {
    // active = 0.1.5-test in DATA_DIR, damaged (no .complete); previous = the bundled release; pending = 0.2.0-test.
    const sb = await pendingSandbox({ active: { version: '0.1.5-test', source: 'data' }, previous: { version: BUNDLED_VERSION, source: 'bundled' } });
    await makeRelease(releasesPath(sb, '0.1.5-test'), { version: '0.1.5-test' });
    await fsp.rm(releasesPath(sb, '0.1.5-test', '.complete'));
    const { exit, lines, stderr } = await run(sb, ['doctor']);
    expect(exit.code).toBe(ACTIVE_CLI_EXIT);
    expect(lines, stderr).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ argv: ['doctor'], version: BUNDLED_VERSION });
    expect(await bootMarkers(sb)).toEqual([]);
  });

  it('jobs:run prints one line and exits 0 without running anything (cron must not mail an error, 1D-27)', async () => {
    const sb = await pendingSandbox();
    const { exit, stdout, stderr } = await run(sb, ['jobs:run']);
    expect(exit.code).toBe(0);
    expect(stdout).toBe(`pending ${PENDING}: nothing run\n`); // runCli never ran (it would print its argv)
    expect(stderr).toBe('');
    expect(await bootMarkers(sb)).toEqual([]);
  });

  it('jobs:run --budget 30 --json prints one JSON line {ok:true} with nothing run, exit 0', async () => {
    const sb = await pendingSandbox();
    const { exit, lines, stderr } = await run(sb, ['jobs:run', '--budget', '30', '--json']);
    expect(exit.code).toBe(0);
    expect(lines, stderr).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ ok: true, command: 'jobs:run', pending: PENDING, passes: 0, slices: 0 });
  });

  it('nothing pending: every command reaches runCli of the active release as before (jobs:run, migrate)', async () => {
    const sb = await h.sandbox();
    for (const args of [['jobs:run'], ['migrate', '--json']]) {
      const { exit, lines, stderr } = await run(sb, args);
      expect(exit.code).toBe(ACTIVE_CLI_EXIT);
      expect(lines, stderr).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ argv: args, version: BUNDLED_VERSION });
    }
  });
});
