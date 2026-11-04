/**
 * JSON Canonicalization Scheme, RFC 8785 (JCS).
 *
 * Accepts exactly the JSON data model: `null`, booleans, finite numbers, well-formed strings, arrays and
 * plain objects (prototype `Object.prototype` or `null`). Everything else throws
 * `TypeError('JCS_INVALID:<reason> at <JSON Pointer>')`, with reason one of `non_finite`,
 * `lone_surrogate`, `undefined`, `function`, `symbol`, `bigint`, `object` (not a plain object or array)
 * and `cycle`.
 *
 * One leniency, matching `JSON.stringify`: an object property whose value is `undefined` is omitted, so
 * `canonicalize(v) === canonicalize(JSON.parse(JSON.stringify(v)))` for every accepted `v`. `undefined`
 * anywhere else (top level, array element, array hole) throws.
 *
 * Bundled into the ES2017 bootloader: keep the syntax plain and the module dependency-free.
 */

/** Property names / array indexes from the root to the value being serialized, for error messages. */
type Path = (string | number)[];

function pointer(path: Path): string {
  let out = '';
  for (const segment of path) out += '/' + String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return out || '/';
}

function fail(reason: string, path: Path): never {
  throw new TypeError('JCS_INVALID:' + reason + ' at ' + pointer(path));
}

/** RFC 8785 §3.2.2.2: lone surrogates must make a compliant implementation fail. */
function quote(s: string, path: Path): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
    }
    fail('lone_surrogate', path);
  }
  // ECMAScript JSON.stringify string escaping is exactly RFC 8785 §3.2.2.2: \b \t \n \f \r, lower-case
  // \u00hh for the other controls, \" and \\, everything else as is.
  return JSON.stringify(s);
}

function serialize(value: unknown, path: Path, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return quote(value, path);
    case 'number':
      if (!isFinite(value)) fail('non_finite', path);
      // RFC 8785 §3.2.2.3 is ECMAScript Number::toString; String(-0) is "0".
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint
      return fail(typeof value, path);
  }
  if (value === null) return 'null';
  if (ancestors.has(value)) fail('cycle', path);

  let out: string;
  ancestors.add(value);
  if (Array.isArray(value)) {
    out = '[';
    for (let i = 0; i < value.length; i++) {
      path.push(i);
      const item: unknown = value[i];
      if (item === undefined) fail('undefined', path);
      out += (i > 0 ? ',' : '') + serialize(item, path, ancestors);
      path.pop();
    }
    out += ']';
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail('object', path);
    const record = value as Record<string, unknown>;
    // Array.prototype.sort without a comparator orders strings by UTF-16 code units (RFC 8785 §3.2.3).
    const keys = Object.keys(record).sort();
    out = '{';
    let first = true;
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) continue;
      path.push(key);
      out += (first ? '' : ',') + quote(key, path) + ':' + serialize(item, path, ancestors);
      path.pop();
      first = false;
    }
    out += '}';
  }
  ancestors.delete(value);
  return out;
}

/** RFC 8785 canonical JSON text of `value`. Encode it as UTF-8 to get the bytes to sign or hash. */
export function canonicalize(value: unknown): string {
  return serialize(value, [], new Set());
}
