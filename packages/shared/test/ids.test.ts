import { afterEach, describe, expect, it, vi } from 'vitest';

type Ids = typeof import('../src/ids.js');

/** The monotonic state lives in module scope; tests that touch it load a pristine copy. */
async function freshIds(): Promise<Ids> {
  vi.resetModules();
  return import('../src/ids.js');
}

const CROCKFORD_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T_2026 = 1767225600000; // 2026-01-01T00:00:00.000Z

afterEach(() => {
  vi.restoreAllMocks();
});

describe('newId', () => {
  it('returns a 26-character Crockford base32 ULID', async () => {
    const { newId } = await freshIds();
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(CROCKFORD_ULID);
  });

  it('is strictly increasing for 10,000 ids generated within the same millisecond', async () => {
    const { newId } = await freshIds();
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(newId(T_2026));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is strictly increasing across a stream of implicit-time ids', async () => {
    const { newId } = await freshIds();
    let previous = newId();
    for (let i = 0; i < 10_000; i++) {
      const next = newId();
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  it('encodes the given timestamp', async () => {
    const { newId, ulidTime } = await freshIds();
    expect(ulidTime(newId(T_2026))).toBe(T_2026);
  });

  it('honours an explicit timestamp even after ids were issued for a later time', async () => {
    const { newId, ulidTime } = await freshIds();
    newId(); // implicit: now, which is later than T_2026
    expect(ulidTime(newId(T_2026))).toBe(T_2026);
  });

  it('keeps ids strictly increasing for an explicit timestamp that is earlier than ids already issued', async () => {
    const { newId } = await freshIds();
    newId(); // implicit: now, which is later than T_2026
    const ids: string[] = [];
    for (let i = 0; i < 1_000; i++) ids.push(newId(T_2026));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });

  it('issues later implicit ids above an explicit past timestamp', async () => {
    const { newId } = await freshIds();
    const backfilled = newId(T_2026);
    expect(newId() > backfilled).toBe(true);
  });

  it('encodes known vectors (ulid reference value, epoch zero, 48-bit maximum)', async () => {
    const { newId } = await freshIds();
    expect(newId(1469918176385).slice(0, 10)).toBe('01ARYZ6S41');
    expect(newId(0).slice(0, 10)).toBe('0000000000');
    expect(newId(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
  });

  it('keeps increasing when the clock steps backwards', async () => {
    const { newId } = await freshIds();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_900_000_000_000);
    const first = newId();
    now.mockReturnValue(1_899_999_999_000); // NTP stepped the clock back one second
    const second = newId();
    now.mockReturnValue(1_900_000_000_000);
    const third = newId();
    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
  });

  it('moves to the next millisecond instead of wrapping when the random part overflows', async () => {
    const { newId, ulidTime } = await freshIds();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => buf.fill(0xff)) as never);
    const first = newId(T_2026);
    expect(first.slice(10)).toBe('ZZZZZZZZZZZZZZZZ');
    const second = newId(T_2026);
    expect(second > first).toBe(true);
    expect(ulidTime(second)).toBe(T_2026 + 1);
    expect(second).toMatch(CROCKFORD_ULID);
  });

  it('draws the random part from crypto.getRandomValues', async () => {
    const { newId } = await freshIds();
    const spy = vi.spyOn(crypto, 'getRandomValues');
    newId(T_2026);
    expect(spy).toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 48])('rejects the timestamp %s', async (bad) => {
    const { newId } = await freshIds();
    expect(() => newId(bad)).toThrow(RangeError);
  });
});

describe('isUlid', () => {
  it('accepts canonical ULIDs', async () => {
    const { isUlid, newId } = await freshIds();
    expect(isUlid(newId())).toBe(true);
    expect(isUlid('01ARYZ6S41TSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('00000000000000000000000000')).toBe(true);
    expect(isUlid('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['25 characters', '01ARYZ6S41TSV4RRFFQ69G5FA'],
    ['27 characters', '01ARYZ6S41TSV4RRFFQ69G5FAVV'],
    ['lowercase', '01aryz6s41tsv4rrffq69g5fav'],
    ['letter I', '01ARYZ6S41TSV4RRFFQ69G5FAI'],
    ['letter L', '01ARYZ6S41TSV4RRFFQ69G5FAL'],
    ['letter O', '01ARYZ6S41TSV4RRFFQ69G5FAO'],
    ['letter U', '01ARYZ6S41TSV4RRFFQ69G5FAU'],
    ['timestamp above 2^48-1', '80000000000000000000000000'],
    ['leading space', ' 1ARYZ6S41TSV4RRFFQ69G5FAV'],
    ['trailing newline', '01ARYZ6S41TSV4RRFFQ69G5FA\n'],
  ])('rejects %s', async (_label, value) => {
    const { isUlid } = await freshIds();
    expect(isUlid(value)).toBe(false);
  });
});

describe('ulidTime', () => {
  it('decodes the timestamp of an id', async () => {
    const { ulidTime } = await freshIds();
    expect(ulidTime('01ARYZ6S41TSV4RRFFQ69G5FAV')).toBe(1469918176385);
    expect(ulidTime('00000000000000000000000000')).toBe(0);
    expect(ulidTime('7ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(2 ** 48 - 1);
  });

  it('throws on a value that is not a ULID', async () => {
    const { ulidTime } = await freshIds();
    expect(() => ulidTime('nope')).toThrow(RangeError);
    expect(() => ulidTime('01aryz6s41tsv4rrffq69g5fav')).toThrow(RangeError);
  });
});
