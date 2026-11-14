import { createRotatingFile, dataPath, type RotatingFile } from '@altis/platform';
import { personalLogKeys } from '@altis/db';
import { isDomainError } from '@altis/shared';
import type { Config } from './config.js';
import { loggableError } from './safe-error.js';

// The server log: one JSON object per line in `DATA_DIR/logs/altis.log`, rotated by size.
//
//   {"t":"2026-10-27T05:30:12.345Z","level":"info","msg":"...", ...fields}
//
// Formatting, redaction and level filtering are here; every file system call is in `createRotatingFile` of
// @altis/platform (apps/** may not use fs), which also makes several processes (Passenger starts up to six) share
// one `altis.log` safely (ruling R46).
//
// Redaction is by key name: any field whose name matches REDACT has its whole value replaced by "[redacted]", at
// every depth of an object or array. The match is a case-insensitive substring ("monkey" contains "key"), which
// over-redacts on purpose. Message texts and error messages are not inspected: do not put a secret in either. The
// one exception is a raw database driver error (its message and SQL can hold the values of a statement): it is
// written as its safe fields only, wherever it is, a cause chain included (safe-error.ts loggableError).
//
// Personal data is redacted by key name too: a field whose name, lower-cased and without underscores, is the name of a
// registered personal column or JSON path (`personalLogKeys()` of @altis/db: `name`, `note`, `address`,
// `appointment_ref` and `appointmentRef` alike, ...) has its value replaced the same way, at every depth. This also
// over-redacts on purpose (`name` is personal far more often than not); a field that is not personal is logged under
// another key (`schedule`, `errorName`). The class name of an error (its `name`) is kept.
//
// With `stdout: true` (ruling R59) every line is also written, as it is in the file, to process.stdout.
//
// A log call never throws and never blocks on anything but the append itself. A failure to write, to the file or to
// stdout, is reported once per process on stderr and the line is lost.

export type LogLevel = Config['log']['level'];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line; the fields of a call win over them, the nearer child over its parent. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  dataDir: string;
  level: LogLevel;
  /** Rotate before a write that would pass this size. Default 10 MiB. */
  maxBytes?: number;
  /** Files kept: `altis.log` and `altis.log.1` ... Default 5, at most 10. */
  files?: number;
  /**
   * Also write every line to `process.stdout`, the same redacted JSON line as in the file (ruling R59: Docker and PM2
   * collect stdout). Default false. It works without the file too, when that cannot be used.
   */
  stdout?: boolean;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_FILES = 5;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT = /pass|secret|token|key|authorization|cookie|email|phone/i;
const REDACTED = '[redacted]';

/** The registered personal column names and JSON paths, lower case without underscores (read once). */
const PERSONAL_KEYS: ReadonlySet<string> = personalLogKeys();

/** True when the value of a field named `key` is not written: a secret-like name, or a personal column's. */
function redacted(key: string): boolean {
  return REDACT.test(key) || PERSONAL_KEYS.has(key.toLowerCase().replace(/_/g, ''));
}

/** Levels of nesting kept below a field; a container deeper than this becomes "[max depth]". */
const MAX_DEPTH = 6;
/** Array items and object keys kept per container. */
const MAX_ITEMS = 100;
/** Longest text kept, in UTF-16 units: a line stays far below what one `write` handles in one piece. */
const MAX_TEXT = 8192;

/** Names the line itself uses; a field with one of these names is written as `_t`, `_level`, `_msg`. */
const RESERVED = new Set(['t', 'level', 'msg']);

