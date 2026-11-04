import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signDetached, verifyDetached, type Envelope } from '../src/envelope.js';
import { generateKeyPair, type KeyUse, type TrustedKey } from '../src/keys.js';
import {
  KEYSET_MAX_DOCS,
  KEYSET_MAX_DOC_BYTES,
  parseKeysetDocs,
  resolveKeysetSources,
  resolveTrustedKeys,
  type Keyset,
  type ResolvedKeys,
} from '../src/keyset.js';
import { prng } from './support.js';

// Two-tier key sets (spec §8.3, ruling R65): the embedded `root` keys are the only anchors and the only signers of
// altis-keyset/1 documents; resolution depends neither on the order of the documents nor on their seq.

type TestKey = { privateKey: KeyObject; trusted: TrustedKey };
type Doc = { raw: string; env: Envelope };

function makeKey(kid: string, use: KeyUse): TestKey {
  const { privateKey, pub } = generateKeyPair();
  return { privateKey, trusted: { kid, use, pub } };
}

const rootA = makeKey('root-a', 'root');
const rootB = makeKey('root-b', 'root'); // the offline spare
const ROOTS = [rootA.trusted, rootB.trusted];
const relA = makeKey('rel-a', 'release');
const relB = makeKey('rel-b', 'release');
const relC = makeKey('rel-c', 'release');
const licA = makeKey('lic-a', 'license');
const tsA = makeKey('ts-a', 'timestamp');
const dcaA = makeKey('dca-a', 'device');

/** A keyset document signed as `altis-keyset/1` (or `typ`) by `signer`; raw is pretty-printed JSON. */
function keysetDoc(doc: Keyset | Record<string, unknown>, signer: TestKey = rootA, typ = 'altis-keyset/1'): Doc {
  return {
    raw: JSON.stringify(doc, null, 2),
    env: signDetached(doc, { typ, kid: signer.trusted.kid, privateKey: signer.privateKey }),
  };
}

const kids = (keys: TrustedKey[]): string[] => keys.map((k) => k.kid);

/** What a resolution decides, without the input indexes: comparable across orderings of the same documents. */
function outcome(resolved: ResolvedKeys, docs: Doc[]): { keys: TrustedKey[]; maxSeq: number; conflicts: string[]; rejected: string[] } {
  return {
    keys: resolved.keys,
    maxSeq: resolved.maxSeq,
    conflicts: resolved.conflicts,
    rejected: resolved.rejected.map((r) => `${docs[r.index]!.env.sig} ${r.reason}`).sort(),
  };
}

function permutations<T>(items: T[]): T[][] {
  return items.length <= 1
    ? [items]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [item, ...p]));
}

/** Resolves every ordering of `docs` and checks they all agree; returns the outcome of the given order. */
function resolveInEveryOrder(roots: TrustedKey[], docs: Doc[]): ReturnType<typeof outcome> {
  const expected = outcome(resolveTrustedKeys(roots, docs), docs);
  for (const ordering of permutations(docs)) {
    expect(outcome(resolveTrustedKeys(roots, ordering), ordering)).toEqual(expected);
  }
  return expected;
}

const addAll = keysetDoc({ seq: 1, keys: [relA.trusted, relB.trusted, licA.trusted, tsA.trusted, dcaA.trusted], revokedKids: [] });

