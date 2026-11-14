import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { assertOutsideTx } from '@altis/db';
import { DomainError } from '@altis/shared';
import { bcryptVerify, isBcryptHash } from './bcrypt.js';

// Staff password hashing (spec §7.1): scrypt N=2^15, r=8, p=1, keylen 32, salt 16 bytes, maxmem 64 MiB, stored in
// the PHC string format
//
//   $scrypt$ln=15,r=8,p=1$<salt>$<hash>        (standard base64 without padding; N = 2^ln)
//
// The only algorithm while Node 22 is supported (Argon2id follows with a rehash at login, hence needsRehash).
//
// Passwords are NFKC-normalized and never trimmed (Review Focus 2): the same password typed composed or decomposed
// (Windows vs macOS) or with full-width characters (phone keyboards) hashes the same, and a space is part of it.
//
// Each hash costs about 32 MiB of memory and tens of ms of CPU, so a process runs at most 2 at a time and queues at
// most 8 more; when the queue is full a call fails at once with AUTH_BUSY (429) instead of waiting (P9, P11). The
// queue is per process on purpose: it bounds this process's memory, which nothing shared could do.
//
// Never call the hasher inside a database transaction (Global Constraints, S18): hash or verify first, then open the
// transaction with the result. On SQLite a transaction holds the process's only connection. hash, verify and
// verifyDummy enforce it (assertOutsideTx): inside a withTx callback they reject with a TypeError before any scrypt.
//
// Komunitas (member area): verify also takes the bcrypt hash of a member migrated from SLiMS (`$2a$`, `$2b$`, `$2y$`,
// cost 4-12, crypto/bcrypt.ts), in the same queue and with the password as typed (PHP hashed the bytes it received,
// never normalised); needsRehash is true for it, so the member's next sign-in stores a scrypt hash instead.

/** The scrypt parameters of new hashes (spec §7.1). `maxmem` also bounds what a stored string may ask for. */
export const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16, maxmem: 67108864 } as const);

/** log2(SCRYPT.N), as written in the PHC string. */
const LN = 15;

/** The parameters handed to {@link ScryptFn}. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

/** scrypt as the hasher calls it: `node:crypto`'s, promisified (a test seam in {@link createPasswordHasher}). */
export type ScryptFn = (password: Buffer, salt: Buffer, keylen: number, params: ScryptParams) => Promise<Buffer>;

export interface PasswordHasher {
  /** A PHC string of `pw` (normalized) with a fresh salt. @throws DomainError `AUTH_BUSY` when the queue is full */
  hash(pw: string): Promise<string>;
  /**
   * Whether `pw` (normalized) is the password of `phc`, with the parameters written in `phc`. A malformed string, or
   * one asking for parameters outside the accepted bounds, verifies false. @throws DomainError `AUTH_BUSY`
   */
  verify(pw: string, phc: string): Promise<boolean>;
  /**
   * The work of a verification against no stored hash, for an unknown username: same cost, same queue, always
   * false. @throws DomainError `AUTH_BUSY` exactly when verify would
   */
  verifyDummy(pw: string): Promise<false>;
  /** True unless `phc` is a well-formed string made with exactly the current parameters ({@link SCRYPT}). */
  needsRehash(phc: string): boolean;
}

export interface PasswordHasherOptions {
  /** Hashes run at once (default 2). */
  concurrency?: number;
  /** Calls waiting for a slot before AUTH_BUSY (default 8). */
  queue?: number;
  /** Test seam: replaces `node:crypto` scrypt. */
  scrypt?: ScryptFn;
}

/** NFKC, never trimmed: what is hashed, measured and compared of a password (Review Focus 2). */
export function normalizePassword(pw: string): string {
  return pw.normalize('NFKC');
}

const nodeScrypt: ScryptFn = (password, salt, keylen, params) =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, params, (error, key) => (error ? reject(error) : resolve(key)));
  });

// ---------------------------------------------------------------------------------------------------------------
// The PHC string

/** Bounds of what a stored string may ask for: generous for old or future hashes, but never a denial of service. */
const BOUNDS = { ln: [1, 20], r: [1, 32], p: [1, 16], saltBytes: [8, 64], hashBytes: [16, 64] } as const;

const PHC_STRING = /^\$scrypt\$ln=([1-9]\d?),r=([1-9]\d?),p=([1-9]\d?)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface Parsed {
  ln: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const within = (value: number, [min, max]: readonly [number, number]): boolean => value >= min && value <= max;

/** Standard base64 without padding. */
const encode = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

/** The bytes of canonical unpadded standard base64 `text`, or undefined (Buffer.from alone accepts anything). */
function decode(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, 'base64');
  return encode(bytes) === text ? bytes : undefined;
}

