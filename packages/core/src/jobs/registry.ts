import { isPermission } from '@altis/shared';
import type { JobHandler, JobRegistry } from './types.js';

// The job types an installation runs: one handler per type. The server builds one registry from the handler array of
// apps/server/src/jobs/runtime.ts; claims skip any type it does not know.

/** A job type: lower case, dot-separated words, at most 64 characters (the width of `jobs.type`). */
export const JOB_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

/** `h` checked; a TypeError naming what is wrong. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkHandler(h: JobHandler<any>, i: number): void {
  const where = `createJobRegistry: handler ${i}`;
  if (typeof h !== 'object' || h === null) throw new TypeError(`${where} is not an object`);
  if (typeof h.type !== 'string' || !JOB_TYPE.test(h.type)) throw new TypeError(`${where}: type must match ${String(JOB_TYPE)}`);
  if (typeof h.permission !== 'string' || !isPermission(h.permission)) {
    throw new TypeError(`${where} (${h.type}): permission must be a permission of the catalog`);
  }
  if (h.retryable !== 'api' && h.retryable !== 'origin-only') {
    throw new TypeError(`${where} (${h.type}): retryable must be 'api' or 'origin-only'`);
  }
  if (h.maxAttempts !== undefined && (!Number.isSafeInteger(h.maxAttempts) || h.maxAttempts < 1)) {
    throw new TypeError(`${where} (${h.type}): maxAttempts must be a positive integer`);
  }
  const schema: unknown = h.payload;
  if (typeof schema !== 'object' || schema === null || typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
    throw new TypeError(`${where} (${h.type}): payload must be a Zod schema`);
  }
  if (typeof h.run !== 'function') throw new TypeError(`${where} (${h.type}): run must be a function`);
}

/**
 * The registry of `handlers`, by type.
 *
 * @throws TypeError for two handlers of one type, or a handler whose type, permission, `retryable`, `maxAttempts`,
 *   payload schema or `run` is not well formed
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createJobRegistry(handlers: readonly JobHandler<any>[]): JobRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byType = new Map<string, JobHandler<any>>();
  handlers.forEach((h, i) => {
    checkHandler(h, i);
    if (byType.has(h.type)) throw new TypeError(`createJobRegistry: two handlers of type ${h.type}`);
    byType.set(h.type, h);
  });
  const types = [...byType.keys()];
  return Object.freeze({
    get: (type: string) => byType.get(type),
    types: () => [...types],
  });
}
