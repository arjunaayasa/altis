import { parseStrictJson } from '@altis/crypto';
import { DomainError } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { MAX_PROBLEM_ERRORS, type ProblemFieldError } from './problem.js';
import type { AppEnv } from './request-id.js';

// Step 11 of the middleware chain (spec §4.7, §7.4 "Zod strict untuk semua input"): the request's path params, query
// string and JSON body against the route's strict Zod schemas.
//
// - A body is read only when the route declares a `body` schema; it must be `application/json` (a `charset`, when
//   given, must be utf-8), at most 1 000 000 bytes (P10 "< 1 MB", M22), valid UTF-8 and strict JSON: a duplicate key
//   is refused like a syntax error (parseStrictJson). Failures: 415 UNSUPPORTED_MEDIA_TYPE, 413 PAYLOAD_TOO_LARGE,
//   400 INVALID_JSON.
// - A query string is text: query schemas coerce (`z.coerce.number()`, `z.stringbool()`, M5). A key given once is a
//   string, a key given more than once an array of strings (which a scalar schema refuses).
// - Every Zod issue becomes `{path, code}` in one 422 VALIDATION_FAILED (`meta.errors`, sent as the problem's
//   `errors`): the issue path joined with `.`, the Zod issue code; never the input value, nor an unknown key's name.
// - Well-formed text only: once the three parts pass their schemas, a string anywhere in what the handler would get
//   (a value at any depth, or an object key) that is not well-formed UTF-16 (a lone surrogate, which a JSON `\ud800`
//   escape produces) is refused with `{path, code: 'invalid_format'}` (`invalid_key` for a key, at the path of its
//   object). The walk runs on the schema-parsed values, never on the raw input: the strict schemas have already
//   refused unknown keys (unrecognized_keys, at the path of their object), so every path it names is one the route
//   declares, never a key the client chose. No handler ever sees such text: canonical JSON (idempotency hashes,
//   signed documents), the audit chain and the database drivers cannot carry it.
// - A route without a schema for a part does not read it: `body` and `query` are then undefined, `params` the raw
//   path parameters.
// - A `rawBody` route (1c, Task 9: chunked uploads, P10) declares no body schema; its body is checked here only for
//   its type, which must be `multipart/form-data` (else 415 UNSUPPORTED_MEDIA_TYPE), and its size, at most the route's
//   `maxBytes` (else 413 PAYLOAD_TOO_LARGE), before the params and query are parsed. The handler reads it
//   (`rc.c.req.formData()`).

/** The largest JSON body read (P10: "< 1 MB"). */
export const MAX_JSON_BODY_BYTES = 1_000_000;

export interface InputSchemas {
  body?: z.ZodType | undefined;
  query?: z.ZodType | undefined;
  params?: z.ZodType | undefined;
  /** RouteDecl.rawBody: a body the handler reads itself (see the top of this file). */
  rawBody?: { type: 'multipart'; maxBytes: number } | undefined;
}

export interface ValidInput {
  body: unknown;
  query: unknown;
  params: unknown;
}

/** True for `application/json`, with no parameter other than a utf-8 `charset`. */
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type = '', ...params] = header.split(';');
  if (type.trim().toLowerCase() !== 'application/json') return false;
  return params.every((param) => {
    const eq = param.indexOf('=');
    const name = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
    if (name !== 'charset') return true;
    const value = param.slice(eq + 1).trim().replace(/^"|"$/g, '').toLowerCase();
    return value === 'utf-8' || value === 'utf8';
  });
}

