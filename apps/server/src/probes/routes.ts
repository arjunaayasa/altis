import { hmacB64u, probeHmac } from '@altis/core';
import type { Permission } from '@altis/shared';
import {
  PROBE_CHUNK_MAX_BYTES,
  PROBE_NONCE,
  PROBE_SSE_INTERVAL_MS,
  PROBE_SSE_TICKS,
  XFF_ENTRIES_MAX,
  XFF_ENTRY_MAX_LENGTH,
  type ProbeChunkResponse,
  type ProbeHmacResponse,
  type ProbeMethodResponse,
  type ProbePollResponse,
} from '@altis/shared/api/diagnostics';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import { clientIp, isLocalPeer, peerOf } from '../http/client-ip.js';
import { csrfKey } from '../http/csrf.js';
import { route, type RouteContext, type RouteDecl, type RouteMethod } from '../http/route.js';
import { validationFailed } from '../http/validate.js';

// The browser test's probe routes (spec §11, §2.4, §9.5 step 1, P10, P15; plan Task 23, decisions C22, C35), in two
// places with the same code: Diagnostik (`/api/v1/diagnostics/probe`, signed-in staff with `system.diagnostics.read`,
// `mode: system`) and the install wizard (`/install/api/probe`, the claim's holder, `install: 'claimed'`, maintenance
// allowed; Task 27 mounts them). What each answers is described in @altis/shared/api/diagnostics.
//
//   GET    poll       the request as the server saw it: its X-Forwarded-For chain, the client IP the configured hops
//                      derive, whether the peer is private, the hops the chain suggests and the IP they would give
//   GET    sse        3 `tick` events 1 s apart, then `done` (not gated by realtime.sse, counted by the stream limit:
//                      204 when this process holds all the streams it may)
//   GET    hmac/:nonce (Diagnostik) or :nonce (wizard, a 16-64 character nonce, registered after poll and sse, whose
//                      names it cannot match) → the HMAC that proves this installation answered
//   POST|PUT|PATCH|DELETE methods → {method}; the ids `*.probe.methods.*` make the chain refuse a request sent through
//                      method override (http/route.ts, Task 16): this route tests the real methods
//   POST   chunk      multipart/form-data, field `chunk`, at most 6 MiB in all → {bytes}

const NO_STORE = { 'Cache-Control': 'no-store' };

export interface ProbeRoutesOptions {
  prefix: '/api/v1/diagnostics/probe' | '/install/api/probe';
  access: { permission: Permission } | { install: 'claimed' };
  idPrefix: 'diagnostics.probe' | 'install.probe';
}

const NonceParams = z.strictObject({ nonce: z.string().regex(PROBE_NONCE) });

/** The non-blank entries of an X-Forwarded-For header (several headers arrive joined with commas). */
function xffEntries(header: string | undefined): string[] {
  if (header === undefined) return [];
  return header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function poll(rc: RouteContext<unknown, unknown, unknown>): ProbePollResponse {
  const { c } = rc;
  const header = c.req.header('x-forwarded-for');
  const entries = xffEntries(header);
  const suggestedHops = Math.min(entries.length, XFF_ENTRIES_MAX);
  const peer = peerOf(c);
  const atSuggested = clientIp({ peer, xff: header, xRealIp: c.req.header('x-real-ip'), hops: suggestedHops, persisted: 'ok' });
  return {
    now: rc.now,
    ip: rc.ip,
    ipTrust: rc.ipTrust,
    xff: entries.slice(-XFF_ENTRIES_MAX).map((entry) => entry.slice(0, XFF_ENTRY_MAX_LENGTH)),
    peerPrivate: isLocalPeer(peer),
    suggestedHops,
    ipAtSuggested: atSuggested.ip ?? '',
  };
}

/** The ticks and `done` of the SSE probe; stops early when the browser leaves. */
async function ticks(stream: SSEStreamingApi): Promise<void> {
  let aborted = false;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  stream.onAbort(() => {
    aborted = true;
    clearTimeout(timer);
    wake?.();
  });
  const pause = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, PROBE_SSE_INTERVAL_MS);
    });
  for (let n = 1; n <= PROBE_SSE_TICKS; n += 1) {
    if (n > 1) await pause();
    if (aborted) return;
    await stream.write(`event: tick\ndata: ${JSON.stringify({ n })}\n\n`);
  }
  if (!aborted) await stream.write(`event: done\ndata: ${JSON.stringify({ ticks: PROBE_SSE_TICKS })}\n\n`);
}

