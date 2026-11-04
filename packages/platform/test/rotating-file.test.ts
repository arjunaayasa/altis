import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRotatingFile, type RotatingFile } from '../src/rotating-file.js';

// Lets a test run code at the moment a process claims rotate.lock (O_EXCL), to stage a race deterministically, and
// fail chosen renames the way Windows does while another program holds the file open without FILE_SHARE_DELETE.
const hooks = vi.hoisted(() => ({
  beforeClaim: null as (() => void) | null,
  failRename: null as ((from: string, to: string) => boolean) | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const hook = hooks.beforeClaim;
    if (hook !== null && args[1] === 'wx' && String(args[0]).endsWith('rotate.lock')) {
      hooks.beforeClaim = null;
      hook();
    }
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  const renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (hooks.failRename?.(String(from), String(to)) === true) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${String(from)}'`), { code: 'EBUSY' });
    }
    actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, openSync, renameSync, default: { ...actual, openSync, renameSync } };
});

let root: string;
let logs: string;
let log: string;
let claim: string;
const open: RotatingFile[] = [];

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-rotating-')));
  logs = path.join(root, 'logs');
  log = path.join(logs, 'altis.log');
  claim = path.join(logs, 'rotate.lock');
});

afterEach(async () => {
  hooks.failRename = null;
  for (const file of open.splice(0)) file.close();
  await fsp.rm(root, { recursive: true, force: true });
});

function make(opts: { maxBytes: number; files: number; onError?: (e: unknown) => void }, file = log): RotatingFile {
  const rotating = createRotatingFile(file, opts);
  open.push(rotating);
  return rotating;
}

function names(): string[] {
  return fs.readdirSync(logs).sort();
}

function read(name: string): string {
  return fs.readFileSync(path.join(logs, name), 'utf8');
}

