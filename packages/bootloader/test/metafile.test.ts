import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBootloader } from '../src/build.js';

// app.js is frozen by contract v1 (§9.2): it bundles @altis/platform's root, the root export of @altis/crypto and
// @altis/shared, nothing more. The update feed formats (@altis/crypto/feed, decision D1d-1) are a subpath export that
// app.js must never pull in: they live in server.mjs and the tools.

let dir: string;

beforeAll(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-bootloader-metafile-')));
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('app.js inputs (D1d-1)', { timeout: 30_000 }, () => {
  it('has no input under packages/crypto/src/feed/', async () => {
    const result = await buildBootloader({ profile: 'test', outfile: path.join(dir, 'app.js'), bundledVersion: '0.1.0-test' });
    const inputs = Object.keys(result.metafile.inputs);
    // The paths are relative to the repository root: the crypto root export is there, under this very form.
    expect(inputs).toContain('packages/crypto/src/envelope.ts');
    expect(inputs.filter((input) => input.startsWith('packages/crypto/src/feed/'))).toEqual([]);
  });
});
