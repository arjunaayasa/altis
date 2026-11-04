import { createHash, createPrivateKey } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYSET_TYP, canonicalize, decodeBase64Url, signDetached, type KeyUse, type TrustedKey } from '@altis/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyFingerprint } from '../src/ceremony.js';
import { runCliForTest, type TestHooks } from '../src/testing.js';

// Task 8 (preflight 1D-16, D1d-28): `ceremony check --roots <roots.json> --keyset <keyset.json> [--pub <file>…]` checks
// freshly made production key material: ≥ 2 distinct roots, no dev material, a keyset the roots fully accept
// (refuseDevKids) that trusts a release and a timestamp key (keys of the reserved uses license and device are
// optional); it prints kid, use and the SHA-256 fingerprint of every public key.

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_KEYS = path.resolve(PACKAGE_DIR, '..', 'keys', 'dev');

let root: string;
let counter = 0;

/**
 * The material made once: two roots (root-1 signs), rel-1, ts-1, roots.json and keyset.json (trusting rel-1 and ts-1).
 * root-3 (a root outside roots.json), lic-1 and dca-1 (reserved uses) are made too, for the cases that need them.
 */
let material: { dir: string; roots: string; keyset: string; keys: Record<string, TrustedKey>; keyFiles: Record<string, string> };

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-sign-ceremony-'));
  const dir = path.join(root, 'ceremony');
  const keys: Record<string, TrustedKey> = {};
  const keyFiles: Record<string, string> = {};
  for (const [use, kid] of [
    ['root', 'root-1'],
    ['root', 'root-2'],
    ['root', 'root-3'],
    ['license', 'lic-1'],
    ['release', 'rel-1'],
    ['timestamp', 'ts-1'],
    ['device', 'dca-1'],
  ] as const) {
    keys[kid] = await keygen(dir, use, kid);
    keyFiles[kid] = path.join(dir, `${kid}.key.json`);
  }
  const roots = await writeJson(path.join(dir, 'roots.json'), [keys['root-1'], keys['root-2']]);
  const keyset = path.join(dir, 'keyset.json');
  await sign(dir, { seq: 1, keys: [keys['rel-1'], keys['ts-1']], revokedKids: [] }, keyFiles['root-1']!, roots, keyset);
  material = { dir, roots, keyset, keys, keyFiles };
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

/** Runs altis-sign; `hooks` are the test hooks of runCliForTest (the dev key file), never part of CliIo (preflight M10). */
async function cli(args: string[], hooks: TestHooks = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCliForTest(args, { out: (line) => out.push(line), err: (line) => err.push(line) }, hooks);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function writeJson(file: string, value: unknown): Promise<string> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2));
  return file;
}

async function keygen(dir: string, use: KeyUse, kid: string): Promise<TrustedKey> {
  const run = await cli(['keygen', '--use', use, '--kid', kid, '--out', dir]);
  expect(run).toMatchObject({ code: 0, err: '' });
  const trusted = JSON.parse(await fsp.readFile(path.join(dir, 'trusted.json'), 'utf8')) as TrustedKey[];
  return trusted.find((k) => k.kid === kid)!;
}

async function sign(dir: string, payload: unknown, keyFile: string, roots: string, out: string): Promise<void> {
  const input = await writeJson(path.join(dir, `payload-${counter++}.json`), payload);
  const run = await cli(['keyset', 'sign', '--in', input, '--key', keyFile, '--root-keys', roots, '--out', out]);
  expect(run).toMatchObject({ code: 0, err: '' });
}

const check = (roots: string, keyset: string, ...extra: string[]): Promise<Run> => cli(['ceremony', 'check', '--roots', roots, '--keyset', keyset, ...extra]);