describe('resolveTrustedKeys: the roots are the only anchors', () => {
  it('without documents returns the roots, as fresh objects', () => {
    const resolved = resolveTrustedKeys(ROOTS, []);
    expect(resolved).toEqual({ keys: ROOTS, maxSeq: 0, rejected: [], conflicts: [] });
    expect(resolved.keys[0]).not.toBe(ROOTS[0]);
  });

  it('a root-signed document adds keys of every other use: the roots first, then the added keys by kid', () => {
    const resolved = resolveTrustedKeys(ROOTS, [addAll]);
    expect(kids(resolved.keys)).toEqual(['root-a', 'root-b', 'dca-a', 'lic-a', 'rel-a', 'rel-b', 'ts-a']);
    expect(resolved.keys).toContainEqual(licA.trusted);
    expect(resolved).toMatchObject({ maxSeq: 1, rejected: [], conflicts: [] });
  });

  it('the offline spare root signs just as well', () => {
    const bySpare = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] }, rootB);
    expect(kids(resolveTrustedKeys(ROOTS, [bySpare]).keys)).toEqual(['root-a', 'root-b', 'rel-c']);
  });

  it('a document signed by a root that is not embedded counts for nothing', () => {
    const byOther = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] }, makeKey('root-x', 'root'));
    expect(resolveTrustedKeys(ROOTS, [byOther])).toEqual({ keys: ROOTS, maxSeq: 0, rejected: [{ index: 0, reason: 'SIG_INVALID:kid' }], conflicts: [] });
  });

  it('a compromised release key cannot sign a keyset document that counts, whatever its seq or content', () => {
    // rel-b is trusted (added by a root document) and leaks.
    const contents: Keyset[] = [
      { seq: 1, keys: [], revokedKids: ['rel-a'] }, // revocation-only, low seq
      { seq: 2, keys: [], revokedKids: ['rel-a'] },
      { seq: Number.MAX_SAFE_INTEGER, keys: [], revokedKids: ['rel-a', 'lic-a'] },
      { seq: 1, keys: [relC.trusted], revokedKids: [] },
      { seq: Number.MAX_SAFE_INTEGER, keys: [relC.trusted], revokedKids: ['rel-a'] },
      { seq: 3, keys: [relB.trusted], revokedKids: [] }, // only re-lists keys that are already trusted
    ];
    const honest = resolveTrustedKeys(ROOTS, [addAll]);
    for (const content of contents) {
      for (const signer of [relB, relA, licA, tsA, dcaA]) {
        const forged = keysetDoc(content, signer);
        for (const docs of [[addAll, forged], [forged, addAll]]) {
          const resolved = resolveTrustedKeys(ROOTS, docs);
          expect(resolved.keys).toEqual(honest.keys);
          expect(resolved.maxSeq).toBe(1);
          expect(resolved.rejected).toEqual([{ index: docs.indexOf(forged), reason: 'SIG_INVALID:kid' }]);
        }
      }
    }
  });

  it('a root key signing under another typ, or another typ under a root key, is refused', () => {
    const wrongTyp = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] }, rootA, 'altis-release/1');
    expect(resolveTrustedKeys(ROOTS, [wrongTyp]).rejected).toEqual([{ index: 0, reason: 'SIG_INVALID:typ' }]);
    const releaseByRoot = signDetached({ version: '1.0.0' }, { typ: 'altis-release/1', kid: 'root-a', privateKey: rootA.privateKey });
    expect(() => verifyDetached('{"version":"1.0.0"}', releaseByRoot, resolveTrustedKeys(ROOTS, []).keys, 'altis-release/1')).toThrow(
      'SIG_INVALID:use',
    );
  });

  it('the resolved keys verify documents signed by added keys, and no longer by revoked ones', () => {
    const revokeA = keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-a'] });
    const { keys: trusted } = resolveTrustedKeys(ROOTS, [addAll, revokeA]);
    const payload = { version: '1.0.0' };
    const byB = signDetached(payload, { typ: 'altis-release/1', kid: 'rel-b', privateKey: relB.privateKey });
    const byA = signDetached(payload, { typ: 'altis-release/1', kid: 'rel-a', privateKey: relA.privateKey });
    expect(verifyDetached(JSON.stringify(payload), byB, trusted, 'altis-release/1')).toEqual(payload);
    expect(() => verifyDetached(JSON.stringify(payload), byA, trusted, 'altis-release/1')).toThrow('SIG_INVALID:kid');
  });
});

