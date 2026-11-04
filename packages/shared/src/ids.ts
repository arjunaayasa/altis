/**
 * ULID: 48-bit millisecond timestamp + 80 random bits, 26 characters of Crockford base32.
 *
 * Plain arithmetic on Numbers and a Uint8Array, with no BigInt and no Node-only imports, so the module
 * downlevels to the ES2017 bootloader bundle and also runs in the browser. Randomness comes from the
 * global `crypto.getRandomValues`.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

/** Canonical form only: uppercase, and a first character of 0-7 so that the timestamp fits 48 bits. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

// One entry per random digit (0-31) of the most recently issued id.
const lastRandom = new Uint8Array(RANDOM_LEN);
let lastTime = -1;

function assertTime(time: number): void {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`ULID timestamp must be an integer in [0, 2^48-1], got ${time}`);
  }
}

function fillRandom(digits: Uint8Array): void {
  crypto.getRandomValues(digits);
  // 256 is a multiple of 32, so masking a uniform byte yields a uniform base32 digit.
  for (let i = 0; i < digits.length; i++) digits[i] = digits[i]! & 31;
}

/** Adds one to the base32 number in `digits`. Returns false when it wrapped around (all digits were 31). */
function increment(digits: Uint8Array): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i]!;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

function encode(time: number, random: Uint8Array): string {
  const chars: string[] = new Array<string>(TIME_LEN + RANDOM_LEN);
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const digit = t % 32;
    chars[i] = ALPHABET[digit]!;
    t = (t - digit) / 32;
  }
  for (let i = 0; i < RANDOM_LEN; i++) chars[TIME_LEN + i] = ALPHABET[random[i]!]!;
  return chars.join('');
}

/**
 * Returns a new ULID, strictly greater than the previous one issued by this process.
 *
 * Without `now` the timestamp is the current time, held at the last issued timestamp if the clock steps
 * backwards. Ids issued for the same millisecond count up from a single random start, so they stay ordered.
 *
 * An explicit `now` (epoch ms) is used exactly as given, which makes ids reproducible in tests and
 * back-fills. Ordering is only guaranteed while `now` does not go back: an earlier timestamp than the
 * previous call restarts the sequence there.
 */
export function newId(now?: number): string {
  let time = now === undefined ? Math.max(Date.now(), lastTime) : now;
  assertTime(time);
  if (time === lastTime) {
    if (increment(lastRandom)) return encode(time, lastRandom);
    // All 2^80 ids of this millisecond are used up. Borrow the next millisecond rather than wrap around.
    time += 1;
    assertTime(time);
  }
  lastTime = time;
  fillRandom(lastRandom);
  return encode(time, lastRandom);
}

/** True for a canonical ULID: 26 uppercase Crockford base32 characters with a 48-bit timestamp. */
export function isUlid(s: string): boolean {
  return typeof s === 'string' && ULID_PATTERN.test(s);
}

/** The creation time of a ULID, in epoch milliseconds. Throws a RangeError for anything but a canonical ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new RangeError('Not a ULID');
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) time = time * 32 + ALPHABET.indexOf(id.charAt(i));
  return time;
}
