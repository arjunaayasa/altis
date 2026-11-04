/**
 * Field schemas shared by the catalog API contracts (Phase 2, plan Task 4), on top of `../common.ts`.
 *
 * - Every maximum equals its column width (L36). `z.string().max()` counts code points, as VARCHAR does; a free TEXT
 *   value is also capped at {@link TEXT_MAX_BYTES} UTF-8 **bytes**, because MySQL `TEXT` holds 65 535 bytes, not
 *   characters (Review Focus 3): 15 001 four-byte characters are refused although they are far below 60 000.
 * - Bodies are strict at every depth (`z.strictObject`); a query reads text (`z.coerce.number()`, `z.stringbool()`).
 * - No text field accepts NUL: PostgreSQL TEXT cannot store it (dialect neutrality).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/common`.
 */
import { z } from 'zod';

/** The cap of every free TEXT value, in UTF-8 bytes (a MySQL `TEXT` holds 65 535). */
export const TEXT_MAX_BYTES = 60_000;

/**
 * The length of `s` in UTF-8 bytes, counted without encoding it. A lone surrogate counts 3 bytes, the U+FFFD it is
 * written as (TextEncoder; the HTTP layer refuses such text before validation anyway).
 */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * A check that refuses a string longer than `bytes` UTF-8 bytes with the issue code `too_big` (the field error the
 * SPA maps like any other maximum): `z.string().check(utf8Max(60_000))`.
 */
export function utf8Max(bytes: number): z.core.$ZodCheck<string> {
  return z.check<string>((ctx) => {
    if (utf8Length(ctx.value) > bytes) {
      ctx.issues.push({ code: 'too_big', origin: 'string', maximum: bytes, inclusive: true, input: ctx.value });
    }
  });
}

/** No control character at all (C0, DEL, C1): single-line text. */
const NO_CONTROL = /^\P{Cc}*$/u;

/**
 * True when `s` holds a C0 control other than tab, line feed and carriage return, or DEL: what multi-line text refuses
 * (NUL above all, which PostgreSQL TEXT cannot store). A loop, not a regex: it reads a 60 000-byte body once.
 */
export function hasForbiddenControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}

/** The check of multi-line text: {@link hasForbiddenControl} is `invalid_format`. */
export function multilineSafe(): z.core.$ZodCheck<string> {
  return z.check<string>((ctx) => {
    if (hasForbiddenControl(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'regex', input: ctx.value });
  });
}

/**
 * A single-line text of at most `max` characters (its column width), trimmed, with no control character. It may be
 * empty: a required field adds `.min(1)`, an optional one `.nullable().optional()` (a service stores `''` as null).
 */
export function shortText(max: number) {
  return z.string().trim().max(max).regex(NO_CONTROL);
}

/**
 * A free TEXT value (summary, notes, scope note, description, address, a page body): at most {@link TEXT_MAX_BYTES}
 * UTF-8 bytes, kept as written (line breaks and leading spaces matter in Markdown), with no C0 control but tab, LF
 * and CR.
 */
export const longText = z.string().check(utf8Max(TEXT_MAX_BYTES), multilineSafe());

/**
 * A single-line TEXT value (a title, a subtitle, a statement of responsibility: TEXT columns shown on one line):
 * trimmed, no control character, at most {@link TEXT_MAX_BYTES} UTF-8 bytes. Required ones add `.min(1)`.
 */
export const lineText = z.string().trim().check(utf8Max(TEXT_MAX_BYTES)).regex(NO_CONTROL);

/**
 * A human code (`code_display`; its key is `normalizeKey(code)`): 1-32 printable ASCII characters (space included),
 * trimmed. Codes end up on labels, in OPAC query strings and in CSV files, so they stay ASCII.
 */
export const codeField = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[\x20-\x7E]*$/);

/** A four-digit year (`records.publication_year`, CHAR 4). */
export const yearField = z.string().regex(/^\d{4}$/);