describe('resolveTrustedKeys: order and seq never matter', () => {
  const revokeA = keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-a'] });
  const addC = keysetDoc({ seq: 3, keys: [relC.trusted], revokedKids: [] }, rootB);
  const conflictC = keysetDoc({ seq: 4, keys: [{ ...relC.trusted, pub: generateKeyPair().pub }], revokedKids: [] });
  const forged = keysetDoc({ seq: 9, keys: [], revokedKids: ['rel-b'] }, relA);
  const bad = keysetDoc({ seq: 5, keys: [], revokedKids: [], note: 'x' });

  it('every ordering of adds, revocations, a conflict and rejected documents gives the same result', () => {
    const result = resolveInEveryOrder(ROOTS, [addAll, revokeA, addC, conflictC]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b', 'dca-a', 'lic-a', 'rel-b', 'ts-a']);
    expect(result.conflicts).toEqual(['rel-c']);
    expect(result.maxSeq).toBe(4);
    expect(result.rejected).toEqual([]);

    const withRejects = resolveInEveryOrder(ROOTS, [addAll, forged, revokeA, bad]);
    expect(kids(withRejects.keys)).toEqual(['root-a', 'root-b', 'dca-a', 'lic-a', 'rel-b', 'ts-a']);
    expect(withRejects.maxSeq).toBe(2);
    expect(withRejects.rejected).toHaveLength(2);
  });

  it('property: random sets of 3-4 documents resolve the same in every order', () => {
    const extra = [makeKey('rel-x', 'release'), makeKey('rel-y', 'release'), makeKey('lic-x', 'license')];
    const pool: Doc[] = [
      addAll,
      revokeA,
      addC,
      conflictC,
      forged,
      bad,
      keysetDoc({ seq: 1, keys: [extra[0]!.trusted], revokedKids: ['rel-y'] }),
      keysetDoc({ seq: 7, keys: [extra[1]!.trusted, extra[2]!.trusted], revokedKids: [] }, rootB),
      keysetDoc({ seq: 2, keys: [{ ...extra[2]!.trusted, use: 'timestamp' }], revokedKids: ['ts-a'] }),
      keysetDoc({ seq: 1, keys: [], revokedKids: ['root-a'] }), // touches a root: rejected
      keysetDoc({ seq: 6, keys: [relA.trusted, relA.trusted], revokedKids: [] }),
    ];
    const rand = prng(65);
    for (let round = 0; round < 40; round++) {
      const size = 3 + Math.floor(rand() * 2);
      const picked: Doc[] = [];
      while (picked.length < size) {
        const doc = pool[Math.floor(rand() * pool.length)]!;
        if (!picked.includes(doc)) picked.push(doc);
      }
      resolveInEveryOrder(ROOTS, picked);
    }
  });

  it('seq decides nothing: a revocation with a lower seq than the addition still revokes', () => {
    const addLate = keysetDoc({ seq: 50, keys: [relC.trusted], revokedKids: [] });
    const revokeEarly = keysetDoc({ seq: 1, keys: [], revokedKids: ['rel-c'] });
    const result = resolveInEveryOrder(ROOTS, [addLate, revokeEarly]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b']);
    expect(result.maxSeq).toBe(50);
  });

  it('documents with the same seq all count', () => {
    const one = keysetDoc({ seq: 1, keys: [relB.trusted], revokedKids: [] });
    const two = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] });
    expect(kids(resolveInEveryOrder(ROOTS, [one, two]).keys)).toEqual(['root-a', 'root-b', 'rel-b', 'rel-c']);
  });

  it('maxSeq is the highest seq of a valid document; rejected documents do not count', () => {
    expect(resolveTrustedKeys(ROOTS, [addAll, forged, bad]).maxSeq).toBe(1);
    expect(resolveTrustedKeys(ROOTS, [forged]).maxSeq).toBe(0);
    expect(resolveTrustedKeys(ROOTS, [conflictC, addAll]).maxSeq).toBe(4);
  });

  it('a replayed document changes nothing', () => {
    expect(resolveTrustedKeys(ROOTS, [addAll, revokeA, revokeA, addAll])).toEqual(resolveTrustedKeys(ROOTS, [addAll, revokeA]));
  });
});

