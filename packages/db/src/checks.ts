// Checks of text values bound as parameters, shared by the concurrency primitives and the audit log: a value must
// be stored and compared the same way on every dialect (package-internal).

/** A UTF-16 surrogate without its partner: MySQL/MariaDB would store U+FFFD (or refuse it) instead. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export interface TextRule {
  /** Most characters (code points, as MySQL VARCHAR and PostgreSQL varchar count them). */
  max: number;
  /** Refuse '' (default true). */
  nonEmpty?: boolean;
  /**
   * Refuse a trailing blank (default false): MySQL/MariaDB compare and index utf8mb4 VARCHAR with PAD SPACE, so
   * `'a '` and `'a'` would be the same key there and different ones on PostgreSQL and SQLite (ruling R24).
   */
  noTrailingBlank?: boolean;
}

/**
 * `value` when it is a string every dialect stores unchanged and within `rule`; a TypeError naming `what`
 * otherwise. Refused everywhere: NUL (PostgreSQL text cannot hold it) and lone surrogates (not valid UTF-8).
 */
export function checkText(what: string, value: unknown, rule: TextRule): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string, got ${describe(value)}`);
  if (value === '' && rule.nonEmpty !== false) throw new TypeError(`${what} must not be empty`);
  const chars = [...value].length;
  if (chars > rule.max) throw new TypeError(`${what} must be at most ${rule.max} characters, got ${chars}`);
  if (rule.noTrailingBlank === true && value.endsWith(' ')) {
    throw new TypeError(`${what} must not end in a blank (MySQL/MariaDB ignore trailing blanks when comparing)`);
  }
  if (value.includes('\u0000')) throw new TypeError(`${what} must not contain NUL characters (PostgreSQL cannot store them)`);
  if (LONE_SURROGATE.test(value)) throw new TypeError(`${what} must be well-formed Unicode (it holds a lone surrogate)`);
  return value;
}

/**
 * A short description of a value for error messages: its type, and for a string only its length, never its text (a
 * username, an e-mail address or an ID number passed by mistake must not end up in logs).
 */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string of ${value.length} characters`;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return `${typeof value} ${String(value)}`;
  return typeof value === 'object' ? 'an object' : typeof value;
}
