/**
 * Ed25519 key helpers (node:crypto only) and the trusted-key shape (spec §8.3).
 *
 * Public keys travel as base64url (no padding) of the raw 32-byte key. Bundled into the ES2017
 * bootloader: keep the syntax plain and the module dependency-free.
 */
import { Buffer } from 'node:buffer';
import { KeyObject, createPublicKey, generateKeyPairSync } from 'node:crypto';

/**
 * Key uses (spec §8.3). `root` keys are the trust anchors a build embeds and the only signers of `altis-keyset/1`
 * documents (ruling R65); every other use is trusted through those documents. `license` and `device` are reserved uses
 * that the community edition never signs or verifies with; the list stays whole because app.js freezes it (a keyset
 * naming an unknown use fails `isKeyset`).
 */
export type KeyUse = 'root' | 'license' | 'release' | 'timestamp' | 'device';

export const KEY_USES: readonly KeyUse[] = Object.freeze(['root', 'license', 'release', 'timestamp', 'device'] as KeyUse[]);

export type TrustedKey = { kid: string; use: KeyUse; pub: string /* base64url raw 32 bytes */ };

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PUBLIC_KEY_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/**
 * Strict base64url decoding: alphabet `A-Z a-z 0-9 - _`, no padding, no whitespace, and canonical (unused
 * trailing bits must be zero). Returns null for anything else.
 */
export function decodeBase64Url(text: string): Buffer | null {
  if (typeof text !== 'string' || !BASE64URL.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

function isEd25519(key: unknown): key is KeyObject {
  return key instanceof KeyObject && key.asymmetricKeyType === 'ed25519';
}

/** Raw public key (base64url) of an Ed25519 private or public KeyObject. */
export function rawPublicKey(key: KeyObject): string {
  if (!isEd25519(key)) throw new TypeError('rawPublicKey: expected an Ed25519 key');
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const prefixLength = ED25519_SPKI_PREFIX.length;
  const wellFormed =
    der.length === prefixLength + ED25519_PUBLIC_KEY_BYTES && der.subarray(0, prefixLength).equals(ED25519_SPKI_PREFIX);
  if (!wellFormed) throw new TypeError('rawPublicKey: unexpected SPKI encoding');
  return encodeBase64Url(der.subarray(prefixLength));
}

/** Public KeyObject for a raw base64url Ed25519 key. Throws TypeError unless `pub` is 32 canonical bytes. */
export function importPublicKey(pub: string): KeyObject {
  const raw = decodeBase64Url(pub);
  if (raw === null || raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new TypeError('importPublicKey: pub must be 32 bytes of unpadded base64url');
  }
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function generateKeyPair(): { privateKey: KeyObject; pub: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: rawPublicKey(privateKey) };
}

export function isKeyUse(value: unknown): value is KeyUse {
  return typeof value === 'string' && KEY_USES.indexOf(value as KeyUse) !== -1;
}

/** Exactly `{kid, use, pub}`: non-empty kid, a known use, and a pub of 32 canonical base64url bytes. */
export function isTrustedKey(value: unknown): value is TrustedKey {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  const k = value as Record<string, unknown>;
  if (!hasOwn(k, 'kid') || !hasOwn(k, 'use') || !hasOwn(k, 'pub')) return false;
  if (typeof k['kid'] !== 'string' || k['kid'] === '' || !isKeyUse(k['use'])) return false;
  const raw = typeof k['pub'] === 'string' ? decodeBase64Url(k['pub']) : null;
  return raw !== null && raw.length === ED25519_PUBLIC_KEY_BYTES;
}

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}
