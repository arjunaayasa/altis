/**
 * The Diagnostik API vocabulary shared by the server, the admin SPA and the install wizard (spec §11, §2.4, P10, P15,
 * P19; plan Task 23). No Node built-ins here: the browser bundles this module. Import it as
 * `@altis/shared/api/diagnostics`.
 *
 * - `GET diagnostics` → {@link DiagnosticsReport}: every §11 item, from cheap reads only (the audit chain, the DATA_DIR
 *   size and the exposure check come from the daily jobs' settings, never a scan per request).
 * - `PUT diagnostics/realtime` {@link RealtimeBody} → {@link RealtimeResponse}: `realtime.sse` (null = automatic). On
 *   Passenger and LiteSpeed `true` needs the browser test's SSE result (`sse: true`) measured within 24 h, else 409
 *   `REALTIME_PROBE_REQUIRED` (§2.4: "hanya bila diaktifkan admin dan lolos uji").
 * - `POST diagnostics/clock-confirm` (re-authenticated) → {@link ClockConfirmResponse}: the admin confirms the server
 *   clock (§10.4), which clears `clock_anomaly`.
 * - `POST diagnostics/probe-result` {@link ProbeResultBody} → {@link ProbeResultResponse}: the browser test's results,
 *   kept as `system.probe`; a spoofable X-Forwarded-For sets `system.ip_trust = 'spoofable'`.
 *
 * The browser test runs against the probe routes, under `/api/v1/diagnostics/probe` (signed-in staff with
 * `system.diagnostics.read`) and under `/install/api/probe` (the wizard's claim):
 *
 * - `GET poll` → {@link ProbePollResponse}: the request as the server saw it (its X-Forwarded-For chain, the client IP
 *   the configured hops derive, the hops the chain suggests). The XFF test polls once clean and once with
 *   `X-Forwarded-For: ` {@link XFF_PROBE_FORGED} (decision C22).
 * - `GET sse` → `text/event-stream`: {@link PROBE_SSE_TICKS} events `tick` (data `{"n": 1..3}`) 1 s apart, then one
 *   `done` (data `{"ticks": 3}`), then the end. A proxy that buffers delivers them all at once (or never): the SSE
 *   test fails. Not gated by `realtime.sse`; counted by the stream limit (204 when the process holds all it may).
 * - `GET hmac/:nonce` (Diagnostik) or `GET :nonce` (wizard), nonce {@link PROBE_NONCE} → {@link ProbeHmacResponse}:
 *   proves that a URL reaches this installation (the wizard compares it in `POST config`, §9.5 step 1).
 * - `POST|PUT|PATCH|DELETE methods` → {@link ProbeMethodResponse}: the real method arrived (a WAF lets it through). These
 *   must be sent as the real methods: a request sent through method override (`X-HTTP-Method-Override`) is refused
 *   with 403 `METHOD_OVERRIDE_DENIED`.
 * - `POST chunk` (multipart/form-data, field `chunk`, at most {@link PROBE_CHUNK_MAX_BYTES} in all) →
 *   {@link ProbeChunkResponse}; 413 above the limit (or a WAF's 413/403 below it).
 */
import { z } from 'zod';
import type { EditionView } from '../edition.js';
import type { IpTrust } from '../keys.js';

/** The X-Forwarded-For value of the forged poll (TEST-NET-3, RFC 5737: never a real client). */
export const XFF_PROBE_FORGED = '203.0.113.77';

/** A probe nonce: 16-64 base64url characters (the wizard's route pattern too). */
export const PROBE_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** The probe chunk route's body limit (multipart framing included): a 5 MiB chunk passes, 7 MiB does not. */
export const PROBE_CHUNK_MAX_BYTES = 6 * 1024 * 1024;

/** The `tick` events of the SSE probe, and their spacing. */
export const PROBE_SSE_TICKS = 3;
export const PROBE_SSE_INTERVAL_MS = 1000;