describe('resolveTrustedKeys: counter-revocation (the R65 review scenarios)', () => {
  it('rel-a / rel-b: the leaked rel-b cannot revoke the honest rel-a; the root revokes rel-b, in every order', () => {
    const add = keysetDoc({ seq: 1, keys: [relA.trusted, relB.trusted], revokedKids: [] });
    const lowSeqCounter = keysetDoc({ seq: 1, keys: [], revokedKids: ['rel-a'] }, relB);
    const highSeqCounter = keysetDoc({ seq: Number.MAX_SAFE_INTEGER, keys: [relC.trusted], revokedKids: ['rel-a'] }, relB);
    const rootRevokesB = keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-b'] });
    const result = resolveInEveryOrder(ROOTS, [add, lowSeqCounter, highSeqCounter, rootRevokesB]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b', 'rel-a']);
    expect(result.maxSeq).toBe(2);
    expect(result.rejected).toEqual([`${lowSeqCounter.env.sig} SIG_INVALID:kid`, `${highSeqCounter.env.sig} SIG_INVALID:kid`].sort());
  });

  it('rel-1 / rel-2 / rel-3: the leaked rel-2 adds rel-3 and revokes rel-1; the root revokes rel-2 and rotates to rel-4', () => {
    const rel1 = makeKey('rel-1', 'release');
    const rel2 = makeKey('rel-2', 'release');
    const rel3 = makeKey('rel-3', 'release'); // the attacker's
    const rel4 = makeKey('rel-4', 'release');
    const add = keysetDoc({ seq: 1, keys: [rel1.trusted, rel2.trusted], revokedKids: [] });
    const grab = keysetDoc({ seq: 2, keys: [rel3.trusted], revokedKids: ['rel-1'] }, rel2);
    const freeze = keysetDoc({ seq: 1, keys: [], revokedKids: ['rel-1'] }, rel2);
    const rotate = keysetDoc({ seq: 3, keys: [rel4.trusted], revokedKids: ['rel-2'] }, rootB);
    const result = resolveInEveryOrder(ROOTS, [add, grab, freeze, rotate]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b', 'rel-1', 'rel-4']);
    expect(result.rejected.every((r) => r.endsWith(' SIG_INVALID:kid'))).toBe(true);
    expect(result.rejected).toHaveLength(2);
  });

  it('a revoked key never comes back, not even when a root document lists it again with a higher seq', () => {
    const add = keysetDoc({ seq: 1, keys: [relB.trusted], revokedKids: [] });
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-b'] });
    const relist = keysetDoc({ seq: 3, keys: [relB.trusted, relC.trusted], revokedKids: [] });
    expect(kids(resolveInEveryOrder(ROOTS, [add, revoke, relist]).keys)).toEqual(['root-a', 'root-b', 'rel-c']);
  });

  it('a kid may be revoked before any document adds it, and revocation wins inside one document', () => {
    const preRevoke = keysetDoc({ seq: 1, keys: [], revokedKids: ['rel-c', 'never-seen'] });
    const add = keysetDoc({ seq: 2, keys: [relB.trusted, relC.trusted], revokedKids: [] });
    expect(kids(resolveInEveryOrder(ROOTS, [preRevoke, add]).keys)).toEqual(['root-a', 'root-b', 'rel-b']);
    const both = keysetDoc({ seq: 1, keys: [relB.trusted, relC.trusted], revokedKids: ['rel-c'] });
    expect(kids(resolveTrustedKeys(ROOTS, [both]).keys)).toEqual(['root-a', 'root-b', 'rel-b']);
  });
});

describe('resolveTrustedKeys: documents that touch a root are rejected as a whole', () => {
  const impostor = makeKey('root-a', 'root');
  it.each<[string, Keyset]>([
    ['lists a root kid unchanged', { seq: 1, keys: [relC.trusted, rootA.trusted], revokedKids: [] }],
    ['rebinds a root kid to another key', { seq: 1, keys: [relC.trusted, impostor.trusted], revokedKids: [] }],
    ['rebinds a root kid to another use', { seq: 1, keys: [relC.trusted, { ...rootB.trusted, use: 'release' }], revokedKids: [] }],
    ['revokes a root', { seq: 1, keys: [relC.trusted], revokedKids: ['root-b'] }],
    ['revokes its own signer', { seq: 1, keys: [relC.trusted], revokedKids: ['root-a'] }],
    ['adds a key of use root', { seq: 1, keys: [relC.trusted, makeKey('root-new', 'root').trusted], revokedKids: [] }],
    ['binds a root public key under another kid', { seq: 1, keys: [relC.trusted, { kid: 'rel-z', use: 'release', pub: rootB.trusted.pub }], revokedKids: [] }],
  ])('a document that %s', (_name, payload) => {
    const doc = keysetDoc({ ...payload, revokedKids: [...payload.revokedKids, 'rel-a'] });
    const resolved = resolveTrustedKeys(ROOTS, [addAll, doc]);
    expect(resolved.rejected).toEqual([{ index: 1, reason: 'root' }]);
    // Nothing of it applies: rel-c is not added, rel-a is not revoked, the roots are intact.
    expect(resolved.keys).toEqual(resolveTrustedKeys(ROOTS, [addAll]).keys);
    expect(resolved.maxSeq).toBe(1);
  });
});

describe('resolveTrustedKeys: conflicting bindings fail closed', () => {
  const relC2 = makeKey('rel-c', 'release');

  it('one kid bound to two public keys by two valid documents is not trusted, and is reported', () => {
    const one = keysetDoc({ seq: 1, keys: [relC.trusted, relB.trusted], revokedKids: [] });
    const two = keysetDoc({ seq: 2, keys: [relC2.trusted, licA.trusted], revokedKids: [] }, rootB);
    const result = resolveInEveryOrder(ROOTS, [one, two]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b', 'lic-a', 'rel-b']);
    expect(result.conflicts).toEqual(['rel-c']);
    expect(result.rejected).toEqual([]);
    expect(result.maxSeq).toBe(2);
  });

  it('one kid bound to two uses is a conflict too', () => {
    const one = keysetDoc({ seq: 1, keys: [licA.trusted], revokedKids: [] });
    const two = keysetDoc({ seq: 2, keys: [{ ...licA.trusted, use: 'timestamp' }], revokedKids: [] });
    const result = resolveInEveryOrder(ROOTS, [one, two]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b']);
    expect(result.conflicts).toEqual(['lic-a']);
  });

  it('one document that lists a kid twice with different keys is a conflict', () => {
    const doc = keysetDoc({ seq: 1, keys: [relC.trusted, relC2.trusted, relB.trusted], revokedKids: [] });
    expect(resolveTrustedKeys(ROOTS, [doc])).toMatchObject({ conflicts: ['rel-c'], rejected: [] });
    expect(kids(resolveTrustedKeys(ROOTS, [doc]).keys)).toEqual(['root-a', 'root-b', 'rel-b']);
  });

  it('the same binding listed by several documents is no conflict', () => {
    const one = keysetDoc({ seq: 1, keys: [relC.trusted, relC.trusted], revokedKids: [] });
    const two = keysetDoc({ seq: 2, keys: [relC.trusted], revokedKids: [] }, rootB);
    expect(resolveInEveryOrder(ROOTS, [one, two])).toMatchObject({ conflicts: [], rejected: [] });
  });

  it('a conflict stays reported when the kid is also revoked', () => {
    const one = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] });
    const two = keysetDoc({ seq: 2, keys: [relC2.trusted], revokedKids: ['rel-c'] });
    expect(resolveInEveryOrder(ROOTS, [one, two])).toMatchObject({ conflicts: ['rel-c'], keys: ROOTS });
  });
});

describe('resolveTrustedKeys: rejected documents', () => {
  it('a tampered document', () => {
    const doc = { ...addAll, raw: addAll.raw.replace(relB.trusted.pub, relC.trusted.pub) };
    expect(resolveTrustedKeys(ROOTS, [doc])).toEqual({ keys: ROOTS, maxSeq: 0, rejected: [{ index: 0, reason: 'SIG_INVALID:signature' }], conflicts: [] });
  });

  it('a document with duplicate keys in its raw JSON', () => {
    const doc = { ...addAll, raw: addAll.raw.replace('"seq": 1,', '"seq": 9, "seq": 1,') };
    expect(resolveTrustedKeys(ROOTS, [doc]).rejected).toEqual([{ index: 0, reason: 'SIG_INVALID:payload' }]);
  });

  it('entries that are not {raw, env}', () => {
    const docs = [null, 'doc', { raw: addAll.raw }, { env: addAll.env }] as unknown as Doc[];
    const { keys, rejected } = resolveTrustedKeys(ROOTS, docs);
    expect(keys).toEqual(ROOTS);
    expect(rejected.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    for (const { reason } of rejected) expect(reason).toMatch(/^SIG_INVALID:(envelope|payload)$/);
  });

  it.each([
    ['seq 0', { seq: 0, keys: [], revokedKids: [] }],
    ['negative seq', { seq: -1, keys: [], revokedKids: [] }],
    ['fractional seq', { seq: 1.5, keys: [], revokedKids: [] }],
    ['unsafe seq', { seq: 2 ** 53, keys: [], revokedKids: [] }],
    ['string seq', { seq: '1', keys: [], revokedKids: [] }],
    ['missing seq', { keys: [], revokedKids: [] }],
    ['missing keys', { seq: 1, revokedKids: [] }],
    ['missing revokedKids', { seq: 1, keys: [] }],
    ['keys not an array', { seq: 1, keys: {}, revokedKids: [] }],
    ['revokedKids not an array', { seq: 1, keys: [], revokedKids: 'rel-a' }],
    ['an empty revoked kid', { seq: 1, keys: [], revokedKids: [''] }],
    ['a numeric revoked kid', { seq: 1, keys: [], revokedKids: [1] }],
    ['a key with an unknown use', { seq: 1, keys: [{ ...relB.trusted, use: 'admin' }], revokedKids: [] }],
    ['a key with a bad pub', { seq: 1, keys: [{ ...relB.trusted, pub: 'AAAA' }], revokedKids: [] }],
    ['a key with an extra field', { seq: 1, keys: [{ ...relB.trusted, note: 'x' }], revokedKids: [] }],
    ['an extra field', { seq: 1, keys: [], revokedKids: [], note: 'x' }],
    ['an array payload', [1]],
    ['a null payload', null],
  ])('a document with %s', (_name, payload) => {
    const doc = keysetDoc(payload as Record<string, unknown>);
    const resolved = resolveTrustedKeys(ROOTS, [doc, addAll]);
    expect(resolved.rejected).toEqual([{ index: 0, reason: 'shape' }]);
    expect(resolved.keys).toEqual(resolveTrustedKeys(ROOTS, [addAll]).keys);
  });

  it('reports every rejected document by its input index, in index order', () => {
    const forged = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] }, relA);
    const touchesRoot = keysetDoc({ seq: 1, keys: [], revokedKids: ['root-b'] });
    const shapeless = keysetDoc({ seq: 0, keys: [], revokedKids: [] });
    expect(resolveTrustedKeys(ROOTS, [shapeless, addAll, forged, touchesRoot]).rejected).toEqual([
      { index: 0, reason: 'shape' },
      { index: 2, reason: 'SIG_INVALID:kid' },
      { index: 3, reason: 'root' },
    ]);
  });
});

