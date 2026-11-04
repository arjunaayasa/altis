import { scryptSync } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { SCRYPT, createPasswordHasher, normalizePassword, type ScryptFn } from '../src/crypto/password.js';

// Password hashing (spec §7.1, Global Constraints): scrypt N=2^15, r=8, p=1, keylen 32, salt 16 B, maxmem 64 MiB, in
// PHC format; NFKC-normalized and never trimmed (Review Focus 2); at most 2 hashes per process at a time with a
// queue of 8, a full queue failing at once with AUTH_BUSY (429).

const PHC = /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

/** Standard base64 without padding, as in the PHC string format. */
const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

/** A PHC string made here with node:crypto directly, independently of password.ts. */
function phcOf(password: string, o: { ln: number; r: number; p: number; salt?: Buffer; keylen?: number }): string {
  const salt = o.salt ?? Buffer.from('0123456789abcdef');
  const hash = scryptSync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, o.keylen ?? 32, {
    N: 2 ** o.ln,
    r: o.r,
    p: o.p,
    maxmem: SCRYPT.maxmem,
  });
  return `$scrypt$ln=${o.ln},r=${o.r},p=${o.p}$${b64(salt)}$${b64(hash)}`;
}

async function domainCode(p: Promise<unknown>): Promise<{ code: string; meta: unknown }> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isDomainError(error)) throw new Error(`expected a DomainError, got ${String(error)}`);
  return { code: error.code, meta: error.meta };
}

/** An scrypt seam whose calls stay pending until the test releases them. */
function gatedScrypt() {
  const waiting: Array<() => void> = [];
  const state = {
    calls: [] as Array<{ password: string; salt: Buffer; keylen: number; options: unknown }>,
    running: 0,
    maxRunning: 0,
  };
  const fn: ScryptFn = async (password, salt, keylen, options) => {
    state.calls.push({ password: password.toString('utf8'), salt, keylen, options });
    state.running += 1;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    await new Promise<void>((resolve) => waiting.push(resolve));
    state.running -= 1;
    return Buffer.alloc(keylen, 7);
  };
  /** Releases the oldest pending call. */
  const releaseOne = async (): Promise<void> => {
    const next = waiting.shift();
    if (next === undefined) throw new Error('no pending scrypt call');
    next();
    await tick();
  };
  /** Releases pending calls until none is left (queued calls start as slots free up). */
  const releaseAll = async (): Promise<void> => {
    await tick();
    while (waiting.length > 0) await releaseOne();
  };
  return { fn, state, waiting, releaseOne, releaseAll };
}

describe('SCRYPT and normalizePassword', () => {
  it('holds the parameters of spec §7.1', () => {
    expect(SCRYPT).toEqual({ N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16, maxmem: 67108864 });
    expect(Object.isFrozen(SCRYPT)).toBe(true);
  });

  it('applies NFKC and never trims', () => {
    expect(normalizePassword('Café-kopi')).toBe('Café-kopi'); // decomposed (macOS) -> composed
    expect(normalizePassword('ｐａｓｓ')).toBe('pass'); // full-width (phone keyboards)
    expect(normalizePassword('  dua spasi  ')).toBe('  dua spasi  ');
    expect(normalizePassword('\ttab\n')).toBe('\ttab\n');
  });
});

