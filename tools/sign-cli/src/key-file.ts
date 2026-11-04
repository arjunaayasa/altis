/**
 * Key files of altis-sign (spec §8.3; decision D1d-28; preflight 1D-16, S11).
 *
 * Two formats, both JSON written with mode 0600:
 * - plain `{kid, use, pkcs8}`: the PKCS#8 DER of an Ed25519 private key in base64 (1a; the dev keys of tools/keys/dev);
 * - encrypted `{kid, use, enc: {kdf: 'scrypt', N: 131072, r: 8, p: 1, salt, iv, tag, ct}}` (base64url values): the
 *   PKCS#8 DER under AES-256-GCM, keyed by scrypt from a passphrase, with the additional data `kid + ':' + use`, so a
 *   file whose kid or use was edited fails exactly like a wrong passphrase. Production keys (`root`, `rel`, `ts`) should
 *   only ever exist in this form, kept offline.
 *
 * scrypt with N = 2^17 and r = 8 needs 128·N·r = 128 MiB, above Node's default `maxmem` of 32 MiB, so it is called with
 * `maxmem` 256 MiB. The parameters are fixed: a file with others is refused before any passphrase is asked (it would
 * either be weaker or make the derivation cost what the file says).
 *
 * The passphrase comes from the caller (`loadKeyFile(file, {passphrase})`), else from ALTIS_KEY_PASSPHRASE, else from a
 * hidden prompt on the terminal; with none of them: KEY_PASSPHRASE_REQUIRED (exit 2). A wrong one:
 * KEY_PASSPHRASE_INVALID (exit 1). A passphrase typed at the terminal that opened a file is remembered for that file
 * for the rest of the process, so a release build (which reads its signing key, then signs with it through
 * `release sign`) asks once. It never leaves the process.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, scrypt, type KeyObject } from 'node:crypto';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import {
  KEY_USES,
  decodeBase64Url,
  encodeBase64Url,
  generateKeyPair,
  isKeyUse,
  isTrustedKey,
  parseStrictJson,
  rawPublicKey,
  useForTyp,
  type KeyUse,
  type TrustedKey,
} from '@altis/crypto';
import {
  CliError,
  UsageError,
  errorCode,
  hasExactKeys,
  isRecord,
  json,
  messageOf,
  parseOptions,
  readStrictJson,
  refuseOutputOverInput,
  writeTextAtomic,
  type CliIo,
} from './common.js';

/** The environment variable that may carry the passphrase of encrypted key files (automation, tests). */
export const PASSPHRASE_ENV = 'ALTIS_KEY_PASSPHRASE';

/** The key derivation of encrypted key files: fixed (see the top of this file). */
export const KEY_FILE_KDF = Object.freeze({ kdf: 'scrypt', N: 131_072, r: 8, p: 1 } as const);

/** scrypt's memory bound: 128·N·r = 128 MiB is needed, Node's default is 32 MiB (preflight 1D-16). */
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
/** An Ed25519 PKCS#8 DER is 48 bytes: a much larger ciphertext is not a key file of this tool. */
const MAX_CIPHERTEXT_BYTES = 1024;

const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRUSTED_FILE = 'trusted.json';

export type PlainKeyFile = { kid: string; use: KeyUse; pkcs8: string };

export type EncryptedKeyFile = {
  kid: string;
  use: KeyUse;
  enc: { kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string };
};

/** A private key read from a key file, with its public half (base64url raw, as in `{kid, use, pub}`). */
export type LoadedKeyFile = { kid: string; use: KeyUse; privateKey: KeyObject; pub: string };

/** Gives the passphrase of an encrypted key file. */
export type PassphraseSource = () => Promise<string>;

export interface LoadKeyFileOptions {
  /** Default: ALTIS_KEY_PASSPHRASE, else a hidden prompt on the terminal. Never called for a plain key file. */
  passphrase?: PassphraseSource;
}