describe('altis-sign ceremony check', () => {
  it('two fresh roots and a keyset signed by the first trusting fresh rel and ts keys: exit 0, four kids with their fingerprints', async () => {
    const run = await check(material.roots, material.keyset);
    expect(run).toMatchObject({ code: 0, err: '' });
    const rows = run.out.split('\n').filter((line) => /^\S+\s+(root|license|release|timestamp|device)\s+[0-9a-f]{4}( [0-9a-f]{4}){15}$/.test(line));
    expect(rows).toHaveLength(4);
    for (const kid of ['root-1', 'root-2', 'rel-1', 'ts-1']) {
      const key = material.keys[kid]!;
      const row = rows.find((line) => line.split(/\s+/)[0] === kid);
      expect(row, kid).toBeDefined();
      expect(row!.split(/\s+/)[1]).toBe(key.use);
      expect(row!.split(/\s+/).slice(2).join('')).toBe(createHash('sha256').update(decodeBase64Url(key.pub)!).digest('hex'));
      expect(row).toContain(keyFingerprint(key.pub));
    }
    expect(run.out).not.toContain('root-3');
    expect(run.out).toContain('trust release, timestamp keys');
  });

  it('keys of the reserved uses license and device are optional: a keyset that also trusts lic and dca keys passes', async () => {
    const dir = await freshDir();
    const keyset = path.join(dir, 'keyset.json');
    const k = material.keys;
    await sign(dir, { seq: 1, keys: [k['lic-1'], k['rel-1'], k['ts-1'], k['dca-1']], revokedKids: [] }, material.keyFiles['root-1']!, material.roots, keyset);
    const run = await check(material.roots, keyset);
    expect(run).toMatchObject({ code: 0, err: '' });
    for (const kid of ['lic-1', 'dca-1']) expect(run.out).toContain(keyFingerprint(k[kid]!.pub));
  });

  it('keyFingerprint is the SHA-256 of the raw 32-byte public key, hex in groups of four', () => {
    const pub = material.keys['rel-1']!.pub;
    const hex = createHash('sha256').update(decodeBase64Url(pub)!).digest('hex');
    expect(keyFingerprint(pub)).toBe(hex.match(/.{4}/g)!.join(' '));
  });

  it('the dev material (tools/keys/dev roots.json and keyset.json): exit 1 DEV_KEY', async () => {
    const run = await check(path.join(DEV_KEYS, 'roots.json'), path.join(DEV_KEYS, 'keyset.json'));
    expect(run.code).toBe(1);
    expect(run.err).toContain('DEV_KEY');
  });

  it('a public key of tools/keys/dev under another kid is dev material too (roots, keyset keys, --pub)', async () => {
    const devTrusted = JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'trusted.json'), 'utf8')) as TrustedKey[];
    const devRoot = devTrusted.find((k) => k.kid === 'dev-root-1')!;
    const devRel = devTrusted.find((k) => k.kid === 'dev-rel-1')!;
    const dir = await freshDir();

    const roots = await writeJson(path.join(dir, 'roots.json'), [{ ...devRoot, kid: 'root-9' }, material.keys['root-2']]);
    expect((await check(roots, material.keyset)).err).toContain('DEV_KEY');

    // keyset sign refuses to make such a document, so it is signed here directly with root-1.
    const payload = { seq: 2, keys: [{ ...devRel, kid: 'rel-9' }, material.keys['ts-1']], revokedKids: [] };
    const root1 = JSON.parse(await fsp.readFile(material.keyFiles['root-1']!, 'utf8')) as { pkcs8: string };
    const privateKey = createPrivateKey({ key: Buffer.from(root1.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const keyset = await writeJson(path.join(dir, 'keyset.json'), [
      { raw: canonicalize(payload), env: signDetached(payload, { typ: KEYSET_TYP, kid: 'root-1', privateKey }) },
    ]);
    const run = await check(material.roots, keyset);
    expect(run.code).toBe(1);
    expect(run.err).toContain('DEV_KEY');

    const pub = await writeJson(path.join(dir, 'dev.pub.json'), devRel);
    const withPub = await check(material.roots, material.keyset, '--pub', pub);
    expect(withPub.code).toBe(1);
    expect(withPub.err).toContain('DEV_KEY');
  });

  it('one root: exit 1 ROOTS_TOO_FEW', async () => {
    const dir = await freshDir();
    const roots = await writeJson(path.join(dir, 'roots.json'), [material.keys['root-1']]);
    const run = await check(roots, material.keyset);
    expect(run.code).toBe(1);
    expect(run.err).toContain('ROOTS_TOO_FEW');
  });

  it('two roots sharing a kid or a public key: exit 1 ROOTS_DUPLICATE', async () => {
    const dir = await freshDir();
    const r1 = material.keys['root-1']!;
    for (const [name, list] of [
      ['same key twice', [r1, r1]],
      ['same kid', [r1, { ...material.keys['root-2']!, kid: 'root-1' }]],
      ['same pub', [r1, { ...r1, kid: 'root-2' }]],
    ] as const) {
      const roots = await writeJson(path.join(dir, `${name}.json`), list);
      const run = await check(roots, material.keyset);
      expect(run.code, name).toBe(1);
      expect(run.err, name).toContain('ROOTS_DUPLICATE');
    }
  });

  it('a keyset signed by a root that is not in roots.json: exit 1 KEYSET_INVALID', async () => {
    const dir = await freshDir();
    const otherRoots = await writeJson(path.join(dir, 'other-roots.json'), [material.keys['root-3']]);
    const keyset = path.join(dir, 'keyset.json');
    const k = material.keys;
    await sign(dir, { seq: 1, keys: [k['rel-1'], k['ts-1']], revokedKids: [] }, material.keyFiles['root-3']!, otherRoots, keyset);
    const run = await check(material.roots, keyset);
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEYSET_INVALID');
  });

  it('a keyset file that is not an array of documents, or a document that binds a kid to two keys: exit 1 KEYSET_INVALID', async () => {
    const dir = await freshDir();
    const docs = JSON.parse(await fsp.readFile(material.keyset, 'utf8')) as unknown[];
    const notArray = await writeJson(path.join(dir, 'single.json'), docs[0]);
    expect((await check(material.roots, notArray)).err).toContain('KEYSET_INVALID');
    for (const entry of [1, null, { raw: 'x' }, { raw: 'x', env: null }]) {
      const malformed = await writeJson(path.join(dir, 'malformed.json'), [...docs, entry]);
      const run = await check(material.roots, malformed);
      expect(run.code, JSON.stringify(entry)).toBe(1);
      expect(run.err, JSON.stringify(entry)).toContain('KEYSET_INVALID');
    }

    // A second document binds rel-1 to another public key: the kid is in conflict, so nothing of it is trusted.
    const conflicting = path.join(dir, 'conflict.json');
    await fsp.copyFile(material.keyset, conflicting);
    const fresh = await keygen(dir, 'release', 'rel-x');
    await sign(dir, { seq: 3, keys: [{ ...fresh, kid: 'rel-1' }], revokedKids: [] }, material.keyFiles['root-1']!, material.roots, conflicting);
    const run = await check(material.roots, conflicting);
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEYSET_INVALID');
  });

  it.each(['timestamp', 'release'] as const)('a keyset without a %s key: exit 1 KEYSET_MISSING_USE:%s', async (use) => {
    const dir = await freshDir();
    const keyset = path.join(dir, 'keyset.json');
    const k = material.keys;
    // The reserved uses do not stand in for a missing one.
    const keys = [k['lic-1'], k['dca-1'], use === 'timestamp' ? k['rel-1'] : k['ts-1']];
    await sign(dir, { seq: 1, keys, revokedKids: [] }, material.keyFiles['root-1']!, material.roots, keyset);
    const run = await check(material.roots, keyset);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`KEYSET_MISSING_USE:${use}`);
  });

  it('a key the keyset later revokes does not count: KEYSET_MISSING_USE:release', async () => {
    const dir = await freshDir();
    const keyset = path.join(dir, 'keyset.json');
    await fsp.copyFile(material.keyset, keyset);
    await sign(dir, { seq: 2, keys: [], revokedKids: ['rel-1'] }, material.keyFiles['root-1']!, material.roots, keyset);
    const run = await check(material.roots, keyset);
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEYSET_MISSING_USE:release');
  });

  it('--pub files (as `pub` writes them) must be keys the roots or the keyset trust: PUB_NOT_TRUSTED otherwise', async () => {
    const dir = await freshDir();
    const pubs: string[] = [];
    for (const kid of ['root-2', 'rel-1', 'ts-1']) {
      const out = path.join(dir, `${kid}.pub.json`);
      expect((await cli(['pub', '--key', material.keyFiles[kid]!, '--out', out])).code).toBe(0);
      pubs.push('--pub', out);
    }
    expect(await check(material.roots, material.keyset, ...pubs)).toMatchObject({ code: 0, err: '' });

    const stray = path.join(dir, 'root-3.pub.json');
    expect((await cli(['pub', '--key', material.keyFiles['root-3']!, '--out', stray])).code).toBe(0);
    const run = await check(material.roots, material.keyset, ...pubs, '--pub', stray);
    expect(run.code).toBe(1);
    expect(run.err).toContain('PUB_NOT_TRUSTED:root-3');

    const renamed = await writeJson(path.join(dir, 'renamed.pub.json'), { ...material.keys['rel-1'], kid: 'rel-9' });
    expect((await check(material.roots, material.keyset, '--pub', renamed)).err).toContain('PUB_NOT_TRUSTED:rel-9');
    // A key of a reserved use made alongside but never put in the keyset is not trusted either.
    const lic = path.join(dir, 'lic-1.pub.json');
    expect((await cli(['pub', '--key', material.keyFiles['lic-1']!, '--out', lic])).code).toBe(0);
    expect((await check(material.roots, material.keyset, '--pub', lic)).err).toContain('PUB_NOT_TRUSTED:lic-1');
    const malformed = await writeJson(path.join(dir, 'malformed.pub.json'), { ...material.keys['rel-1'], extra: 1 });
    expect((await check(material.roots, material.keyset, '--pub', malformed)).code).toBe(1);
  });

  it('never runs without the dev public keys: an unreadable dev file fails (exit 1)', async () => {
    const dir = await freshDir();
    const run = await cli(['ceremony', 'check', '--roots', material.roots, '--keyset', material.keyset], { devTrustedFile: path.join(dir, 'nowhere.json') });
    expect(run.code).toBe(1);
    expect(run.err).toContain('dev public keys');
  });

  it('takes its dev list from the test hooks (preflight M10): a key that list names is dev material, whatever its kid', async () => {
    const dir = await freshDir();
    const devList = await writeJson(path.join(dir, 'dev-trusted.json'), [material.keys['ts-1']]);
    const run = await cli(['ceremony', 'check', '--roots', material.roots, '--keyset', material.keyset], { devTrustedFile: devList });
    expect(run.code).toBe(1);
    expect(run.err).toContain('DEV_KEY:ts-1');
    const rootList = await writeJson(path.join(dir, 'dev-roots.json'), [material.keys['root-2']]);
    expect((await cli(['ceremony', 'check', '--roots', material.roots, '--keyset', material.keyset], { devTrustedFile: rootList })).err).toContain(
      'DEV_KEY:root-2',
    );
    // Without hooks, tools/keys/dev's list: the same material passes.
    expect((await cli(['ceremony', 'check', '--roots', material.roots, '--keyset', material.keyset])).code).toBe(0);
  });

  it('missing options exit 2', async () => {
    expect((await cli(['ceremony', 'check', '--roots', material.roots])).code).toBe(2);
    expect((await cli(['ceremony', 'check', '--keyset', material.keyset])).code).toBe(2);
    expect((await cli(['ceremony'])).code).toBe(2);
    expect((await cli(['ceremony', 'run'])).code).toBe(2);
  });
});
