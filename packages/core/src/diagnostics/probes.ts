import type { DB } from '@altis/db';
import type { Runtime } from '@altis/platform';
import { DomainError, type IpTrust } from '@altis/shared';
import { REALTIME_PROBE_MAX_AGE_MS, XFF_PROBE_FORGED, type ProbeResultBody } from '@altis/shared/api/diagnostics';
import type { Transaction } from 'kysely';
import { readSettings, writeSettings } from '../settings/service.js';
import { analyzeXff, xffClientAt } from './xff.js';

// What the browser test of Diagnostik changes (spec §11, P10, P15, §2.4; plan Task 23): `system.probe`, read by the
// client hints (method override, the first chunk size, Task 16) and the report; `system.ip_trust` when the XFF test
// finds the configured hops spoofable; and the gate on turning SSE on where it is off by default.

/** `system.probe` as stored. */
export interface StoredProbe {
  at: number;
  polling: boolean;
  sse: boolean;
  methods: { put: boolean; patch: boolean; delete: boolean };
  chunkBytes: number | null;
  xff: { spoofable: boolean; suggestedHops: number | null };
}

/** What {@link recordProbeResult} decided. */
export interface ProbeOutcome {
  /** `system.ip_trust` afterwards. */
  ipTrust: IpTrust;
  spoofable: boolean;
  suggestedHops: number;
  /** The methods a WAF refused (`put`, `patch`, `delete`), for the audit entry. */
  methodsBlocked: ('put' | 'patch' | 'delete')[];
}

/**
 * Keeps the browser test's result in `trx` at `o.now`: `system.probe` (with the XFF analysis, the forged value being
 * {@link XFF_PROBE_FORGED}); `system.ip_trust = 'spoofable'` when the forged entry became the client IP, and back to
 * `ok` from `spoofable` when it did not (a `collapsed` setting stays: the sessions job owns it). The caller audits.
 *
 * `o.hops`: judge the forged poll at these hops ({@link xffClientAt} of its chain) instead of the `forgedDerived` the
 * server answered it with. The install wizard passes the hops confirmed in `POST config`: its polls ran before
 * config.json existed, at the pre-install hops, which are not the hops the installation runs with (decision C22).
 */
export async function recordProbeResult(
  trx: Transaction<DB>,
  body: ProbeResultBody,
  o: { now: number; actorId: string | null; hops?: number },
): Promise<ProbeOutcome> {
  const forgedDerived = o.hops === undefined ? body.xff.forgedDerived : xffClientAt(body.xff.forgedXff, o.hops);
  const { spoofable, suggestedHops } = analyzeXff({ ...body.xff, forgedDerived, forged: XFF_PROBE_FORGED });
  const current = (await readSettings(trx, ['system.ip_trust'], []))['system.ip_trust'] as IpTrust;
  const ipTrust: IpTrust = spoofable ? 'spoofable' : current === 'spoofable' ? 'ok' : current;
  const probe: StoredProbe = {
    at: o.now,
    polling: body.polling,
    sse: body.sse,
    methods: { put: body.methods.put, patch: body.methods.patch, delete: body.methods.delete },
    chunkBytes: body.chunkBytes,
    xff: { spoofable, suggestedHops },
  };
  await writeSettings(trx, { 'system.probe': probe, 'system.ip_trust': ipTrust }, { keyring: [], now: o.now, actorId: o.actorId });
  const methodsBlocked = (['put', 'patch', 'delete'] as const).filter((m) => !body.methods[m]);
  return { ipTrust, spoofable, suggestedHops, methodsBlocked };
}

/** Whether SSE is off unless an admin turns it on (§2.4, decision C6): Passenger and LiteSpeed. */
export function sseNeedsProbe(runtime: Runtime): boolean {
  return runtime === 'passenger' || runtime === 'litespeed';
}

/**
 * Sets `realtime.sse` in `trx` (null = automatic) and returns the value it had. Turning it on (`true`) where SSE is off
 * by default needs the browser test's SSE success measured within 24 h (§2.4: "hanya bila diaktifkan admin dan lolos
 * uji").
 *
 * @throws DomainError `REALTIME_PROBE_REQUIRED` (409) otherwise
 */
export async function setRealtime(
  trx: Transaction<DB>,
  sse: boolean | null,
  o: { runtime: Runtime; now: number; actorId: string | null },
): Promise<{ previous: boolean | null }> {
  const read = await readSettings(trx, ['realtime.sse', 'system.probe'], []);
  const previous = read['realtime.sse'] as boolean | null;
  const probe = read['system.probe'] as StoredProbe | null;
  if (sse === true && sseNeedsProbe(o.runtime)) {
    const fresh = probe !== null && probe.sse && o.now - probe.at <= REALTIME_PROBE_MAX_AGE_MS && probe.at <= o.now + 60_000;
    if (!fresh) throw new DomainError('REALTIME_PROBE_REQUIRED');
  }
  await writeSettings(trx, { 'realtime.sse': sse }, { keyring: [], now: o.now, actorId: o.actorId });
  return { previous };
}
