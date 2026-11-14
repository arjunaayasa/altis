import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '../src/logger.js';
import { useDataDir } from './support.js';

const dirs = useDataDir();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Entry = Record<string, unknown>;

function logDir(): string {
  return path.join(dirs.dataDir, 'logs');
}

function readLines(name = 'altis.log'): Entry[] {
  const text = fs.readFileSync(path.join(logDir(), name), 'utf8');
  expect(text === '' || text.endsWith('\n')).toBe(true);
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Entry);
}

function only(): Entry {
  const lines = readLines();
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function make(extra: Partial<Parameters<typeof createLogger>[0]> = {}): Logger {
  return createLogger({ dataDir: dirs.dataDir, level: 'debug', ...extra });
}

describe('line format', () => {
  it('writes one JSON object per line with t, level and msg first, then the fields', () => {
    make().info('buku dipinjam', { memberId: 'm-1', count: 2 });
    const text = fs.readFileSync(path.join(logDir(), 'altis.log'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(2); // exactly one line
    const entry = JSON.parse(text) as Entry;
    expect(Object.keys(entry)).toEqual(['t', 'level', 'msg', 'memberId', 'count']);
    expect(entry).toMatchObject({ level: 'info', msg: 'buku dipinjam', memberId: 'm-1', count: 2 });
  });

  it('stamps t as ISO-8601 UTC with milliseconds', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T05:30:12.345Z'));
    make().warn('x');
    expect(only()['t']).toBe('2026-10-27T05:30:12.345Z');
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('has a %s method that sets the level', (level) => {
    make()[level]('m');
    expect(only()['level']).toBe(level);
  });

  it('works without fields, and keeps the line on one line however the message looks', () => {
    make().info('two\nlines\r\nand "quotes"');
    expect(only()['msg']).toBe('two\nlines\r\nand "quotes"');
  });

  it('keeps fields that clash with t, level and msg under an underscore name instead of overwriting them', () => {
    make().info('real', { t: 'x', level: 'y', msg: 'z', other: 1 });
    const entry = only();
    expect(entry).toMatchObject({ level: 'info', msg: 'real', _t: 'x', _level: 'y', _msg: 'z', other: 1 });
    expect(entry['t']).toMatch(/^\d{4}-/);
  });

  it('turns a message that is not a string into text', () => {
    const log = make();
    log.info(42 as unknown as string);
    log.info(undefined as unknown as string);
    log.info(Object.create(null) as unknown as string);
    expect(readLines().map((l) => l['msg'])).toEqual(['42', 'undefined', '[unprintable]']);
  });

  it('cuts a very long message or string field, so that a line stays one cheap write', () => {
    make().info('m'.repeat(100_000), { body: 'b'.repeat(100_000) });
    const entry = only();
    expect((entry['msg'] as string).length).toBeLessThan(9_000);
    expect(entry['msg']).toMatch(/…\[truncated\]$/);
    expect((entry['body'] as string).length).toBeLessThan(9_000);
  });

  it('writes to DATA_DIR/logs/altis.log, creating the folder', () => {
    expect(fs.existsSync(logDir())).toBe(false);
    make().info('x');
    expect(fs.readdirSync(logDir())).toEqual(['altis.log']);
  });

  it('creates nothing until something is logged at a level that passes', () => {
    make({ level: 'error' }).info('quiet');
    expect(fs.existsSync(logDir())).toBe(false);
  });
});

describe('levels', () => {
  it.each([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ] as const)('with level %s writes %j', (level, expected) => {
    const log = make({ level });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(readLines().map((l) => l['level'])).toEqual(expected);
  });

  it('does not even look at the fields of a line it drops', () => {
    const trap = {
      get boom(): never {
        throw new Error('must not be read');
      },
    };
    make({ level: 'error' }).debug('x', trap);
    expect(fs.existsSync(logDir())).toBe(false);
  });

  it('refuses an unknown level when the logger is made', () => {
    expect(() => createLogger({ dataDir: dirs.dataDir, level: 'trace' as never })).toThrow(RangeError);
  });
});

describe('redaction', () => {
  it.each([
    'password',
    'Password',
    'db_password',
    'passwd',
    'secret',
    'clientSecret',
    'token',
    'csrfToken',
    'cronToken',
    'apiKey',
    'api_key',
    'sessionKey',
    'privateKey',
    'keyring',
    'authorization',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'email',
    'userEmail',
    'phone',
    'phoneNumber',
    'MOBILE_PHONE',
  ])('redacts the field %s', (key) => {
    make().info('x', { [key]: 'sensitive-value', keep: 'visible' });
    const entry = only();
    expect(entry[key]).toBe('[redacted]');
    expect(entry['keep']).toBe('visible');
    expect(JSON.stringify(entry)).not.toContain('sensitive-value');
  });

  it.each([null, 0, 12345, true, false, ['a', 'b'], { nested: 'object' }, ''])('redacts a sensitive field whatever its value (%j)', (value) => {
    make().info('x', { password: value });
    expect(only()['password']).toBe('[redacted]');
  });

  it.each(['user', 'id', 'path', 'status', 'method', 'ip', 'durationMs', 'memberId', 'kid'])('keeps the field %s', (key) => {
    make().info('x', { [key]: 'plain' });
    expect(only()[key]).toBe('plain');
  });

  it('redacts by key name wherever it is, in nested objects and arrays', () => {
    make().info('request', {
      req: {
        headers: { authorization: 'Bearer abc', 'user-agent': 'curl', cookie: 'sid=1' },
        user: { id: 7, email: 'a@b.example', phone: '0812' },
      },
      list: [{ token: 't1', n: 1 }, 'plain', [{ secret: 's' }]],
    });
    const entry = only();
    expect(entry['req']).toEqual({
      headers: { authorization: '[redacted]', 'user-agent': 'curl', cookie: '[redacted]' },
      user: { id: 7, email: '[redacted]', phone: '[redacted]' },
    });
    expect(entry['list']).toEqual([{ token: '[redacted]', n: 1 }, 'plain', [{ secret: '[redacted]' }]]);
    expect(JSON.stringify(entry)).not.toMatch(/Bearer abc|sid=1|a@b\.example|0812|"t1"/);
  });

  it('redacts the fields given to child() as well', () => {
    make().child({ apiKey: 'k-123', component: 'mailer' }).info('x');
    expect(only()).toMatchObject({ apiKey: '[redacted]', component: 'mailer' });
  });

  it('redacts inside the meta of a DomainError and inside an error field', () => {
    make().error('failed', {
      err: new DomainError('INVALID_CONFIG', { meta: { reason: 'x', password: 'pw-value', nested: { token: 'token-value' } } }),
    });
    const entry = only();
    expect(entry['err']).toMatchObject({ meta: { reason: 'x', password: '[redacted]', nested: { token: '[redacted]' } } });
    expect(JSON.stringify(entry)).not.toMatch(/pw-value|token-value/);
  });

  it('matches by substring and ignoring case, as the brief says (so "monkey" goes too)', () => {
    make().info('x', { monkey: 1, bypass: 2, EMAILADDRESS: 3 });
    expect(only()).toMatchObject({ monkey: '[redacted]', bypass: '[redacted]', EMAILADDRESS: '[redacted]' });
  });

  it('does not touch the message', () => {
    make().info('password reset requested');
    expect(only()['msg']).toBe('password reset requested');
  });
});

describe('values', () => {
  it('survives a circular structure', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    a['list'] = [a, { back: a }];
    make().info('x', { a });
    // `name` is redacted as a personal column's name (logger-personal.test.ts).
    expect(only()['a']).toEqual({ name: '[redacted]', self: '[circular]', list: ['[circular]', { back: '[circular]' }] });
  });

  it('is not fooled by the same object appearing twice without a cycle', () => {
    const shared = { n: 1 };
    make().info('x', { one: shared, two: shared, both: [shared, shared] });
    expect(only()).toMatchObject({ one: { n: 1 }, two: { n: 1 }, both: [{ n: 1 }, { n: 1 }] });
  });

  it('stops at a depth limit', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: 'bottom' } } } } } } } };
    make().info('x', { deep, shallow: { a: { b: 'ok' } } });
    const entry = only();
    expect(entry['shallow']).toEqual({ a: { b: 'ok' } });
    expect(JSON.stringify(entry['deep'])).toContain('[max depth]');
    expect(JSON.stringify(entry['deep'])).not.toContain('bottom');
  });

  it('caps the number of array items and object keys', () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    make().info('x', { big, wide });
    const entry = only();
    expect((entry['big'] as unknown[]).length).toBe(101);
    expect((entry['big'] as unknown[])[100]).toBe('[+400 more]');
    expect(Object.keys(entry['wide'] as object)).toHaveLength(101);
    expect((entry['wide'] as Record<string, unknown>)['…']).toBe('[+400 more]');
  });

  it('writes bigint, Date, non-finite numbers, symbols and binary data as text, and drops undefined and functions', () => {
    make().info('x', {
      big: 12345678901234567890n,
      when: new Date('2026-10-27T01:02:03.004Z'),
      badDate: new Date(Number.NaN),
      nan: Number.NaN,
      inf: Infinity,
      sym: Symbol('s'),
      bytes: Buffer.from('abc'),
      arrayBuffer: new ArrayBuffer(8),
      missing: undefined,
      fn: () => 1,
      nothing: null,
    });
    const entry = only();
    expect(entry).toMatchObject({
      big: '12345678901234567890',
      when: '2026-10-27T01:02:03.004Z',
      badDate: 'Invalid Date',
      nan: 'NaN',
      inf: 'Infinity',
      sym: 'Symbol(s)',
      bytes: '[binary 3 bytes]',
      arrayBuffer: '[binary 8 bytes]',
      nothing: null,
    });
    expect(entry).not.toHaveProperty('missing');
    expect(entry).not.toHaveProperty('fn');
  });

  it('writes class instances by their own enumerable properties', () => {
    class Member {
      id = 'm-1';
      password = 'pw';
    }
    make().info('x', { member: new Member() });
    expect(only()['member']).toEqual({ id: 'm-1', password: '[redacted]' });
  });
});