/** `phc` taken apart, or undefined when it is malformed or out of bounds. */
function parse(phc: string): Parsed | undefined {
  if (typeof phc !== 'string') return undefined;
  const m = PHC_STRING.exec(phc);
  if (m === null) return undefined;
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!within(ln, BOUNDS.ln) || !within(r, BOUNDS.r) || !within(p, BOUNDS.p)) return undefined;
  // What OpenSSL's scrypt allocates (128 r (N + p + 2) bytes) must fit maxmem, as it must for node:crypto anyway.
  if (128 * r * (2 ** ln + p + 2) > SCRYPT.maxmem) return undefined;
  const salt = decode(m[4]!);
  const hash = decode(m[5]!);
  if (salt === undefined || hash === undefined) return undefined;
  if (!within(salt.length, BOUNDS.saltBytes) || !within(hash.length, BOUNDS.hashBytes)) return undefined;
  return { ln, r, p, salt, hash };
}

// ---------------------------------------------------------------------------------------------------------------
// The per-process limit

/** Runs tasks at most `concurrency` at a time, FIFO, with at most `queue` waiting; beyond that, AUTH_BUSY at once. */
function createLimiter(concurrency: number, queue: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (running < concurrency) {
      running += 1;
    } else {
      if (waiting.length >= queue) {
        throw new DomainError('AUTH_BUSY', {
          detail:
            'Server sedang sibuk memeriksa kata sandi; coba lagi sebentar lagi / ' +
            'The server is busy checking passwords; try again in a moment',
          meta: { retryAfterS: 1 },
        });
      }
      // The slot is handed over by the task that frees it (`running` stays as it is).
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  };
}

function checkLimit(name: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`createPasswordHasher: ${name} must be an integer of at least ${min}, got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------

/** Why the hasher refuses to run inside a transaction (S18). */
const OUTSIDE_TX_REASON =
  'hashes with scrypt (S18): call it before opening the transaction, not inside a withTx callback (the transaction ' +
  'would hold its connection, on SQLite the only one, for the hash and its queue wait)';

/** A {@link PasswordHasher} with its own queue: create one per process (the server's services hold it). */
export function createPasswordHasher(o: PasswordHasherOptions = {}): PasswordHasher {
  const concurrency = checkLimit('concurrency', o.concurrency ?? 2, 1);
  const queue = checkLimit('queue', o.queue ?? 8, 0);
  const scrypt = o.scrypt ?? nodeScrypt;
  const limit = createLimiter(concurrency, queue);
  const current: ScryptParams = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem };
  const bytesOf = (pw: string): Buffer => Buffer.from(normalizePassword(pw), 'utf8');
  const outsideTx = (method: string): void => assertOutsideTx(`PasswordHasher.${method}`, OUTSIDE_TX_REASON);

  return {
    hash: async (pw) => {
      outsideTx('hash');
      return limit(async () => {
        const salt = randomBytes(SCRYPT.saltBytes);
        const key = await scrypt(bytesOf(pw), salt, SCRYPT.keylen, current);
        return `$scrypt$ln=${LN},r=${SCRYPT.r},p=${SCRYPT.p}$${encode(salt)}$${encode(key)}`;
      });
    },

    verify: async (pw, phc) => {
      outsideTx('verify');
      // ---- Komunitas (member area): a migrated SLiMS password ----
      if (isBcryptHash(phc)) return limit(() => bcryptVerify(pw, phc));
      const parsed = parse(phc);
      // A malformed string costs nothing: it cannot belong to anyone (the caller's dummy path covers unknown users).
      if (parsed === undefined) return false;
      return limit(async () => {
        const params: ScryptParams = { N: 2 ** parsed.ln, r: parsed.r, p: parsed.p, maxmem: SCRYPT.maxmem };
        const key = await scrypt(bytesOf(pw), parsed.salt, parsed.hash.length, params);
        return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
      });
    },

    verifyDummy: async (pw) => {
      outsideTx('verifyDummy');
      return limit(async () => {
        const key = await scrypt(bytesOf(pw), randomBytes(SCRYPT.saltBytes), SCRYPT.keylen, current);
        timingSafeEqual(key, Buffer.alloc(key.length)); // the comparison of a real verification, result unused
        return false as const;
      });
    },

    needsRehash: (phc) => {
      const parsed = parse(phc);
      return (
        parsed === undefined ||
        parsed.ln !== LN ||
        parsed.r !== SCRYPT.r ||
        parsed.p !== SCRYPT.p ||
        parsed.salt.length !== SCRYPT.saltBytes ||
        parsed.hash.length !== SCRYPT.keylen
      );
    },
  };
}