describe('resolveTrustedKeys: embedded roots', () => {
  it('refuses an embedded key that is not a valid root key', () => {
    expect(() => resolveTrustedKeys([relA.trusted], [])).toThrow(TypeError);
    expect(() => resolveTrustedKeys([rootA.trusted, licA.trusted], [])).toThrow(TypeError);
    expect(() => resolveTrustedKeys([{ ...rootA.trusted, pub: 'AAAA' }], [])).toThrow(TypeError);
    expect(() => resolveTrustedKeys([{ ...rootA.trusted, use: 'admin' as KeyUse }], [])).toThrow(TypeError);
    expect(() => resolveTrustedKeys([null as unknown as TrustedKey], [])).toThrow(TypeError);
  });

  it('refuses one kid embedded twice with different keys, and collapses an identical key embedded twice', () => {
    expect(() => resolveTrustedKeys([rootA.trusted, makeKey('root-a', 'root').trusted], [])).toThrow(TypeError);
    expect(resolveTrustedKeys([rootA.trusted, { ...rootA.trusted }], []).keys).toEqual([rootA.trusted]);
  });

  it('refuses non-array arguments', () => {
    expect(() => resolveTrustedKeys(undefined as unknown as TrustedKey[], [])).toThrow(TypeError);
    expect(() => resolveTrustedKeys(ROOTS, undefined as unknown as Doc[])).toThrow(TypeError);
  });

  it('with no root at all trusts nothing', () => {
    expect(resolveTrustedKeys([], [addAll])).toEqual({ keys: [], maxSeq: 0, rejected: [{ index: 0, reason: 'SIG_INVALID:kid' }], conflicts: [] });
  });

  it('does not modify its inputs', () => {
    const roots = [rootA.trusted, rootB.trusted];
    const docs = [addAll, keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-a'] })];
    const snapshot = JSON.stringify({ roots, docs });
    resolveTrustedKeys(roots, docs);
    expect(JSON.stringify({ roots, docs })).toBe(snapshot);
  });
});

describe('parseKeysetDocs (R65c: the frozen file format)', () => {
  it('accepts a list of documents; entries are checked one by one later, by resolveTrustedKeys', () => {
    expect(parseKeysetDocs([addAll, addAll])).toEqual([addAll, addAll]);
    expect(parseKeysetDocs([])).toEqual([]);
    expect(parseKeysetDocs([1, { raw: 'x' }, addAll])).toEqual([1, { raw: 'x' }, addAll]);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 1],
    ['an empty object', {}],
    ['a bare document', addAll],
  ])('refuses %s: a keyset file is a JSON array, never a bare document', (_name, value) => {
    expect(() => parseKeysetDocs(value)).toThrow(TypeError);
  });

  it(`refuses more than ${KEYSET_MAX_DOCS} documents, and a document over ${KEYSET_MAX_DOC_BYTES} bytes`, () => {
    expect(parseKeysetDocs(new Array(KEYSET_MAX_DOCS).fill(addAll))).toHaveLength(KEYSET_MAX_DOCS);
    expect(() => parseKeysetDocs(new Array(KEYSET_MAX_DOCS + 1).fill(addAll))).toThrow(/too many/);
    const big = { raw: 'x'.repeat(KEYSET_MAX_DOC_BYTES), env: addAll.env };
    expect(() => parseKeysetDocs([addAll, big])).toThrow(/too large/);
  });
});

