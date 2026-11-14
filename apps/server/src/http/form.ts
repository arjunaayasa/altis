import { DomainError } from '@altis/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './request-id.js';

// The HTML form bodies of the OPAC member area (routes declared `form: true`): a browser posts them as
// `application/x-www-form-urlencoded`, without a script, so the request chain reads them itself, before step 8 (the
// CSRF token travels in the form's hidden `_csrf` field):
//
// - the content type must be `application/x-www-form-urlencoded` (a `charset`, when given, utf-8): else 415
//   UNSUPPORTED_MEDIA_TYPE; the body at most 16 KB: else 413 PAYLOAD_TOO_LARGE; valid UTF-8 once decoded;
// - a field given twice is refused (VALIDATION_FAILED `{path: <field>, code: 'duplicate_field'}`, 422 as every field
//   error of the API): a form never
//   sends one name twice, so a second value is never silently picked over the first; a list of checkboxes uses indexed
//   names (`recordIds.0`, `recordIds.1`, ...), which become an array here in index order;
// - `_csrf` is taken out for step 8 and never reaches the route's schema, which then validates the rest strictly.

/** The largest form body read. */
export const MAX_FORM_BODY_BYTES = 16_384;

/** An indexed field: `<name>.<0-999>`. */
const INDEXED = /^([A-Za-z][A-Za-z0-9_]*)\.(\d{1,3})$/;
/** The most entries of an indexed field. */
const MAX_INDEXED = 100;

/** What {@link readFormBody} gives step 8 and step 11. */
export interface FormBody {
  /** The fields, `_csrf` taken out, indexed names made arrays. */
  fields: Record<string, string | string[]>;
  /** The `_csrf` field, when the form sent one. */
  csrf: string | undefined;
}

function isFormContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type = '', ...params] = header.split(';');
  if (type.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return false;
  return params.every((param) => {
    const eq = param.indexOf('=');
    const name = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
    if (name !== 'charset') return true;
    const value = param.slice(eq + 1).trim().replace(/^"|"$/g, '').toLowerCase();
    return value === 'utf-8' || value === 'utf8';
  });
}

const limitForm = bodyLimit({
  maxSize: MAX_FORM_BODY_BYTES,
  onError: () => {
    throw new DomainError('PAYLOAD_TOO_LARGE');
  },
});

const utf8 = new TextDecoder('utf-8', { fatal: true });

function duplicate(path: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Isian formulir terkirim dua kali / A form field was sent twice',
    meta: { errors: [{ path, code: 'duplicate_field' }] },
  });
}

/**
 * The request's form body (see the top of this file).
 *
 * @throws DomainError `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `VALIDATION_FAILED` (`duplicate_field`, or
 *   `invalid_format` for a body that is not UTF-8)
 */
export async function readFormBody(c: Context<AppEnv>): Promise<FormBody> {
  if (!isFormContentType(c.req.header('content-type'))) throw new DomainError('UNSUPPORTED_MEDIA_TYPE');
  await limitForm(c, async () => {});
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_FORM_BODY_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE');
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new DomainError('VALIDATION_FAILED', { meta: { errors: [{ path: '', code: 'invalid_format' }] } });
  }
  const seen = new Set<string>();
  const plain: Record<string, string> = {};
  const indexed = new Map<string, Map<number, string>>();
  let csrf: string | undefined;
  for (const [name, value] of new URLSearchParams(text)) {
    if (seen.has(name)) throw duplicate(name);
    seen.add(name);
    if (name === '_csrf') {
      csrf = value;
      continue;
    }
    const m = INDEXED.exec(name);
    if (m !== null) {
      const list = indexed.get(m[1]!) ?? new Map<number, string>();
      if (list.size >= MAX_INDEXED) throw new DomainError('PAYLOAD_TOO_LARGE');
      list.set(Number(m[2]), value);
      indexed.set(m[1]!, list);
      continue;
    }
    plain[name] = value;
  }
  const fields: Record<string, string | string[]> = { ...plain };
  for (const [name, list] of indexed) {
    if (Object.hasOwn(fields, name)) throw duplicate(name);
    fields[name] = [...list.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
  return { fields, csrf };
}
