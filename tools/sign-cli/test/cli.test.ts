import { execFile } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  KEYSET_TYP,
  KEY_USES,
  RELEASE_TYP,
  buildManifest,
  canonicalize,
  generateKeyPair,
  isTrustedKey,
  rawPublicKey,
  resolveTrustedKeys,
  verifyDetached,
  verifyRelease,
  type Envelope,
  type KeyUse,
  type KeysetDoc,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/index.js';
import { runCliForTest } from '../src/testing.js';

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-sign-cli-'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
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

async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

const exists = (file: string): Promise<boolean> =>
  fsp.access(file).then(
    () => true,
    () => false,
  );

type KeyFile = { kid: string; use: KeyUse; pkcs8: string };

/** Runs `keygen`; returns the key file path and the trusted key. */
async function keygen(dir: string, use: KeyUse, kid: string): Promise<{ keyFile: string; trusted: TrustedKey }> {
  const run = await cli('keygen', '--use', use, '--kid', kid, '--out', dir);
  expect(run).toMatchObject({ code: 0, err: '' });
  const keyFile = path.join(dir, `${kid}.key.json`);
  const trusted = (await readJson<TrustedKey[]>(path.join(dir, 'trusted.json'))).find((k) => k.kid === kid);
  return { keyFile, trusted: trusted as TrustedKey };
}

function privateKeyOf(file: KeyFile): KeyObject {
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
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

/** A release directory with manifest.json (not yet signed) and .complete. */
async function makeRelease(): Promise<string> {
  const dir = await freshDir();
  await fsp.mkdir(path.join(dir, 'public'));
  await fsp.writeFile(path.join(dir, 'server.mjs'), 'export const bootProtocol = 1;\n');
  await fsp.writeFile(path.join(dir, 'public', 'a.css'), 'body { margin: 0 }\n');
  const manifest = await buildManifest(dir, META);
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(dir, '.complete'), '');
  return dir;
}

describe('altis-sign: usage', () => {
  it('prints the usage for --help and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const run = await cli(flag);
      expect(run.code).toBe(0);
      expect(run.err).toBe('');
      for (const line of [
        'altis-sign keygen',
        'altis-sign pub',
        'altis-sign release sign',
        'altis-sign keyset sign',
        'altis-sign feed sign',
        'altis-sign freshness sign',
        'altis-sign ceremony check',
      ]) {
        expect(run.out).toContain(line);
      }
    }
  });

  it('has no licence command: the usage names none, and each is an unknown command (exit 2)', async () => {
    const help = await cli('--help');
    for (const gone of ['license issue', 'request decode', 'clock token', 'deactivation verify', 'altis-license']) {
      expect(help.out).not.toContain(gone);
    }
    for (const args of [['license', 'issue'], ['request', 'decode'], ['clock', 'token'], ['deactivation', 'verify']]) {
      const run = await cli(...args, '--key', 'x');
      expect(run.code).toBe(2);
      expect(run.err).toContain(`unknown command: ${args[0]}`);
    }
  });

  it.each([
    [[]],
    [['nope']],
    [['release']],
    [['release', 'verify']],
    [['release', 'constructor']],
    [['keyset']],
    [['keyset', 'verify']],
    [['feed']],
    [['freshness', 'toString']],
    [['ceremony', 'run']],
    [['keygen', '--use', 'release', '--kid', 'k', '--out', 'x', '--bogus']],
    [['keygen', 'extra', '--use', 'release', '--kid', 'k', '--out', 'x']],
    [['release', 'sign', '--dir']],
  ])('%j exits 2 with the usage on stderr', async (args) => {
    const run = await cli(...args);
    expect(run.code).toBe(2);
    expect(run.out).toBe('');
    expect(run.err).toContain('Usage');
  });
});