describe('errors', () => {
  it('writes an Error as {name, message} plus a stack outside the production profile', () => {
    make().error('x', { err: new TypeError('bad thing') });
    const err = only()['err'] as Record<string, unknown>;
    expect(err).toMatchObject({ name: 'TypeError', message: 'bad thing' });
    expect(err['stack']).toEqual(expect.stringContaining('bad thing'));
    expect(Object.keys(err).sort()).toEqual(['message', 'name', 'stack']);
  });

  it('leaves the stack out of the production profile', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    make().error('x', { err: new Error('bad thing') });
    expect(only()['err']).toEqual({ name: 'Error', message: 'bad thing' });
  });

  it('adds the code of a system error', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    make().error('x', { err: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED', errno: -61 }) });
    expect(only()['err']).toEqual({ name: 'Error', message: 'connect failed', code: 'ECONNREFUSED' });
  });

  it('writes a DomainError with code, status, detail and meta', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    make().error('x', {
      err: new DomainError('DB_UNAVAILABLE', { detail: 'tidak terhubung / not connected', meta: { host: 'db', attempts: 3 } }),
    });
    expect(only()['err']).toEqual({
      name: 'DomainError',
      message: 'DB_UNAVAILABLE: tidak terhubung / not connected',
      code: 'DB_UNAVAILABLE',
      status: 503,
      detail: 'tidak terhubung / not connected',
      meta: { host: 'db', attempts: 3 },
    });
  });

  it('follows the cause chain, as far as the depth limit allows', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    const root = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    make().error('x', { err: new DomainError('DB_UNAVAILABLE', { cause: root }) });
    expect(only()['err']).toMatchObject({
      code: 'DB_UNAVAILABLE',
      cause: { name: 'Error', message: 'socket hang up', code: 'ECONNRESET' },
    });
  });

  it('writes an error that is the whole of a field named err, error or cause alike', () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    make().error('x', { error: new RangeError('r') });
    expect(only()['error']).toEqual({ name: 'RangeError', message: 'r' });
  });

  describe('database driver errors (safe-cause policy: code, errno, sqlState, constraint)', () => {
    const VALUE = 'Budi Santoso 0812-3456-7890';
    /** mysql2's ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: message, sqlMessage and sql repeat the member's input. */
    const mysqlError = (): Error =>
      Object.assign(new Error(`Incorrect string value: '${VALUE}' for column 'name' at row 1`), {
        code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
        errno: 1366,
        sqlState: 'HY000',
        sqlMessage: `Incorrect string value: '${VALUE}' for column 'name' at row 1`,
        sql: `insert into members (name) values ('${VALUE}')`,
      });
    /** pg's unique violation: `detail` holds the key and the value. */
    const pgError = (): Error =>
      Object.assign(new Error('duplicate key value violates unique constraint "uq_members_phone"'), {
        name: 'error',
        code: '23505',
        severity: 'ERROR',
        constraint: 'uq_members_phone',
        detail: `Key (phone)=(${VALUE}) already exists.`,
      });

    it.each([
      ['test', 'mysql2', mysqlError, { name: 'Error', code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366, sqlState: 'HY000' }],
      ['production', 'pg', pgError, { name: 'error', code: '23505', constraint: 'uq_members_phone' }],
    ] as const)('%s profile, %s: only the safe fields, no message, stack, SQL or value', (profile, _driver, make1, expected) => {
      vi.stubGlobal('__BUILD_PROFILE__', profile);
      make().error('x', { err: make1() });
      const line = only();
      expect(line['err']).toEqual(expected);
      expect(JSON.stringify(line)).not.toContain('Budi');
    });

    it('below a DomainError and below a wrapper whose message repeats the driver text', () => {
      const wrapped = new Error(`saving failed: ${mysqlError().message}`, { cause: mysqlError() });
      make().error('x', { err: new DomainError('INTERNAL', { cause: mysqlError() }), other: wrapped });
      const line = only();
      expect(JSON.stringify(line)).not.toContain('Budi');
      expect(line['err']).toMatchObject({ code: 'INTERNAL', cause: { code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366 } });
      expect(line['other']).toMatchObject({ name: 'Error', cause: { code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' } });
    });

    it('keeps the message of a wrapper that does not repeat the driver text', () => {
      vi.stubGlobal('__BUILD_PROFILE__', 'production');
      make().error('x', { err: new Error('saving the member failed', { cause: mysqlError() }) });
      expect(only()['err']).toEqual({
        name: 'Error',
        message: 'saving the member failed',
        cause: { name: 'Error', code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366, sqlState: 'HY000' },
      });
    });
  });

  it('survives an error whose properties throw', () => {
    const nasty = new Error('nasty');
    Object.defineProperty(nasty, 'code', {
      get() {
        throw new Error('getter');
      },
    });
    make().error('x', { err: nasty });
    expect(only()['err']).toMatchObject({ name: 'Error', message: 'nasty' });
  });
});

describe('child', () => {
  it('adds its fields to every line and shares the file with its parent', () => {
    const log = make();
    const req = log.child({ reqId: 'r-1' });
    req.info('start', { path: '/a' });
    log.info('other');
    req.warn('slow');
    expect(readLines()).toMatchObject([
      { msg: 'start', reqId: 'r-1', path: '/a' },
      { msg: 'other' },
      { msg: 'slow', reqId: 'r-1', level: 'warn' },
    ]);
    expect(readLines()[1]).not.toHaveProperty('reqId');
  });

  it('merges nested children, the nearer one and the call fields winning on the same name', () => {
    const log = make().child({ a: 1, b: 1, c: 1 }).child({ b: 2, c: 2 });
    log.info('x', { c: 3 });
    expect(only()).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it('keeps the level of its parent', () => {
    const child = make({ level: 'warn' }).child({ a: 1 });
    child.info('no');
    child.error('yes');
    expect(readLines().map((l) => l['msg'])).toEqual(['yes']);
  });
});

describe('rotation', () => {
  it('rotates altis.log to altis.log.1 past maxBytes, and keeps at most `files` files', () => {
    const log = make({ maxBytes: 400, files: 3 });
    for (let i = 0; i < 40; i += 1) log.info('line', { i, pad: 'x'.repeat(40) });
    const names = fs.readdirSync(logDir()).sort();
    expect(names).toEqual(['altis.log', 'altis.log.1', 'altis.log.2']);
    const newest = readLines('altis.log');
    expect(newest.at(-1)).toMatchObject({ i: 39 });
    for (const name of names) for (const entry of readLines(name)) expect(entry['msg']).toBe('line'); // whole lines only
    // newest first: every line of altis.log is newer than every line of altis.log.1, and so on
    const first = (name: string): number => readLines(name)[0]!['i'] as number;
    expect(first('altis.log')).toBeGreaterThan(readLines('altis.log.1').at(-1)!['i'] as number);
    expect(first('altis.log.1')).toBeGreaterThan(readLines('altis.log.2').at(-1)!['i'] as number);
  });

  it('writes a line that reaches the limit to the new file rather than losing it', () => {
    const log = make({ maxBytes: 200, files: 10 }); // room for every line
    for (let i = 0; i < 12; i += 1) log.info('line', { i });
    expect(fs.readdirSync(logDir()).length).toBeGreaterThan(2);
    const all = fs
      .readdirSync(logDir())
      .flatMap((name) => readLines(name))
      .map((l) => l['i'] as number)
      .sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('leaves no claim file behind', () => {
    const log = make({ maxBytes: 200, files: 3 });
    for (let i = 0; i < 20; i += 1) log.info('line', { i });
    expect(fs.readdirSync(logDir())).not.toContain('rotate.lock');
  });

  it('shares the files with another logger on the same DATA_DIR, as another worker process does', () => {
    const a = make({ maxBytes: 600, files: 10 });
    const b = make({ maxBytes: 600, files: 10 });
    for (let i = 0; i < 30; i += 1) {
      a.info('a', { i });
      b.info('b', { i });
    }
    const seen = fs
      .readdirSync(logDir())
      .flatMap((name) => readLines(name))
      .map((l) => `${String(l['msg'])}${String(l['i'])}`)
      .sort();
    const expected = Array.from({ length: 30 }, (_, i) => [`a${i}`, `b${i}`]).flat().sort();
    expect(seen).toEqual(expected);
  });

  it('refuses sizes that make no sense when the logger is made', () => {
    expect(() => make({ maxBytes: 0 })).toThrow(RangeError);
    expect(() => make({ files: 0 })).toThrow(RangeError);
    expect(() => make({ files: 11 })).toThrow(RangeError);
  });
});

describe('never throws', () => {
  /** A logger module of its own, so that the once-per-process notice starts afresh. */
  async function fresh(): Promise<typeof import('../src/logger.js')> {
    vi.resetModules();
    return import('../src/logger.js');
  }

  function captureStderr(): { text: () => string; calls: () => number } {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { text: () => writes.join(''), calls: () => writes.length };
  }

  it('swallows a write failure and says so once on stderr, however many lines fail, in any logger', async () => {
    const stderr = captureStderr();
    const { createLogger: create } = await fresh();
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.writeFile(path.join(dirs.dataDir, 'logs'), 'a file where the folder should be');
    const a = create({ dataDir: dirs.dataDir, level: 'debug' });
    const b = a.child({ x: 1 });
    expect(() => {
      a.info('1');
      a.error('2');
      b.warn('3');
      create({ dataDir: dirs.dataDir, level: 'debug' }).info('4');
    }).not.toThrow();
    expect(stderr.calls()).toBe(1);
    expect(stderr.text()).toMatch(/altis\.log/);
    expect(stderr.text()).toMatch(/ENOTDIR|ENOENT/);
    expect(stderr.text().endsWith('\n')).toBe(true);
  });

  it('keeps logging once the problem is gone', async () => {
    captureStderr();
    const { createLogger: create } = await fresh();
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.writeFile(path.join(dirs.dataDir, 'logs'), 'blocker');
    const log = create({ dataDir: dirs.dataDir, level: 'debug' });
    log.info('lost');
    await fsp.rm(path.join(dirs.dataDir, 'logs'));
    log.info('kept');
    expect(readLines().map((l) => l['msg'])).toEqual(['kept']);
  });

  it('does not throw, and says so once, when the logs folder is a symbolic link out of DATA_DIR', async () => {
    const stderr = captureStderr();
    const { createLogger: create } = await fresh();
    await fsp.mkdir(path.join(dirs.root, 'elsewhere'), { recursive: true });
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.symlink(path.join(dirs.root, 'elsewhere'), path.join(dirs.dataDir, 'logs'));
    const log = create({ dataDir: dirs.dataDir, level: 'debug' });
    expect(() => log.info('nowhere')).not.toThrow();
    expect(stderr.calls()).toBe(1);
    expect(stderr.text()).toMatch(/symbolic link|tautan simbolik/);
    expect(fs.readdirSync(path.join(dirs.root, 'elsewhere'))).toEqual([]);
  });

  it('reports a rotation failure through the same single notice and still writes the line', async () => {
    const stderr = captureStderr();
    const { createLogger: create } = await fresh();
    const log = create({ dataDir: dirs.dataDir, level: 'debug', maxBytes: 100, files: 2 });
    log.info('first', { pad: 'x'.repeat(60) });
    fs.mkdirSync(path.join(logDir(), 'altis.log.1', 'blocker'), { recursive: true }); // rename onto it fails
    log.info('second', { pad: 'x'.repeat(60) });
    log.info('third', { pad: 'x'.repeat(60) });
    expect(readLines().map((l) => l['msg'])).toEqual(['first', 'second', 'third']);
    expect(stderr.calls()).toBe(1);
  });

  it('survives fields that throw when read, serialise or stringify', () => {
    const log = make();
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    const getter = {
      get boom(): never {
        throw new Error('getter');
      },
      fine: 1,
    };
    expect(() => {
      log.info('proxy', { throwing });
      log.info('getter', getter);
      log.info('after');
    }).not.toThrow();
    const lines = readLines();
    expect(lines.map((l) => l['msg'])).toEqual(['proxy', 'getter', 'after']);
    expect(lines[0]).toMatchObject({ throwing: '[unserializable]' });
    expect(lines[1]).toMatchObject({ fine: 1, boom: '[unserializable]' });
  });

  it('survives a fields object that cannot even be listed, in a call and in child()', () => {
    const log = make();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    expect(() => {
      log.info('call', hostile);
      log.child(hostile).info('child');
    }).not.toThrow();
    expect(readLines()).toMatchObject([
      { msg: 'call', logError: 'unserializable_fields' },
      { msg: 'child', logError: 'unserializable_fields' },
    ]);
  });

  it('survives fields that are not an object at all', () => {
    const log = make();
    expect(() => {
      log.info('a', null as never);
      log.info('b', 'text' as never);
      log.info('c', 5 as never);
      log.info('d', [1, 2] as never);
    }).not.toThrow();
    expect(readLines().map((l) => l['msg'])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('stdout (R59)', () => {
  function captureStdout(): { lines: () => string[]; spy: ReturnType<typeof vi.spyOn> } {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    return { lines: () => writes, spy };
  }

  function captureStderr(): { text: () => string; calls: () => number } {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { text: () => writes.join(''), calls: () => writes.length };
  }

  it('writes nothing to stdout by default, or with stdout: false', () => {
    const out = captureStdout();
    make().info('quiet');
    make({ stdout: false }).info('quiet');
    expect(out.lines()).toEqual([]);
  });

  it('with stdout: true writes each line to stdout as well, identical to the line in the file', () => {
    const out = captureStdout();
    const log = make({ stdout: true });
    log.info('one', { n: 1 });
    log.warn('two');
    const file = fs.readFileSync(path.join(logDir(), 'altis.log'), 'utf8');
    expect(out.lines().join('')).toBe(file);
    expect(out.lines()).toHaveLength(2);
    expect(JSON.parse(out.lines()[0]!)).toMatchObject({ level: 'info', msg: 'one', n: 1 });
    for (const line of out.lines()) expect(line.endsWith('\n')).toBe(true);
  });

  it('writes the redacted line, never the raw fields', () => {
    const out = captureStdout();
    make({ stdout: true }).child({ apiKey: 'k-123' }).error('x', { password: 'pw-1', user: { email: 'a@b.example', id: 7 } });
    const text = out.lines().join('');
    expect(text).not.toMatch(/k-123|pw-1|a@b\.example/);
    expect(JSON.parse(text)).toMatchObject({ apiKey: '[redacted]', password: '[redacted]', user: { email: '[redacted]', id: 7 } });
  });

  it('applies the level, in the logger and in its children', () => {
    const out = captureStdout();
    const log = make({ stdout: true, level: 'warn' });
    log.info('no');
    log.child({ a: 1 }).debug('no');
    log.child({ a: 1 }).error('yes');
    expect(out.lines().map((l) => (JSON.parse(l) as Entry)['msg'])).toEqual(['yes']);
  });

  it('keeps writing to stdout when the log file cannot be used, with one stderr notice', async () => {
    const out = captureStdout();
    const stderr = captureStderr();
    vi.resetModules();
    const { createLogger: create } = await import('../src/logger.js');
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.writeFile(path.join(dirs.dataDir, 'logs'), 'a file where the folder should be');
    const log = create({ dataDir: dirs.dataDir, level: 'debug', stdout: true });
    expect(() => {
      log.info('one');
      log.info('two');
    }).not.toThrow();
    expect(out.lines().map((l) => (JSON.parse(l) as Entry)['msg'])).toEqual(['one', 'two']);
    expect(stderr.calls()).toBe(1);
  });

  it('writes to stdout, and says so once, when the logs folder is a symbolic link out of DATA_DIR', async () => {
    const out = captureStdout();
    const stderr = captureStderr();
    vi.resetModules();
    const { createLogger: create } = await import('../src/logger.js');
    await fsp.mkdir(path.join(dirs.root, 'elsewhere'), { recursive: true });
    await fsp.mkdir(dirs.dataDir, { recursive: true });
    await fsp.symlink(path.join(dirs.root, 'elsewhere'), path.join(dirs.dataDir, 'logs'));
    create({ dataDir: dirs.dataDir, level: 'debug', stdout: true }).info('still visible');
    expect(out.lines().map((l) => (JSON.parse(l) as Entry)['msg'])).toEqual(['still visible']);
    expect(stderr.calls()).toBe(1);
    expect(fs.readdirSync(path.join(dirs.root, 'elsewhere'))).toEqual([]);
  });

  it('swallows a stdout write that throws, keeps the file line, and reports it once on stderr', async () => {
    const stderr = captureStderr();
    vi.spyOn(process.stdout, 'write').mockImplementation((() => {
      throw new Error('stdout is gone');
    }) as typeof process.stdout.write);
    vi.resetModules();
    const { createLogger: create } = await import('../src/logger.js');
    const log = create({ dataDir: dirs.dataDir, level: 'debug', stdout: true });
    expect(() => {
      log.info('one');
      log.info('two');
    }).not.toThrow();
    expect(readLines().map((l) => l['msg'])).toEqual(['one', 'two']);
    expect(stderr.calls()).toBe(1);
    expect(stderr.text()).toContain('stdout');
  });

  it('reports an asynchronous stdout failure (the write callback) once on stderr', async () => {
    const stderr = captureStderr();
    vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, callback?: (error?: Error | null) => void) => {
      callback?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      return true;
    }) as typeof process.stdout.write);
    vi.resetModules();
    const { createLogger: create } = await import('../src/logger.js');
    const log = create({ dataDir: dirs.dataDir, level: 'debug', stdout: true });
    log.info('one');
    log.info('two');
    expect(stderr.calls()).toBe(1);
    expect(stderr.text()).toMatch(/stdout.*EPIPE/);
  });
});
