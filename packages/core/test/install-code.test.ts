import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXAMPLE_INSTALL_CODE,
  INSTALL_CODE_TTL_MS,
  ensureInstallCode,
  formatInstallCode,
  generateInstallCode,
  normalizeInstallCode,
} from '../src/install/code.js';

// The install code (spec §7.7, §9.5 step 0; plan Task 10): 26 Crockford base32 characters (130 random bits), shown
// 5-5-5-5-6, kept in DATA_DIR/install-code.txt ({code, createdAt}, mode 600) and made with O_EXCL only when absent or
// older than 24 h, so every process validates against (and prints) the same code; ALTIS_INSTALL_CODE (Docker) wins.

const CODE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORMATTED = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/;
const NOW = 1_767_225_600_000;

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-install-code-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(dataDir);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const codeFile = (): string => path.join(dataDir, 'install-code.txt');

async function readCodeFile(): Promise<{ code: string; createdAt: number }> {
  return JSON.parse(await fsp.readFile(codeFile(), 'utf8')) as { code: string; createdAt: number };
}

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

describe('generateInstallCode / formatInstallCode / normalizeInstallCode', () => {
  it('generates 26 Crockford characters, uniformly over the whole alphabet', () => {
    const codes = Array.from({ length: 200 }, () => generateInstallCode());
    for (const code of codes) expect(code).toMatch(CODE);
    expect(new Set(codes).size).toBe(200);
    expect([...new Set(codes.join(''))].sort().join('')).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('formats 5-5-5-5-6 and normalizes the formatted code back', () => {
    const code = generateInstallCode();
    const shown = formatInstallCode(code);
    expect(shown).toMatch(FORMATTED);
    expect(shown.replaceAll('-', '')).toBe(code);
    expect(normalizeInstallCode(shown)).toBe(code);
    expect(formatInstallCode('ABCDEFGHJKMNPQRSTVWXYZ0123')).toBe('ABCDE-FGHJK-MNPQR-STVWX-YZ0123');
  });

  it('normalizes what a person types: case, spaces and dashes, I/L as 1 and O as 0', () => {
    expect(normalizeInstallCode('abcde fghjk-mnpqr stvwx-yz0123')).toBe('ABCDEFGHJKMNPQRSTVWXYZ0123');
    expect(normalizeInstallCode('OOOOO-OOOOO-OOOOO-OOOOO-OOOOOO')).toBe('0'.repeat(26));
    expect(normalizeInstallCode('iiiii-lllll-IIIII-LLLLL-iiiiii')).toBe('1'.repeat(26));
    expect(normalizeInstallCode('  ABCDE FGHJK MNPQR STVWX YZ0123\t')).toBe('ABCDEFGHJKMNPQRSTVWXYZ0123');
  });

  it('refuses anything that is not exactly 26 Crockford characters', () => {
    expect(normalizeInstallCode('ABCDEFGHJKMNPQRSTVWXYZ012')).toBeNull(); // 25
    expect(normalizeInstallCode('ABCDEFGHJKMNPQRSTVWXYZ01234')).toBeNull(); // 27
    expect(normalizeInstallCode('UBCDEFGHJKMNPQRSTVWXYZ0123')).toBeNull(); // U is not Crockford
    expect(normalizeInstallCode('ABCDE_FGHJK_MNPQR_STVWX_YZ0123')).toBeNull();
    expect(normalizeInstallCode('')).toBeNull();
    expect(normalizeInstallCode(42 as unknown as string)).toBeNull();
  });

  it('EXAMPLE_INSTALL_CODE is the code the documentation shows, normalized', () => {
    expect(EXAMPLE_INSTALL_CODE).toBe(normalizeInstallCode('ALTIS-CONTO-HKODE-INSTA-LASI01'));
    expect(EXAMPLE_INSTALL_CODE).toMatch(CODE);
  });
});

describe('ensureInstallCode', () => {
  it('writes DATA_DIR/install-code.txt {code, createdAt} with mode 600 when absent; the next call reads it back', async () => {
    const first = await ensureInstallCode(dataDir, { now: NOW, env: {} });
    expect(first).toEqual({ code: expect.stringMatching(CODE), createdAt: NOW, source: 'file', fresh: true });
    expect(await readCodeFile()).toEqual({ code: formatInstallCode(first.code), createdAt: NOW });
    if (process.platform !== 'win32') expect((await fsp.stat(codeFile())).mode & 0o777).toBe(0o600);

    const again = await ensureInstallCode(dataDir, { now: NOW + 60_000, env: {} });
    expect(again).toEqual({ code: first.code, createdAt: NOW, source: 'file', fresh: false });
  });

  it('keeps a code exactly 24 h old; one 24 h + 1 ms old is replaced by a new one (fresh)', async () => {
    const first = await ensureInstallCode(dataDir, { now: NOW, env: {} });
    expect(await ensureInstallCode(dataDir, { now: NOW + INSTALL_CODE_TTL_MS, env: {} })).toMatchObject({ code: first.code, fresh: false });

    const later = NOW + INSTALL_CODE_TTL_MS + 1;
    const renewed = await ensureInstallCode(dataDir, { now: later, env: {} });
    expect(renewed).toEqual({ code: expect.stringMatching(CODE), createdAt: later, source: 'file', fresh: true });
    expect(renewed.code).not.toBe(first.code);
    expect(await readCodeFile()).toEqual({ code: formatInstallCode(renewed.code), createdAt: later });
    // The old file was moved aside and removed: nothing is left in tmp/ but the lock folder's leftovers (none).
    expect((await fsp.readdir(path.join(dataDir, 'tmp'))).filter((n) => !n.endsWith('.lock'))).toEqual([]);
  });

  it('replaces an unusable file (not JSON, a malformed code, a createdAt that is no number)', async () => {
    for (const content of ['not json', JSON.stringify({ code: 'NOPE', createdAt: NOW }), JSON.stringify({ code: formatInstallCode(generateInstallCode()), createdAt: 'x' })]) {
      await fsp.writeFile(codeFile(), content, { mode: 0o600 });
      const made = await ensureInstallCode(dataDir, { now: NOW, env: {} });
      expect(made, content).toMatchObject({ source: 'file', fresh: true });
      expect((await readCodeFile()).code).toBe(formatInstallCode(made.code));
    }
  });

  it('ALTIS_INSTALL_CODE wins: source env, no file written', async () => {
    const env = { ALTIS_INSTALL_CODE: 'abcde-fghjk-mnpqr-stvwx-yz0123' };
    expect(await ensureInstallCode(dataDir, { now: NOW, env })).toEqual({
      code: 'ABCDEFGHJKMNPQRSTVWXYZ0123',
      createdAt: NOW,
      source: 'env',
      fresh: false,
    });
    await expect(fsp.stat(codeFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ALTIS_INSTALL_CODE equal to the documentation example, or malformed: INVALID_CONFIG naming the variable', async () => {
    for (const value of ['ALTIS-CONTO-HKODE-INSTA-LASI01', 'altis conto hkode insta lasi01', 'too-short', 'ABCDEFGHJKMNPQRSTVWXYZ0123U']) {
      const error = await failure(() => ensureInstallCode(dataDir, { now: NOW, env: { ALTIS_INSTALL_CODE: value } }));
      expect(isDomainError(error) && error.code, value).toBe('INVALID_CONFIG');
      expect((error as { meta?: unknown }).meta).toEqual({ env: 'ALTIS_INSTALL_CODE' });
      expect(JSON.stringify(error)).not.toContain(value);
    }
    // A blank variable counts as not set.
    expect(await ensureInstallCode(dataDir, { now: NOW, env: { ALTIS_INSTALL_CODE: '  ' } })).toMatchObject({ source: 'file' });
  });

  it('two processes at once end up with the same code', async () => {
    const fixture = path.join(import.meta.dirname, 'fixtures', 'install-code-child.mjs');
    const children: ChildProcess[] = [];
    try {
      const runs = [0, 1].map(() => {
        const child = fork(fixture, [JSON.stringify({ dataDir, now: NOW })], {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        children.push(child);
        let report: { code: string; fresh: boolean } | undefined;
        const ready = new Promise<void>((resolve, reject) => {
          child.on('message', (message) => {
            if (message === 'ready') resolve();
            else report = message as { code: string; fresh: boolean };
          });
          child.once('error', reject);
          child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
        });
        const closed = new Promise<{ exit: number | null; report: typeof report }>((resolve) =>
          child.once('close', (exit) => resolve({ exit, report })),
        );
        return { child, ready, closed };
      });
      await Promise.all(runs.map((r) => r.ready));
      for (const r of runs) r.child.send('go');
      const done = await Promise.all(runs.map((r) => r.closed));
      expect(done.map((d) => d.exit)).toEqual([0, 0]);
      const [a, b] = done.map((d) => d.report!);
      expect(a!.code).toMatch(CODE);
      expect(b!.code).toBe(a!.code);
      expect([a!.fresh, b!.fresh].filter(Boolean)).toHaveLength(1);
      expect((await readCodeFile()).code).toBe(formatInstallCode(a!.code));
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});