interface EncryptedPart {
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

/** A key file as read, before any passphrase: who it is, and either the DER or the encrypted part. */
interface KeyRecord {
  file: string;
  kid: string;
  use: KeyUse;
  der?: Buffer;
  enc?: EncryptedPart;
}

const ENC_FIELDS = ['N', 'ct', 'iv', 'kdf', 'p', 'r', 'salt', 'tag'];

/** Reads and checks a key file of either format; nothing is decrypted yet. @throws CliError naming "key file" */
async function readKeyRecord(file: string): Promise<KeyRecord> {
  return recordOf(await readStrictJson(file, 'key file'), file);
}

/** Checks the parsed content of a key file of either format. @throws CliError naming "key file" */
function recordOf(value: unknown, file: string): KeyRecord {
  const invalid = (reason: string): CliError => new CliError(`invalid key file ${file}: ${reason}`);
  if (!isRecord(value) || !(hasExactKeys(value, ['kid', 'pkcs8', 'use']) || hasExactKeys(value, ['enc', 'kid', 'use']))) {
    throw invalid('expected exactly {kid, use, pkcs8} or {kid, use, enc}');
  }
  const { kid, use } = value;
  if (typeof kid !== 'string' || kid === '') throw invalid('kid must be a non-empty string');
  if (!isKeyUse(use)) throw invalid(`use must be one of ${KEY_USES.join(', ')}`);
  if ('pkcs8' in value) {
    const pkcs8 = value['pkcs8'];
    if (typeof pkcs8 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(pkcs8) || pkcs8.length % 4 !== 0) throw invalid('pkcs8 must be base64');
    return { file, kid, use, der: Buffer.from(pkcs8, 'base64') };
  }
  const enc = value['enc'];
  if (!isRecord(enc) || !hasExactKeys(enc, ENC_FIELDS)) throw invalid(`enc must be exactly {${ENC_FIELDS.join(', ')}}`);
  if (enc['kdf'] !== KEY_FILE_KDF.kdf || enc['N'] !== KEY_FILE_KDF.N || enc['r'] !== KEY_FILE_KDF.r || enc['p'] !== KEY_FILE_KDF.p) {
    throw invalid(`enc must use kdf "${KEY_FILE_KDF.kdf}" with N ${KEY_FILE_KDF.N}, r ${KEY_FILE_KDF.r}, p ${KEY_FILE_KDF.p}`);
  }
  const bytes = (name: string, min: number, max: number): Buffer => {
    const field = enc[name];
    const decoded = typeof field === 'string' ? decodeBase64Url(field) : null;
    if (decoded === null || decoded.length < min || decoded.length > max) {
      throw invalid(min === max ? `enc.${name} must be ${min} bytes in base64url` : `enc.${name} must be base64url`);
    }
    return decoded;
  };
  return {
    file,
    kid,
    use,
    enc: {
      salt: bytes('salt', SALT_BYTES, SALT_BYTES),
      iv: bytes('iv', IV_BYTES, IV_BYTES),
      tag: bytes('tag', TAG_BYTES, TAG_BYTES),
      ct: bytes('ct', 1, MAX_CIPHERTEXT_BYTES),
    },
  };
}

/** The AES-256 key of `passphrase` (NFC, UTF-8) and `salt`. */
function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { N, r, p } = KEY_FILE_KDF;
    scrypt(Buffer.from(passphrase.normalize('NFC'), 'utf8'), salt, AES_KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err === null ? resolve(key) : reject(err),
    );
  });
}

const additionalData = (kid: string, use: KeyUse): Buffer => Buffer.from(`${kid}:${use}`, 'utf8');

/** Encrypts the PKCS#8 DER of `privateKey` into the encrypted key file format. */
export async function encryptPrivateKey(privateKey: KeyObject, kid: string, use: KeyUse, passphrase: string): Promise<EncryptedKeyFile> {
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(kid, use));
  const ct = Buffer.concat([cipher.update(der), cipher.final()]);
  return {
    kid,
    use,
    enc: { ...KEY_FILE_KDF, salt: encodeBase64Url(salt), iv: encodeBase64Url(iv), tag: encodeBase64Url(cipher.getAuthTag()), ct: encodeBase64Url(ct) },
  };
}

/** The PKCS#8 DER of an encrypted record. @throws CliError `KEY_PASSPHRASE_INVALID` */
async function decrypt(record: KeyRecord, enc: EncryptedPart, passphrase: string): Promise<Buffer> {
  const key = await deriveKey(passphrase, enc.salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, enc.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(record.kid, record.use));
    decipher.setAuthTag(enc.tag);
    return Buffer.concat([decipher.update(enc.ct), decipher.final()]);
  } catch (err) {
    void err; // GCM says only "unable to authenticate": a wrong passphrase, or an altered file
    throw new CliError(`KEY_PASSPHRASE_INVALID (the passphrase does not open ${record.kid} in ${record.file}, or the file was altered)`);
  }
}

