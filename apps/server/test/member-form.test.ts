import { DomainError } from '@altis/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { readFormBody } from '../src/http/form.js';
import { safeLanjut } from '../src/opac/akun/lanjut.js';
import { ALL_ROUTES } from '../src/routes.js';

// The member area's HTML form bodies (http/form.ts) and its `lanjut` rule (opac/akun/lanjut.ts).

async function parse(body: string, type = 'application/x-www-form-urlencoded'): Promise<unknown> {
  const app = new Hono();
  app.post('/f', async (c) => {
    try {
      return c.json(await readFormBody(c as never));
    } catch (error) {
      if (error instanceof DomainError) return c.json({ code: error.code, errors: error.meta?.['errors'] }, 400);
      throw error;
    }
  });
  const res = await app.request('/f', { method: 'POST', headers: { 'content-type': type }, body });
  return res.json();
}

describe('readFormBody', () => {
  it('takes `_csrf` out, keeps the other fields and makes indexed names a list in index order', async () => {
    expect(await parse('_csrf=abc&recordIds.1=B&recordIds.0=A&q=Laskar+Pelangi')).toEqual({
      fields: { q: 'Laskar Pelangi', recordIds: ['A', 'B'] },
      csrf: 'abc',
    });
  });

  it('refuses a field sent twice (also `_csrf`), another content type and a body over 16 KB', async () => {
    expect(await parse('a=1&a=2')).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'a', code: 'duplicate_field' }] });
    expect(await parse('_csrf=1&_csrf=2')).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: '_csrf', code: 'duplicate_field' }] });
    expect(await parse('recordIds.0=1&recordIds.0=2')).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await parse('{"a":1}', 'application/json')).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(await parse(`a=${'x'.repeat(16_400)}`)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('safeLanjut', () => {
  it('keeps a path an OPAC GET route serves, with its query', () => {
    expect(safeLanjut('/katalog/01JZ0000000000000000000R01/laskar-pelangi', ALL_ROUTES)).toBe('/katalog/01JZ0000000000000000000R01/laskar-pelangi');
    expect(safeLanjut('/akun/reservasi/baru?cantuman=01JZ0000000000000000000R01', ALL_ROUTES)).toBe('/akun/reservasi/baru?cantuman=01JZ0000000000000000000R01');
    expect(safeLanjut('/cari?q=buku', ALL_ROUTES)).toBe('/cari?q=buku');
  });

  it.each(['//evil.example', '/\\\\evil.example', '/\\evil', 'https://evil.example/', 'javascript:alert(1)', '/admin/login', '/api/v1/auth/me', '/akun/masuk', '/akun/keluar', '/x\ty', ''])(
    'drops %j',
    (value) => {
      expect(safeLanjut(value, ALL_ROUTES)).toBeNull();
    },
  );
});