// ---------------------------------------------------------------------------------------------------------------
// Serialising values

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[truncated]` : text;
}

const UNSERIALIZABLE = '[unserializable]';

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Stack traces help while developing and are left out of production builds (the check is compiled out there). */
function stacksAllowed(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ !== 'production';
}

function serializeError(error: Error, depth: number, path: Set<object>): Record<string, unknown> {
  const entries: [string, unknown][] = [
    ['name', clip(String(attempt(() => error.name) ?? 'Error'))],
    ['message', clip(String(attempt(() => error.message) ?? ''))],
  ];
  const code = attempt(() => (error as { code?: unknown }).code);
  if (typeof code === 'string' || typeof code === 'number') entries.push(['code', code]);
  if (isDomainError(error)) {
    const status = attempt(() => error.status);
    if (status !== undefined) entries.push(['status', status]);
    const detail = attempt(() => error.detail);
    if (detail !== undefined) entries.push(['detail', clip(detail)]);
    const meta = attempt(() => error.meta);
    if (meta !== undefined) entries.push(['meta', serializeChild(meta, depth + 1, path)]);
  }
  const cause = attempt(() => error.cause);
  if (cause !== undefined) entries.push(['cause', serializeChild(cause, depth + 1, path)]);
  const stack = attempt(() => error.stack);
  if (stacksAllowed() && typeof stack === 'string') entries.push(['stack', clip(stack)]);
  return Object.fromEntries(entries);
}

/**
 * The fields of a plain object, redacted by name. `errorShaped`: the object is an error made safe to log (safe-error.ts
 * loggableError) or one of its links, whose `name` is the error's class and is kept.
 */
function serializeObject(object: object, depth: number, path: Set<object>, errorShaped = false): Record<string, unknown> {
  const keys = Object.keys(object);
  const entries: [string, unknown][] = [];
  for (const key of keys.slice(0, MAX_ITEMS)) {
    if (redacted(key) && !(key === 'name' && errorShaped)) {
      entries.push([key, REDACTED]);
      continue;
    }
    const value = serializeChild(readProperty(object, key), depth + 1, path, errorShaped && (key === 'cause' || key === 'errors'));
    if (value !== undefined) entries.push([key, value]);
  }
  if (keys.length > MAX_ITEMS) entries.push(['…', `[+${keys.length - MAX_ITEMS} more]`]);
  return Object.fromEntries(entries);
}

/** `object[key]`, or "[unserializable]" when reading it throws (a getter). */
function readProperty(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key];
  } catch {
    return UNSERIALIZABLE;
  }
}

/** `serialize`, made safe: a value whose inspection throws (a Proxy, a hostile getter) becomes "[unserializable]". */
function serializeChild(value: unknown, depth: number, path: Set<object>, errorShaped = false): unknown {
  try {
    return serialize(value, depth, path, errorShaped);
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * A JSON-safe copy of `value`, or `undefined` when it should be left out (undefined, functions). `path` holds the
 * containers being walked right now, so that only a real cycle is called "[circular]".
 */
function serialize(value: unknown, depth: number, path: Set<object>, errorShaped = false): unknown {
  switch (typeof value) {
    case 'string':
      return clip(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
    case 'symbol':
      return value.toString();
    case 'undefined':
    case 'function':
      return undefined;
  }
  if (value === null) return null;
  const object = value as object;
  if (path.has(object)) return '[circular]';
  if (depth > MAX_DEPTH) return '[max depth]';
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) return `[binary ${object.byteLength} bytes]`;

  path.add(object);
  try {
    if (object instanceof Error) {
      // A raw database driver error, or one with such an error below it, is written as its safe fields only.
      const safe = loggableError(object);
      return safe === object ? serializeError(object, depth, path) : serializeObject(safe as object, depth, path, true);
    }
    if (Array.isArray(object)) {
      const items: unknown[] = object.slice(0, MAX_ITEMS).map((item) => serializeChild(item, depth + 1, path, errorShaped) ?? null);
      if (object.length > MAX_ITEMS) items.push(`[+${object.length - MAX_ITEMS} more]`);
      return items;
    }
    return serializeObject(object, depth, path, errorShaped);
  } finally {
    path.delete(object);
  }
}

/** `[name, serialized value]` for every field of `fields` that is to be written, redacted by name. */
function fieldEntries(fields: LogFields): [string, unknown][] {
  const entries: [string, unknown][] = [];
  const path = new Set<object>();
  for (const key of Object.keys(fields)) {
    const name = RESERVED.has(key) ? `_${key}` : key;
    if (redacted(key)) {
      entries.push([name, REDACTED]);
      continue;
    }
    const value = serializeChild(readProperty(fields, key), 1, path);
    if (value !== undefined) entries.push([name, value]);
  }
  return entries;
}

/** The fields argument as entries: an object is spread, anything else (a mistake, but not worth losing) goes under `fields`. */
function argumentEntries(fields: unknown): [string, unknown][] {
  if (fields === undefined || fields === null) return [];
  if (typeof fields === 'object' && !Array.isArray(fields)) return fieldEntries(fields as LogFields);
  const value = serializeChild(fields, 1, new Set());
  return value === undefined ? [] : [['fields', value]];
}

function messageText(msg: unknown): string {
  try {
    return clip(String(msg));
  } catch {
    return '[unprintable]';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Failures of the log itself

let reported = false;

/** One notice per process on stderr, whichever logger it comes from and whatever failed. */
function reportOnce(error: unknown, target: string): void {
  if (reported) return;
  reported = true;
  const code = attempt(() => (error as { code?: unknown }).code);
  const reason =
    typeof code === 'string' && !isDomainError(error)
      ? code
      : error instanceof Error
        ? error.message
        : String(error);
  const text =
    `ALTIS: log ${target} tidak dapat ditulis (${clip(reason).slice(0, 300)}); kegagalan berikutnya tidak dilaporkan / ` +
    `the log ${target} cannot be written (${clip(reason).slice(0, 300)}); further failures are not reported\n`;
  try {
    process.stderr.write(text);
  } catch {
    // nowhere left to complain
  }
}

/** The line on stdout; a failure, synchronous or reported by the stream, is the same single notice as for the file. */
function writeStdout(line: string): void {
  try {
    process.stdout.write(line, (error?: Error | null) => {
      if (error) reportOnce(error, 'stdout');
    });
  } catch (error) {
    reportOnce(error, 'stdout');
  }
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * A logger writing to `DATA_DIR/logs/altis.log` (see the top of this file for the format and the rules).
 *
 * The file is opened on the first line that passes the level, so a logger that never writes creates nothing. A
 * `logs` folder that is a symbolic link out of DATA_DIR (which `dataPath` refuses) leaves a logger that writes
 * nothing and says so once on stderr, rather than a server that cannot start.
 *
 * @throws RangeError when `level`, `maxBytes` or `files` is not acceptable
 */
export function createLogger(options: LoggerOptions): Logger {
  const { dataDir, level, maxBytes = DEFAULT_MAX_BYTES, files = DEFAULT_FILES, stdout = false } = options;
  if (!Object.prototype.hasOwnProperty.call(RANK, level)) {
    throw new RangeError(`createLogger: level must be one of ${Object.keys(RANK).join(', ')}`);
  }
  let target = 'DATA_DIR/logs/altis.log';
  function openSink(): RotatingFile | undefined {
    try {
      target = dataPath(dataDir, 'logs', 'altis.log');
      return createRotatingFile(target, {
        maxBytes,
        files,
        lockPath: dataPath(dataDir, 'logs', 'rotate.lock'),
        onError: (error) => reportOnce(error, target),
      });
    } catch (error) {
      if (error instanceof RangeError) throw error; // maxBytes or files
      reportOnce(error, target);
      return undefined;
    }
  }
  const sink = openSink();
  const threshold = RANK[level];

  function logger(inherited: [string, unknown][]): Logger {
    function write(at: LogLevel, msg: string, fields?: LogFields): void {
      if (RANK[at] < threshold || (sink === undefined && !stdout)) return;
      let line: string;
      try {
        const merged = new Map<string, unknown>(inherited);
        for (const [name, value] of argumentEntries(fields)) merged.set(name, value);
        const entries: [string, unknown][] = [
          ['t', new Date().toISOString()],
          ['level', at],
          ['msg', messageText(msg)],
          ...merged,
        ];
        line = `${JSON.stringify(Object.fromEntries(entries))}\n`;
      } catch {
        line = `${JSON.stringify({ t: new Date().toISOString(), level: at, msg: messageText(msg), logError: 'unserializable_fields' })}\n`;
      }
      if (sink !== undefined) {
        try {
          sink.append(line);
        } catch (error) {
          reportOnce(error, target);
        }
      }
      if (stdout) writeStdout(line);
    }

    return {
      debug: (msg, fields) => write('debug', msg, fields),
      info: (msg, fields) => write('info', msg, fields),
      warn: (msg, fields) => write('warn', msg, fields),
      error: (msg, fields) => write('error', msg, fields),
      child(fields) {
        const own = new Map<string, unknown>(inherited);
        let added: [string, unknown][];
        try {
          added = argumentEntries(fields);
        } catch {
          added = [['logError', 'unserializable_fields']];
        }
        for (const [name, value] of added) own.set(name, value);
        return logger([...own]);
      },
    };
  }

  return logger([]);
}
