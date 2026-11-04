/**
 * Detached Ed25519 signature envelope (spec §8.3): `{typ, kid, alg: 'Ed25519', sig}`.
 *
 * The signature covers the UTF-8 bytes of `canonicalize({typ, kid, alg, payload})` (RFC 8785), so the
 * envelope header is bound to the payload. Bundled into the ES2017 bootloader: keep the syntax plain and
 * the module dependency-free.
 */
import { Buffer } from 'node:buffer';
import { KeyObject, sign, verify } from 'node:crypto';
import { canonicalize } from './jcs.js';
import { decodeBase64Url, encodeBase64Url, importPublicKey, isKeyUse, type KeyUse, type TrustedKey } from './keys.js';
import { parseStrictJson } from './strict-json.js';

export const SIG_ALG = 'Ed25519';

export type Envelope = { typ: string; kid: string; alg: 'Ed25519'; sig: string /* base64url */ };

export type SignOptions = { typ: string; kid: string; privateKey: KeyObject };

/**
 * Which key use may sign each document type (spec §8.3). Key sets are signed by `root` keys only (ruling R65);
 * release keys sign manifests and feeds, never key sets. The `license` and `device` typs are reserved: app.js freezes
 * this table, though the community edition never signs or reads such documents. Frozen and without a prototype, so that
 * `TYP_USE['constructor']` or `TYP_USE['__proto__']` is undefined; prefer {@link useForTyp}.
 */
export const TYP_USE: Readonly<Record<string, KeyUse>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, KeyUse>, {
    'altis-license/1': 'license',
    'altis-deactivation/1': 'license',
    'altis-heartbeat/1': 'license',
    'altis-clock/1': 'license',
    'altis-feed/1': 'release',
    'altis-release/1': 'release',
    'altis-keyset/1': 'root',
    'altis-timestamp/1': 'timestamp',
    'altis-device-cert/1': 'device',
    // Device-certificate use (reserved): room for device revocation lists the feed and release packages may carry
    // later (D1d-35), signed by a `device` key and merged without a seq rule. No verifier reads them.
    'altis-device-revocations/1': 'device',
  } satisfies Record<string, KeyUse>),
);

const ED25519_SIGNATURE_BYTES = 64;

/** Key use for a typ, or undefined for an unknown typ (including inherited names such as "toString"). */
export function useForTyp(typ: string): KeyUse | undefined {
  return typeof typ === 'string' && Object.prototype.hasOwnProperty.call(TYP_USE, typ) ? TYP_USE[typ] : undefined;
}

function signingInput(typ: string, kid: string, payload: unknown): Buffer {
  return Buffer.from(canonicalize({ typ, kid, alg: SIG_ALG, payload }), 'utf8');
}

/**
 * Rejects a payload that {@link verifyDetached} could never accept: `undefined`, or one whose canonical
 * text is not strict JSON within {@link parseStrictJson}'s limits (nesting deeper than 64). Signing it
 * would only produce an envelope nobody can verify.
 */
function assertVerifiablePayload(payload: unknown): void {
  const refuse = (cause?: unknown): Error =>
    cause === undefined ? new Error('SIGN_INVALID_PAYLOAD') : new Error('SIGN_INVALID_PAYLOAD', { cause });
  if (payload === undefined) throw refuse();
  let text: string;
  try {
    text = canonicalize(payload);
  } catch (err) {
    // A stack overflow means absurd nesting; every other canonicalize error names the offending value.
    if (err instanceof RangeError) throw refuse(err);
    throw err;
  }
  try {
    parseStrictJson(text);
  } catch (err) {
    throw refuse(err);
  }
}

/**
 * Signs `payload` (any value `canonicalize` accepts). `typ` is not restricted to {@link TYP_USE}; the
 * verifier decides which typs it accepts. Throws TypeError for an empty typ/kid or a key that is not an
 * Ed25519 private key, the `canonicalize` error for a payload outside the JSON data model, and
 * `Error('SIGN_INVALID_PAYLOAD')` for `undefined` or a payload that `verifyDetached` would refuse to parse
 * (nesting deeper than 64 levels; `cause` is set when there is one).
 */