const limitBody = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: () => {
    throw new DomainError('PAYLOAD_TOO_LARGE');
  },
});

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The request's JSON body.
 *
 * @throws DomainError `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `INVALID_JSON`
 */
export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  if (!isJsonContentType(c.req.header('content-type'))) throw new DomainError('UNSUPPORTED_MEDIA_TYPE');
  // body-limit trusts a Content-Length (Node's parser holds the body to it) and counts the bytes of a chunked body.
  await limitBody(c, async () => {});
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BODY_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE');
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new DomainError('INVALID_JSON');
  }
  try {
    return parseStrictJson(text);
  } catch {
    throw new DomainError('INVALID_JSON');
  }
}

/** True for `multipart/form-data`, whatever its parameters (the boundary is the body parser's to need). */
function isMultipartContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type = ''] = header.split(';');
  return type.trim().toLowerCase() === 'multipart/form-data';
}

/**
 * Checks a `rawBody` route's body: `multipart/form-data`, at most `raw.maxBytes` bytes (body-limit trusts a
 * Content-Length, which Node's parser holds the body to, and counts the bytes of a chunked body, keeping them for the
 * handler). The body is left for the handler to read.
 *
 * @throws DomainError `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`
 */
export async function checkRawBody(c: Context<AppEnv>, raw: { type: 'multipart'; maxBytes: number }): Promise<void> {
  if (!isMultipartContentType(c.req.header('content-type'))) throw new DomainError('UNSUPPORTED_MEDIA_TYPE');
  const limit = bodyLimit({
    maxSize: raw.maxBytes,
    onError: () => {
      throw new DomainError('PAYLOAD_TOO_LARGE');
    },
  });
  await limit(c, async () => {});
}

/** The query string as `{key: value}` (`{key: [values]}` for a key given more than once). */
function queryObject(c: Context<AppEnv>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    out[key] = values.length === 1 ? values[0]! : values;
  }
  return out;
}

/**
 * `{path, code}` of a Zod issue: no value, no message (Zod's messages can quote the input). The code is issueCode's:
 * a custom check of ours names its own (`missing_link`).
 */
export function fieldError(issue: z.core.$ZodIssue): ProblemFieldError {
  return { path: issue.path.map((segment) => String(segment)).join('.'), code: issueCode(issue) };
}

/** A lone surrogate: a high half not followed by a low one, or a low half not preceded by a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Where `value` holds text that is not well-formed UTF-16: `{path, code: 'invalid_format'}` for each such string (the
 * path of its keys and indices joined with `.`, '' for `value` itself) and `{path, code: 'invalid_key'}` for each such
 * object key, at the path of its object (the key itself is never repeated, and its value is not looked into). At
 * most MAX_PROBLEM_ERRORS entries. JSON nests at most MAX_JSON_DEPTH (64) levels, so the walk is shallow.
 */
export function notWellFormed(value: unknown): ProblemFieldError[] {
  const errors: ProblemFieldError[] = [];
  const walk = (v: unknown, path: readonly string[]): void => {
    if (errors.length >= MAX_PROBLEM_ERRORS) return;
    if (typeof v === 'string') {
      if (LONE_SURROGATE.test(v)) errors.push({ path: path.join('.'), code: 'invalid_format' });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...path, String(i)]));
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [key, item] of Object.entries(v)) {
      if (errors.length >= MAX_PROBLEM_ERRORS) return;
      if (LONE_SURROGATE.test(key)) errors.push({ path: path.join('.'), code: 'invalid_key' });
      else walk(item, [...path, key]);
    }
  };
  walk(value, []);
  return errors;
}

/** One VALIDATION_FAILED for `errors` (decision D10). */
export function validationFailed(errors: ProblemFieldError[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data yang dikirim tidak valid / The submitted data is not valid',
    meta: { errors },
  });
}

/**
 * The request's params, query and body, each parsed by its schema (see the top of this file).
 *
 * @throws DomainError `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `INVALID_JSON` (the body, or a `rawBody`'s type
 *   and size, before any schema runs) or `VALIDATION_FAILED` (every schema issue of the three parts in one error; once they all pass, the text
 *   in the parsed values that is not well-formed)
 */
export async function validateInput(c: Context<AppEnv>, schemas: InputSchemas): Promise<ValidInput> {
  if (schemas.rawBody !== undefined) await checkRawBody(c, schemas.rawBody);
  const rawBody = schemas.body === undefined ? undefined : await readJsonBody(c);
  const rawQuery = schemas.query === undefined ? undefined : queryObject(c);
  const errors: ProblemFieldError[] = [];
  const parse = async (schema: z.ZodType | undefined, input: unknown): Promise<unknown> => {
    if (schema === undefined) return undefined;
    const result = await schema.safeParseAsync(input);
    if (result.success) return result.data;
    errors.push(...result.error.issues.map(fieldError));
    return undefined;
  };
  const params = schemas.params === undefined ? c.req.param() : await parse(schemas.params, c.req.param());
  const query = await parse(schemas.query, rawQuery);
  const body = await parse(schemas.body, rawBody);
  if (errors.length > 0) throw validationFailed(errors);
  // What the handler gets, after the strict schemas (so no path below names a key the client chose; the raw params
  // of a route without a params schema are named by the route's own path).
  const malformed = [...notWellFormed(params), ...notWellFormed(query), ...notWellFormed(body)];
  if (malformed.length > 0) throw validationFailed(malformed.slice(0, MAX_PROBLEM_ERRORS));
  return { body, query, params };
}