describe('createRotatingFile: appending', () => {
  it('creates the directory and the file (mode 600) and appends lines in order', () => {
    const file = make({ maxBytes: 1000, files: 3 });
    file.append('one\n');
    file.append('two\n');
    expect(read('altis.log')).toBe('one\ntwo\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    }
  });

  it('appends to a file that already exists instead of replacing it', () => {
    fs.mkdirSync(logs);
    fs.writeFileSync(log, 'old\n');
    make({ maxBytes: 1000, files: 3 }).append('new\n');
    expect(read('altis.log')).toBe('old\nnew\n');
  });

  it('writes non-ASCII text as UTF-8 and counts bytes, not characters', () => {
    const file = make({ maxBytes: 12, files: 3 });
    file.append('héllo\n'); // 7 bytes
    file.append('wörld\n'); // 7 bytes: 14 > 12, so the first line is rotated out first
    expect(read('altis.log.1')).toBe('héllo\n');
    expect(read('altis.log')).toBe('wörld\n');
  });

  it('reopens by itself when appending after close()', () => {
    const file = make({ maxBytes: 1000, files: 3 });
    file.append('a\n');
    file.close();
    file.close(); // idempotent
    file.append('b\n');
    expect(read('altis.log')).toBe('a\nb\n');
  });

  it('throws the I/O error when the file cannot be opened', () => {
    fs.writeFileSync(path.join(root, 'plain-file'), 'x');
    const file = make({ maxBytes: 1000, files: 3 }, path.join(root, 'plain-file', 'altis.log'));
    expect(() => file.append('x\n')).toThrow();
  });

  it.each([
    [{ maxBytes: 0, files: 3 }],
    [{ maxBytes: 1.5, files: 3 }],
    [{ maxBytes: Number.NaN, files: 3 }],
    [{ maxBytes: 100, files: 0 }],
    [{ maxBytes: 100, files: 11 }],
    [{ maxBytes: 100, files: 2.5 }],
  ])('rejects the options %j', (opts) => {
    expect(() => createRotatingFile(log, opts)).toThrow(RangeError);
  });
});

describe('createRotatingFile: rotation', () => {
  it('rotates altis.log to altis.log.1 before the line that would pass maxBytes, and loses no line', () => {
    const file = make({ maxBytes: 20, files: 3 });
    file.append('aaaaaaaa\n'); // 9
    file.append('bbbbbbbb\n'); // 18
    expect(names()).toEqual(['altis.log']);
    file.append('cccccccc\n'); // 27 > 20: rotate first
    expect(names()).toEqual(['altis.log', 'altis.log.1']);
    expect(read('altis.log.1')).toBe('aaaaaaaa\nbbbbbbbb\n');
    expect(read('altis.log')).toBe('cccccccc\n');
  });

  it('shifts the chain and keeps at most `files` files (altis.log + .1 ... .files-1)', () => {
    const file = make({ maxBytes: 10, files: 3 });
    for (let i = 1; i <= 8; i += 1) file.append(`line-${i}\n`); // 7 bytes each: one line per file
    expect(names()).toEqual(['altis.log', 'altis.log.1', 'altis.log.2']);
    expect(read('altis.log')).toBe('line-8\n');
    expect(read('altis.log.1')).toBe('line-7\n');
    expect(read('altis.log.2')).toBe('line-6\n');
  });

  it('fills a gap at .1 instead of shifting the files after it: .2 and .3 stay as they are', () => {
    fs.mkdirSync(logs);
    fs.writeFileSync(log, 'main-1\n');
    fs.writeFileSync(`${log}.2`, 'two\n');
    fs.writeFileSync(`${log}.3`, 'three\n');
    make({ maxBytes: 10, files: 4 }).append('main-2\n');
    expect(names()).toEqual(['altis.log', 'altis.log.1', 'altis.log.2', 'altis.log.3']);
    expect(read('altis.log')).toBe('main-2\n');
    expect(read('altis.log.1')).toBe('main-1\n');
    expect(read('altis.log.2')).toBe('two\n');
    expect(read('altis.log.3')).toBe('three\n');
  });

  it('shifts only the files before the first gap', () => {
    fs.mkdirSync(logs);
    fs.writeFileSync(log, 'main-1\n');
    fs.writeFileSync(`${log}.1`, 'one\n');
    fs.writeFileSync(`${log}.2`, 'two\n');
    fs.writeFileSync(`${log}.4`, 'four\n'); // .3 is missing
    make({ maxBytes: 10, files: 5 }).append('main-2\n');
    expect(names()).toEqual(['altis.log', 'altis.log.1', 'altis.log.2', 'altis.log.3', 'altis.log.4']);
    expect(read('altis.log')).toBe('main-2\n');
    expect(read('altis.log.1')).toBe('main-1\n');
    expect(read('altis.log.2')).toBe('one\n');
    expect(read('altis.log.3')).toBe('two\n');
    expect(read('altis.log.4')).toBe('four\n');
  });

  it('a rename of altis.log that keeps failing (Windows: the file is held open) loses no history on retries', () => {
    fs.mkdirSync(logs);
    fs.writeFileSync(log, 'main-1\n');
    fs.writeFileSync(`${log}.1`, 'one\n');
    fs.writeFileSync(`${log}.2`, 'two\n');
    fs.writeFileSync(`${log}.3`, 'three\n');
    hooks.failRename = (from) => from === log;
    const errors: unknown[] = [];
    // The first failure shifts the full chain (dropping the oldest file, as any rotation does) and leaves .1 empty.
    make({ maxBytes: 10, files: 4, onError: (e) => errors.push(e) }).append('main-2\n');
    expect(names()).toEqual(['altis.log', 'altis.log.2', 'altis.log.3']);
    // Every later attempt (each process tries again; one process every 30 s) finds the gap and shifts nothing.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      make({ maxBytes: 10, files: 4, onError: (e) => errors.push(e) }).append(`main-${attempt + 3}\n`);
    }
    expect(errors).toHaveLength(4);
    expect(names()).toEqual(['altis.log', 'altis.log.2', 'altis.log.3']);
    expect(read('altis.log.2')).toBe('one\n');
    expect(read('altis.log.3')).toBe('two\n');
    // Once the file is free again, the next rotation fills the gap.
    hooks.failRename = null;
    make({ maxBytes: 10, files: 4 }).append('main-6\n');
    expect(names()).toEqual(['altis.log', 'altis.log.1', 'altis.log.2', 'altis.log.3']);
    expect(read('altis.log')).toBe('main-6\n');
    expect(read('altis.log.1')).toBe('main-1\nmain-2\nmain-3\nmain-4\nmain-5\n');
    expect(read('altis.log.2')).toBe('one\n');
    expect(read('altis.log.3')).toBe('two\n');
  });

  it('with files = 1 keeps only altis.log: a rotation starts it afresh', () => {
    const file = make({ maxBytes: 10, files: 1 });
    file.append('line-1\n');
    file.append('line-2\n');
    file.append('line-3\n');
    expect(names()).toEqual(['altis.log']);
    expect(read('altis.log')).toBe('line-3\n');
  });

  it('supports the longest chain the data path accepts: files = 10', () => {
    const file = make({ maxBytes: 10, files: 10 });
    for (let i = 1; i <= 15; i += 1) file.append(`line-${String(i).padStart(2, '0')}\n`);
    expect(names()).toEqual(['altis.log', ...Array.from({ length: 9 }, (_, i) => `altis.log.${i + 1}`)].sort());
    expect(read('altis.log')).toBe('line-15\n');
    expect(read('altis.log.9')).toBe('line-06\n');
  });

  it('never rotates an empty file: a line longer than maxBytes is written whole, and the next one rotates it', () => {
    const file = make({ maxBytes: 5, files: 3 });
    file.append('a-very-long-line\n');
    expect(names()).toEqual(['altis.log']);
    expect(read('altis.log')).toBe('a-very-long-line\n');
    file.append('b\n');
    expect(read('altis.log.1')).toBe('a-very-long-line\n');
    expect(read('altis.log')).toBe('b\n');
  });

  it('removes its claim file after a rotation', () => {
    const file = make({ maxBytes: 10, files: 3 });
    file.append('line-1\n');
    file.append('line-2\n');
    expect(names()).toEqual(['altis.log', 'altis.log.1']);
    expect(fs.existsSync(claim)).toBe(false);
  });

  it('uses the claim file next to the log by default, or the one it is given', () => {
    const custom = path.join(root, 'elsewhere.lock');
    const file = createRotatingFile(log, { maxBytes: 10, files: 3, lockPath: custom });
    open.push(file);
    fs.mkdirSync(logs);
    fs.writeFileSync(custom, 'held'); // a fresh claim in the custom place blocks the rotation
    file.append('line-1\n');
    file.append('line-2\n');
    expect(names()).toEqual(['altis.log']);
    expect(read('altis.log')).toBe('line-1\nline-2\n');
  });
});

