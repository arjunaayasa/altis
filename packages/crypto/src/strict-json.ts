/**
 * Strict JSON parser for signed documents.
 *
 * Accepts and returns exactly what `JSON.parse` does (RFC 8259 grammar; escaped and raw lone surrogates
 * are kept; numbers convert like `Number()`, so 1e400 is Infinity), with two extra refusals:
 * - a duplicate property name in one object: `Error('DUPLICATE_KEY:<key>')` (names compared unescaped);
 * - more than {@link MAX_JSON_DEPTH} nested arrays/objects: `Error('JSON_TOO_DEEP')`.
 * Syntax errors, including trailing garbage, throw `SyntaxError('JSON_SYNTAX:<offset>')`.
 *
 * A property named `__proto__` becomes an own data property, as with `JSON.parse`; it never touches the
 * prototype. Bundled into the ES2017 bootloader: keep the syntax plain and the module dependency-free.
 */

export const MAX_JSON_DEPTH = 64;

const hasOwn = Object.prototype.hasOwnProperty;

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0-9
  if (c >= 0x61 && c <= 0x66) return c - 0x57; // a-f
  if (c >= 0x41 && c <= 0x46) return c - 0x37; // A-F
  return -1;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

export function parseStrictJson(text: string): unknown {
  if (typeof text !== 'string') throw new TypeError('parseStrictJson: text must be a string');
  const len = text.length;
  let pos = 0;

  function syntaxError(): never {
    throw new SyntaxError('JSON_SYNTAX:' + pos);
  }

  function skipWhitespace(): void {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return;
      pos++;
    }
  }

  function parseLiteral(word: string, result: unknown): unknown {
    if (!text.startsWith(word, pos)) syntaxError();
    pos += word.length;
    return result;
  }

  function parseNumber(): number {
    const start = pos;
    if (text.charCodeAt(pos) === 0x2d) pos++; // -
    const first = text.charCodeAt(pos);
    if (first === 0x30) {
      pos++;
    } else if (first >= 0x31 && first <= 0x39) {
      while (isDigit(text.charCodeAt(pos))) pos++;
    } else {
      syntaxError();
    }
    if (text.charCodeAt(pos) === 0x2e) {
      // .
      pos++;
      if (!isDigit(text.charCodeAt(pos))) syntaxError();
      while (isDigit(text.charCodeAt(pos))) pos++;
    }
    const e = text.charCodeAt(pos);
    if (e === 0x65 || e === 0x45) {
      // e E
      pos++;
      const sign = text.charCodeAt(pos);
      if (sign === 0x2b || sign === 0x2d) pos++;
      if (!isDigit(text.charCodeAt(pos))) syntaxError();
      while (isDigit(text.charCodeAt(pos))) pos++;
    }
    return Number(text.slice(start, pos));
  }

  function parseString(): string {
    pos++; // opening quote
    let out = '';
    let chunkStart = pos;
    for (;;) {
      if (pos >= len) syntaxError();
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        out += text.slice(chunkStart, pos);
        pos++;
        return out;
      }
      if (c < 0x20) syntaxError();
      if (c !== 0x5c) {
        pos++;
        continue;
      }
      out += text.slice(chunkStart, pos);
      pos++; // backslash
      switch (text.charCodeAt(pos)) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += '\\';
          break;
        case 0x2f:
          out += '/';
          break;
        case 0x62:
          out += '\b';
          break;
        case 0x66:
          out += '\f';
          break;
        case 0x6e:
          out += '\n';
          break;
        case 0x72:
          out += '\r';
          break;
        case 0x74:
          out += '\t';
          break;
        case 0x75: {
          // \uXXXX: one UTF-16 code unit; surrogate halves are kept as they are, like JSON.parse.
          let code = 0;
          for (let k = 1; k <= 4; k++) {
            const h = hexValue(text.charCodeAt(pos + k));
            if (h < 0) {
              pos += k;
              syntaxError();
            }
            code = code * 16 + h;
          }
          out += String.fromCharCode(code);
          pos += 4;
          break;
        }
        default:
          syntaxError();
      }
      pos++;
      chunkStart = pos;
    }
  }

  function parseArray(depth: number): unknown[] {
    pos++; // [
    const result: unknown[] = [];
    skipWhitespace();
    if (text.charCodeAt(pos) === 0x5d) {
      pos++;
      return result;
    }
    for (;;) {
      result.push(parseValue(depth));
      skipWhitespace();
      const c = text.charCodeAt(pos);
      if (c === 0x5d) {
        pos++;
        return result;
      }
      if (c !== 0x2c) syntaxError();
      pos++;
    }
  }

  function parseObject(depth: number): Record<string, unknown> {
    pos++; // {
    const result: Record<string, unknown> = {};
    skipWhitespace();
    if (text.charCodeAt(pos) === 0x7d) {
      pos++;
      return result;
    }
    for (;;) {
      skipWhitespace();
      if (text.charCodeAt(pos) !== 0x22) syntaxError();
      const key = parseString();
      if (hasOwn.call(result, key)) throw new Error('DUPLICATE_KEY:' + key);
      skipWhitespace();
      if (text.charCodeAt(pos) !== 0x3a) syntaxError();
      pos++;
      // defineProperty, not assignment: "__proto__" must become an own property (as with JSON.parse).
      Object.defineProperty(result, key, {
        value: parseValue(depth),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      skipWhitespace();
      const c = text.charCodeAt(pos);
      if (c === 0x7d) {
        pos++;
        return result;
      }
      if (c !== 0x2c) syntaxError();
      pos++;
    }
  }

  function parseValue(depth: number): unknown {
    skipWhitespace();
    const c = text.charCodeAt(pos);
    switch (c) {
      case 0x7b: // {
        if (depth >= MAX_JSON_DEPTH) throw new Error('JSON_TOO_DEEP');
        return parseObject(depth + 1);
      case 0x5b: // [
        if (depth >= MAX_JSON_DEPTH) throw new Error('JSON_TOO_DEEP');
        return parseArray(depth + 1);
      case 0x22:
        return parseString();
      case 0x74:
        return parseLiteral('true', true);
      case 0x66:
        return parseLiteral('false', false);
      case 0x6e:
        return parseLiteral('null', null);
      default:
        if (c === 0x2d || isDigit(c)) return parseNumber();
        return syntaxError();
    }
  }

  const value = parseValue(0);
  skipWhitespace();
  if (pos !== len) syntaxError();
  return value;
}