export function signDetached(payload: unknown, o: SignOptions): Envelope {
  const { typ, kid, privateKey } = o;
  if (typeof typ !== 'string' || typ === '') throw new TypeError('signDetached: typ must be a non-empty string');
  if (typeof kid !== 'string' || kid === '') throw new TypeError('signDetached: kid must be a non-empty string');
  const isEd25519Private =
    privateKey instanceof KeyObject && privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519';
  if (!isEd25519Private) throw new TypeError('signDetached: privateKey must be an Ed25519 private KeyObject');
  assertVerifiablePayload(payload);
  const sig = sign(null, signingInput(typ, kid, payload), privateKey);
  return { typ, kid, alg: SIG_ALG, sig: encodeBase64Url(sig) };
}

function invalid(reason: string, cause?: unknown): Error {
  return cause === undefined ? new Error('SIG_INVALID:' + reason) : new Error('SIG_INVALID:' + reason, { cause });
}

function isEnvelopeShape(env: unknown): env is { typ: string; kid: string; alg: string; sig: string } {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return false;
  const keys = Object.keys(env).sort();
  if (keys.length !== 4 || keys.join(',') !== 'alg,kid,sig,typ') return false;
  const e = env as Record<string, unknown>;
  return (
    typeof e['typ'] === 'string' &&
    typeof e['kid'] === 'string' &&
    typeof e['alg'] === 'string' &&
    typeof e['sig'] === 'string'
  );
}

/**
 * Verifies a detached signature and returns the parsed payload.
 *
 * `rawPayload` is parsed with {@link parseStrictJson} (duplicate keys, excess depth and trailing garbage
 * are refused before any signature check) and the signature is checked over its canonical form, so any
 * semantically equal JSON text verifies. Throws `Error('SIG_INVALID:<reason>')`, checked in this order:
 * - `envelope`: env is not exactly `{typ, kid, alg, sig}` with string values;
 * - `alg`: alg is not `Ed25519`;
 * - `typ`: env.typ differs from `expectTyp`, or `expectTyp` has no key use in {@link TYP_USE};
 * - `kid`: no trusted key has env.kid, or several trusted keys with that kid disagree;
 * - `use`: the trusted key's use is not the one `TYP_USE` requires for the typ;
 * - `key`: the trusted key has an unknown use or a pub that is not 32 bytes of base64url;
 * - `payload`: rawPayload is not a string, is not strict JSON, or holds a lone surrogate (`cause` set);
 * - `signature`: sig is not 64 bytes of base64url, or the signature does not verify.
 */
export function verifyDetached(rawPayload: string, env: Envelope, trusted: TrustedKey[], expectTyp: string): unknown {
  if (!isEnvelopeShape(env)) throw invalid('envelope');
  if (env.alg !== SIG_ALG) throw invalid('alg');
  const use = useForTyp(expectTyp);
  if (env.typ !== expectTyp || use === undefined) throw invalid('typ');

  let key: TrustedKey | undefined;
  for (const candidate of trusted) {
    if (candidate === null || typeof candidate !== 'object' || candidate.kid !== env.kid) continue;
    if (key === undefined) key = candidate;
    else if (candidate.use !== key.use || candidate.pub !== key.pub) throw invalid('kid');
  }
  if (key === undefined) throw invalid('kid');
  if (!isKeyUse(key.use)) throw invalid('key');
  if (key.use !== use) throw invalid('use');
  let publicKey: KeyObject;
  try {
    publicKey = importPublicKey(key.pub);
  } catch (err) {
    throw invalid('key', err);
  }

  let payload: unknown;
  let data: Buffer;
  try {
    payload = parseStrictJson(rawPayload);
    data = signingInput(env.typ, env.kid, payload);
  } catch (err) {
    throw invalid('payload', err);
  }

  const sig = decodeBase64Url(env.sig);
  if (sig === null || sig.length !== ED25519_SIGNATURE_BYTES) throw invalid('signature');
  let ok: boolean;
  try {
    ok = verify(null, data, publicKey, sig);
  } catch (err) {
    throw invalid('signature', err);
  }
  if (!ok) throw invalid('signature');
  return payload;
}
