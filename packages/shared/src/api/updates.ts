/**
 * The updates API vocabulary shared by the server, the bootloader's minimal serving and the admin (spec §9.2 step 6,
 * §9.3-9.7, §13.5 "Update"). No Node built-ins here: the browser bundles this module. Import it as
 * `@altis/shared/api/updates`. Phase 1d Task 1 adds {@link UpdateStatusView}; Task 28 adds the rest of the routes'
 * shapes:
 *
 * | Route | Call | Access |
 * |---|---|---|
 * | `updates.get` | `GET updates` → {@link UpdatesView} | `system.update.read` |
 * | `updates.check` | `POST updates/check` → 202 {@link UpdateCheckResponse}; 429 `UPDATE_CHECK_THROTTLED` within 60 s | `system.update.read` |
 * | `updates.apply` | `POST updates/apply` {@link UpdateApplyBody} → {@link UpdateOpResponse} + `altis_ops` (reauth) | `system.update.run` |
 * | `updates.status` | `GET updates/status` → {@link UpdateStatusView}, header `X-Altis-Serving: server` | `opsAuth` |
 * | `updates.upload` | `POST updates/upload` {@link UpdateUploadBody} → {@link UpdateUploadDryRun} or {@link UpdateOpResponse} (reauth) | `system.update.run` |
 * | `updates.rollback` | `POST updates/rollback` → {@link UpdateOpResponse} + `altis_ops` (reauth) | `system.update.run` |
 * | `updates.channel` | `PUT updates/channel` {@link ChannelBody} → {@link ChannelResponse} | `system.update.run` |
 * | `updates.history` | `GET updates/history` {@link UpdateHistoryQuery} → {@link UpdateHistoryResponse} | `system.update.read` |
 *
 * In image mode (`ALTIS_RELEASE_SOURCE=image`, §9.8) apply, upload and rollback answer 409 `UPDATE_HIDDEN` reason
 * `image`, and {@link UpdatesView} says `oneClick: false, dockerPull: true`.
 */
import { z } from 'zod';
import { isSemver } from '../semver.js';
import { ulidField } from './common.js';
import type { OpStatusView } from './ops.js';

/**
 * The header with which the server (`server`) and app.js's minimal serving (`app`) answer `GET ops/current` and
 * `GET updates/status`: app.js's `/admin/_update` reloads into the server's page as soon as an answer carries
 * `server`, whatever its status (§9.2 step 6, preflight S20).
 */
export const SERVING_HEADER = 'X-Altis-Serving';

/**
 * The answer of `GET updates/status` (`opsAuth`): the current op, the release pointers of `releases/current.json` and
 * who answered. While a pending release boots, app.js answers it straight from `op.json` and `current.json` (§9.2 step
 * 6) with `serving: 'app'`; the server answers with `serving: 'server'`. The page `/admin/_update` reloads into the
 * server's page as soon as `serving` is `server`.
 */
export interface UpdateStatusView {
  /** The current (or last, within the hour) op; null without one. */
  op: OpStatusView | null;
  /** The versions `current.json` names (§9.3): `active` always, the others when set. */
  releases: {
    active: string;
    previous: string | null;
    pending: string | null;
    pinned: string | null;
  };
  /** `app`: app.js's minimal serving during the pending boot; `server`: the release's own server. */
  serving: 'app' | 'server';
  /**
   * 1d Task 29: while no op runs (none, or the last one ended), a newer bundled release whose prechecks failed (§9.8 row
   * 2, `update.bundled_blocked`) with the failures (`update.precheck.<failure>` names each); null without one. The
   * server sends it; app.js's minimal serving (no database) never does.
   */
  bundledBlocked?: { version: string; failures: string[] } | null;
}

// ---- 1d Task 28 -----------------------------------------------------------------------------------------------

/** The update channels (§9.6): the feed of each is `<feedBase>/<channel>/feed.json`. */
export const UPDATE_CHANNELS = Object.freeze(['stable', 'beta'] as const);

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** A release version as the update routes take it: SemVer 2.0.0 without a leading `v`, at most 64 characters. */
export const semverField = z
  .string()
  .max(64)
  .refine((v) => isSemver(v));

/**
 * The precheck failures (§9.6 step 2), in the order they are listed. @altis/shared cannot import core, so this mirrors
 * core's `PrecheckFailure`; core's updates/precheck.ts asserts at compile time that {@link PrecheckReportView} is its
 * `PrecheckReport` (preflight M7). The admin names each with `update.precheck.<failure>`.
 */
export const PRECHECK_FAILURE_VIEWS = Object.freeze([
  'not_newer',
  'min_upgrade_from',
  'boot_protocol',
  'min_node',
  'min_db',
  'entitlement',
  'snapshot_backup',
] as const);

export type PrecheckFailureView = (typeof PRECHECK_FAILURE_VIEWS)[number];

/** The prechecks of an update to one release (core's `PrecheckReport`, §9.6 step 2). */
export interface PrecheckReportView {
  ok: boolean;
  failures: PrecheckFailureView[];
  /** The running release is below the candidate's `minCodeVersionAfter`: "pemulihan DB diperlukan bila gagal". */
  dbRestoreNeeded: boolean;
  /** The expected maintenance time (ms). */
  estimateMs: number;
  /** The free space the update needs (bytes). */
  headroomBytes: number;
  /** The candidate is below the latest release the last check saw: another update follows it. */
  steppingStone: boolean;
  /** What a refusal names: the candidate's version, its bootProtocol and its `minUpgradeFrom` (the stepping stone). */
  candidate: { version: string; bootProtocol: number; minUpgradeFrom: string };
  /** Why this edition does not cover the release (the `entitlement` failure); null when it does (community: always). */
  notEntitled: 'no_license' | 'released_after' | null;
}

