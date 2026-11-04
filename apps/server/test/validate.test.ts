import { isDomainError } from '@altis/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_PROBLEM_ERRORS } from '../src/http/problem.js';
import type { AppEnv } from '../src/http/request-id.js';
import { notWellFormed, validateInput, type InputSchemas } from '../src/http/validate.js';

// Step 11 refuses text that is not well-formed UTF-16 (a lone surrogate) wherever a handler could see it: the path
// params, the query and the JSON body (route-runtime.test.ts covers the HTTP side). notWellFormed is the walk.

describe('notWellFormed', () => {
  it('finds lone surrogates in values at any depth: {path, code: invalid_format}, never the value', () => {
    expect(notWellFormed('\ud800')).toEqual([{ path: '', code: 'invalid_format' }]);
    expect(notWellFormed({ id: 'abc\udc00' })).toEqual([{ path: 'id', code: 'invalid_format' }]);
    // A query key given twice is an array of strings.
    expect(notWellFormed({ q: ['ok', 'x\ud83d'] })).toEqual([{ path: 'q.1', code: 'invalid_format' }]);
    expect(notWellFormed({ a: { b: [{ c: '\udfff\ud800' }] } })).toEqual([{ path: 'a.b.0.c', code: 'invalid_format' }]);
  });

  it('an object key: {path of its object, code: invalid_key}; its value is not looked into', () => {
    expect(notWellFormed({ m: { '\ud800': '\ud800', ok: 'v' } })).toEqual([{ path: 'm', code: 'invalid_key' }]);
    expect(notWellFormed({ '\udc00x': 1 })).toEqual([{ path: '', code: 'invalid_key' }]);
  });

  it('well-formed text, surrogate pairs and other JSON values pass', () => {
    expect(notWellFormed({ s: '\u{1F600}', n: 1, b: true, z: null, l: ['😀'], e: '' })).toEqual([]);
    expect(notWellFormed(undefined)).toEqual([]);
    expect(notWellFormed({ '\u{1F600}': 'ok' })).toEqual([]);
  });

  it('stops at MAX_PROBLEM_ERRORS entries', () => {
    expect(notWellFormed(Array.from({ length: 500 }, () => '\ud800'))).toHaveLength(MAX_PROBLEM_ERRORS);
    const keys = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`${i}\ud800`, 1]));
    expect(notWellFormed(keys)).toHaveLength(MAX_PROBLEM_ERRORS);
  });
});

describe('validateInput', () => {
  /** The `errors` of the VALIDATION_FAILED that validateInput throws for `text` against `schemas`, or 'passed'. */
  async function errorsOf(schemas: InputSchemas, text: string): Promise<unknown> {
    const app = new Hono<AppEnv>();
    app.post('/x', async (c) => {
      try {
        await validateInput(c, schemas);
        return c.json({ errors: 'passed' });
      } catch (error) {
        if (isDomainError(error) && error.code === 'VALIDATION_FAILED') return c.json({ errors: error.meta?.errors });
        throw error;
      }
    });
    const res = await app.request('/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
    return ((await res.json()) as { errors: unknown }).errors;
  }

  it('never names a key the client chose: a lone surrogate under an unknown key is refused without its name', async () => {
    const errors = await errorsOf({ body: z.strictObject({ a: z.string().optional() }) }, '{"zzz":"\\ud800"}');
    expect(errors).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    expect(JSON.stringify(errors)).not.toContain('zzz');
    const long = 'k'.repeat(10_000);
    const big = await errorsOf({ body: z.strictObject({ a: z.string().optional() }) }, `{"${long}":{"x":"\\ud800"}}`);
    expect(JSON.stringify(big)).not.toContain(long);
  });

  it('a lone surrogate under a declared key is still refused at that path', async () => {
    const schema = z.strictObject({ a: z.string().optional(), deep: z.strictObject({ t: z.string() }).optional() });
    expect(await errorsOf({ body: schema }, '{"a":"x\\ud800"}')).toEqual([{ path: 'a', code: 'invalid_format' }]);
    expect(await errorsOf({ body: schema }, '{"deep":{"t":"\\udc00"}}')).toEqual([{ path: 'deep.t', code: 'invalid_format' }]);
    expect(await errorsOf({ body: schema }, '{"a":"ok"}')).toBe('passed');
  });
});