describe('createPasswordHasher (real scrypt)', () => {
  const hasher = createPasswordHasher();

  it('hashes to $scrypt$ln=15,r=8,p=1$<salt>$<hash> (standard base64, no padding), with a fresh salt each time', async () => {
    const [a, b] = await Promise.all([hasher.hash('kuda-lumping-biru'), hasher.hash('kuda-lumping-biru')]);
    expect(a).toMatch(PHC);
    expect(b).toMatch(PHC);
    expect(a).not.toBe(b);
    expect(hasher.needsRehash(a)).toBe(false);
  });

  it('verifies the right password, and refuses a wrong one and one with a leading or trailing space', async () => {
    const phc = await hasher.hash('kuda-lumping-biru');
    expect(await hasher.verify('kuda-lumping-biru', phc)).toBe(true);
    expect(await hasher.verify('kuda-lumping-hijau', phc)).toBe(false);
    expect(await hasher.verify(' kuda-lumping-biru', phc)).toBe(false);
    expect(await hasher.verify('kuda-lumping-biru ', phc)).toBe(false);
    expect(await hasher.verify('Kuda-lumping-biru', phc)).toBe(false);
  });

  it('matches a password typed composed and decomposed, either way round (Review Focus 2: macOS vs Windows)', async () => {
    const composed = 'Café-kopi-2026';
    const decomposed = 'Café-kopi-2026';
    expect(composed).not.toBe(decomposed);
    expect(await hasher.verify(decomposed, await hasher.hash(composed))).toBe(true);
    expect(await hasher.verify(composed, await hasher.hash(decomposed))).toBe(true);
    expect(await hasher.verify('Ｃafé-kopi-2026', await hasher.hash(composed))).toBe(true); // full-width C
  });

  it('verifies every vector of test/fixtures/password-vectors.json, made on Node 26, on the running Node (§7.1)', async () => {
    const file = path.join(import.meta.dirname, 'fixtures', 'password-vectors.json');
    const vectors = JSON.parse(await fsp.readFile(file, 'utf8')) as Array<{ password: string; phc: string }>;
    expect(vectors).toHaveLength(3);
    expect(vectors.some((v) => v.password !== v.password.normalize('NFC'))).toBe(true); // one is decomposed
    for (const v of vectors) {
      expect(v.phc).toMatch(PHC);
      expect(await hasher.verify(v.password, v.phc), JSON.stringify(v.password)).toBe(true);
      expect(await hasher.verify(`${v.password}x`, v.phc)).toBe(false);
    }
    const decomposed = vectors.find((v) => v.password !== v.password.normalize('NFC'))!;
    expect(await hasher.verify(decomposed.password.normalize('NFC'), decomposed.phc)).toBe(true);
  });

  it('honours the parameters written in the string: ln=14 verifies, and needs a rehash', async () => {
    const phc = phcOf('kuda-lumping-biru', { ln: 14, r: 8, p: 1 });
    expect(phc).toMatch(/^\$scrypt\$ln=14,r=8,p=1\$/);
    expect(await hasher.verify('kuda-lumping-biru', phc)).toBe(true);
    expect(await hasher.verify('kuda-lumping-hijau', phc)).toBe(false);
    expect(hasher.needsRehash(phc)).toBe(true);
    // Other r, p, salt and key lengths are honoured too.
    const other = phcOf('kuda-lumping-biru', { ln: 12, r: 4, p: 2, salt: Buffer.alloc(24, 3), keylen: 64 });
    expect(await hasher.verify('kuda-lumping-biru', other)).toBe(true);
    expect(hasher.needsRehash(other)).toBe(true);
    // The current parameters with another salt or key length still need a rehash.
    expect(hasher.needsRehash(phcOf('x', { ln: 15, r: 8, p: 1, salt: Buffer.alloc(32, 1) }))).toBe(true);
    expect(hasher.needsRehash(phcOf('x', { ln: 15, r: 8, p: 1, keylen: 64 }))).toBe(true);
    expect(hasher.needsRehash(phcOf('x', { ln: 15, r: 8, p: 1 }))).toBe(false);
  });

  it('verifies a malformed or tampered string false without throwing, and says it needs a rehash', async () => {
    const good = phcOf('kuda-lumping-biru', { ln: 10, r: 8, p: 1 });
    const [, , params, salt, hash] = good.split('$') as [string, string, string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const malformed = [
      '$scrypt$garbage',
      '',
      'kuda-lumping-biru',
      '$scrypt$',
      `$argon2id$${params}$${salt}$${hash}`,
      `$scrypt$${params}$${salt}`,
      `$scrypt$${params}$${salt}$${hash}$`,
      `$scrypt$${params}$${salt}$${hash}=`, // padding
      `$scrypt$${params}$${salt}$${hash.slice(0, -1)}!`, // not base64
      `$scrypt$${params}$$${hash}`, // empty salt
      `$scrypt$${params}$${salt}$`, // empty hash
      `$scrypt$${params}$${salt}$${hash.slice(0, 20)}`, // hash too short
      `$scrypt$${params}$${salt.slice(0, 5)}$${hash}`, // salt too short
      `$scrypt$${params}$${salt.slice(0, -1)}B$${hash}`, // non-canonical base64 (trailing bits set)
      `$scrypt$ln=10,r=8$${salt}$${hash}`,
      `$scrypt$r=8,ln=10,p=1$${salt}$${hash}`,
      `$scrypt$ln=010,r=8,p=1$${salt}$${hash}`,
      `$scrypt$ln=0,r=8,p=1$${salt}$${hash}`,
      `$scrypt$ln=99,r=8,p=1$${salt}$${hash}`, // far beyond maxmem
      `$scrypt$ln=16,r=8,p=1$${salt}$${hash}`, // 128 * 2^16 * 8 = 64 MiB: over maxmem
      `$scrypt$ln=10,r=0,p=1$${salt}$${hash}`,
      `$scrypt$ln=10,r=8,p=0$${salt}$${hash}`,
      `$scrypt$ln=10,r=8,p=99$${salt}$${hash}`,
      `$scrypt$ln=10,r=8,p=1,x=1$${salt}$${hash}`,
      ` ${good}`,
      `${good}\n`,
    ];
    for (const phc of malformed) {
      expect(await hasher.verify('kuda-lumping-biru', phc), JSON.stringify(phc)).toBe(false);
      expect(hasher.needsRehash(phc), JSON.stringify(phc)).toBe(true);
    }
    expect(await hasher.verify('kuda-lumping-biru', good)).toBe(true);
    expect(await hasher.verify('kuda-lumping-biru', `$scrypt$${params}$${salt}$${flip(hash)}`)).toBe(false);
    expect(await hasher.verify('kuda-lumping-biru', `$scrypt$${params}$${flip(salt)}$${hash}`)).toBe(false);
  });

  it('verifyDummy resolves false', async () => {
    await expect(hasher.verifyDummy('kuda-lumping-biru')).resolves.toBe(false);
  });
});

describe('createPasswordHasher (scrypt seam)', () => {
  it('runs scrypt on the NFKC-normalized UTF-8 bytes with the parameters of SCRYPT and a 16-byte salt', async () => {
    const calls: Array<{ password: string; salt: Buffer; keylen: number; options: unknown }> = [];
    const scrypt: ScryptFn = async (password, salt, keylen, options) => {
      calls.push({ password: password.toString('utf8'), salt, keylen, options });
      return Buffer.alloc(keylen, 9);
    };
    const hasher = createPasswordHasher({ scrypt });
    const phc = await hasher.hash('Café ');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.password).toBe('Café ');
    expect(calls[0]!.salt).toHaveLength(16);
    expect(calls[0]!.keylen).toBe(32);
    expect(calls[0]!.options).toEqual({ N: 32768, r: 8, p: 1, maxmem: 67108864 });
    expect(phc).toBe(`$scrypt$ln=15,r=8,p=1$${b64(calls[0]!.salt)}$${b64(Buffer.alloc(32, 9))}`);
    expect(await hasher.verify('Café ', phc)).toBe(true);
    expect(calls[1]!.salt.equals(calls[0]!.salt)).toBe(true);
  });

  it('verifyDummy calls the seam once, with the cost of a real verification, and resolves false', async () => {
    const calls: Array<{ keylen: number; salt: Buffer; options: unknown }> = [];
    const scrypt: ScryptFn = async (_password, salt, keylen, options) => {
      calls.push({ keylen, salt, options });
      return Buffer.alloc(keylen);
    };
    const hasher = createPasswordHasher({ scrypt });
    await expect(hasher.verifyDummy('siapa saja')).resolves.toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keylen).toBe(32);
    expect(calls[0]!.salt).toHaveLength(16);
    expect(calls[0]!.options).toEqual({ N: 32768, r: 8, p: 1, maxmem: 67108864 });
  });

  it('runs at most 2 at a time; with 8 queued the 11th call fails at once with AUTH_BUSY, and the 10 others resolve', async () => {
    const gate = gatedScrypt();
    const hasher = createPasswordHasher({ scrypt: gate.fn });
    const settled: boolean[] = [];
    const first10 = Array.from({ length: 10 }, (_, i) => {
      const p = hasher.hash(`kata-sandi-${i}`);
      p.then(
        () => (settled[i] = true),
        () => (settled[i] = true),
      );
      return p;
    });
    await tick();
    expect(gate.state.running).toBe(2);
    const busy = await domainCode(hasher.hash('kata-sandi-10'));
    expect(busy).toEqual({ code: 'AUTH_BUSY', meta: { retryAfterS: 1 } });
    expect(gate.state.running).toBe(2); // the refusal did not wait for a slot, nor take one
    expect(settled.filter(Boolean)).toHaveLength(0);
    await gate.releaseAll();
    const phcs = await Promise.all(first10);
    expect(phcs).toHaveLength(10);
    for (const phc of phcs) expect(phc).toMatch(PHC);
    expect(gate.state.maxRunning).toBe(2);
    expect(gate.state.calls).toHaveLength(10);
  });

  it('starts queued calls in arrival order (FIFO)', async () => {
    const gate = gatedScrypt();
    const hasher = createPasswordHasher({ scrypt: gate.fn });
    const all = Array.from({ length: 6 }, (_, i) => hasher.hash(`urutan-${i}`));
    await tick();
    expect(gate.state.calls.map((c) => c.password)).toEqual(['urutan-0', 'urutan-1']);
    await gate.releaseOne();
    expect(gate.state.calls.map((c) => c.password)).toEqual(['urutan-0', 'urutan-1', 'urutan-2']);
    await gate.releaseAll();
    await Promise.all(all);
    expect(gate.state.calls.map((c) => c.password)).toEqual(['urutan-0', 'urutan-1', 'urutan-2', 'urutan-3', 'urutan-4', 'urutan-5']);
  });

  it('shares one queue between hash, verify and verifyDummy (an unknown username is refused the same way)', async () => {
    const gate = gatedScrypt();
    const hasher = createPasswordHasher({ scrypt: gate.fn, concurrency: 1, queue: 2 });
    const phc = `$scrypt$ln=15,r=8,p=1$${b64(Buffer.alloc(16, 1))}$${b64(Buffer.alloc(32, 7))}`;
    const running = [hasher.hash('a-a-a-a-a-a'), hasher.verify('b-b-b-b-b-b', phc), hasher.verifyDummy('c-c-c-c-c-c')];
    await tick();
    expect(gate.state.running).toBe(1);
    expect((await domainCode(hasher.verifyDummy('d-d-d-d-d-d'))).code).toBe('AUTH_BUSY');
    expect((await domainCode(hasher.verify('e-e-e-e-e-e', phc))).code).toBe('AUTH_BUSY');
    expect((await domainCode(hasher.hash('f-f-f-f-f-f'))).code).toBe('AUTH_BUSY');
    await gate.releaseAll();
    const [hashed, verified, dummy] = await Promise.all(running);
    expect(hashed).toMatch(PHC);
    expect(verified).toBe(true);
    expect(dummy).toBe(false);
  });

  it('frees the slot when scrypt fails, and passes the failure on', async () => {
    let fail = true;
    const scrypt: ScryptFn = async (_password, _salt, keylen) => {
      if (fail) throw new Error('scrypt exploded');
      return Buffer.alloc(keylen, 1);
    };
    const hasher = createPasswordHasher({ scrypt, concurrency: 1, queue: 0 });
    await expect(hasher.hash('kuda-lumping-biru')).rejects.toThrow('scrypt exploded');
    await expect(hasher.hash('kuda-lumping-biru')).rejects.toThrow('scrypt exploded');
    fail = false;
    await expect(hasher.hash('kuda-lumping-biru')).resolves.toMatch(PHC);
  });

  it('refuses nonsensical limits', () => {
    for (const o of [{ concurrency: 0 }, { concurrency: 1.5 }, { queue: -1 }, { queue: Number.NaN }]) {
      expect(() => createPasswordHasher(o), JSON.stringify(o)).toThrow(TypeError);
    }
    expect(() => createPasswordHasher({ concurrency: 1, queue: 0 })).not.toThrow();
  });
});