describe('resolveTrustedKeys: bounded work (R65c)', () => {
  it('copies of an accepted document count once, and copies spelled differently change nothing', () => {
    const respelled = { raw: JSON.stringify(JSON.parse(addAll.raw)), env: { ...addAll.env } };
    expect(respelled.raw).not.toBe(addAll.raw);
    expect(resolveTrustedKeys(ROOTS, [addAll, respelled, addAll, addAll])).toEqual(resolveTrustedKeys(ROOTS, [addAll]));
  });

  it('only an accepted document suppresses its copies: every rejected copy is verified and reported', () => {
    const forged = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: [] }, relA);
    expect(resolveTrustedKeys(ROOTS, [addAll, forged, forged]).rejected).toEqual([
      { index: 1, reason: 'SIG_INVALID:kid' },
      { index: 2, reason: 'SIG_INVALID:kid' },
    ]);
  });

  it('CRITICAL regression (round 2): a tampered copy never hides the genuine document, whichever comes first', () => {
    const revokeB = keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-b'] });
    const tampered = [
      { raw: revokeB.raw, env: { ...revokeB.env, pad: 0 } }, // extra envelope field: SIG_INVALID:envelope
      { raw: revokeB.raw, env: { ...revokeB.env, sig: (revokeB.env.sig[0] === 'A' ? 'B' : 'A') + revokeB.env.sig.slice(1) } }, // bad signature
      { raw: revokeB.raw.replace('"rel-b"', '"rel-x"'), env: revokeB.env }, // payload changed
    ];
    const honest = resolveTrustedKeys(ROOTS, [addAll, revokeB]).keys;
    expect(kids(honest)).not.toContain('rel-b');
    for (const copy of tampered) {
      for (const docs of [[copy, addAll, revokeB], [addAll, copy, revokeB], [addAll, revokeB, copy]]) {
        const resolved = resolveTrustedKeys(ROOTS, docs as Doc[]);
        expect(resolved.keys).toEqual(honest);
        expect(resolved.rejected).toHaveLength(1);
      }
      const report = resolveKeysetSources(ROOTS, [
        { name: 'DATA_DIR/releases/keyset.json', docs: [copy as Doc] },
        { name: 'DATA_DIR/releases/keyset.json.bak', docs: [copy as Doc] },
        { name: 'bundled-release/1.0.0/keyset.json', docs: [addAll, revokeB] },
      ]);
      expect(report.keys).toEqual(honest);
    }
  });

  it(`a document whose raw text is over ${KEYSET_MAX_DOC_BYTES} bytes is rejected (size) without being verified`, () => {
    const padded = { raw: addAll.raw + ' '.repeat(KEYSET_MAX_DOC_BYTES), env: addAll.env };
    expect(resolveTrustedKeys(ROOTS, [padded]).rejected).toEqual([{ index: 0, reason: 'size' }]);
  });
});

