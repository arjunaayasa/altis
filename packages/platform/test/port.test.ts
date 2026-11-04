import { DomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { resolvePort } from '../src/port.js';

describe('resolvePort', () => {
  it('prefers ALTIS_PORT over PORT', () => {
    expect(resolvePort({ ALTIS_PORT: '8123', PORT: '3001' })).toEqual({ port: 8123, source: 'ALTIS_PORT' });
  });

  it('prefers ALTIS_PORT over the config port', () => {
    expect(resolvePort({ ALTIS_PORT: '8123' }, 4000)).toEqual({ port: 8123, source: 'ALTIS_PORT' });
  });

  it('falls back to PORT', () => {
    expect(resolvePort({ PORT: '3001' })).toEqual({ port: 3001, source: 'PORT' });
  });

  it('prefers PORT over the config port', () => {
    expect(resolvePort({ PORT: '3001' }, 4000)).toEqual({ port: 3001, source: 'PORT' });
  });

  it('falls back to the config port', () => {
    expect(resolvePort({}, 4000)).toEqual({ port: 4000, source: 'config' });
  });

  it('falls back to 3000', () => {
    expect(resolvePort({})).toEqual({ port: 3000, source: 'default' });
    expect(resolvePort({}, undefined)).toEqual({ port: 3000, source: 'default' });
  });

  it('ignores unrelated variables', () => {
    expect(resolvePort({ PATH: '/bin', ALTIS_DB_PORT: '3306' })).toEqual({ port: 3000, source: 'default' });
  });

  it('treats an undefined or empty value as not set and moves on', () => {
    expect(resolvePort({ ALTIS_PORT: undefined, PORT: '3001' })).toEqual({ port: 3001, source: 'PORT' });
    expect(resolvePort({ ALTIS_PORT: '', PORT: '3001' })).toEqual({ port: 3001, source: 'PORT' });
    expect(resolvePort({ ALTIS_PORT: '  ', PORT: '' }, 4000)).toEqual({ port: 4000, source: 'config' });
  });

  it('accepts the whole valid range and surrounding whitespace', () => {
    expect(resolvePort({ ALTIS_PORT: '1' }).port).toBe(1);
    expect(resolvePort({ ALTIS_PORT: '65535' }).port).toBe(65535);
    expect(resolvePort({ ALTIS_PORT: ' 8080\n' }).port).toBe(8080);
    expect(resolvePort({}, 1).port).toBe(1);
    expect(resolvePort({}, 65535).port).toBe(65535);
  });

  describe('rejects an invalid value with INVALID_CONFIG', () => {
    const expectInvalid = (fn: () => unknown, variable: string, value: string): void => {
      let thrown: unknown;
      try {
        fn();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      const e = thrown as DomainError;
      expect(e.code).toBe('INVALID_CONFIG');
      expect(e.status).toBe(422);
      expect(e.meta).toEqual({ variable, value }); // the input as received: not quoted, not converted
      // User-facing text is bilingual id/en and names the offending source.
      expect(e.detail).toContain(variable);
      expect(e.detail).toContain('harus');
      expect(e.detail).toContain('must');
    };

    it.each(['abc', '80abc', '-1', '1.5', '0x1F90', '1e3', '0', '65536', '99999999999999999999', '+80', '8 080'])(
      'ALTIS_PORT=%j',
      (value) => {
        expectInvalid(() => resolvePort({ ALTIS_PORT: value }), 'ALTIS_PORT', value);
      },
    );

    it.each(['abc', '0', '70000'])('PORT=%j', (value) => {
      expectInvalid(() => resolvePort({ PORT: value }), 'PORT', value);
    });

    it.each([0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('config port %s', (value) => {
      expectInvalid(() => resolvePort({}, value), 'config.port', String(value));
    });

    it('keeps the offending value verbatim in meta and quotes it only in the message', () => {
      const env = { ALTIS_PORT: ' 80abc ' };
      let thrown: unknown;
      try {
        resolvePort(env);
      } catch (e) {
        thrown = e;
      }
      const e = thrown as DomainError;
      expect(e.meta).toEqual({ variable: 'ALTIS_PORT', value: ' 80abc ' });
      expect(e.detail).toContain('(nilai: " 80abc ")');
      expect(e.detail).toContain('(got: " 80abc ")');
    });

    it('does not fall through to a lower-priority source', () => {
      expect(() => resolvePort({ ALTIS_PORT: 'abc', PORT: '3001' }, 4000)).toThrow(DomainError);
      expect(() => resolvePort({ PORT: 'abc' }, 4000)).toThrow(DomainError);
    });

    it('does not check lower-priority sources once a higher one is valid', () => {
      expect(resolvePort({ ALTIS_PORT: '8123', PORT: 'abc' }, 0)).toEqual({ port: 8123, source: 'ALTIS_PORT' });
    });
  });
});
