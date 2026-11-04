import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, type TrustedKey } from '@altis/crypto';
import * as acorn from 'acorn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBootloader, defaultOutfile, parseBuildArgs } from '../src/build.js';
import { devRootKeys, devTrustedKeys } from './helpers/make-release.js';

const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');

// app.js must parse on any Node a hosting panel may still offer (Review Focus 4, P1): CommonJS, ES2017 syntax.
// The production build carries no test hook and no dev key (ruling R57, spec §8.3). app.js embeds root keys only
// (ruling R65): every other key reaches it through root-signed keyset documents.

let dir: string;

beforeAll(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-bootloader-syntax-')));
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const PRODUCTION_ROOTS: TrustedKey[] = [
  { kid: 'root-1', use: 'root', pub: generateKeyPair().pub },
  { kid: 'root-2', use: 'root', pub: generateKeyPair().pub },
];

function parsesAsEs2017Script(text: string): void {
  acorn.parse(text, { ecmaVersion: 2017, sourceType: 'script' });
}

describe('app.js syntax', { timeout: 30_000 }, () => {
  it('the test build is an ES2017 script', async () => {
    const outfile = path.join(dir, 'test', 'app.js');
    await buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test' });
    const text = await fsp.readFile(outfile, 'utf8');
    expect(() => parsesAsEs2017Script(text)).not.toThrow();
    // A sanity check of the parser options: ES2020 syntax is refused.
    expect(() => parsesAsEs2017Script('a?.b')).toThrow();
  });

  it('bundles the shared current.json module (1d: pending, updateCurrentState)', async () => {
    const outfile = path.join(dir, 'test-inputs', 'app.js');
    const { metafile } = await buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test' });
    const inputs = Object.keys(metafile.inputs).map((input) => input.split(path.sep).join('/'));
    expect(inputs.some((input) => input.endsWith('packages/platform/src/current-state.ts'))).toBe(true);
  });

  it('the test build embeds the dev root key (tools/keys/dev/roots.json), and no other key', async () => {
    const outfile = path.join(dir, 'test-keys', 'app.js');
    const result = await buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test' });
    const text = await fsp.readFile(outfile, 'utf8');
    const dev = devTrustedKeys();
    expect(dev.map((k) => k.use)).toContain('release');
    for (const key of dev) {
      if (key.use === 'root') expect(text).toContain(key.pub);
      else expect(text).not.toContain(key.pub);
    }
    expect(result.trustedKeys).toEqual(devRootKeys());
    expect(result.trustedKeys.map((k) => k.kid)).toEqual(['dev-root-1']);
  });
});

describe('production build (R57)', { timeout: 30_000 }, () => {
  it('is an ES2017 script with no ALTIS_TEST_ hook, no dev key and exactly the root key set', async () => {
    const outfile = path.join(dir, 'production', 'app.js');
    const result = await buildBootloader({
      profile: 'production',
      outfile,
      bundledVersion: '1.0.0',
      rootKeys: PRODUCTION_ROOTS,
    });
    const text = await fsp.readFile(outfile, 'utf8');
    expect(() => parsesAsEs2017Script(text)).not.toThrow();
    expect(text).not.toContain('ALTIS_TEST_');
    for (const key of devTrustedKeys()) {
      expect(text).not.toContain(key.kid);
      expect(text).not.toContain(key.pub);
    }
    for (const key of PRODUCTION_ROOTS) {
      expect(text).toContain(key.kid);
      expect(text).toContain(key.pub);
    }
    expect(result.trustedKeys).toEqual(PRODUCTION_ROOTS);
    expect(text).toContain('"1.0.0"');
  });

  it('refuses a dev key (DEV_KEY_IN_PRODUCTION): the dev root, or any dev- kid', async () => {
    const outfile = path.join(dir, 'refused-dev', 'app.js');
    await expect(
      buildBootloader({ profile: 'production', outfile, bundledVersion: '1.0.0', rootKeys: [...PRODUCTION_ROOTS, ...devRootKeys()] }),
    ).rejects.toThrow('DEV_KEY_IN_PRODUCTION');
    const devNamed: TrustedKey = { kid: 'dev-root-9', use: 'root', pub: generateKeyPair().pub };
    await expect(
      buildBootloader({ profile: 'production', outfile, bundledVersion: '1.0.0', rootKeys: [...PRODUCTION_ROOTS, devNamed] }),
    ).rejects.toThrow('DEV_KEY_IN_PRODUCTION: dev-root-9');
  });

  it('refuses a missing or empty root key set, and keys of another use (a release key is never an anchor)', async () => {
    const outfile = path.join(dir, 'refused', 'app.js');
    await expect(buildBootloader({ profile: 'production', outfile, bundledVersion: '1.0.0' })).rejects.toThrow('ROOT_KEYS_REQUIRED');
    await expect(buildBootloader({ profile: 'production', outfile, bundledVersion: '1.0.0', rootKeys: [] })).rejects.toThrow(
      'ROOT_KEYS_REQUIRED',
    );
    for (const use of ['release', 'license'] as const) {
      const other: TrustedKey = { kid: `${use}-1`, use, pub: generateKeyPair().pub };
      await expect(
        buildBootloader({ profile: 'production', outfile, bundledVersion: '1.0.0', rootKeys: [...PRODUCTION_ROOTS, other] }),
      ).rejects.toThrow('ROOT_KEYS_INVALID');
    }
    await expect(
      buildBootloader({ profile: 'test', outfile: path.join(dir, 'refused-test', 'app.js'), bundledVersion: '0.1.0-test', rootKeys: devTrustedKeys() }),
    ).rejects.toThrow('ROOT_KEYS_INVALID');
  });

  it('R65e: needs at least two roots (active + offline spare), with distinct kids and distinct public keys', async () => {
    const outfile = path.join(dir, 'refused-roots', 'app.js');
    const [first, second] = PRODUCTION_ROOTS as [TrustedKey, TrustedKey];
    for (const rootKeys of [[first], [first, { ...second, pub: first.pub }], [first, { ...second, kid: first.kid }]]) {
      await expect(buildBootloader({ profile: 'production', outfile, bundledVersion: '1.0.0', rootKeys }), JSON.stringify(rootKeys)).rejects.toThrow(
        'ROOT_KEYS_INVALID',
      );
    }
  });

  it('R65e: a test build embeds dev- roots only (NON_DEV_KEY_IN_TEST_BUILD), as the release build checks', async () => {
    const outfile = path.join(dir, 'refused-test-roots', 'app.js');
    await expect(buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test', rootKeys: PRODUCTION_ROOTS })).rejects.toThrow(
      'NON_DEV_KEY_IN_TEST_BUILD: root-1',
    );
    // One dev root is enough for a test build.
    await expect(buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test', rootKeys: devRootKeys() })).resolves.toBeDefined();
  });

  it('refuses a bundled version that is not SemVer', async () => {
    await expect(
      buildBootloader({
        profile: 'production',
        outfile: path.join(dir, 'refused-version', 'app.js'),
        bundledVersion: 'v1',
        rootKeys: PRODUCTION_ROOTS,
      }),
    ).rejects.toThrow('BUNDLED_VERSION_INVALID');
  });
});

describe('output files (a test build is never dist/app.js)', { timeout: 30_000 }, () => {
  it('the test profile writes dist/app.test.js by default, the production profile dist/app.js', async () => {
    expect(defaultOutfile('test')).toBe(path.join(PACKAGE_DIR, 'dist', 'app.test.js'));
    expect(defaultOutfile('production')).toBe(path.join(PACKAGE_DIR, 'dist', 'app.js'));

    // The build command (`pnpm --filter @altis/bootloader build`) without --out.
    expect(await parseBuildArgs([])).toEqual({ profile: 'test', outfile: defaultOutfile('test'), bundledVersion: '0.1.0-test' });
    const keysFile = path.join(dir, 'root-keys.json');
    await fsp.writeFile(keysFile, JSON.stringify(PRODUCTION_ROOTS));
    expect(await parseBuildArgs(['--profile', 'production', '--version', '1.0.0', '--root-keys', keysFile])).toEqual({
      profile: 'production',
      outfile: defaultOutfile('production'),
      bundledVersion: '1.0.0',
      rootKeys: PRODUCTION_ROOTS,
    });
    const elsewhere = path.join(dir, 'elsewhere', 'app.js');
    expect((await parseBuildArgs(['--out', elsewhere])).outfile).toBe(elsewhere);
    await expect(parseBuildArgs(['--profile', 'staging'])).rejects.toThrow('BUILD_PROFILE_INVALID');
  });

  it('refuses to write a test build where the production app.js goes', async () => {
    const production = defaultOutfile('production');
    const before = await fsp.stat(production).then((s) => s.mtimeMs, () => null);
    await expect(buildBootloader({ profile: 'test', outfile: production, bundledVersion: '0.1.0-test' })).rejects.toThrow(
      'TEST_BUILD_AT_PRODUCTION_PATH',
    );
    // Nothing was written there.
    expect(await fsp.stat(production).then((s) => s.mtimeMs, () => null)).toBe(before);
  });

  it('a test build names its profile in its first line', async () => {
    const outfile = path.join(dir, 'banner', 'app.js');
    await buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test' });
    expect((await fsp.readFile(outfile, 'utf8')).split('\n', 1)[0]).toBe('/* ALTIS app.js (bootloader v1, test) */');
  });
});
