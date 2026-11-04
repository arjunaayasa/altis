/**
 * The file shape of signed documents (decision D1d-3): `{raw, env}`, the payload as text and its detached envelope
 * (the keyset document shape). `freshness.json` of the update feed is one; verification checks the envelope over `raw`
 * (`verifyDetached`), then reads the payload.
 */
import { Buffer } from 'node:buffer';
import type { Envelope } from '../envelope.js';
import { parseStrictJson } from '../strict-json.js';
import { hasExactKeys, isRecord } from './fields.js';

/** A signed document as a file holds it: the payload text and its envelope (D1d-3). */
export type SignedDoc = { raw: string; env: Envelope };

/** Largest signed document file: its UTF-8 bytes (the keyset document bound, R65c). */
export const SIGNED_DOC_MAX_BYTES = 64 * 1024;

const SIGNED_DOC_KEYS = ['raw', 'env'];
const ENVELOPE_KEYS = ['typ', 'kid', 'alg', 'sig'];

function badFile(reason: string, cause?: unknown): never {
  throw cause === undefined ? new Error('SIGNED_DOC_FORMAT:' + reason) : new Error('SIGNED_DOC_FORMAT:' + reason, { cause });
}

/**
 * Reads the text of a signed document file such as `freshness.json` (decision D1d-3): strict JSON (duplicate keys
 * refused) of at most {@link SIGNED_DOC_MAX_BYTES} UTF-8 bytes, exactly `{raw, env}` with `raw` a string and `env`
 * exactly `{typ, kid, alg: 'Ed25519', sig}` of strings. The signature is not checked here (`verifyDetached`).
 * Throws `Error('SIGNED_DOC_FORMAT:<size|json|shape>')`.
 */
export function parseSignedDocFile(text: string): SignedDoc {
  if (typeof text !== 'string') return badFile('json');
  if (text.length > SIGNED_DOC_MAX_BYTES || Buffer.byteLength(text, 'utf8') > SIGNED_DOC_MAX_BYTES) return badFile('size');
  let doc: unknown;
  try {
    doc = parseStrictJson(text);
  } catch (err) {
    return badFile('json', err);
  }
  if (!isRecord(doc) || !hasExactKeys(doc, SIGNED_DOC_KEYS)) return badFile('shape');
  const raw = doc['raw'];
  const env = doc['env'];
  if (typeof raw !== 'string' || !isRecord(env) || !hasExactKeys(env, ENVELOPE_KEYS)) return badFile('shape');
  const { typ, kid, alg, sig } = env;
  if (typeof typ !== 'string' || typeof kid !== 'string' || alg !== 'Ed25519' || typeof sig !== 'string') return badFile('shape');
  return { raw, env: { typ, kid, alg, sig } };
}
