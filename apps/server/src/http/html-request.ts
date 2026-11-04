import type { Context } from 'hono';
import type { AppEnv } from './request-id.js';

// Whether a request is a browser asking for a page (spec §4.9, §11): the OPAC's 404 and 500 pages (createApp's
// catch-alls) and, from 1c Task 19, the maintenance page of step 5 (http/maintenance.ts) answer such a request with
// HTML; every other request keeps its problem+json. It lives here, beside the route chain, so that step 5 can ask it
// without importing a route module (opac/routes.ts re-exports it for its callers).

/** True when `accept` lists the type `text/html` itself (a wildcard range does not count) with a quality above 0. */
function acceptsHtml(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  for (const range of accept.split(',')) {
    const [type = '', ...params] = range.split(';');
    if (type.trim().toLowerCase() !== 'text/html') continue;
    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue;
    return true;
  }
  return false;
}

/**
 * Whether the request is answered with a page rather than problem+json: its path is not under `/api/` and its Accept
 * header asks for `text/html`. A request with no Accept header, a wildcard one (curl, fetch) or `application/json` is not.
 */
export function wantsHtml(c: Context<AppEnv>): boolean {
  return !c.req.path.startsWith('/api/') && acceptsHtml(c.req.header('Accept'));
}
