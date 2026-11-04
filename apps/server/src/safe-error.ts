import { isDriverError } from '@altis/db';
import { isDomainError } from '@altis/shared';

// Errors on their way into a log (spec §6.9, UU PDP). A raw database driver error carries the server's message, and
// mysql2's `sqlMessage` and `sql` or pg's `detail` with it: SQL text and the values of the statement (a member's name,
// a phone number). What may be logged of one is what the safe-cause policy of @altis/db keeps (normalizeDbError,
// MigrationError): `code`, `errno`, `sqlState`, `constraint`, plus its `name`. normalizeDbError already applies it to
// what it maps; this module applies it to whatever reaches a log without passing there (an unmapped driver error
// thrown by a handler, a wrapper of one).

/** How many links of a cause chain (and levels of AggregateError.errors) are followed. */
const MAX_DEPTH = 5;

/** A raw driver error: an Error that @altis/db's isDriverError recognises (a plain object of safe fields is not one). */
function isRawDriverError(error: unknown): error is Error {
  return error instanceof Error && isDriverError(error);
}

/** The fields of a raw driver error that may be logged: its name and code, errno, sqlState and constraint. */
export function driverErrorFields(error: Error): Record<string, string | number> {
  const s = error as { code?: unknown; errno?: unknown; errcode?: unknown; sqlState?: unknown; constraint?: unknown };
  const fields: Record<string, string | number> = { name: error.name };
  if (typeof s.code === 'string' && s.code !== '') fields['code'] = s.code;
  // node:sqlite reports its result code as `errcode`.
  if (typeof s.errno === 'number') fields['errno'] = s.errno;
  else if (typeof s.errcode === 'number') fields['errno'] = s.errcode;
  if (typeof s.sqlState === 'string') fields['sqlState'] = s.sqlState;
  if (typeof s.constraint === 'string') fields['constraint'] = s.constraint;
  return fields;
}

/** The links below `error`: an AggregateError's `errors`, then its `cause`. */
function linksBelow(error: Error): unknown[] {
  const below: unknown[] = error instanceof AggregateError && Array.isArray(error.errors) ? [...error.errors] : [];
  if (error.cause !== undefined) below.push(error.cause);
  return below;
}

/** The raw driver errors in `error` and below it (nothing is looked for below a raw driver error). */
function driverErrorsIn(error: unknown, depth = 0): Error[] {
  if (isRawDriverError(error)) return [error];
  if (!(error instanceof Error) || depth >= MAX_DEPTH) return [];
  return linksBelow(error).flatMap((link) => driverErrorsIn(link, depth + 1));
}

/** True when `text` repeats a text of one of `driverErrors` that can hold SQL or values. */
function repeatsDriverText(text: string | undefined, driverErrors: readonly Error[]): boolean {
  if (text === undefined || text === '') return false;
  return driverErrors.some((d) => {
    const t = d as { message?: unknown; sqlMessage?: unknown; sql?: unknown; detail?: unknown };
    return [t.message, t.sqlMessage, t.sql, t.detail].some((part) => typeof part === 'string' && part !== '' && text.includes(part));
  });
}

/**
 * `error` made safe to log. Returned as it is when no raw driver error is in it or below it (its cause chain and an
 * AggregateError's `errors`, at most 5 levels): every other error, a DomainError included, keeps what the logger
 * writes of it. Otherwise a plain object:
 *
 * - a raw driver error becomes {@link driverErrorFields} (no message, no stack: both repeat the driver's text);
 * - an error with one below it becomes `{name, message, cause}` (a DomainError also `code`, `status`, `detail`,
 *   `meta`; an AggregateError also `errors`), each link made safe the same way, without a stack; its message and
 *   detail are left out when they repeat a driver error's text.
 *
 * Never throws: an error that cannot even be inspected (a getter that throws) is returned as it is, for the logger's
 * own guarded serialisation.
 */
export function loggableError(error: unknown): unknown {
  try {
    return safeOf(error, 0);
  } catch {
    return error;
  }
}

function safeOf(error: unknown, depth: number): unknown {
  if (isRawDriverError(error)) return driverErrorFields(error);
  if (!(error instanceof Error)) return error;
  const below = driverErrorsIn(error);
  if (below.length === 0) return error;

  const out: Record<string, unknown> = { name: error.name };
  if (!repeatsDriverText(error.message, below)) out['message'] = error.message;
  if (isDomainError(error)) {
    out['code'] = error.code;
    out['status'] = error.status;
    if (error.detail !== undefined && !repeatsDriverText(error.detail, below)) out['detail'] = error.detail;
    if (error.meta !== undefined) out['meta'] = error.meta;
  } else {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') out['code'] = code;
  }
  if (depth < MAX_DEPTH) {
    if (error instanceof AggregateError && Array.isArray(error.errors)) {
      out['errors'] = error.errors.map((inner: unknown) => safeOf(inner, depth + 1));
    }
    if (error.cause !== undefined) out['cause'] = safeOf(error.cause, depth + 1);
  }
  return out;
}
