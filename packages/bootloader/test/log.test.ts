import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLog, errorFields } from '../src/log.js';

// The bootloader's log (one JSON line per entry on stderr, used until the server has read config.json) writes an
// error's class as `errorName`, the key the server log uses too: there a field called `name` is redacted as a person's
// name, so one key for the class serves both logs, and the class reads in either.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the bootloader log and errors', () => {
  it('errorFields names the class of an error and of each cause `errorName`', () => {
    const error = new TypeError('the release folder is missing', { cause: Object.assign(new RangeError('too deep'), { code: 'E_DEPTH' }) });
    expect(errorFields(error)).toMatchObject({
      errorName: 'TypeError',
      message: 'the release folder is missing',
      cause: { errorName: 'RangeError', message: 'too deep', code: 'E_DEPTH' },
    });
    expect(Object.keys(errorFields(error) as object)).not.toContain('name');
    expect(errorFields('plain text')).toBe('plain text');
  });

  it('a logged error field carries its class as `errorName`', () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    createLog({ runtime: 'standalone' }).error('the server could not start', { error: new SyntaxError('bad config') });
    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', msg: 'the server could not start', src: 'app.js', runtime: 'standalone', error: { errorName: 'SyntaxError', message: 'bad config' } });
  });
});
