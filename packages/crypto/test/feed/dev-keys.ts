import { Buffer } from 'node:buffer';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { KeysetDoc } from '../../src/keyset.js';
import type { TrustedKey } from '../../src/keys.js';

// The test-only keys of tools/keys/dev (their private halves are public on purpose; see its README).

const DEV_KEYS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'tools', 'keys', 'dev');

export type DevKey = { kid: string; privateKey: KeyObject };

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(DEV_KEYS_DIR, name), 'utf8')) as unknown;
}

/** A private key from tools/keys/dev (`{kid, use, pkcs8}`). */
export function devKey(kid: string): DevKey {
  const file = readJson(`${kid}.key.json`) as { kid: string; pkcs8: string };
  return { kid: file.kid, privateKey: createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }) };
}

/** tools/keys/dev/roots.json: the dev trust anchor (dev-root-1). */
export function devRoots(): TrustedKey[] {
  return readJson('roots.json') as TrustedKey[];
}

/** tools/keys/dev/trusted.json: every dev public key. */
export function devTrusted(): TrustedKey[] {
  return readJson('trusted.json') as TrustedKey[];
}

/** tools/keys/dev/keyset.json: the dev-root-1 document that trusts the five other dev keys. */
export function devKeyset(): KeysetDoc[] {
  return readJson('keyset.json') as KeysetDoc[];
}
