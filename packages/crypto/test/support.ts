/**
 * Deterministic random JSON data for property-style tests (no fast-check dependency).
 */

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;

const int = (rand: Rand, n: number): number => Math.floor(rand() * n);
const pick = <T>(rand: Rand, items: readonly T[]): T => items[int(rand, items.length)] as T;

/** A finite double built from random bits, or one of a few interesting values. */
export function randomNumber(rand: Rand): number {
  const special = [0, -0, 1, -1, 0.1, 1e21, 1e-7, 123456789, 2 ** 53, -(2 ** 53), Number.MIN_VALUE, Number.MAX_VALUE];
  if (rand() < 0.3) return pick(rand, special);
  if (rand() < 0.3) return int(rand, 2_000_001) - 1_000_000;
  const view = new DataView(new ArrayBuffer(8));
  for (;;) {
    view.setUint32(0, Math.floor(rand() * 2 ** 32));
    view.setUint32(4, Math.floor(rand() * 2 ** 32));
    const n = view.getFloat64(0);
    if (Number.isFinite(n)) return n;
  }
}

/** Code units chosen to stress escaping and sorting: controls, quotes, non-ASCII, valid surrogate pairs. */
const STRING_PIECES = [
  'a', 'b', 'z', 'A', 'Z', '0', '9', ' ', '"', '\\', '/', '\b', '\f', '\n', '\r', '\t', '\u0000', '\u0001', '\u001f',
  '\u007f', '\u0080', 'é', '€', ' ', ' ', 'דּ', '﻿', '😀', '􏿿', '~',
];

export function randomString(rand: Rand, max = 8): string {
  let s = '';
  const n = int(rand, max + 1);
  for (let i = 0; i < n; i++) s += pick(rand, STRING_PIECES);
  return s;
}

const KEY_POOL = ['a', 'b', 'aa', 'ab', '', '1', '10', '__proto__', 'constructor', 'toString', 'é', 'z', '😀', 'דּ'];

/** A random value inside the JSON data model (plain objects, arrays, strings, finite numbers, literals). */
export function randomJson(rand: Rand, depth = 0): unknown {
  const r = rand();
  if (depth >= 4 || r < 0.45) {
    const s = rand();
    if (s < 0.1) return null;
    if (s < 0.2) return rand() < 0.5;
    if (s < 0.6) return randomNumber(rand);
    return randomString(rand);
  }
  if (r < 0.7) {
    const n = int(rand, 5);
    const arr: unknown[] = [];
    for (let i = 0; i < n; i++) arr.push(randomJson(rand, depth + 1));
    return arr;
  }
  const obj: Record<string, unknown> = {};
  const n = int(rand, 6);
  for (let i = 0; i < n; i++) {
    const key = rand() < 0.5 ? pick(rand, KEY_POOL) : randomString(rand, 4);
    // defineProperty, so that "__proto__" becomes an own property just as JSON.parse makes it.
    Object.defineProperty(obj, key, {
      value: randomJson(rand, depth + 1),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return obj;
}

const WHITESPACE = ['', '', ' ', '\t', '\n', '\r', '  \r\n'];

/** JSON text for `v` with random insignificant whitespace, random escapes and random number spellings. */
export function looseStringify(rand: Rand, v: unknown): string {
  const ws = (): string => pick(rand, WHITESPACE);
  const str = (s: string): string => {
    let out = '"';
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (ch === '"' || ch === '\\' || code < 0x20 || rand() < 0.15) {
        // escape every code unit of this character as \uXXXX (random hex case)
        for (let i = 0; i < ch.length; i++) {
          const hex = ch.charCodeAt(i).toString(16).padStart(4, '0');
          out += '\\u' + (rand() < 0.5 ? hex : hex.toUpperCase());
        }
      } else if (ch === '/' && rand() < 0.5) {
        out += '\\/';
      } else {
        out += ch;
      }
    }
    return out + '"';
  };
  const num = (n: number): string => (rand() < 0.3 ? n.toExponential() : String(n)).replace('e', rand() < 0.5 ? 'e' : 'E');
  const go = (x: unknown): string => {
    if (x === null) return 'null';
    if (typeof x === 'boolean') return String(x);
    if (typeof x === 'number') return num(x);
    if (typeof x === 'string') return str(x);
    if (Array.isArray(x)) return '[' + ws() + x.map((e) => go(e)).join(ws() + ',' + ws()) + ws() + ']';
    const entries = Object.keys(x as object).map((k) => str(k) + ws() + ':' + ws() + go((x as Record<string, unknown>)[k]));
    return '{' + ws() + entries.join(ws() + ',' + ws()) + ws() + '}';
  };
  return ws() + go(v) + ws();
}

/**
 * First structural difference between two parsed JSON values, or null when they are identical:
 * prototypes, own key order, property descriptors and `Object.is` on primitives (so -0 differs from 0).
 * Vitest's toStrictEqual cannot be used here: it compares `.constructor`, which a JSON document may
 * define as an own property holding an object.
 */
export function jsonDiff(a: unknown, b: unknown, path = ''): string | null {
  const at = path || '/';
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b) ? null : `${at}: ${String(a)} !== ${String(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array vs object`;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${at}: prototype`;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return `${at}: keys ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`;
  for (const k of ka) {
    const da = Object.getOwnPropertyDescriptor(a, k) as PropertyDescriptor;
    const db = Object.getOwnPropertyDescriptor(b, k) as PropertyDescriptor;
    if (da.writable !== db.writable || da.enumerable !== db.enumerable || da.configurable !== db.configurable) {
      return `${path}/${k}: descriptor`;
    }
    const d = jsonDiff(da.value, db.value, `${path}/${k}`);
    if (d !== null) return d;
  }
  return null;
}