/**
 * The probe routes under `o.prefix` (see the top of this file), with ids `<idPrefix>.poll`, `.sse`, `.hmac`,
 * `.methods.{post,put,patch,delete}` and `.chunk`, in that order (the nonce route after `poll` and `sse`).
 */
export function probeRoutes(o: ProbeRoutesOptions): RouteDecl[] {
  const wizard = 'install' in o.access;
  const access = wizard
    ? ({ public: true, session: 'none', install: 'claimed', maintenance: 'allow' } as const)
    : { permission: (o.access as { permission: Permission }).permission };
  const common = { ...access, mode: 'system', idempotency: 'none', audit: null } as const;
  // The write probes touch no database, so they open no handler transaction: the wizard runs them before `POST config`,
  // when there is no database to open one on (route.ts `dbFor` → 503 DB_UNAVAILABLE otherwise).
  const writeProbe = { tx: 'self' } as const;
  const id = (name: string): string => `${o.idPrefix}.${name}`;

  const pollRoute = route({
    ...common,
    id: id('poll'),
    method: 'GET',
    path: `${o.prefix}/poll`,
    handler: async (rc) => ({ body: poll(rc), headers: NO_STORE }),
  });

  const sseRoute = route({
    ...common,
    id: id('sse'),
    method: 'GET',
    path: `${o.prefix}/sse`,
    handler: async (rc) => {
      const { services, c } = rc;
      const streamHeaders = { 'Content-Type': 'text/event-stream', ...NO_STORE, 'X-Accel-Buffering': 'no' };
      // HEAD (Hono answers it with the GET route) would hold a slot for a stream nobody reads.
      if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: streamHeaders });
      if (!services.streams.tryAcquire()) return { status: 204, headers: NO_STORE };
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        services.streams.release();
      };
      try {
        const res = streamSSE(c, async (stream) => {
          try {
            await ticks(stream);
          } finally {
            release();
          }
        });
        for (const [name, value] of Object.entries(streamHeaders)) res.headers.set(name, value);
        return res;
      } catch (error) {
        release();
        throw error;
      }
    },
  });

  const hmacRoute = route<unknown, unknown, z.infer<typeof NonceParams>>({
    ...common,
    id: id('hmac'),
    method: 'GET',
    path: wizard ? `${o.prefix}/:nonce{[A-Za-z0-9_-]{16,64}}` : `${o.prefix}/hmac/:nonce`,
    params: NonceParams,
    handler: async (rc) => {
      const { nonce } = rc.params;
      // The wizard: keyed by the claim's probe secret (the same in every process, §9.5 step 1); an `install: 'claimed'`
      // route runs only with a valid claim. Diagnostik: keyed by the installation's sessionKey.
      if (wizard && rc.installSession === null) throw new TypeError(`${id('hmac')}: no install session`);
      const hmac = wizard ? probeHmac(rc.installSession!, nonce) : hmacB64u(csrfKey(rc.config), `probe:${nonce}`);
      const body: ProbeHmacResponse = { hmac };
      return { body, headers: NO_STORE };
    },
  });

  const methodRoute = (method: Exclude<RouteMethod, 'GET'>): RouteDecl =>
    route({
      ...common,
      ...writeProbe,
      id: id(`methods.${method.toLowerCase()}`),
      method,
      path: `${o.prefix}/methods`,
      handler: async (rc) => {
        const body: ProbeMethodResponse = { method: rc.c.req.method as ProbeMethodResponse['method'] };
        return { body, headers: NO_STORE };
      },
    });

  const chunkRoute = route({
    ...common,
    ...writeProbe,
    id: id('chunk'),
    method: 'POST',
    path: `${o.prefix}/chunk`,
    rawBody: { type: 'multipart', maxBytes: PROBE_CHUNK_MAX_BYTES },
    handler: async (rc) => {
      let form: FormData;
      try {
        form = await rc.c.req.formData();
      } catch {
        throw validationFailed([{ path: '', code: 'invalid_format' }]);
      }
      const chunk = form.get('chunk');
      if (chunk === null || typeof chunk === 'string') throw validationFailed([{ path: 'chunk', code: 'invalid_type' }]);
      const body: ProbeChunkResponse = { bytes: chunk.size };
      return { body, headers: NO_STORE };
    },
  });

  return [
    pollRoute,
    sseRoute,
    hmacRoute,
    methodRoute('POST'),
    methodRoute('PUT'),
    methodRoute('PATCH'),
    methodRoute('DELETE'),
    chunkRoute,
  ];
}