describe('altis-sign keygen', () => {
  it('writes <kid>.key.json and trusted.json', async () => {
    const dir = await freshDir();
    const run = await cli('keygen', '--use', 'release', '--kid', 'dev-rel-1', '--out', dir);
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toContain('dev-rel-1.key.json');

    const key = await readJson<KeyFile>(path.join(dir, 'dev-rel-1.key.json'));
    expect(Object.keys(key).sort()).toEqual(['kid', 'pkcs8', 'use']);
    expect(key).toMatchObject({ kid: 'dev-rel-1', use: 'release' });
    expect(key.pkcs8).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const privateKey = privateKeyOf(key);
    expect(privateKey.asymmetricKeyType).toBe('ed25519');

    const trusted = await readJson<TrustedKey[]>(path.join(dir, 'trusted.json'));
    expect(trusted).toEqual([{ kid: 'dev-rel-1', use: 'release', pub: rawPublicKey(privateKey) }]);
    expect(trusted.every(isTrustedKey)).toBe(true);
    expect(await fsp.readFile(path.join(dir, 'trusted.json'), 'utf8')).not.toContain('pkcs8');
    expect((await fsp.readdir(dir)).sort()).toEqual(['dev-rel-1.key.json', 'trusted.json']);
  });

  it('writes the private key readable by its owner only', async () => {
    if (process.platform === 'win32') return;
    const dir = await freshDir();
    await keygen(dir, 'license', 'dev-lic-1');
    const mode = (await fsp.stat(path.join(dir, 'dev-lic-1.key.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.each(KEY_USES.map((use) => [use]))('accepts the key use %s', async (use) => {
    const dir = await freshDir();
    const { keyFile, trusted } = await keygen(dir, use, `k-${use}`);
    expect(trusted.use).toBe(use);
    expect((await readJson<KeyFile>(keyFile)).use).toBe(use);
  });

  it('appends to trusted.json and keeps the entries that are already there', async () => {
    const dir = await freshDir();
    const a = await keygen(dir, 'release', 'dev-rel-1');
    const b = await keygen(dir, 'release', 'dev-rel-2');
    const c = await keygen(dir, 'timestamp', 'dev-ts-1');
    const trusted = await readJson<TrustedKey[]>(path.join(dir, 'trusted.json'));
    expect(trusted).toEqual([a.trusted, b.trusted, c.trusted]);
    expect(new Set(trusted.map((k) => k.pub)).size).toBe(3);
  });

  it('creates the output directory, parents included', async () => {
    const dir = path.join(await freshDir(), 'a', 'b');
    await keygen(dir, 'device', 'dev-dca-1');
    expect(await exists(path.join(dir, 'trusted.json'))).toBe(true);
  });

  it('refuses a kid that is already in trusted.json and changes nothing', async () => {
    const dir = await freshDir();
    await keygen(dir, 'release', 'dev-rel-1');
    const keyBefore = await fsp.readFile(path.join(dir, 'dev-rel-1.key.json'), 'utf8');
    const trustedBefore = await fsp.readFile(path.join(dir, 'trusted.json'), 'utf8');
    const run = await cli('keygen', '--use', 'license', '--kid', 'dev-rel-1', '--out', dir);
    expect(run.code).toBe(1);
    expect(run.err).toContain('dev-rel-1');
    expect(await fsp.readFile(path.join(dir, 'dev-rel-1.key.json'), 'utf8')).toBe(keyBefore);
    expect(await fsp.readFile(path.join(dir, 'trusted.json'), 'utf8')).toBe(trustedBefore);
  });

  it('never overwrites an existing private key file', async () => {
    const dir = await freshDir();
    await fsp.writeFile(path.join(dir, 'dev-rel-1.key.json'), 'precious');
    const run = await cli('keygen', '--use', 'release', '--kid', 'dev-rel-1', '--out', dir);
    expect(run.code).toBe(1);
    expect(await fsp.readFile(path.join(dir, 'dev-rel-1.key.json'), 'utf8')).toBe('precious');
    expect(await exists(path.join(dir, 'trusted.json'))).toBe(false);
  });

  it('refuses a malformed trusted.json and writes no key', async () => {
    for (const content of ['not json', '{}', '[1]', '[{"kid":"x","use":"release","pub":"AAAA"}]']) {
      const dir = await freshDir();
      await fsp.writeFile(path.join(dir, 'trusted.json'), content);
      const run = await cli('keygen', '--use', 'release', '--kid', 'dev-rel-1', '--out', dir);
      expect(run.code).toBe(1);
      expect(run.err).toContain('trusted.json');
      expect(await fsp.readFile(path.join(dir, 'trusted.json'), 'utf8')).toBe(content);
      expect(await exists(path.join(dir, 'dev-rel-1.key.json'))).toBe(false);
    }
  });

  it.each([
    ['a missing --use', ['--kid', 'k', '--out', 'OUT']],
    ['a missing --kid', ['--use', 'release', '--out', 'OUT']],
    ['a missing --out', ['--use', 'release', '--kid', 'k']],
    ['an unknown use', ['--use', 'admin', '--kid', 'k', '--out', 'OUT']],
    ['an empty kid', ['--use', 'release', '--kid', '', '--out', 'OUT']],
    ['a kid with a path separator', ['--use', 'release', '--kid', '../evil', '--out', 'OUT']],
    ['a kid with a space', ['--use', 'release', '--kid', 'dev rel', '--out', 'OUT']],
    ['a kid that starts with a dot', ['--use', 'release', '--kid', '.hidden', '--out', 'OUT']],
  ])('exits 2 for %s and writes nothing', async (_name, args) => {
    const dir = await freshDir();
    const run = await cli('keygen', ...args.map((a) => (a === 'OUT' ? dir : a)));
    expect(run.code).toBe(2);
    expect(run.err).not.toBe('');
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('altis-sign release sign', () => {
  it('signs manifest.json so that verifyRelease accepts the directory', async () => {
    const keys = await freshDir();
    const { keyFile, trusted } = await keygen(keys, 'release', 'dev-rel-1');
    const dir = await makeRelease();
    const run = await cli('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run).toMatchObject({ code: 0, err: '' });
    expect(run.out).toContain('manifest.sig');

    const env = await readJson<Envelope>(path.join(dir, 'manifest.sig'));
    expect(env).toMatchObject({ typ: RELEASE_TYP, kid: 'dev-rel-1', alg: 'Ed25519' });
    const trustedFile = await readJson<TrustedKey[]>(path.join(keys, 'trusted.json'));
    expect(trustedFile).toEqual([trusted]);

    const manifest = await verifyRelease(dir, trustedFile, { check: 'all' });
    expect(manifest.files.map((f) => f.path)).toEqual(['public/a.css', 'server.mjs']);
    await expect(verifyRelease(dir, trustedFile, { check: 'executed' })).resolves.toEqual(manifest);
  });

  it('the signed directory stops verifying when server.mjs changes, or with other keys', async () => {
    const keys = await freshDir();
    const { keyFile } = await keygen(keys, 'release', 'dev-rel-1');
    const dir = await makeRelease();
    await cli('release', 'sign', '--dir', dir, '--key', keyFile);
    const trusted = await readJson<TrustedKey[]>(path.join(keys, 'trusted.json'));

    const otherKeys = await freshDir();
    await keygen(otherKeys, 'release', 'dev-rel-1');
    const others = await readJson<TrustedKey[]>(path.join(otherKeys, 'trusted.json'));
    await expect(verifyRelease(dir, others, { check: 'all' })).rejects.toThrow('RELEASE_INVALID:signature');

    await fsp.appendFile(path.join(dir, 'server.mjs'), '// tampered\n');
    await expect(verifyRelease(dir, trusted, { check: 'executed' })).rejects.toThrow('RELEASE_INVALID:hash:server.mjs');
  });

  it('signs a manifest that has properties this version does not know (R12) and signs them too', async () => {
    const keys = await freshDir();
    const { keyFile } = await keygen(keys, 'release', 'dev-rel-1');
    const dir = await makeRelease();
    const manifestFile = path.join(dir, 'manifest.json');
    const known = await readJson<ReleaseManifest>(manifestFile);
    const future = {
      ...known,
      channel: 'stable',
      minDb: { ...known.minDb, sqlite: '3.45' },
      files: known.files.map((f) => ({ ...f, mode: 420 })),
    };
    await fsp.writeFile(manifestFile, JSON.stringify(future, null, 2));

    const run = await cli('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run).toMatchObject({ code: 0, err: '' });
    const trusted = await readJson<TrustedKey[]>(path.join(keys, 'trusted.json'));
    await expect(verifyRelease(dir, trusted, { check: 'all' })).resolves.toStrictEqual(known);

    // the unknown properties are covered by the signature
    await fsp.writeFile(manifestFile, JSON.stringify({ ...future, channel: 'beta' }));
    await expect(verifyRelease(dir, trusted, { check: 'all' })).rejects.toThrow('RELEASE_INVALID:signature');
  });

  it('re-signing replaces manifest.sig and leaves no temporary file', async () => {
    const keys = await freshDir();
    const a = await keygen(keys, 'release', 'dev-rel-1');
    const b = await keygen(keys, 'release', 'dev-rel-2');
    const dir = await makeRelease();
    await cli('release', 'sign', '--dir', dir, '--key', a.keyFile);
    await cli('release', 'sign', '--dir', dir, '--key', b.keyFile);
    expect((await readJson<Envelope>(path.join(dir, 'manifest.sig'))).kid).toBe('dev-rel-2');
    expect((await fsp.readdir(dir)).sort()).toEqual(['.complete', 'manifest.json', 'manifest.sig', 'public', 'server.mjs']);
    await expect(verifyRelease(dir, [b.trusted], { check: 'all' })).resolves.toBeDefined();
    await expect(verifyRelease(dir, [a.trusted], { check: 'all' })).rejects.toThrow('RELEASE_INVALID:signature');
  });

  it('refuses a key that is not a release key, and writes no manifest.sig', async () => {
    const keys = await freshDir();
    const { keyFile } = await keygen(keys, 'license', 'dev-lic-1');
    const dir = await makeRelease();
    const run = await cli('release', 'sign', '--dir', dir, '--key', keyFile);
    expect(run.code).toBe(1);
    expect(run.err).toContain('release');
    expect(await exists(path.join(dir, 'manifest.sig'))).toBe(false);
  });

  it('refuses a missing, malformed or invalid manifest.json', async () => {
    const keys = await freshDir();
    const { keyFile } = await keygen(keys, 'release', 'dev-rel-1');
    const cases: [string | null, string][] = [
      [null, 'manifest.json'],
      ['not json', 'manifest.json'],
      ['{}', 'MANIFEST_INVALID'],
      ['{"version":"1.0.0","version":"1.0.1"}', 'DUPLICATE_KEY'],
      [JSON.stringify({ ...META, files: 'x' }), 'MANIFEST_INVALID:files'],
    ];
    for (const [content, message] of cases) {
      const dir = await makeRelease();
      if (content === null) await fsp.rm(path.join(dir, 'manifest.json'));
      else await fsp.writeFile(path.join(dir, 'manifest.json'), content);
      const run = await cli('release', 'sign', '--dir', dir, '--key', keyFile);
      expect(run.code).toBe(1);
      expect(run.err).toContain(message);
      expect(await exists(path.join(dir, 'manifest.sig'))).toBe(false);
    }
  });

  it('refuses a malformed key file', async () => {
    const dir = await makeRelease();
    const bad = await freshDir();
    const { privateKey } = generateKeyPair();
    const good = { kid: 'k', use: 'release', pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
    const x25519 = generateKeyPairSync('x25519').privateKey;
    const files: [string, string][] = [
      ['missing.key.json', ''],
      ['garbage.key.json', 'not json'],
      ['extra.key.json', JSON.stringify({ ...good, extra: 1 })],
      ['nokid.key.json', JSON.stringify({ use: good.use, pkcs8: good.pkcs8 })],
      ['baduse.key.json', JSON.stringify({ ...good, use: 'admin' })],
      ['badb64.key.json', JSON.stringify({ ...good, pkcs8: '***' })],
      ['notder.key.json', JSON.stringify({ ...good, pkcs8: 'AAAA' })],
      [
        'x25519.key.json',
        JSON.stringify({ ...good, pkcs8: x25519.export({ format: 'der', type: 'pkcs8' }).toString('base64') }),
      ],
    ];
    for (const [name, content] of files) {
      if (name !== 'missing.key.json') await fsp.writeFile(path.join(bad, name), content);
      const run = await cli('release', 'sign', '--dir', dir, '--key', path.join(bad, name));
      expect(run.code, name).toBe(1);
      expect(run.err, name).toContain('key');
    }
    expect(await exists(path.join(dir, 'manifest.sig'))).toBe(false);
  });
});

describe('altis-sign keyset sign', () => {
  const payload = (seq: number, keys: TrustedKey[], revokedKids: string[] = []) => ({ seq, keys, revokedKids });

  async function writePayload(dir: string, value: unknown, name = 'keyset-payload.json'): Promise<string> {
    const file = path.join(dir, name);
    await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  }

  /** `<dir>/roots.json`: the root keys keygen wrote into `<dir>/trusted.json`, as the --root-keys file. */
  async function rootsOf(dir: string): Promise<string> {
    const file = path.join(dir, 'roots.json');
    const trusted = await readJson<TrustedKey[]>(path.join(dir, 'trusted.json'));
    await fsp.writeFile(file, JSON.stringify(trusted.filter((k) => k.use === 'root')));
    return file;
  }

  /** `keyset sign` with the roots of `dir`. */
  async function sign(dir: string, input: string, keyFile: string, out: string): Promise<Run> {
    return cli('keyset', 'sign', '--in', input, '--key', keyFile, '--root-keys', await rootsOf(dir), '--out', out);
  }

  it('writes a document array that resolveTrustedKeys accepts under the root key', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const rel1 = await keygen(dir, 'release', 'dev-rel-1');
    const rel2 = await keygen(dir, 'release', 'dev-rel-2');
    const lic = await keygen(dir, 'license', 'dev-lic-1');
    const input = await writePayload(dir, payload(1, [rel1.trusted, rel2.trusted, lic.trusted]));
    const out = path.join(dir, 'keyset.json');
    const run = await sign(dir, input, root.keyFile, out);
    expect(run).toMatchObject({ code: 0, err: '' });

    const docs = await readJson<KeysetDoc[]>(out);
    expect(docs).toHaveLength(1);
    expect(Object.keys(docs[0]!).sort()).toEqual(['env', 'raw']);
    expect(docs[0]!.raw).toBe(canonicalize(payload(1, [rel1.trusted, rel2.trusted, lic.trusted])));
    expect(docs[0]!.env).toMatchObject({ typ: KEYSET_TYP, kid: 'dev-root-1', alg: 'Ed25519' });
    const { keys, maxSeq, rejected } = resolveTrustedKeys([root.trusted], docs);
    expect(rejected).toEqual([]);
    expect(maxSeq).toBe(1);
    expect(keys.map((k) => k.kid)).toEqual(['dev-root-1', 'dev-lic-1', 'dev-rel-1', 'dev-rel-2']);
  });

  it('appends to an existing array and keeps its documents as they are', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const rel1 = await keygen(dir, 'release', 'dev-rel-1');
    const rel2 = await keygen(dir, 'release', 'dev-rel-2');
    const lic = await keygen(dir, 'license', 'dev-lic-1');
    const out = path.join(dir, 'keyset.json');
    await sign(dir, await writePayload(dir, payload(1, [rel1.trusted, rel2.trusted], [])), root.keyFile, out);
    const first = (await readJson<KeysetDoc[]>(out))[0]!;
    const second = await sign(dir, await writePayload(dir, payload(2, [lic.trusted], ['dev-rel-1']), 'p2.json'), root.keyFile, out);
    expect(second).toMatchObject({ code: 0, err: '' });
    const docs = await readJson<KeysetDoc[]>(out);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual(first);
    expect(docs[1]!.env.kid).toBe('dev-root-1');
    const { keys, maxSeq } = resolveTrustedKeys([root.trusted], docs);
    expect(maxSeq).toBe(2);
    expect(keys.map((k) => k.kid)).toEqual(['dev-root-1', 'dev-lic-1', 'dev-rel-2']);
  });

  it('signs under altis-keyset/1: verifyDetached accepts the raw text with the signer as trusted key', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const out = path.join(dir, 'keyset.json');
    await sign(dir, await writePayload(dir, payload(5, [])), root.keyFile, out);
    const [doc] = await readJson<KeysetDoc[]>(out);
    expect(verifyDetached(doc!.raw, doc!.env, [root.trusted], KEYSET_TYP)).toEqual(payload(5, []));
  });

  it('accepts any JSON spelling of the payload (whitespace, property order)', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const out = path.join(dir, 'keyset.json');
    const input = await writePayload(dir, '\n{ "revokedKids" : [ ],\n "seq":3 , "keys" : [] }\n\n');
    expect(await sign(dir, input, root.keyFile, out)).toMatchObject({ code: 0 });
    expect((await readJson<KeysetDoc[]>(out))[0]!.raw).toBe('{"keys":[],"revokedKids":[],"seq":3}');
  });

  it('refuses a payload that is not a keyset, and writes nothing', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const rel1 = await keygen(dir, 'release', 'dev-rel-1');
    const out = path.join(dir, 'keyset.json');
    const bad: unknown[] = [
      payload(0, []),
      payload(1.5, []),
      { seq: 1, keys: [] },
      { ...payload(1, []), note: 'x' },
      payload(1, [{ ...rel1.trusted, use: 'admin' as KeyUse }]),
      [],
      'not json',
      '{"seq":1,"seq":2,"keys":[],"revokedKids":[]}',
    ];
    for (const value of bad) {
      const run = await sign(dir, await writePayload(dir, value), root.keyFile, out);
      expect(run.code).toBe(1);
      expect(run.err).not.toBe('');
      expect(await exists(out)).toBe(false);
    }
  });

  it('refuses a payload that touches any root of --root-keys, the spare included (R65e: documents never touch a root)', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const spare = await keygen(dir, 'root', 'dev-root-2');
    const rel1 = await keygen(dir, 'release', 'dev-rel-1');
    const out = path.join(dir, 'keyset.json');
    const asRelease = (key: TrustedKey): TrustedKey => ({ kid: 'rel-x', use: 'release', pub: key.pub });
    for (const value of [
      payload(1, [rel1.trusted, spare.trusted]),
      payload(1, [root.trusted]),
      payload(1, [rel1.trusted], ['dev-root-1']),
      payload(1, [rel1.trusted], ['dev-root-2']),
      payload(1, [asRelease(root.trusted)]),
      payload(1, [asRelease(spare.trusted)]),
      payload(1, [{ ...rel1.trusted, use: 'root' }]),
    ]) {
      const run = await sign(dir, await writePayload(dir, value), root.keyFile, out);
      expect(run.code, JSON.stringify(value)).toBe(1);
      expect(run.err).toContain('root');
      expect(await exists(out)).toBe(false);
    }
  });

  it('needs --root-keys: root keys only, the signing root among them', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const rel1 = await keygen(dir, 'release', 'dev-rel-1');
    const out = path.join(dir, 'keyset.json');
    const input = await writePayload(dir, payload(1, [rel1.trusted]));
    expect((await cli('keyset', 'sign', '--in', input, '--key', root.keyFile, '--out', out)).code).toBe(2);
    const other = await freshDir();
    await keygen(other, 'root', 'dev-root-9');
    const notAmong = await cli('keyset', 'sign', '--in', input, '--key', root.keyFile, '--root-keys', await rootsOf(other), '--out', out);
    expect(notAmong.code).toBe(1);
    expect(notAmong.err).toContain('dev-root-1');
    const mixed = path.join(dir, 'mixed-roots.json');
    await fsp.writeFile(mixed, JSON.stringify([root.trusted, rel1.trusted]));
    const notRoots = await cli('keyset', 'sign', '--in', input, '--key', root.keyFile, '--root-keys', mixed, '--out', out);
    expect(notRoots.code).toBe(1);
    expect(notRoots.err).toContain('root keys');
    expect(await exists(out)).toBe(false);
  });

  it('a production root (not dev-) refuses dev- kids and the public keys of tools/keys/dev (R65b); a dev root signs them', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'root-1');
    const out = path.join(dir, 'keyset.json');
    const devTrusted = await readJson<TrustedKey[]>(path.resolve(PACKAGE_DIR, '..', 'keys', 'dev', 'trusted.json'));
    const devRel = devTrusted.find((k) => k.kid === 'dev-rel-1')!;
    const fresh = { kid: 'dev-rel-77', use: 'release' as KeyUse, pub: generateKeyPair().pub };
    for (const keys of [[devRel], [fresh], [{ ...devRel, kid: 'rel-renamed' }]]) {
      const run = await sign(dir, await writePayload(dir, payload(1, keys)), root.keyFile, out);
      expect(run.code, JSON.stringify(keys)).toBe(1);
      expect(run.err).toContain('dev');
      expect(await exists(out)).toBe(false);
    }
    // Revoking a dev kid is fine.
    expect((await sign(dir, await writePayload(dir, payload(1, [], ['dev-rel-1'])), root.keyFile, out)).code).toBe(0);

    const devDir = await freshDir();
    const devRoot = await keygen(devDir, 'root', 'dev-root-1');
    expect((await sign(devDir, await writePayload(devDir, payload(1, [fresh])), devRoot.keyFile, path.join(devDir, 'k.json'))).code).toBe(0);
  });

  it('a production root refuses to sign when the dev public keys cannot be read: the dev check is never skipped (round 2)', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'root-1');
    const rel = await keygen(dir, 'release', 'rel-1');
    const input = await writePayload(dir, payload(1, [rel.trusted]));
    const out = path.join(dir, 'keyset.json');
    const roots = await rootsOf(dir);
    const malformed = path.join(dir, 'dev-trusted-malformed.json');
    await fsp.writeFile(malformed, '{ not json');
    // The dev file comes through the test hooks of runCliForTest (src/testing.ts), never through CliIo (preflight M10).
    for (const devTrustedFile of [path.join(dir, 'no-such-dir', 'trusted.json'), malformed]) {
      const lines: string[] = [];
      const code = await runCliForTest(
        ['keyset', 'sign', '--in', input, '--key', root.keyFile, '--root-keys', roots, '--out', out],
        { out: (l) => void lines.push(l), err: (l) => void lines.push(l) },
        { devTrustedFile },
      );
      expect(code, devTrustedFile).toBe(1);
      expect(lines.join('\n')).toContain('dev public keys');
      expect(await exists(out)).toBe(false);
    }
    // A dev root does not need them.
    const devDir = await freshDir();
    const devRoot = await keygen(devDir, 'root', 'dev-root-1');
    const devRel = await keygen(devDir, 'release', 'dev-rel-1');
    const code = await runCliForTest(
      ['keyset', 'sign', '--in', await writePayload(devDir, payload(1, [devRel.trusted])), '--key', devRoot.keyFile, '--root-keys', await rootsOf(devDir), '--out', path.join(devDir, 'k.json')],
      { out: () => {}, err: () => {} },
      { devTrustedFile: path.join(devDir, 'nowhere.json') },
    );
    expect(code).toBe(0);
  });

  it('a production root refuses a key that the dev list of the test hooks names, whatever its kid', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'root-1');
    const rel = await keygen(dir, 'release', 'rel-1');
    const input = await writePayload(dir, payload(1, [rel.trusted]));
    const out = path.join(dir, 'keyset.json');
    const devList = path.join(dir, 'dev-trusted.json');
    await fsp.writeFile(devList, JSON.stringify([rel.trusted]));
    const lines: string[] = [];
    const io: CliIo = { out: (l) => void lines.push(l), err: (l) => void lines.push(l) };
    const args = ['keyset', 'sign', '--in', input, '--key', root.keyFile, '--root-keys', await rootsOf(dir), '--out', out];
    expect(await runCliForTest(args, io, { devTrustedFile: devList })).toBe(1);
    expect(lines.join('\n')).toContain('never trusts a dev key (rel-1)');
    expect(await exists(out)).toBe(false);
    // Without hooks the dev list is tools/keys/dev's, which does not name rel-1.
    expect(await runCliForTest(args, io)).toBe(0);
  });

  it.each<KeyUse>(['release', 'license', 'timestamp', 'device'])('refuses a %s key: only a root key signs a keyset (R65)', async (use) => {
    const dir = await freshDir();
    await keygen(dir, 'root', 'dev-root-1');
    const key = await keygen(dir, use, `k-${use}`);
    const rel = await keygen(dir, 'release', 'dev-rel-9');
    const out = path.join(dir, 'keyset.json');
    const run = await sign(dir, await writePayload(dir, payload(1, [rel.trusted])), key.keyFile, out);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`has use "${use}"`);
    expect(run.err).toContain('"root"');
    expect(await exists(out)).toBe(false);
  });

  it('refuses a missing input file', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const run = await sign(dir, path.join(dir, 'nope.json'), root.keyFile, path.join(dir, 'o.json'));
    expect(run.code).toBe(1);
    expect(run.err).toContain('nope.json');
  });

  it('refuses an --out file that is not an array of {raw, env}, and leaves it alone', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'dev-root-1');
    const input = await writePayload(dir, payload(1, []));
    for (const content of ['not json', '{}', '"x"', '[1]', '[{"raw":"x"}]', '[{"raw":1,"env":{}}]', '[{"raw":"x","env":{},"extra":1}]']) {
      const out = path.join(dir, 'existing.json');
      await fsp.writeFile(out, content);
      const run = await sign(dir, input, root.keyFile, out);
      expect(run.code, content).toBe(1);
      expect(run.err, content).toContain('existing.json');
      expect(await fsp.readFile(out, 'utf8')).toBe(content);
    }
  });

  it('exits 2 when an option is missing', async () => {
    const dir = await freshDir();
    const all = ['--in', 'i', '--key', 'k', '--root-keys', 'r', '--out', 'o'];
    for (let i = 0; i < all.length; i += 2) {
      const args = [...all.slice(0, i), ...all.slice(i + 2)];
      expect((await cli('keyset', 'sign', ...args)).code, args.join(' ')).toBe(2);
    }
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('altis-sign: the test seam is out of the public API (preflight M10)', () => {
  it('CliIo has no devTrustedFile and runCli takes no hooks (type test)', () => {
    const io: CliIo = {
      out: () => {},
      err: () => {},
      // @ts-expect-error devTrustedFile is a test hook of runCliForTest (src/testing.ts), not part of CliIo
      devTrustedFile: 'nowhere.json',
    };
    // @ts-expect-error runCli(argv, io) has no third parameter
    const call = (): Promise<number> => runCli(['--help'], io, { devTrustedFile: 'nowhere.json' });
    expect(typeof call).toBe('function');
  });

  it('the package publishes src/index.ts only, and its exports hold no test runner', async () => {
    const pkg = await readJson<{ name: string; bin: Record<string, string>; exports: Record<string, string> }>(path.join(PACKAGE_DIR, 'package.json'));
    expect(pkg.name).toBe('@altis/sign-cli');
    expect(pkg.bin).toEqual({ 'altis-sign': './src/bin.ts' });
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
    const api = await import('../src/index.js');
    expect(Object.keys(api).sort()).toEqual(['KEY_FILE_KDF', 'PASSPHRASE_ENV', 'loadKeyFile', 'runCli']);
  });

  it('runCli ignores a devTrustedFile smuggled into its io: a production root still checks the dev keys of tools/keys/dev', async () => {
    const dir = await freshDir();
    const root = await keygen(dir, 'root', 'root-1');
    const roots = path.join(dir, 'roots.json');
    await fsp.writeFile(roots, JSON.stringify([root.trusted]));
    const devTrusted = await readJson<TrustedKey[]>(path.resolve(PACKAGE_DIR, '..', 'keys', 'dev', 'trusted.json'));
    const devRel = devTrusted.find((k) => k.kid === 'dev-rel-1')!;
    const input = path.join(dir, 'payload.json');
    await fsp.writeFile(input, JSON.stringify({ seq: 1, keys: [{ ...devRel, kid: 'rel-renamed' }], revokedKids: [] }));
    const out = path.join(dir, 'keyset.json');
    // A dev list that names none of tools/keys/dev: honoured, it would let the renamed dev key through.
    const decoy = path.join(dir, 'decoy-dev-list.json');
    await fsp.writeFile(decoy, JSON.stringify([{ kid: 'x', use: 'release', pub: generateKeyPair().pub }]));
    const lines: string[] = [];
    const io = { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), devTrustedFile: decoy } as CliIo;
    const code = await runCli(['keyset', 'sign', '--in', input, '--key', root.keyFile, '--root-keys', roots, '--out', out], io);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('never trusts a dev key (rel-renamed)');
    expect(await exists(out)).toBe(false);
  });
});

describe('altis-sign as a process (bin.ts under tsx)', () => {
  const bin = path.join(PACKAGE_DIR, 'src', 'bin.ts');
  const run = (...args: string[]) =>
    execFileAsync(process.execPath, ['--import', 'tsx', bin, ...args], { cwd: PACKAGE_DIR, timeout: 60_000 });

  it('keygen and release sign work end to end, and the exit code follows the result', async () => {
    const keys = await freshDir();
    const { stdout } = await run('keygen', '--use', 'release', '--kid', 'dev-rel-1', '--out', keys);
    expect(stdout).toContain('dev-rel-1.key.json');
    const dir = await makeRelease();
    await run('release', 'sign', '--dir', dir, '--key', path.join(keys, 'dev-rel-1.key.json'));
    const trusted = await readJson<TrustedKey[]>(path.join(keys, 'trusted.json'));
    await expect(verifyRelease(dir, trusted, { check: 'all' })).resolves.toBeDefined();

    await expect(run('keygen', '--use', 'release', '--kid', 'dev-rel-1', '--out', keys)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('dev-rel-1'),
    });
    await expect(run('bogus')).rejects.toMatchObject({ code: 2 });
    await expect(run('--help')).resolves.toMatchObject({ stdout: expect.stringContaining('altis-sign keygen') });
  });
});