describe('resolveTrustedKeys: a revoked public key stays revoked under any kid (R65d)', () => {
  const leaked = relB.trusted;
  const reboundKid = { kid: 'rel-b2', use: 'release' as const, pub: leaked.pub };
  const reboundUse = { kid: 'lic-b', use: 'license' as const, pub: leaked.pub };

  it('a revoked key bound again under a new kid or use is not trusted, in every order', () => {
    const add = keysetDoc({ seq: 1, keys: [leaked, relC.trusted], revokedKids: [] });
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['rel-b'] });
    const rebind = keysetDoc({ seq: 3, keys: [reboundKid, reboundUse, relA.trusted], revokedKids: [] }, rootB);
    const result = resolveInEveryOrder(ROOTS, [add, revoke, rebind]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b', 'rel-a', 'rel-c']);
  });

  it('every public key a revoked kid was bound to is revoked (a conflicted kid has two)', () => {
    const relB2 = makeKey('rel-b', 'release');
    const one = keysetDoc({ seq: 1, keys: [leaked] , revokedKids: [] });
    const two = keysetDoc({ seq: 2, keys: [relB2.trusted], revokedKids: ['rel-b'] });
    const rebind = keysetDoc({ seq: 3, keys: [reboundKid, { kid: 'rel-b3', use: 'release', pub: relB2.trusted.pub }], revokedKids: [] });
    expect(kids(resolveInEveryOrder(ROOTS, [one, two, rebind]).keys)).toEqual(['root-a', 'root-b']);
  });

  it('every public key of a conflicted kid is revoked too (fail closed, as R65d)', () => {
    const relC2 = makeKey('rel-c', 'release');
    const one = keysetDoc({ seq: 1, keys: [relC.trusted, relA.trusted], revokedKids: [] });
    const two = keysetDoc({ seq: 2, keys: [relC2.trusted], revokedKids: [] });
    const rebind = keysetDoc({ seq: 3, keys: [{ kid: 'rel-c1', use: 'release', pub: relC.trusted.pub }, { kid: 'rel-c2', use: 'release', pub: relC2.trusted.pub }], revokedKids: [] }, rootB);
    const result = resolveInEveryOrder(ROOTS, [one, two, rebind]);
    expect(kids(result.keys)).toEqual(['root-a', 'root-b', 'rel-a']);
    expect(result.conflicts).toEqual(['rel-c']);
  });

  it('a public key is revoked only through a revoked kid: the same key under two live kids stays trusted', () => {
    const doc = keysetDoc({ seq: 1, keys: [leaked, reboundKid], revokedKids: [] });
    expect(kids(resolveTrustedKeys(ROOTS, [doc]).keys)).toEqual(['root-a', 'root-b', 'rel-b', 'rel-b2']);
  });
});