/** The answer of `GET updates` (§13.3 Pembaruan). */
export interface UpdatesView {
  /** The running release, the running app.js (null when the bootloader named none) and its contract (§9.2). */
  current: { version: string; appJs: string | null; bootProtocol: 1 };
  /** The channel the feed is read from (`update.channel`). */
  channel: UpdateChannel;
  /** The last update check: when (epoch ms), whether it worked, and the error code when it did not. Null before any. */
  check: { at: number; ok: boolean; error: string | null } | null;
  /**
   * The release the last check of this channel found to install, newer than the running one, or null:
   * `steppingStone` when a newer release (`latest`) follows it (§9.6, decision D1d-43).
   */
  available: { version: string; releasedAt: string; notesUrl: string | null; steppingStone: boolean; latest: string | null } | null;
  /** The prechecks of `available` as they stand now (the free space is proven when the update begins); null without it. */
  precheck: PrecheckReportView | null;
  /**
   * Whether "Kembali ke versi sebelumnya" can run (§9.7), why not (`no_previous`, `incompatible`, `missing`, `pending`,
   * or `image` in image mode, §9.8), and to which version.
   */
  rollback: { available: boolean; reason: string | null; target: string | null };
  /** The version a manual rollback pinned (§9.7), or null. */
  pinned: string | null;
  /** One-click update, package upload and rollback are offered (not in image mode, §9.8). */
  oneClick: boolean;
  /** Show the `docker compose pull && docker compose up -d` path (image mode, or the Docker runtime, §9.8). */
  dockerPull: boolean;
  /**
   * An update feed is configured, so updates are checked online (daily, from the dashboard, `POST updates/check`).
   * False for a build without a feed URL and none set: online checks are off and updates come by upload.
   */
  onlineCheck: boolean;
  /** The current (or last, within the hour) update or rollback op; null without one. */
  op: OpStatusView | null;
  /** A newer bundled release whose prechecks failed (§9.8 row 2), with the failures; null without one. */
  bundledBlocked: { version: string; failures: string[] } | null;
}

/** `POST updates/apply`: the version the last check found (`UpdatesView.available.version`). */
export const UpdateApplyBody = z.strictObject({ version: semverField });

export type UpdateApplyBody = z.infer<typeof UpdateApplyBody>;

/** The answer of `POST updates/apply`, the real `POST updates/upload` and `POST updates/rollback`: the op begun. */
export interface UpdateOpResponse {
  opId: string;
}

/**
 * `POST updates/upload` (decision D1d-31): a completed upload of context `update` (the release zip). `dryRun: true`
 * checks the package's signature and runs the prechecks without beginning anything; the upload stays, so the real call
 * may follow with the same `uploadId`.
 */
export const UpdateUploadBody = z.strictObject({ uploadId: ulidField, dryRun: z.boolean().optional() });

export type UpdateUploadBody = z.infer<typeof UpdateUploadBody>;

/** The answer of a dry run of `POST updates/upload`: the package's signed release and its prechecks. */
export interface UpdateUploadDryRun {
  version: string;
  releasedAt: string;
  precheck: PrecheckReportView;
}

/** The answer of `POST updates/check` (202): the queued check, which publishes `update.checked` on `system.update`. */
export interface UpdateCheckResponse {
  jobId: string;
}

/** `PUT updates/channel`. */
export const ChannelBody = z.strictObject({ channel: z.enum(UPDATE_CHANNELS) });

export type ChannelBody = z.infer<typeof ChannelBody>;

/** The answer of `PUT updates/channel`. */
export interface ChannelResponse {
  channel: UpdateChannel;
}

/** The default page size of `GET updates/history`. */
export const UPDATE_HISTORY_PAGE_DEFAULT = 50;
/** The largest page of `GET updates/history`. */
export const UPDATE_HISTORY_PAGE_MAX = 100;

/** `GET updates/history`: keyset paging on the row id, newest first; `before` is the previous page's `nextBefore`. */
export const UpdateHistoryQuery = z.strictObject({
  before: ulidField.optional(),
  limit: z.coerce.number().int().min(1).max(UPDATE_HISTORY_PAGE_MAX).optional(),
});

export type UpdateHistoryQuery = z.infer<typeof UpdateHistoryQuery>;

/** One `releases_log` row (§9.6 step 7): an update or rollback op (its id is the op's). */
export interface ReleaseLogView {
  id: string;
  /** The release the op installs or goes back to. */
  version: string;
  /** `update` or `rollback`. */
  action: string;
  /** The release it started from. */
  fromVersion: string | null;
  /** `running`, `done`, `aborted`, `rolled_back`, `restored`, `restore_failed` or `failed`. */
  status: string;
  startedAt: number;
  finishedAt: number | null;
  /** The `pre_update` backup it made, or null. */
  backupId: string | null;
}

/** The answer of `GET updates/history`: newest first; `nextBefore` is the `before` of the next page, or null. */
export interface UpdateHistoryResponse {
  items: ReleaseLogView[];
  nextBefore: string | null;
}