/** The Ed25519 private key of a DER. @throws CliError naming "key file" */
function privateKeyOf(record: KeyRecord, der: Buffer): KeyObject {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch (err) {
    throw new CliError(`invalid key file ${record.file}: the key is not a PKCS#8 private key: ${messageOf(err)}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new CliError(`invalid key file ${record.file}: the key is not an Ed25519 private key`);
  return privateKey;
}

// ---------------------------------------------------------------------------------------------------------
// Passphrases

const envPassphrase = (): string | undefined => {
  const value = process.env[PASSPHRASE_ENV];
  return value === undefined || value === '' ? undefined : value;
};

/** stdin when it is a terminal that can hide what is typed. */
function terminal(): NodeJS.ReadStream | undefined {
  const input = process.stdin;
  return input.isTTY === true && typeof input.setRawMode === 'function' ? input : undefined;
}

/** Asks `question` on stderr and reads one line from the terminal without echoing it. */
function readHidden(input: NodeJS.ReadStream, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stderr.write(question);
    const finish = (err?: Error): void => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (err === undefined) resolve(value);
      else reject(err);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new CliError('cancelled at the passphrase prompt'));
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char === '\u0015') value = '';
        else if (char >= ' ') value += char;
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function passphraseRequired(what: string): UsageError {
  return new UsageError(`KEY_PASSPHRASE_REQUIRED (${what}: set ${PASSPHRASE_ENV} or run on a terminal to type it)`);
}

/** The passphrase of a new encrypted key: ALTIS_KEY_PASSPHRASE, else typed twice on the terminal. */
async function newPassphrase(kid: string): Promise<string> {
  const env = envPassphrase();
  if (env !== undefined) return env;
  const input = terminal();
  if (input === undefined) throw passphraseRequired(`--encrypt needs a passphrase for ${kid}`);
  const first = await readHidden(input, `New passphrase for ${kid}: `);
  if (first === '') throw new UsageError('KEY_PASSPHRASE_EMPTY (an encrypted key needs a passphrase; nothing was written)');
  const second = await readHidden(input, `Repeat the passphrase for ${kid}: `);
  if (first !== second) throw new UsageError('KEY_PASSPHRASE_MISMATCH (the two passphrases differ; nothing was written)');
  return first;
}

/** Passphrases typed at the terminal that opened a key file, by absolute path (see the top of this file). */
const remembered = new Map<string, string>();

/** The DER of an encrypted record, with the passphrase of `o`, the environment, the terminal (see the top of this file). */
async function unlockEncrypted(record: KeyRecord, enc: EncryptedPart, o: LoadKeyFileOptions): Promise<Buffer> {
  if (o.passphrase !== undefined) return decrypt(record, enc, await o.passphrase());
  const env = envPassphrase();
  if (env !== undefined) return decrypt(record, enc, env);
  const at = nodePath.resolve(record.file);
  const known = remembered.get(at);
  if (known !== undefined) {
    try {
      return await decrypt(record, enc, known);
    } catch (err) {
      void err; // the file changed since: ask again
      remembered.delete(at);
    }
  }
  const input = terminal();
  if (input === undefined) throw passphraseRequired(`${record.kid} in ${record.file} is encrypted`);
  const typed = await readHidden(input, `Passphrase for ${record.kid} (${record.file}): `);
  const der = await decrypt(record, enc, typed);
  remembered.set(at, typed);
  return der;
}

async function unlock(record: KeyRecord, o: LoadKeyFileOptions): Promise<LoadedKeyFile> {
  const der = record.enc === undefined ? (record.der as Buffer) : await unlockEncrypted(record, record.enc, o);
  const privateKey = privateKeyOf(record, der);
  return { kid: record.kid, use: record.use, privateKey, pub: rawPublicKey(privateKey) };
}

/**
 * Reads a key file of either format and returns its private key and public half. An encrypted file is checked first,
 * then decrypted with the passphrase of `o.passphrase`, else ALTIS_KEY_PASSPHRASE, else the terminal.
 *
 * @throws Error (a CliError, exit 1) naming "key file" for a file that cannot be read or is not a key file;
 *   `KEY_PASSPHRASE_INVALID` for a wrong passphrase or an altered file; (a UsageError, exit 2) `KEY_PASSPHRASE_REQUIRED`
 *   when no passphrase can be had
 */
export async function loadKeyFile(file: string, o: LoadKeyFileOptions = {}): Promise<LoadedKeyFile> {
  return unlock(await readKeyRecord(file), o);
}

/** A key file read and checked for `typ` (its use), not yet decrypted: what a command may look at before a passphrase. */
export interface OpenedKeyFile {
  kid: string;
  use: KeyUse;
  encrypted: boolean;
  unlock(o?: LoadKeyFileOptions): Promise<LoadedKeyFile>;
}

/** Reads a key file that signs documents of `typ`; its use is checked before any passphrase is asked (KEY_USE:<use>). */
export async function openKeyFor(file: string, typ: string): Promise<OpenedKeyFile> {
  const record = await readKeyRecord(file);
  requireUse(record, typ);
  return { kid: record.kid, use: record.use, encrypted: record.enc !== undefined, unlock: (o = {}) => unlock(record, o) };
}

/** {@link loadKeyFile} for a key that signs documents of `typ`: its use is checked before any passphrase is asked. */
export async function loadKeyFor(file: string, typ: string, o: LoadKeyFileOptions = {}): Promise<LoadedKeyFile> {
  return (await openKeyFor(file, typ)).unlock(o);
}

/** Only a key of `typ`'s use signs it (spec §8.3). @throws CliError `KEY_USE:<use>` */
export function requireUse(key: { kid: string; use: KeyUse; file?: string }, typ: string): void {
  const required = useForTyp(typ);
  if (required === undefined) throw new TypeError(`unknown document type ${typ}`);
  if (key.use !== required) {
    const where = key.file === undefined ? '' : ` (${key.file})`;
    throw new CliError(`KEY_USE:${required} (key ${key.kid}${where} has use "${key.use}"; ${typ} must be signed by a "${required}" key)`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// keygen

async function readTrusted(file: string): Promise<TrustedKey[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw err;
  }
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (err) {
    throw new CliError(`${file} is not strict JSON: ${messageOf(err)}`);
  }
  if (!Array.isArray(value) || !value.every(isTrustedKey)) {
    throw new CliError(`${file} must be an array of {kid, use, pub}`);
  }
  return value;
}

/**
 * `keygen --use <use> --kid <kid> --out <dir> [--encrypt]`: writes `<dir>/<kid>.key.json` (never over an existing file,
 * mode 0600), plain or, with --encrypt, passphrase-encrypted (asked twice on a terminal, or ALTIS_KEY_PASSPHRASE), and
 * appends the public half to `<dir>/trusted.json`.
 */
export async function keygenCommand(args: string[], io: CliIo): Promise<void> {
  const o = parseOptions(args, { required: ['use', 'kid', 'out'], flags: ['encrypt'] });
  const { use, kid, out } = o.values as { use: string; kid: string; out: string };
  if (!isKeyUse(use)) throw new UsageError(`--use must be one of: ${KEY_USES.join(', ')}`);
  if (!KID.test(kid)) throw new UsageError('--kid must match ' + String(KID));
  if (out === '') throw new UsageError('--out must not be empty');

  const dir = nodePath.resolve(out);
  const trustedFile = nodePath.join(dir, TRUSTED_FILE);
  const keyFile = nodePath.join(dir, `${kid}.key.json`);
  const trusted = await readTrusted(trustedFile);
  if (trusted.some((key) => key.kid === kid)) throw new CliError(`kid ${kid} is already in ${trustedFile}`);
  const taken = await fsp.access(keyFile).then(
    () => true,
    (err: unknown) => errorCode(err) !== 'ENOENT',
  );
  if (taken) throw new CliError(`${keyFile} already exists; not overwriting a private key`);
  const passphrase = o.flags['encrypt'] === true ? await newPassphrase(kid) : undefined;

  const { privateKey, pub } = generateKeyPair();
  let content: PlainKeyFile | EncryptedKeyFile;
  if (passphrase === undefined) {
    content = { kid, use, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  } else {
    content = await encryptPrivateKey(privateKey, kid, use, passphrase);
    // The file, read back as the loader reads it, must open with the passphrase it was made with before it is the only
    // copy of the key.
    const check = await unlock(recordOf(parseStrictJson(json(content)), keyFile), { passphrase: async () => passphrase });
    if (check.pub !== pub) throw new CliError(`${kid}: the encrypted key does not decrypt to the generated key; nothing was written`);
  }
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.writeFile(keyFile, json(content), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (errorCode(err) === 'EEXIST') throw new CliError(`${keyFile} already exists; not overwriting a private key`);
    throw err;
  }
  await writeTextAtomic(trustedFile, json(trusted.concat([{ kid, use, pub }])));
  io.out(`wrote ${keyFile}${passphrase === undefined ? '' : ' (encrypted)'}`);
  io.out(`trusted ${kid} (${use}) in ${trustedFile}`);
}

// ---------------------------------------------------------------------------------------------------------
// pub

/** `pub --key <file> [--out <file>]`: `{kid, use, pub}` of a key file (a passphrase for an encrypted one), nothing else. */
export async function pubCommand(args: string[], io: CliIo): Promise<void> {
  const o = parseOptions(args, { required: ['key'], optional: ['out'] });
  const out = o.values['out'];
  if (out === '') throw new UsageError('--out must not be empty');
  // Before anything is read: a typo must never replace the private key with its public half (1d review L01).
  if (out !== undefined) await refuseOutputOverInput(out, [['--key', o.values['key']]]);
  const key = await loadKeyFile(o.values['key'] as string);
  const value: TrustedKey = { kid: key.kid, use: key.use, pub: key.pub };
  if (out === undefined) {
    io.out(JSON.stringify(value, null, 2));
    return;
  }
  await writeTextAtomic(nodePath.resolve(out), json(value));
  io.out(`wrote ${out}: ${key.kid} (${key.use})`);
}