describe('resolveTrustedKeys: production refuses documents that add a dev- key (R65b)', () => {
  const devRel = makeKey('dev-rel-9', 'release');

  it('with refuseDevKids, a root-signed document that adds a dev- kid is rejected as a whole (dev)', () => {
    const doc = keysetDoc({ seq: 1, keys: [relC.trusted, devRel.trusted], revokedKids: ['rel-a'] });
    const production = resolveTrustedKeys(ROOTS, [addAll, doc], { refuseDevKids: true });
    expect(production.rejected).toEqual([{ index: 1, reason: 'dev' }]);
    expect(production.keys).toEqual(resolveTrustedKeys(ROOTS, [addAll]).keys);
    // A test build takes it.
    expect(kids(resolveTrustedKeys(ROOTS, [addAll, doc]).keys)).toContain('dev-rel-9');
  });

  it('revoking a dev- kid is always fine', () => {
    const doc = keysetDoc({ seq: 1, keys: [relC.trusted], revokedKids: ['dev-rel-1'] });
    expect(resolveTrustedKeys(ROOTS, [doc], { refuseDevKids: true }).rejected).toEqual([]);
  });
});

describe('resolveKeysetSources: rejections named by source', () => {
  it('flattens the sources in order and names each rejection by its source and index there', () => {
    const forged = keysetDoc({ seq: 1, keys: [], revokedKids: [] }, relA);
    const shapeless = keysetDoc({ seq: 0, keys: [], revokedKids: [] });
    const report = resolveKeysetSources(ROOTS, [
      { name: 'data', docs: [addAll, forged] },
      { name: 'empty', docs: [] },
      { name: 'release', docs: [addAll, shapeless, forged] },
    ]);
    expect(report.keys).toEqual(resolveTrustedKeys(ROOTS, [addAll]).keys);
    expect(report.rejected).toEqual([
      { source: 'data', index: 1, reason: 'SIG_INVALID:kid' },
      { source: 'release', index: 1, reason: 'shape' },
      { source: 'release', index: 2, reason: 'SIG_INVALID:kid' }, // a rejected document suppresses no copy
    ]);
    expect(report.conflicts).toEqual([]);
    expect(report.maxSeq).toBe(1);
  });
});
