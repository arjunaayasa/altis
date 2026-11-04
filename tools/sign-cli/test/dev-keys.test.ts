import { createPrivateKey, type KeyObject } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYSET_TYP,
  TYP_USE,
  isTrustedKey,
  rawPublicKey,
  resolveTrustedKeys,
  signDetached,
  verifyDetached,
  type KeyUse,
  type KeysetDoc,
  type TrustedKey,
} from '@altis/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const DEV_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'keys', 'dev');

const EXPECTED: [string, KeyUse][] = [
  ['dev-rel-1', 'release'],
  ['dev-rel-2', 'release'],
  ['dev-lic-1', 'license'],
  ['dev-ts-1', 'timestamp'],
  ['dev-dca-1', 'device'],
  ['dev-root-1', 'root'],
];

type KeyFile = { kid: string; use: KeyUse; pkcs8: string };

const read = async (name: string): Promise<string> => fsp.readFile(path.join(DEV_DIR, name), 'utf8');

let keyFiles: KeyFile[];
let trusted: TrustedKey[];
let roots: TrustedKey[];
let keyset: KeysetDoc[];

beforeAll(async () => {
  keyFiles = await Promise.all(EXPECTED.map(async ([kid]) => JSON.parse(await read(`${kid}.key.json`)) as KeyFile));
  trusted = JSON.parse(await read('trusted.json')) as TrustedKey[];
  roots = JSON.parse(await read('roots.json')) as TrustedKey[];
  keyset = JSON.parse(await read('keyset.json')) as KeysetDoc[];
});

const privateKeyOf = (file: KeyFile): KeyObject =>
  createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });

describe('committed dev keys (tools/keys/dev)', () => {
  it('holds exactly the six private keys, trusted.json, roots.json, keyset.json and the README', async () => {
    expect((await fsp.readdir(DEV_DIR)).sort()).toEqual([
      'README.md',
      'dev-dca-1.key.json',
      'dev-lic-1.key.json',
      'dev-rel-1.key.json',
      'dev-rel-2.key.json',
      'dev-root-1.key.json',
      'dev-ts-1.key.json',
      'keyset.json',
      'roots.json',
      'trusted.json',
    ]);
  });

  it('has Ed25519 private keys of the right kid and use', () => {
    expect(keyFiles.map((f) => [f.kid, f.use])).toEqual(EXPECTED);
    for (const file of keyFiles) {
      expect(Object.keys(file).sort()).toEqual(['kid', 'pkcs8', 'use']);
      expect(privateKeyOf(file).asymmetricKeyType).toBe('ed25519');
    }
    expect(new Set(keyFiles.map((f) => f.pkcs8)).size).toBe(6);
  });

  it('trusted.json lists the six public keys, and only public keys', async () => {
    expect(trusted.map((k) => [k.kid, k.use])).toEqual(EXPECTED);
    expect(trusted.every(isTrustedKey)).toBe(true);
    expect(trusted.every((k) => k.kid.startsWith('dev-'))).toBe(true);
    keyFiles.forEach((file, i) => expect(trusted[i]!.pub).toBe(rawPublicKey(privateKeyOf(file))));
    const text = await read('trusted.json');
    expect(text).not.toContain('pkcs8');
    for (const file of keyFiles) expect(text).not.toContain(file.pkcs8);
  });

  it('roots.json is the dev trust anchor set: the root keys of trusted.json, public only', async () => {
    expect(roots).toEqual(trusted.filter((k) => k.use === 'root'));
    expect(roots.map((k) => k.kid)).toEqual(['dev-root-1']);
    expect(await read('roots.json')).not.toContain('pkcs8');
  });

  it('keyset.json is one seq-1 document, signed by dev-root-1, that trusts the five other keys', () => {
    expect(keyset).toHaveLength(1);
    const resolved = resolveTrustedKeys(roots, keyset);
    expect(resolved.rejected).toEqual([]);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.maxSeq).toBe(1);
    const signed = trusted.filter((k) => k.use !== 'root');
    const byKid = (a: TrustedKey, b: TrustedKey): number => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0);
    expect(resolved.keys).toEqual([...roots, ...[...signed].sort(byKid)]);
    expect(keyset[0]!.env).toMatchObject({ typ: KEYSET_TYP, kid: 'dev-root-1' });
    expect(JSON.parse(keyset[0]!.raw)).toEqual({ seq: 1, keys: signed, revokedKids: [] });
    // The pre-R65 anchors (the release keys) are no anchors any more.
    expect(() => resolveTrustedKeys(signed, keyset)).toThrow(TypeError);
  });

  it('every key signs the documents of its use, verified with trusted.json, and no others', () => {
    for (const file of keyFiles) {
      const privateKey = privateKeyOf(file);
      for (const [typ, use] of Object.entries(TYP_USE)) {
        const env = signDetached({ probe: typ }, { typ, kid: file.kid, privateKey });
        const verify = () => verifyDetached(JSON.stringify({ probe: typ }), env, trusted, typ);
        if (use === file.use) expect(verify()).toEqual({ probe: typ });
        else expect(verify).toThrow('SIG_INVALID:use');
      }
    }
  });

  it('the README says the keys are for tests only', async () => {
    const readme = await read('README.md');
    expect(readme).toMatch(/TEST ONLY/);
    expect(readme).toMatch(/never ship/i);
  });
});
