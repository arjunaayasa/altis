import { z } from 'zod';
import { isUlid } from '../ids.js';

/**
 * Field schemas shared by the request bodies of `/api/v1` (server) and the forms of the admin SPA.
 *
 * - Every maximum equals its column width (L36). Zod's `min()` and `max()` count a string in code points, as the
 *   VARCHAR columns do (api-common.test.ts pins that); {@link passwordField} counts UTF-16 units instead (M21).
 * - Fields that normalize (`usernameField`, `branchCodeField`) do it before their pattern runs (S12): phone keyboards
 *   type full-width letters, macOS types decomposed accents, pasting adds spaces.
 * - No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/common`, so that code
 *   which does not validate input (the bootloader, `app.js`) never pulls Zod in.
 */

/**
 * The `code` of the field error (`{path, code}`, decision D10) a Zod issue becomes: the issue's own code, except for a
 * `custom` issue raised by one of our own checks, which names its code in `params.code` (`missing_link`).
 */
export function issueCode(issue: { code: string; params?: Record<string, unknown> | undefined }): string {
  const named = issue.code === 'custom' ? issue.params?.['code'] : undefined;
  return typeof named === 'string' ? named : issue.code;
}

/** NFKC, then trim: the shared first step of `usernameField` and `branchCodeField`. */
function nfkcTrim(s: string): string {
  return s.normalize('NFKC').trim();
}

/** 3-64 letters, digits, `.`, `_` or `-`, with no inner whitespace; NFKC and trimmed first. Case is kept. */
export const usernameField = z
  .string()
  .transform(nfkcTrim)
  .pipe(z.string().min(3).max(64).regex(/^[\p{L}\p{N}._-]*$/u));

/** 1-191 characters, trimmed, with no control character (C0, DEL, C1). */
export const personNameField = z.string().trim().min(1).max(191).regex(/^\P{Cc}*$/u);

/** At most 191 characters (the width of `email_display`), a valid address. */
export const emailField = z.email().max(191);

/**
 * 1-512 UTF-16 units. Never trimmed or normalized here: the password policy counts code points after NFKC and caps
 * them at 256 (M21); this limit only bounds the body.
 */
export const passwordField = z
  .string()
  .min(1)
  .check((ctx) => {
    // Zod's own max() counts code points; this bound is in UTF-16 units.
    if (ctx.value.length > 512) {
      ctx.issues.push({ code: 'too_big', origin: 'string', maximum: 512, inclusive: true, input: ctx.value });
    }
  });

/** A canonical ULID: 26 uppercase Crockford base32 characters. */
export const ulidField = z.string().refine(isUlid);

export const localeField = z.enum(['id', 'en']);

/** 1-32 of `A-Z a-z 0-9 _ -`; NFKC and trimmed first. */
export const branchCodeField = z
  .string()
  .transform(nfkcTrim)
  .pipe(z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]*$/));

/** An IANA time zone name of at most 64 characters (the width of `timezone`) that `Intl.DateTimeFormat` accepts. */
export const timezoneField = z
  .string()
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  });

/** The optimistic-concurrency counter: an integer from 0 up to what an INT column holds. */
export const versionField = z.int().min(0).max(2_147_483_647);

/** The `Idempotency-Key` header (spec §7.9): 8-64 of `A-Z a-z 0-9 . _ : -`. */
export const idempotencyKeyField = z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/);
