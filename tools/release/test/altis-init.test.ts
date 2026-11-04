import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_INSTALL_CODE, envInstallCode, formatInstallCode, normalizeInstallCode } from '../../../packages/core/src/install/code.js';

// 1d Task 32 (spec §9.11, §7.7): docker/altis-init writes the Docker .env (mode 600) with two random database passwords
// and a random ALTIS_INSTALL_CODE, prints the code, and never overwrites an existing .env without --force. It is run
// here as an operator runs it: `sh altis-init` in the folder of compose.yml (a temp folder), never from this repository.

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'docker', 'altis-init');
const IS_WINDOWS = process.platform === 'win32';

/** `sh`, plus dash where it is installed: Debian and Ubuntu hosts run /bin/sh as dash. */
const SHELLS = ['sh', ...['/bin/dash', '/usr/bin/dash'].filter((file) => existsSync(file)).slice(0, 1)];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let shell = 'sh';

/** `<shell> <docker/altis-init> ...args` in `cwd`, with a minimal environment (PATH only). */
function runInit(cwd: string, args: string[] = []): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [SCRIPT, ...args], { cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The KEY=VALUE lines of a .env text (comments and blank lines skipped). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    expect(eq, line).toBeGreaterThan(0);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

let dir: string;

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-init-')));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS).each(SHELLS)('docker/altis-init under %s', (name) => {
  beforeEach(() => {
    shell = name;
  });

  it('is an executable POSIX sh script: LF only, no bashisms, only head/tr for the randomness, valid syntax', async () => {
    const stat = await fsp.stat(SCRIPT);
    expect(stat.mode & 0o111).toBe(0o111);
    const bytes = await fsp.readFile(SCRIPT);
    expect(bytes.includes(0x0d)).toBe(false); // dash stops at `set -eu\r`
    const script = bytes.toString('utf8');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    const code = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\[\[|\bfunction\b|\blocal\b|\$\{[A-Za-z_]+(\/\/|:[0-9])|<<<|\bsource\b|\$RANDOM|\$'/);
    expect(code).not.toMatch(/\b(openssl|python3?|node|perl|base64|shuf|uuidgen|mktemp)\b/);
    expect(code).toContain('/dev/urandom');
    const run = await new Promise<number | null>((resolve) => spawn(shell, ['-n', SCRIPT]).once('close', resolve));
    expect(run).toBe(0);
  });

  it('writes .env with mode 0600: two 32-character passwords and an install code the server accepts, and prints the code', async () => {
    const run = await runInit(dir);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const file = path.join(dir, '.env');
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    const env = parseEnv(await fsp.readFile(file, 'utf8'));
    expect(Object.keys(env).sort()).toEqual(['ALTIS_DB_PASSWORD', 'ALTIS_DB_ROOT_PASSWORD', 'ALTIS_INSTALL_CODE']);

    // the passwords: 32 characters of [A-Za-z0-9], different from each other
    expect(env['ALTIS_DB_PASSWORD']).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(env['ALTIS_DB_ROOT_PASSWORD']).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(env['ALTIS_DB_PASSWORD']).not.toBe(env['ALTIS_DB_ROOT_PASSWORD']);

    // the install code: 26 base32 characters in groups 5-5-5-5-6, as the server parses ALTIS_INSTALL_CODE (§7.7)
    const shown = env['ALTIS_INSTALL_CODE']!;
    expect(shown).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}$/);
    const code = normalizeInstallCode(shown);
    expect(code).not.toBeNull();
    expect(formatInstallCode(code!)).toBe(shown); // already in the server's own alphabet: no I, L, O or U to read as 1/0
    expect(code).not.toBe(EXAMPLE_INSTALL_CODE);
    expect(envInstallCode({ ALTIS_INSTALL_CODE: shown })).toBe(code);

    // stdout shows the code; no secret is printed
    expect(run.stdout).toContain(shown);
    expect(run.stdout).not.toContain(env['ALTIS_DB_PASSWORD']);
    expect(run.stdout).not.toContain(env['ALTIS_DB_ROOT_PASSWORD']);
  });

  it('every run draws new values', async () => {
    const other = await fsp.mkdtemp(path.join(dir, 'b-'));
    expect((await runInit(dir)).code).toBe(0);
    expect((await runInit(other)).code).toBe(0);
    const a = parseEnv(await fsp.readFile(path.join(dir, '.env'), 'utf8'));
    const b = parseEnv(await fsp.readFile(path.join(other, '.env'), 'utf8'));
    for (const key of ['ALTIS_DB_PASSWORD', 'ALTIS_DB_ROOT_PASSWORD', 'ALTIS_INSTALL_CODE']) expect(a[key], key).not.toBe(b[key]);
  });

  it('a second run refuses: exit 1, .env unchanged', async () => {
    expect((await runInit(dir)).code).toBe(0);
    const file = path.join(dir, '.env');
    const before = await fsp.readFile(file);
    const again = await runInit(dir);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/--force/);
    expect(again.stdout).toBe('');
    expect(await fsp.readFile(file)).toEqual(before);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fsp.readdir(dir)).sort()).toEqual(['.env']); // no temp file left behind
  });

  it('an existing .env written by hand (even a dangling link) is refused without --force', async () => {
    const file = path.join(dir, '.env');
    await fsp.writeFile(file, 'ALTIS_DB_PASSWORD=mine\n', { mode: 0o644 });
    expect((await runInit(dir)).code).toBe(1);
    expect(await fsp.readFile(file, 'utf8')).toBe('ALTIS_DB_PASSWORD=mine\n');
    await fsp.rm(file);
    await fsp.symlink(path.join(dir, 'nowhere'), file);
    expect((await runInit(dir)).code).toBe(1);
    await expect(fsp.stat(path.join(dir, 'nowhere'))).rejects.toThrow();
  });

  it('--force writes a new file (mode 0600 even over a 0644 one) and keeps the old one as .env.bak', async () => {
    const file = path.join(dir, '.env');
    await fsp.writeFile(file, 'ALTIS_DB_PASSWORD=old\n', { mode: 0o644 });
    await fsp.chmod(file, 0o644);
    const run = await runInit(dir, ['--force']);
    expect(run.code).toBe(0);
    const env = parseEnv(await fsp.readFile(file, 'utf8'));
    expect(env['ALTIS_DB_PASSWORD']).toMatch(/^[A-Za-z0-9]{32}$/);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(path.join(dir, '.env.bak'), 'utf8')).toBe('ALTIS_DB_PASSWORD=old\n');
    expect(run.stdout).toContain(env['ALTIS_INSTALL_CODE']);
    // a database volume made with the old password keeps it: the warning says so
    expect(run.stderr).toMatch(/volume/);

    // A second --force would put the first forced .env in .env.bak and lose the passwords the database volume may
    // still use: refused, nothing changed, until the operator moves .env.bak away.
    const first = await fsp.readFile(file, 'utf8');
    const again = await runInit(dir, ['--force']);
    expect(again.code).toBe(1);
    expect(again.stdout).toBe('');
    expect(again.stderr).toMatch(/\.env\.bak/);
    expect(await fsp.readFile(file, 'utf8')).toBe(first);
    expect(await fsp.readFile(path.join(dir, '.env.bak'), 'utf8')).toBe('ALTIS_DB_PASSWORD=old\n');
    expect((await fsp.readdir(dir)).sort()).toEqual(['.env', '.env.bak']);

    await fsp.rename(path.join(dir, '.env.bak'), path.join(dir, 'kept.env'));
    expect((await runInit(dir, ['--force'])).code).toBe(0);
    expect(await fsp.readFile(file, 'utf8')).not.toBe(first);
    expect(await fsp.readFile(path.join(dir, '.env.bak'), 'utf8')).toBe(first);
    expect((await fsp.readdir(dir)).sort()).toEqual(['.env', '.env.bak', 'kept.env']);
  });

  it('--force never replaces a .env.bak, not even a dangling link; without a .env it leaves .env.bak alone', async () => {
    const file = path.join(dir, '.env');
    await fsp.writeFile(file, 'ALTIS_DB_PASSWORD=now\n');
    await fsp.symlink(path.join(dir, 'nowhere'), path.join(dir, '.env.bak'));
    expect((await runInit(dir, ['--force'])).code).toBe(1);
    expect(await fsp.readFile(file, 'utf8')).toBe('ALTIS_DB_PASSWORD=now\n');
    await expect(fsp.stat(path.join(dir, 'nowhere'))).rejects.toThrow();
    expect((await fsp.readdir(dir)).sort()).toEqual(['.env', '.env.bak']);

    // No .env to keep: .env.bak is not touched, so it is no reason to refuse.
    await fsp.rm(path.join(dir, '.env.bak'));
    await fsp.writeFile(path.join(dir, '.env.bak'), 'ALTIS_DB_PASSWORD=older\n');
    await fsp.rm(file);
    expect((await runInit(dir, ['--force'])).code).toBe(0);
    expect(await fsp.readFile(path.join(dir, '.env.bak'), 'utf8')).toBe('ALTIS_DB_PASSWORD=older\n');
    expect(parseEnv(await fsp.readFile(file, 'utf8'))['ALTIS_DB_PASSWORD']).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it('an unknown argument is a usage error (exit 2) and writes nothing', async () => {
    const run = await runInit(dir, ['--forse']);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/altis-init \[--force\]/);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('a folder it cannot write to: exit 1, no .env, nothing left behind', async () => {
    await fsp.chmod(dir, 0o500);
    try {
      for (const args of [[], ['--force']]) {
        const run = await runInit(dir, args);
        expect(run.code, args.join(' ')).toBe(1);
        expect(run.stdout).toBe('');
      }
    } finally {
      await fsp.chmod(dir, 0o700);
    }
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('a .env that is a folder is never replaced, even with --force', async () => {
    await fsp.mkdir(path.join(dir, '.env'));
    expect((await runInit(dir, ['--force'])).code).toBe(1);
    expect((await fsp.stat(path.join(dir, '.env'))).isDirectory()).toBe(true);
    expect(await fsp.readdir(path.join(dir, '.env'))).toEqual([]);
  });
});

describe('the files altis-init leaves next to compose.yml', () => {
  it('.env, the .env.bak of --force and a temp file a killed run left are git-ignored (they hold the database passwords)', async () => {
    const repo = path.resolve(import.meta.dirname, '..', '..', '..');
    const files = ['docker/.env', 'docker/.env.bak', 'docker/.env.altis-init.12345', '.env.bak'];
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['check-ignore', '--no-index', ...files], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      child.once('error', reject);
      child.once('close', () => resolve(text));
    });
    expect(out.split('\n').filter(Boolean)).toEqual(files);
  });
});