describe('createRotatingFile: several processes (R46)', () => {
  it("re-targets a process whose file another process rotated: its next line goes to the new altis.log", () => {
    const a = make({ maxBytes: 20, files: 3 });
    const b = make({ maxBytes: 20, files: 3 });
    a.append('a1-aaaaaa\n'); // 10
    b.append('b1-bbbbbb\n'); // 20 (B holds the same inode)
    a.append('a2-aaaaaa\n'); // A rotates, then writes the new file
    expect(read('altis.log.1')).toBe('a1-aaaaaa\nb1-bbbbbb\n');
    b.append('b2\n'); // B still has the old inode open: it must notice and follow the path
    expect(read('altis.log.1')).toBe('a1-aaaaaa\nb1-bbbbbb\n');
    expect(read('altis.log')).toBe('a2-aaaaaa\nb2\n');
  });

  it('creates the file again when another process removed it (files = 1 rotation)', () => {
    const a = make({ maxBytes: 10, files: 1 });
    const b = make({ maxBytes: 10, files: 1 });
    a.append('a1\n');
    b.append('b1\n');
    fs.rmSync(log);
    b.append('b2\n');
    a.append('a2\n');
    expect(read('altis.log')).toBe('b2\na2\n');
  });

  it('skips the rotation while another process holds a fresh claim, and still writes the line', () => {
    const file = make({ maxBytes: 10, files: 3 });
    file.append('line-1\n');
    fs.writeFileSync(claim, 'someone else');
    file.append('line-2\n');
    file.append('line-3\n');
    expect(names()).toEqual(['altis.log', 'rotate.lock']);
    expect(read('altis.log')).toBe('line-1\nline-2\nline-3\n');
    expect(read('rotate.lock')).toBe('someone else'); // not ours: untouched
  });

  it('takes over a stale claim (older than 10 s), rotates, and removes it', () => {
    const file = make({ maxBytes: 10, files: 3 });
    file.append('line-1\n');
    fs.writeFileSync(claim, 'crashed holder');
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(claim, old, old);
    file.append('line-2\n');
    expect(names()).toEqual(['altis.log', 'altis.log.1']);
    expect(read('altis.log.1')).toBe('line-1\n');
    expect(read('altis.log')).toBe('line-2\n');
  });

  it('does not rotate again a file that another process rotated between its size check and its claim', () => {
    const a = make({ maxBytes: 20, files: 4 });
    const b = make({ maxBytes: 20, files: 4 });
    a.append('a1-aaaaaaaa\n'); // 12
    b.append('b1-bbbb\n'); // 20: full, B holds this inode
    // B sees a full file and goes for the claim; at that very moment A gets there first, rotates and releases it.
    hooks.beforeClaim = () => a.append('a2\n');
    b.append('b2\n');
    expect(hooks.beforeClaim).toBeNull(); // the hook did run
    expect(names()).toEqual(['altis.log', 'altis.log.1']); // one rotation, not two
    expect(read('altis.log.1')).toBe('a1-aaaaaaaa\nb1-bbbb\n');
    expect(read('altis.log')).toBe('a2\nb2\n');
    expect(fs.existsSync(claim)).toBe(false);
  });

  it('writes the line and reports through onError when the rotation fails, and releases its claim', () => {
    const errors: unknown[] = [];
    const file = make({ maxBytes: 10, files: 2, onError: (e) => errors.push(e) });
    file.append('line-1\n');
    fs.mkdirSync(path.join(logs, 'altis.log.1', 'blocker'), { recursive: true }); // renaming onto it fails
    file.append('line-2\n');
    expect(errors).toHaveLength(1);
    expect(read('altis.log')).toBe('line-1\nline-2\n');
    expect(fs.existsSync(claim)).toBe(false);
    file.append('line-3\n'); // not retried at once: the chain is not worn away by a failure that persists
    expect(errors).toHaveLength(1);
    expect(read('altis.log')).toBe('line-1\nline-2\nline-3\n');
  });

  describe('real processes', () => {
    const repo = path.resolve(import.meta.dirname, '../../..');
    const fixture = path.join(import.meta.dirname, 'fixtures', 'rotating-file-child.mjs');
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    function start(id: string, count: number, maxBytes: number, files: number) {
      // tsx lets the child import the TypeScript sources directly, on every supported Node version.
      const child = fork(fixture, [log, id, String(count), String(maxBytes), String(files)], {
        cwd: repo,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(`unexpected message ${String(m)}`))));
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child ${id} exited with ${String(code)} before it was ready`)));
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      return { child, ready, exited };
    }

    it('four processes logging 100 lines each into small files: no line torn, none lost, at most `files` files, no claim left', async () => {
      const ids = ['A', 'B', 'C', 'D'];
      const procs = ids.map((id) => start(id, 100, 6000, 10));
      await Promise.all(procs.map((p) => p.ready));
      for (const p of procs) p.child.send('go');
      expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);

      const files = names();
      expect(files).not.toContain('rotate.lock');
      expect(files.length).toBeLessThanOrEqual(10);
      expect(files.length).toBeGreaterThan(1); // it really rotated

      const seen: Record<string, number[]> = { A: [], B: [], C: [], D: [] };
      for (const name of files) {
        const text = read(name);
        expect(text === '' || text.endsWith('\n')).toBe(true);
        for (const line of text.split('\n').filter((l) => l !== '')) {
          const entry = JSON.parse(line) as { id: string; n: number; pad: string };
          expect(entry.pad).toBe('x'.repeat(60));
          seen[entry.id]!.push(entry.n);
        }
      }
      const expected = Array.from({ length: 100 }, (_, n) => n);
      for (const id of ids) expect(seen[id]!.sort((x, y) => x - y)).toEqual(expected);
    }, 60_000);
  });
});