/** True for a real calendar day written `YYYY-MM-DD` (no 2023-02-29, no 2024-04-31). */
function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= last;
}

/** A calendar date `YYYY-MM-DD` (`date()` CHAR 10 in the library's time zone); a bad one is `invalid_format`. */
export const dateField = z.string().check(
  z.check<string>((ctx) => {
    if (!isCalendarDate(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'date', input: ctx.value });
  }),
);

/**
 * A price as a decimal string of at most 13 integer digits and 2 decimals (`125000.00`). The service turns it into
 * minor units (`money()`, BIGINT) in the item's currency; a string keeps the API free of floating point.
 */
export const priceField = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);

/** An ISO 4217 currency code, upper case (`items.currency`, CHAR 3). */
export const currencyField = z.string().regex(/^[A-Z]{3}$/);

/** The id of an entry of a settings list (a barcode pattern, a label profile, an SRU server): `a-z 0-9 -`, 1-32. */
export const settingIdField = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** An integer `sort_order` (INT). */
export const sortOrderField = z.int().min(0).max(2_147_483_647);

/** An epoch-ms timestamp in a JSON body. */
export const epochMsField = z.int().min(0);

/** An epoch-ms timestamp in a query string (text). */
export const epochMsQuery = z.coerce.number().int().min(0);

/** The longest URL the catalog stores (`attachments.url`; S4). */
export const URL_MAX = 2000;

/** True for an absolute `http:`/`https:` URL with a host and no whitespace or control character. */
export function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s) || /[\s\p{Cc}]/u.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * An `http:`/`https:` URL of at most `max` characters, trimmed; anything else is refused with the field-error code
 * `invalid_url` (the code `insertUrlAttachments` reports for an imported link, S4).
 */
export function httpUrlField(max: number = URL_MAX) {
  return z
    .string()
    .trim()
    .max(max)
    .check(
      z.check<string>((ctx) => {
        if (!isHttpUrl(ctx.value)) ctx.issues.push({ code: 'custom', params: { code: 'invalid_url' }, message: 'invalid_url', input: ctx.value });
      }),
    );
}

/**
 * The keyset paging of a list query: `cursor` (opaque, ≤ 200 characters) and `limit` (1-200, default 50), read from
 * text. Spread it into the list's strict query: `z.strictObject({ q: ..., ...cursorQuery })`.
 */
export const cursorQuery = {
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

/** A page of a keyset list; `nextCursor` is the `cursor` of the next page, null on the last. */
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/** A warning about a value that was stored anyway (an ISBN with a bad check digit, a skipped link). */
export interface FieldWarning {
  path: string;
  code: string;
}

/**
 * The answer of every `store` route that creates, updates, archives, restores, merges, sets a cover or a map (S15):
 * the row's id and new version, never a full view, so the stored idempotent response stays far below 60 000 bytes.
 * Screens read the view again with GET. Batch, bulk and orphan-archive routes answer their own small summaries.
 */
export interface StoreResponse {
  id: string;
  version: number;
  warnings?: FieldWarning[];
}

/** The most custom-field codes one record or item may carry in a body. */
export const CUSTOM_VALUES_MAX = 200;

/**
 * The custom-field values of a record or an item (§3.7): `{<code>: value}`, at most {@link CUSTOM_VALUES_MAX} codes.
 * The values are checked by the server against the live definitions (`customValuesSchema`, which also caps their JSON
 * size, S19). A `__proto__` key is dropped by Zod without touching the prototype.
 */
export const customValuesField = z
  .record(
    z
      .string()
      .min(1)
      .max(32)
      .regex(/^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/),
    z.unknown(),
  )
  .check(
    z.check<Record<string, unknown>>((ctx) => {
      if (Object.keys(ctx.value).length > CUSTOM_VALUES_MAX) {
        ctx.issues.push({ code: 'custom', params: { code: 'too_big' }, message: 'too_big', input: ctx.value });
      }
    }),
  );
