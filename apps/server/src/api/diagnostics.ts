import { collectDiagnostics, confirmClock, recordProbeResult, setRealtime } from '@altis/core';
import {
  ProbeResultBody,
  RealtimeBody,
  type ClockConfirmResponse,
  type DiagnosticsReport,
  type ProbeResultResponse,
  type RealtimeResponse,
} from '@altis/shared/api/diagnostics';
import { csrfKey } from '../http/csrf.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { probeRoutes } from '../probes/routes.js';
import { sseEnabled } from '../realtime/streams.js';
import { embeddedRootKeys, refusesDevKids } from '../release-keys.js';

// The Diagnostik routes of Task 23 (spec §11, §2.4, §10.4; route catalog `diagnostics.*`; the wire format is described
// in @altis/shared/api/diagnostics). Every one is `mode: system` (Diagnostik keeps working in read-only, §8.6).
//
//   GET  diagnostics                system.diagnostics.read    the §11 report (core collectDiagnostics: cheap reads;
//                                                              1d Task 29: the edition's check, the keyset store
//                                                              against the embedded roots)
//   PUT  diagnostics/realtime       system.diagnostics.manage  `realtime.sse`; `true` on passenger/litespeed needs an SSE
//                                                              probe success within 24 h (409 REALTIME_PROBE_REQUIRED);
//                                                              audit `diagnostics.realtime`
//   POST diagnostics/clock-confirm  system.diagnostics.manage  re-authenticated; confirmClock over the route's TxRunner
//                                                              (its audit `diagnostics.clock_confirm` counts for it)
//   POST diagnostics/probe-result   system.diagnostics.manage  `system.probe` and `system.ip_trust`; audit
//                                                              `diagnostics.probe_result` {spoofable, suggestedHops,
//                                                              methodsBlocked}
//   …/diagnostics/probe/*          system.diagnostics.read    the browser test's probes (probes/routes.ts)
//
// The writes change instance settings that every process reads through its settings cache: the cache of this process
// is dropped after the commit, the others follow within its time to live (P6).

const DIAGNOSTICS = '/api/v1/diagnostics';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** The staff user behind the request (the routes are permission routes: step 9 refused any request without one). */
function actorId(rc: RouteContext<unknown, unknown, unknown>): string | null {
  return rc.auth?.subjectId ?? null;
}

/** GET diagnostics. */
const diagnosticsGet = route({
  id: 'diagnostics.get',
  method: 'GET',
  path: DIAGNOSTICS,
  permission: 'system.diagnostics.read',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const { services } = rc;
    const db = rc.db;
    const sse = await services.settings.get<boolean | null>(db.db, 'realtime.sse');
    const body: DiagnosticsReport = await collectDiagnostics({
      h: db,
      dataDir: services.dataDir,
      appRoot: services.install.appRoot,
      runtime: services.runtime,
      env: services.install.env,
      version: services.version,
      appJsVersion: services.appJsVersion,
      transport: sseEnabled(sse, services.runtime) ? 'sse' : 'polling',
      hops: rc.config.trustProxy.hops,
      sessionKey: csrfKey(rc.config),
      now: rc.now,
      // 1d Task 29: the edition (services.edition) and the keyset store's documents against the embedded roots.
      edition: services.edition,
      roots: embeddedRootKeys() ?? [],
      refuseDevKids: refusesDevKids(),
    });
    return { body, headers: NO_STORE };
  },
});

/** PUT diagnostics/realtime. */
const diagnosticsRealtime = route<RealtimeBody>({
  id: 'diagnostics.realtime',
  method: 'PUT',
  path: `${DIAGNOSTICS}/realtime`,
  permission: 'system.diagnostics.manage',
  mode: 'system',
  idempotency: 'none',
  audit: 'diagnostics.realtime',
  body: RealtimeBody,
  handler: async (rc) => {
    const tx = rc.tx();
    const { sse } = rc.body;
    const { previous } = await setRealtime(tx.trx, sse, { runtime: rc.services.runtime, now: rc.now, actorId: actorId(rc) });
    await tx.audit({ action: 'diagnostics.realtime', entity: 'settings', entityId: 'realtime.sse', meta: { sse, previous } });
    rc.afterCommit(() => rc.services.settings.invalidate());
    const body: RealtimeResponse = { sse, transport: sseEnabled(sse, rc.services.runtime) ? 'sse' : 'polling' };
    return { body };
  },
});

/** POST diagnostics/clock-confirm. */
const diagnosticsClockConfirm = route({
  id: 'diagnostics.clock_confirm',
  method: 'POST',
  path: `${DIAGNOSTICS}/clock-confirm`,
  permission: 'system.diagnostics.manage',
  reauth: true,
  mode: 'system',
  tx: 'self',
  idempotency: 'none',
  audit: 'diagnostics.clock_confirm',
  handler: async (rc) => {
    await confirmClock(rc.withTx, { now: rc.now });
    rc.services.settings.invalidate();
    const body: ClockConfirmResponse = { confirmedAt: rc.now };
    return { body };
  },
});

/** POST diagnostics/probe-result. */
const diagnosticsProbeResult = route<ProbeResultBody>({
  id: 'diagnostics.probe_result',
  method: 'POST',
  path: `${DIAGNOSTICS}/probe-result`,
  permission: 'system.diagnostics.manage',
  mode: 'system',
  idempotency: 'none',
  audit: 'diagnostics.probe_result',
  body: ProbeResultBody,
  handler: async (rc) => {
    const tx = rc.tx();
    const outcome = await recordProbeResult(tx.trx, rc.body, { now: rc.now, actorId: actorId(rc) });
    await tx.audit({
      action: 'diagnostics.probe_result',
      entity: 'settings',
      entityId: 'system.probe',
      meta: { spoofable: outcome.spoofable, suggestedHops: outcome.suggestedHops, methodsBlocked: outcome.methodsBlocked },
    });
    rc.afterCommit(() => rc.services.settings.invalidate());
    const body: ProbeResultResponse = { ipTrust: outcome.ipTrust, spoofable: outcome.spoofable, suggestedHops: outcome.suggestedHops };
    return { body };
  },
});

/** The Diagnostik routes, in the order of the route catalog. */
export const DIAGNOSTICS_ROUTES: RouteDecl[] = [
  diagnosticsGet,
  diagnosticsRealtime,
  diagnosticsClockConfirm,
  diagnosticsProbeResult,
  ...probeRoutes({ prefix: `${DIAGNOSTICS}/probe`, access: { permission: 'system.diagnostics.read' }, idPrefix: 'diagnostics.probe' }),
];