/** At most this many X-Forwarded-For entries are answered by a poll and accepted in a result. */
export const XFF_ENTRIES_MAX = 10;

/** An X-Forwarded-For entry as the browser hands it back (an IPv6 address has at most 45 characters). */
export const XFF_ENTRY_MAX_LENGTH = 64;

/** `PUT diagnostics/realtime {sse: true}` on Passenger/LiteSpeed needs an SSE probe success at most this old (24 h). */
export const REALTIME_PROBE_MAX_AGE_MS = 86_400_000;

const xffEntry = z.string().max(XFF_ENTRY_MAX_LENGTH);

/** `POST diagnostics/probe-result` (and the wizard's `probe.results` in `POST install/api/config`, Task 27). */
export const ProbeResultBody = z.strictObject({
  /** The poll answered through the host (always true when the page could send this). */
  polling: z.boolean(),
  /** The SSE probe delivered its ticks spread out, not buffered. */
  sse: z.boolean(),
  /** Which real methods reached the server (false: a WAF refused it). */
  methods: z.strictObject({ put: z.boolean(), patch: z.boolean(), delete: z.boolean() }),
  /** The largest chunk that passed (bytes), or null when none did. */
  chunkBytes: z.int().min(1).max(PROBE_CHUNK_MAX_BYTES).nullable(),
  xff: z.strictObject({
    /** `xff` of the clean poll. */
    cleanXff: z.array(xffEntry).max(XFF_ENTRIES_MAX),
    /** `xff` of the forged poll. */
    forgedXff: z.array(xffEntry).max(XFF_ENTRIES_MAX),
    /** `ip` of the forged poll ('' when it had none). */
    forgedDerived: xffEntry,
  }),
});

export type ProbeResultBody = z.infer<typeof ProbeResultBody>;

/** The answer of `POST diagnostics/probe-result`. */
export interface ProbeResultResponse {
  /** `system.ip_trust` after the result. */
  ipTrust: IpTrust;
  spoofable: boolean;
  /** The hops the clean chain suggests (`trustProxy.hops`, set in `PUT system/config` or the wizard). */
  suggestedHops: number;
}

/** `PUT diagnostics/realtime`: `true`/`false` force SSE on/off; null = automatic (on, except Passenger/LiteSpeed). */
export const RealtimeBody = z.strictObject({ sse: z.boolean().nullable() });

export type RealtimeBody = z.infer<typeof RealtimeBody>;

/** The answer of `PUT diagnostics/realtime`: the setting as stored and the transport it gives this runtime. */
export interface RealtimeResponse {
  sse: boolean | null;
  transport: 'polling' | 'sse';
}

/** The answer of `POST diagnostics/clock-confirm`. */
export interface ClockConfirmResponse {
  /** Epoch ms the confirmation was recorded at. */
  confirmedAt: number;
}

/** The answer of `GET …/probe/poll`. */
export interface ProbePollResponse {
  /** The server's clock (epoch ms). */
  now: number;
  /** The client IP the configured hops derive; null without a usable peer. */
  ip: string | null;
  ipTrust: IpTrust;
  /** The request's X-Forwarded-For entries as received (blanks dropped), the last {@link XFF_ENTRIES_MAX}. */
  xff: string[];
  /** The peer (the proxy in front, or the browser) is a loopback or private address. */
  peerPrivate: boolean;
  /** The request's X-Forwarded-For entry count (at most 10): the hops a clean poll suggests. */
  suggestedHops: number;
  /** The client IP `suggestedHops` hops would give, shown for confirmation ('' without a usable peer). */
  ipAtSuggested: string;
}

/** The answer of `GET …/probe/hmac/:nonce` and the wizard's `GET probe/:nonce`. */
export interface ProbeHmacResponse {
  hmac: string;
}

