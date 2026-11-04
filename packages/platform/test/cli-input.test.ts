import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_INPUT_MAX_BYTES, readCliInputFile } from '../src/cli-input.js';

let root: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cli-input-')));
});

afterEach(async () => {
  await fsp.chmod(root, 0o700).catch(() => undefined);
  await fsp.rm(root, { recursive: true, force: true });
});

/** The error `promise` rejects with (fails the test when it resolves). */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** Asserts an INVALID_CONFIG with `reason`, whose message, detail and meta never repeat `secret`. */
function expectInvalid(error: unknown, reason: string, secret = 'S3CRET-VALUE'): void {
  expect(isDomainError(error)).toBe(true);
  if (!isDomainError(error)) return;
  expect(error.code).toBe('INVALID_CONFIG');
  expect(error.meta?.['reason']).toBe(reason);
  expect(error.detail).toMatch(/ \/ /); // bilingual: Indonesia / English
  expect(`${error.message} ${error.detail ?? ''} ${JSON.stringify(error.meta)}`).not.toContain(secret);
}

const posixOnly = process.platform === 'win32';

describe('readCliInputFile (ruling R1)', () => {
  it('returns the text of a UTF-8 file', async () => {
    const file = path.join(root, 'input.json');
    await fsp.writeFile(file, '{"baseUrl":"https://perpus.example","name":"Perpustakaan Ümit"}\n');
    expect(await readCliInputFile(file)).toBe('{"baseUrl":"https://perpus.example","name":"Perpustakaan Ümit"}\n');
  });

  it('drops a UTF-8 byte-order mark (Notepad adds one)', async () => {
    const file = path.join(root, 'bom.json');
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));
    expect(await readCliInputFile(file)).toBe('{"a":1}');
  });

  it('resolves a relative path against the working directory', async () => {
    const file = path.join(root, 'rel.json');
    await fsp.writeFile(file, '{}');
    expect(await readCliInputFile(path.relative(process.cwd(), file))).toBe('{}');
  });

  it('follows a symbolic link to a regular file', async () => {
    const file = path.join(root, 'target.json');
    await fsp.writeFile(file, '{"x":true}');
    await fsp.symlink(file, path.join(root, 'link.json'));
    expect(await readCliInputFile(path.join(root, 'link.json'))).toBe('{"x":true}');
  });

  it('accepts a file of exactly maxBytes and refuses one byte more (too_large)', async () => {
    const file = path.join(root, 'cap.json');
    await fsp.writeFile(file, 'x'.repeat(10));
    expect(await readCliInputFile(file, { maxBytes: 10 })).toBe('x'.repeat(10));
    await fsp.writeFile(file, 'S3CRET-VALUE');
    expectInvalid(await failure(readCliInputFile(file, { maxBytes: 11 })), 'too_large');
  });

  it('caps at 1 MiB by default', async () => {
    expect(CLI_INPUT_MAX_BYTES).toBe(1024 * 1024);
    const file = path.join(root, 'big.json');
    await fsp.writeFile(file, Buffer.alloc(CLI_INPUT_MAX_BYTES + 1, 0x20));
    expectInvalid(await failure(readCliInputFile(file)), 'too_large');
    await fsp.truncate(file, CLI_INPUT_MAX_BYTES);
    expect((await readCliInputFile(file)).length).toBe(CLI_INPUT_MAX_BYTES);
  });

  it('refuses a missing file (not_found)', async () => {
    expectInvalid(await failure(readCliInputFile(path.join(root, 'nope.json'))), 'not_found');
    expectInvalid(await failure(readCliInputFile(path.join(root, 'nope', 'x.json'))), 'not_found');
  });

  it('refuses a directory (not_a_file)', async () => {
    expectInvalid(await failure(readCliInputFile(root)), 'not_a_file');
  });

  it.skipIf(posixOnly)('refuses a FIFO without waiting for a writer (not_a_file)', async () => {
    const fifo = path.join(root, 'input.fifo');
    execFileSync('mkfifo', [fifo]);
    const started = performance.now();
    expectInvalid(await failure(readCliInputFile(fifo)), 'not_a_file');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it.skipIf(posixOnly)('refuses a device (not_a_file), never reading an endless stream', async () => {
    expectInvalid(await failure(readCliInputFile('/dev/zero')), 'not_a_file');
    expectInvalid(await failure(readCliInputFile('/dev/null')), 'not_a_file');
  });

  it.skipIf(posixOnly || process.getuid?.() === 0)('refuses a file it may not read (unreadable)', async () => {
    const file = path.join(root, 'locked.json');
    await fsp.writeFile(file, 'S3CRET-VALUE');
    await fsp.chmod(file, 0o000);
    expectInvalid(await failure(readCliInputFile(file)), 'unreadable');
  });

  it('refuses bytes that are not UTF-8 without repeating them (not_utf8)', async () => {
    const file = path.join(root, 'latin1.json');
    await fsp.writeFile(file, Buffer.concat([Buffer.from('{"password":"S3CRET-VALUE","x":"'), Buffer.from([0xe9, 0xff]), Buffer.from('"}')]));
    expectInvalid(await failure(readCliInputFile(file)), 'not_utf8');
  });

  it('refuses UTF-16 (Notepad "Unicode") as not UTF-8', async () => {
    const file = path.join(root, 'utf16.json');
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]));
    expectInvalid(await failure(readCliInputFile(file)), 'not_utf8');
  });

  it('refuses an empty path or one holding NUL (path)', async () => {
    expectInvalid(await failure(readCliInputFile('')), 'path');
    expectInvalid(await failure(readCliInputFile('   ')), 'path');
    expectInvalid(await failure(readCliInputFile(`${root}/a\u0000b.json`)), 'path');
    expectInvalid(await failure(readCliInputFile(42 as unknown as string)), 'path');
  });

  it('rejects an invalid maxBytes with a RangeError', async () => {
    const file = path.join(root, 'x.json');
    await fsp.writeFile(file, '{}');
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readCliInputFile(file, { maxBytes })).rejects.toBeInstanceOf(RangeError);
    }
  });
});
