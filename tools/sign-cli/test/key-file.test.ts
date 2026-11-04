import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  RELEASE_TYP,
  buildManifest,
  decodeBase64Url,
  isTrustedKey,
  rawPublicKey,
  verifyRelease,
  type Envelope,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PASSPHRASE_ENV, loadKeyFile, runCli } from '../src/index.js';

// Task 8 (preflight 1D-16, S11; decision D1d-28): passphrase-encrypted key files. `keygen --encrypt` writes
// {kid, use, enc: {kdf: 'scrypt', N: 131072, r: 8, p: 1, salt, iv, tag, ct}} (AES-256-GCM over the PKCS#8 DER, AAD
// `kid:use`); every command reads both formats through loadKeyFile; `pub` prints {kid, use, pub}.

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_KEYS = path.resolve(PACKAGE_DIR, '..', 'keys', 'dev');
const PASSPHRASE = 's3cret';

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-sign-keyfile-'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const freshDir = async (): Promise<string> => {
  const dir = path.join(root, `case-${counter++}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
};

type Run = { code: number; out: string; err: string };

async function cli(...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const readJson = async <T = unknown>(file: string): Promise<T> => JSON.parse(await fsp.readFile(file, 'utf8')) as T;

const exists = (file: string): Promise<boolean> =>
  fsp.access(file).then(
    () => true,
    () => false,
  );

type EncryptedKeyFile = {
  kid: string;
  use: string;
  enc: { kdf: string; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string };
};

/** `keygen --encrypt` under ALTIS_KEY_PASSPHRASE; returns the key file and its trusted.json entry. */
async function encryptedKeygen(dir: string, use: string, kid: string, passphrase = PASSPHRASE): Promise<{ keyFile: string; trusted: TrustedKey }> {
  vi.stubEnv(PASSPHRASE_ENV, passphrase);
  const run = await cli('keygen', '--use', use, '--kid', kid, '--out', dir, '--encrypt');
  vi.unstubAllEnvs();
  expect(run).toMatchObject({ code: 0, err: '' });
  const trusted = (await readJson<TrustedKey[]>(path.join(dir, 'trusted.json'))).find((k) => k.kid === kid);
  return { keyFile: path.join(dir, `${kid}.key.json`), trusted: trusted as TrustedKey };
}

const META: Omit<ReleaseManifest, 'files'> = {
  version: '0.1.0-test',
  buildId: 'abc1234',
  bootProtocol: 1,
  releasedAt: '2026-10-27',
  schemaLatest: '0003',
  minCodeVersionAfter: '0.2.0',
  minUpgradeFrom: '0.1.0',
  minNode: '22.16.0',
  minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
};

async function makeRelease(): Promise<string> {
  const dir = await freshDir();
  await fsp.mkdir(path.join(dir, 'public'));
  await fsp.writeFile(path.join(dir, 'server.mjs'), 'export const bootProtocol = 1;\n');
  await fsp.writeFile(path.join(dir, 'public', 'a.css'), 'body { margin: 0 }\n');
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(await buildManifest(dir, META), null, 2));
  await fsp.writeFile(path.join(dir, '.complete'), '');
  return dir;
}

/** The CLI as a process (bin.ts under tsx), with stdin a pipe (never a terminal) and without ALTIS_KEY_PASSPHRASE. */
async function processRun(...args: string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (name !== PASSPHRASE_ENV) env[name] = value;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', path.join(PACKAGE_DIR, 'src', 'bin.ts'), ...args], {
      cwd: PACKAGE_DIR,
      env,
      timeout: 60_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

describe('altis-sign keygen --encrypt', () => {
  it('writes {kid, use, enc} with the real scrypt parameters (no maxmem error) and no pkcs8, mode 0600, and trusts the public half', async () => {
    const dir = await freshDir();
    const { keyFile, trusted } = await encryptedKeygen(dir, 'release', 'rel-1');
    const file = await readJson<EncryptedKeyFile>(keyFile);
    expect(Object.keys(file).sort()).toEqual(['enc', 'kid', 'use']);
    expect(file).toMatchObject({ kid: 'rel-1', use: 'release', enc: { kdf: 'scrypt', N: 131072, r: 8, p: 1 } });
    expect(Object.keys(file.enc).sort()).toEqual(['N', 'ct', 'iv', 'kdf', 'p', 'r', 'salt', 'tag']);
    expect(decodeBase64Url(file.enc.salt)).toHaveLength(16);
    expect(decodeBase64Url(file.enc.iv)).toHaveLength(12);
    expect(decodeBase64Url(file.enc.tag)).toHaveLength(16);
    expect((decodeBase64Url(file.enc.ct) ?? Buffer.alloc(0)).length).toBeGreaterThan(32);
    const text = await fsp.readFile(keyFile, 'utf8');
    expect(text).not.toContain('pkcs8');
    expect(text).not.toContain(PASSPHRASE);
    if (process.platform !== 'win32') expect((await fsp.stat(keyFile)).mode & 0o777).toBe(0o600);

    expect(isTrustedKey(trusted)).toBe(true);
    const loaded = await loadKeyFile(keyFile, { passphrase: async () => PASSPHRASE });
    expect(loaded).toMatchObject({ kid: 'rel-1', use: 'release', pub: trusted.pub });
    expect(rawPublicKey(loaded.privateKey)).toBe(trusted.pub);
    expect(loaded.privateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('two encryptions never share a salt or an iv', async () => {
    const dir = await freshDir();
    const a = await readJson<EncryptedKeyFile>((await encryptedKeygen(dir, 'license', 'lic-1')).keyFile);
    const b = await readJson<EncryptedKeyFile>((await encryptedKeygen(dir, 'license', 'lic-2')).keyFile);
    expect(a.enc.salt).not.toBe(b.enc.salt);
    expect(a.enc.iv).not.toBe(b.enc.iv);
  });

  it('without a terminal and without ALTIS_KEY_PASSPHRASE: exit 2 KEY_PASSPHRASE_REQUIRED, and nothing is written', async () => {
    const dir = await freshDir();
    const run = await processRun('keygen', '--use', 'root', '--kid', 'root-1', '--out', dir, '--encrypt');
    expect(run.code).toBe(2);
    expect(run.err).toContain('KEY_PASSPHRASE_REQUIRED');
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('loadKeyFile and the commands that sign', () => {
  it('release sign with an encrypted key and ALTIS_KEY_PASSPHRASE signs a manifest that verifyRelease accepts', async () => {
    const keys = await freshDir();
    const { keyFile, trusted } = await encryptedKeygen(keys, 'release', 'rel-1');
    const dir = await makeRelease();
    vi.stubEnv(PASSPHRASE_ENV, PASSPHRASE);
    const run = await cli('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run).toMatchObject({ code: 0, err: '' });
    expect(await readJson<Envelope>(path.join(dir, 'manifest.sig'))).toMatchObject({ typ: RELEASE_TYP, kid: 'rel-1' });
    await expect(verifyRelease(dir, [trusted], { check: 'all' })).resolves.toBeDefined();
  });

  it('a wrong passphrase: exit 1 KEY_PASSPHRASE_INVALID, nothing signed; loadKeyFile rejects with the same code', async () => {
    const keys = await freshDir();
    const { keyFile } = await encryptedKeygen(keys, 'release', 'rel-1');
    const dir = await makeRelease();
    vi.stubEnv(PASSPHRASE_ENV, 'wrong');
    const run = await cli('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEY_PASSPHRASE_INVALID');
    expect(await exists(path.join(dir, 'manifest.sig'))).toBe(false);
    await expect(loadKeyFile(keyFile, { passphrase: async () => 'S3cret' })).rejects.toThrow(/^KEY_PASSPHRASE_INVALID/);
  });

  it('a kid or use edited in the file fails like a wrong passphrase (they are the additional data of AES-GCM)', async () => {
    const keys = await freshDir();
    const { keyFile } = await encryptedKeygen(keys, 'release', 'rel-1');
    const file = await readJson<EncryptedKeyFile>(keyFile);
    for (const [name, edited] of [
      ['kid', { ...file, kid: 'rel-2' }],
      ['use', { ...file, use: 'license' }],
      ['ct', { ...file, enc: { ...file.enc, ct: file.enc.ct.slice(0, -2) + (file.enc.ct.endsWith('AA') ? 'AQ' : 'AA') } }],
    ] as const) {
      const other = path.join(keys, `${name}.key.json`);
      await fsp.writeFile(other, JSON.stringify(edited));
      await expect(loadKeyFile(other, { passphrase: async () => PASSPHRASE }), name).rejects.toThrow(/^KEY_PASSPHRASE_INVALID/);
    }
  });

  it('without a terminal and without ALTIS_KEY_PASSPHRASE an encrypted key cannot sign: exit 2 KEY_PASSPHRASE_REQUIRED', async () => {
    const keys = await freshDir();
    const { keyFile } = await encryptedKeygen(keys, 'release', 'rel-1');
    const dir = await makeRelease();
    const run = await processRun('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run.code).toBe(2);
    expect(run.err).toContain('KEY_PASSPHRASE_REQUIRED');
    expect(await exists(path.join(dir, 'manifest.sig'))).toBe(false);
    // A plain key needs no passphrase.
    expect((await processRun('release', 'sign', '--dir', dir, '--key', path.join(DEV_KEYS, 'dev-rel-1.key.json'))).code).toBe(0);
  });

  it('a key of another use is refused (KEY_USE:<use>) before any passphrase is asked', async () => {
    const keys = await freshDir();
    const { keyFile } = await encryptedKeygen(keys, 'license', 'lic-1');
    const dir = await makeRelease();
    const run = await processRun('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEY_USE:release');
    expect(run.err).toContain('has use "license"');
  });

  it('loadKeyFile reads the plain format {kid, use, pkcs8} without asking for a passphrase', async () => {
    const loaded = await loadKeyFile(path.join(DEV_KEYS, 'dev-lic-1.key.json'), {
      passphrase: async () => {
        throw new Error('asked');
      },
    });
    const devTrusted = await readJson<TrustedKey[]>(path.join(DEV_KEYS, 'trusted.json'));
    expect({ kid: loaded.kid, use: loaded.use, pub: loaded.pub }).toEqual(devTrusted.find((k) => k.kid === 'dev-lic-1'));
  });

  it('refuses a malformed encrypted file (exit 1, "key file"), before any passphrase is asked', async () => {
    const keys = await freshDir();
    const { keyFile } = await encryptedKeygen(keys, 'release', 'rel-1');
    const file = await readJson<EncryptedKeyFile>(keyFile);
    const dir = await makeRelease();
    const cases: [string, unknown][] = [
      ['weaker N', { ...file, enc: { ...file.enc, N: 16384 } }],
      ['huge N', { ...file, enc: { ...file.enc, N: 2 ** 30 } }],
      ['other r', { ...file, enc: { ...file.enc, r: 1 } }],
      ['other p', { ...file, enc: { ...file.enc, p: 2 } }],
      ['other kdf', { ...file, enc: { ...file.enc, kdf: 'pbkdf2' } }],
      ['short iv', { ...file, enc: { ...file.enc, iv: 'AAAA' } }],
      ['short salt', { ...file, enc: { ...file.enc, salt: 'AAAA' } }],
      ['short tag', { ...file, enc: { ...file.enc, tag: 'AAAA' } }],
      ['not base64url', { ...file, enc: { ...file.enc, ct: '***' } }],
      ['extra enc field', { ...file, enc: { ...file.enc, extra: 1 } }],
      ['both formats', { ...file, pkcs8: 'AAAA' }],
      ['extra field', { ...file, note: 'x' }],
    ];
    vi.stubEnv(PASSPHRASE_ENV, PASSPHRASE);
    for (const [name, content] of cases) {
      const bad = path.join(keys, 'bad.key.json');
      await fsp.writeFile(bad, JSON.stringify(content));
      const run = await cli('release', 'sign', '--dir', dir, '--key', bad);
      expect(run.code, name).toBe(1);
      expect(run.err, name).toContain('key file');
      await expect(
        loadKeyFile(bad, {
          passphrase: async () => {
            throw new Error('asked');
          },
        }),
        name,
      ).rejects.toThrow(/key file/);
    }
    expect(await exists(path.join(dir, 'manifest.sig'))).toBe(false);
  });
});

describe('altis-sign pub', () => {
  it('prints exactly {kid, use, pub} of a plain key', async () => {
    const run = await cli('pub', '--key', path.join(DEV_KEYS, 'dev-rel-1.key.json'));
    expect(run).toMatchObject({ code: 0, err: '' });
    const devTrusted = await readJson<TrustedKey[]>(path.join(DEV_KEYS, 'trusted.json'));
    const printed = JSON.parse(run.out) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(['kid', 'use', 'pub']);
    expect(printed).toEqual(devTrusted.find((k) => k.kid === 'dev-rel-1'));
  });

  it('prints exactly {kid, use, pub} of an encrypted key (passphrase from ALTIS_KEY_PASSPHRASE), and writes it with --out', async () => {
    const dir = await freshDir();
    const { keyFile, trusted } = await encryptedKeygen(dir, 'timestamp', 'ts-1');
    vi.stubEnv(PASSPHRASE_ENV, PASSPHRASE);
    const run = await cli('pub', '--key', keyFile);
    expect(run).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(run.out)).toStrictEqual(trusted);
    expect(run.out).not.toContain('enc');

    const out = path.join(dir, 'ts-1.pub.json');
    const written = await cli('pub', '--key', keyFile, '--out', out);
    expect(written).toMatchObject({ code: 0, err: '' });
    expect(await readJson(out)).toStrictEqual(trusted);
  });

  it('--out naming the --key file (any spelling): exit 2, the private key untouched (1d review L01)', async () => {
    const dir = await freshDir();
    const keyFile = path.join(dir, 'dev-ts-1.key.json');
    await fsp.copyFile(path.join(DEV_KEYS, 'dev-ts-1.key.json'), keyFile);
    const before = await fsp.readFile(keyFile, 'utf8');
    for (const out of [keyFile, path.join(dir, '.', 'sub', '..', 'dev-ts-1.key.json')]) {
      const run = await cli('pub', '--key', keyFile, '--out', out);
      expect(run.code).toBe(2);
      expect(run.err).toContain('is the --key file');
      expect(await fsp.readFile(keyFile, 'utf8')).toBe(before);
    }
  });

  it('exits 2 without --key, and 1 for a wrong passphrase', async () => {
    expect((await cli('pub')).code).toBe(2);
    const dir = await freshDir();
    const { keyFile } = await encryptedKeygen(dir, 'device', 'dca-1');
    vi.stubEnv(PASSPHRASE_ENV, 'nope');
    const run = await cli('pub', '--key', keyFile);
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEY_PASSPHRASE_INVALID');
    expect(run.out).toBe('');
  });
});
