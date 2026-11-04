import type { RouteContext, RouteDecl } from './route.js';

// The edition gate: step 10 of the route chain (route.ts), the server half of the edition seam (ruling R2). Every
// route declares a mode (`read`, `write` or `system`; the default: GET `read`, otherwise `write`), and step 10 hands
// the authorized request to `services.editionGate`. The community edition refuses nothing: its gate returns at once.
// A commercial edition passes its own gate, which may refuse a route by its mode.
//
// At step 10 the request is authorized (step 9) but not validated yet (step 11): `rc.params` holds the raw path
// parameters and `rc.body`/`rc.query` are still undefined. Internal writes never pass through here: jobs, the
// scheduler, the ops machine, the boot and the CLI do not run the route chain.

/** The mode of `decl`: as declared, else `read` for a GET route and `write` for any other. */
export function routeMode(decl: RouteDecl): 'read' | 'write' | 'system' {
  return decl.mode ?? (decl.method === 'GET' ? 'read' : 'write');
}

/** Step 10 of the route chain: resolves to let the request on, throws (a DomainError) to refuse it. */
export type EditionGate = (rc: RouteContext, decl: RouteDecl) => Promise<void>;

/** The community edition's gate: every route passes. */
export const communityEditionGate: EditionGate = async () => {};