/** The answer of `… probe/methods`: the method the server received. */
export interface ProbeMethodResponse {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

/** The answer of `POST … probe/chunk`: the size of the `chunk` field received. */
export interface ProbeChunkResponse {
  bytes: number;
}

// ---------------------------------------------------------------------------------------------------------------
// The report

/** The runtimes of @altis/platform (RUNTIMES). */
export type DiagnosticsRuntime = 'passenger' | 'litespeed' | 'pm2' | 'docker' | 'service' | 'standalone';

/** The run modes of the job runner (spec §10.2). */
export type DiagnosticsRunMode = 'worker' | 'cron_cli' | 'cron_http' | 'drive' | 'piggyback';

/** The database dialects of @altis/db. */
export type DiagnosticsDialect = 'mysql' | 'mariadb' | 'postgres' | 'sqlite';

/** One backup as the Backup list shows it (the server's `BackupItem`). */
export interface DiagnosticsBackup {
  id: string;
  kind: 'manual' | 'scheduled' | 'pre_update' | 'pre_restore' | 'external';
  status: 'running' | 'ok' | 'failed' | 'deleted' | 'uploaded';
  size: number | null;
  createdAt: number;
  consistency: 'snapshot' | 'frozen';
  includesFiles: boolean;
  external: boolean;
  sameInstall: boolean;
  schemaVersion: string;
  appVersion: string;
  dialect: DiagnosticsDialect;
}

// ---- 1d Task 29 (spec §11 "edisi", "rilis yang hilang atau tidak teradopsi"; §9.8; preflight S13) --------------------

/** How the release bundled beside app.js compares with `pending ?? active` of current.json (§9.8, as app.js sees it). */
export type BundledRelationView = 'newer' | 'same' | 'older';

/**
 * What became of the bundled release (§9.8, decision D1d-24):
 * - `ignored`: older or the same (row 4: "diabaikan, dicatat di Diagnostik"), or newer in image mode (no one-click
 *   update there; a new image arrives through row 3);
 * - `offered`: newer, begun as an update at boot (row 1), or waiting for the op that runs to end;
 * - `blocked`: newer, its prechecks failed (row 2, `update.bundled_blocked`);
 * - `failed_before`: newer, an update of it failed before (`releases_log`, op.json): not begun again on its own;
 * - `pinned`: newer, the version a manual rollback pinned (§9.7).
 */
export type BundledNoteView = 'ignored' | 'offered' | 'blocked' | 'failed_before' | 'pinned';

/** The release bundled beside app.js (`bundled-release/<app.js version>`) and what became of it. */
export interface DiagnosticsBundled {
  version: string;
  relation: BundledRelationView;
  note: BundledNoteView;
}

/** `GET diagnostics` (spec §11). Times are epoch ms. */
export interface DiagnosticsReport {
  release: {
    version: string;
    /** The version of the running app.js (null when the bootloader does not say). */
    appJsVersion: string | null;
    bootProtocol: 1;
    /** Versions named by releases/current.json whose folder is gone. */
    missing: string[];
    /** Versions current.json runs from the app folder (`bundled`), not adopted into DATA_DIR. */
    unadopted: string[];
    /** 1d Task 29: the release current.json names as `pending` (a pending boot, §9.3), or null. */
    pending: string | null;
    /** 1d Task 29: the version a manual rollback pinned (§9.7), or null. */
    pinned: string | null;
    /** 1d Task 29: the release bundled beside app.js and what became of it (§9.8); null without one. */
    bundled: DiagnosticsBundled | null;
    /**
     * 1d Task 29: DATA_DIR/releases/keyset.json (R65c): how many documents it holds, the highest `seq` among those that
     * verify against the embedded roots (0 without any), and whether the writer refused documents because it is full
     * (`system.keyset_full`). A store that cannot be read counts no document.
     */
    keyset: { docs: number; maxSeq: number; full: boolean };
  };
  runtime: {
    runtime: DiagnosticsRuntime;
    transport: 'polling' | 'sse';
    runner: { mode: 'worker' | 'external'; lastRuns: Partial<Record<DiagnosticsRunMode, number>> };
  };
  queue: { queued: number; running: number; dead: number; oldestQueuedMs: number | null };
  backup: { last: DiagnosticsBackup | null };
  /** The running edition: `{ edition: 'community', status: 'active' }` here. */
  edition: EditionView;
  database: {
    dialect: DiagnosticsDialect;
    version: string;
    fullText: boolean;
    limits: { maxUserConnections: number; maxConnections: number };
    poolSize: number;
  };
  /** The daily `diagnostics.usage` job's last measurement; null before it ran. */
  dataDir: { bytes: number; files: number; truncated: boolean; measuredAt: number } | null;
  memory: { rssBytes: number; heapUsedBytes: number; totalBytes: number; freeBytes: number };
  network: { ipTrust: IpTrust; hops: number; suggestedHops: number | null };
  wasm: { ok: boolean; hint: string | null };
  http: {
    methods: { put: boolean; patch: boolean; delete: boolean } | null;
    methodOverride: boolean;
    chunkBytes: number | null;
    probedAt: number | null;
  };
  audit: { chain: { ok: boolean; head: number; brokenAt: number | null; checkedAt: number } | null };
  clock: { anomaly: { detectedAt: number; maxSeen: number } | null };
  /** The daily `diagnostics.exposure` job's last result (`ok: false` = the red alert); null before it ran. */
  exposure: { ok: boolean; url: string | null; checkedAt: number } | null;
  /** The newest `disk_low` notification (P21's "peringatan Diagnostik"). */
  disk: { lowAt: number | null };
  // ---- Phase 2 (catalog): Task 3 (B2) ----
  /** The catalogue's search index (spec §4.8); null until the search provider fills it (Task 15). */
  search: SearchHealth | null;
  /** OAI-PMH (spec §10): `opac.oai.enabled`, and whether `opac.oai.adminEmail` is set; null until Task 15 fills it. */
  oai: { enabled: boolean; adminEmailSet: boolean } | null;
  // ---- Komunitas K1 (edition lane) ----
  /**
   * Migrations of another lane recorded in this database (the rows of `schema_migrations_edition`): 0 on a database
   * only this edition migrated.
   */
  editionLane: { applied: number };
  // ---- Komunitas K4 (stocktake) ----
  /** The stocktake sessions under way (preparing, active or finishing), oldest first, at most 20. */
  stocktakes: DiagnosticsStocktake[];
}

// ---- Komunitas K4 (stocktake) ----

/**
 * A stocktake session under way and its jobs: `job` is its preparation job (preparing, active) or its finish job
 * (finishing), the newest queued for the session, null when none was; `pendingUploads` the code lists still being
 * applied. `stuck` says why a preparing or finishing session does not move: no job (`no_job`), its job ended without
 * moving it on (`job_ended`: dead or cancelled), or its job has not written for 10 minutes (`stalled`); null otherwise.
 */
export interface DiagnosticsStocktake {
  id: string;
  branch: { id: string; code: string; name: string };
  name: string;
  status: 'preparing' | 'active' | 'finishing';
  startedAt: number;
  counts: { total: number; found: number; pending: number };
  job: { id: string; type: 'stocktake.prepare' | 'stocktake.finish'; status: string; progress: number; updatedAt: number } | null;
  pendingUploads: number;
  stuck: 'no_job' | 'job_ended' | 'stalled' | null;
}

// ---- Phase 2 (catalog): Task 3 (B2) ----

/**
 * The health of the catalogue's search index (spec §4.8; core `searchHealth`): `search_state`'s status (`missing`
 * before the first build, after a restore), the documents against the live records, the time of the last build, and
 * the rebuild job while one is queued or running.
 */
export interface SearchHealth {
  status: 'building' | 'ready' | 'missing';
  docs: number;
  records: number;
  builtAt: number | null;
  jobId: string | null;
}
