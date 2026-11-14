import type { RouteResult } from '../http/route.js';

/**
 * The handler of a declared route whose work is not written yet: it reads and writes nothing and answers 501 with the
 * code `NOT_IMPLEMENTED`. A route that declares an audit action answers 500 AUDIT_MISSING instead (it writes no entry),
 * which the audit-once check of the route layer reports; replacing the handler removes both.
 */
export async function notImplemented(): Promise<RouteResult> {
  return { status: 501, body: { code: 'NOT_IMPLEMENTED' } };
}
