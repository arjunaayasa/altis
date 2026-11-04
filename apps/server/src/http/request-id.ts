import { newId, type IpTrust } from '@altis/shared';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { AuthState } from './auth-state.js';

/** What the app keeps per request (Hono context variables). */
export interface AppEnv {
  Variables: {
    /** A fresh ULID for this request: `X-Request-Id` and the problem+json `traceId`. */
    requestId: string;
    /** The app's logger with `requestId` on every line. */
    log: Logger;
    /** Epoch ms of the request: one reading of `services.clock()`, used for every check and write of it. */
    now: number;
    /** The client IP (P15, step 3); null without a usable peer address. */
    ip: string | null;
    /**
     * How far `ip` can be trusted (P15, decision D13): step 3 sets `collapsed` or `ok`, and a route that is not
     * `session: 'none'` then takes the persisted `system.ip_trust` for an `ok` request.
     */
    ipTrust: IpTrust;
    /** The config this request runs under (step 4, after the config fence); undefined while none is installed. */
    config: Config | undefined;
    /** The resolved session (step 7, Task 13), or null: none, or a `session: 'none'` route. */
    auth: AuthState | null;
  };
}

/** The ids of requests the server dispatched again itself (1c Task 16: method override), by the inner Request. */
const inheritedIds = new WeakMap<Request, string>();

/**
 * Makes the request id middleware give `inner`, a request the server builds and dispatches again from the one whose
 * id is `id` (http/method-override.ts), that same id: one client request keeps one id in the log, in `X-Request-Id`
 * and in the problem `traceId`. Only server code can reach this map; nothing a client sends does.
 */
export function inheritRequestId(inner: Request, id: string): void {
  inheritedIds.set(inner, id);
}

/**
 * Step 1 of the middleware chain (spec §4.7): gives every request a fresh ULID, never one the client sent (an
 * incoming `X-Request-Id` is ignored, so a client cannot plant ids in the log), a logger child carrying it, and the
 * `X-Request-Id` response header. A request the server dispatched again itself keeps the id of the one it came from
 * ({@link inheritRequestId}).
 */
export function requestId(log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = inheritedIds.get(c.req.raw) ?? newId();
    c.set('requestId', id);
    c.set('log', log.child({ requestId: id }));
    await next();
    c.header('X-Request-Id', id);
  };
}
