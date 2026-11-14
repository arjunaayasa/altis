// The bootloader's log: one JSON line per entry on stderr, which every runtime keeps (Passenger's log, PM2,
// `docker logs`, the service wrapper, the terminal). It is also `ctx.log`, which the server uses until it has read
// config.json. Loaded before the Node check, so it uses nothing beyond Node 10.
//
// The log is for the operator: it may name paths and errors. Rescue pages never do (rescue.ts).

export type LogFields = Record<string, unknown>;

/** The shape of the server's Logger (apps/server, Task 13), which `ctx.log` must satisfy. */
export interface BootLog {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): BootLog;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * An error as plain fields: its class (`errorName`), message, code, stack, and the same for its cause (a few levels
 * deep). The class is `errorName` as in the server log, which redacts every field called `name` (a person's name).
 */
export function errorFields(error: unknown, depth?: number): unknown {
  const level = depth === undefined ? 0 : depth;
  if (!(error instanceof Error)) return typeof error === 'string' ? error : String(error);
  const out: LogFields = { errorName: error.name, message: error.message };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out['code'] = code;
  if (typeof error.stack === 'string') out['stack'] = error.stack;
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && level < 4) out['cause'] = errorFields(cause, level + 1);
  return out;
}

function line(level: Level, msg: string, base: LogFields, fields: LogFields | undefined): string {
  const entry: LogFields = { time: new Date().toISOString(), level: level, msg: msg, src: 'app.js' };
  const add = (from: LogFields | undefined): void => {
    if (from === undefined) return;
    for (const key of Object.keys(from)) {
      if (key === 'time' || key === 'level' || key === 'msg') continue;
      const value = from[key];
      entry[key] = value instanceof Error ? errorFields(value) : value;
    }
  };
  add(base);
  add(fields);
  try {
    return JSON.stringify(entry) + '\n';
  } catch {
    return JSON.stringify({ time: entry['time'], level: level, msg: msg, src: 'app.js', note: 'fields not serialisable' }) + '\n';
  }
}

/** A log writing to stderr. Debug lines are dropped. */
export function createLog(base?: LogFields): BootLog {
  const fields: LogFields = base === undefined ? {} : base;
  const write = (level: Level) => (msg: string, more?: LogFields): void => {
    if (level === 'debug') return;
    try {
      process.stderr.write(line(level, msg, fields, more));
    } catch {
      // stderr closed: nothing else to tell
    }
  };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (more: LogFields): BootLog => {
      const merged: LogFields = {};
      for (const key of Object.keys(fields)) merged[key] = fields[key];
      for (const key of Object.keys(more)) merged[key] = more[key];
      return createLog(merged);
    },
  };
}
