/**
 * The system dashboard's vocabulary shared by the server and the admin SPA (spec §13.3 "Dasbor sistem: versi/update,
 * edisi, backup terakhir, antrean, penjadwal, peringatan"; plan Task 26; decision C33). No Node built-ins here: the
 * browser bundles this module. Import it as `@altis/shared/api/dashboard`.
 *
 * `GET dashboard` (any signed-in staff user: the dashboard is `/admin`) → 200 {@link DashboardResponse}. Every section
 * and every alert is filtered by the permission that guards its data, so a staff user without permissions gets the
 * version and the edition only, the other sections null and no alert:
 *
 * - `edition`: everyone (what the running edition is: the community edition, always active);
 * - `version.update`: `system.update.read` (1d Task 29: what the last update check found, §9.6);
 * - `lastBackup`, `nextBackupAt`: `system.backup.read`;
 * - `queue`, `scheduler`: `system.jobs.read`;
 * - each alert by the permission of its data: `runner_stale`, `jobs_dead` → `system.jobs.read`; `clock_anomaly`,
 *   `exposure_failed`, `ip_trust`, `disk_low`, `keyset_full` → `system.diagnostics.read`; `backup_missing`,
 *   `backup_failed` → `system.backup.read`; `audit_broken` → `system.audit.read`; `update_blocked`, `bundled_ignored`,
 *   `schema_hold` → `system.update.read`; `ops_attention` → the permission of the op's kind (`OP_KIND_PERMISSION`,
 *   who may take it over on `/admin/_update`), or any of them for an op of unknown kind; Phase 2's
 *   `search_index_mismatch` (the search index disagrees with the catalog) and `oai_misconfigured` (OAI-PMH is on
 *   without an admin e-mail) → `system.diagnostics.read`.
 *
 * Times are epoch ms, except a release's `releasedAt`, a calendar date `YYYY-MM-DD` (Asia/Jakarta).
 */
import type { EditionView } from '../edition.js';
import type { MessageKey } from '../i18n/index.js';
import type { BackupItem } from './backups.js';
import type { DiagnosticsRunMode } from './diagnostics.js';
import type { ScheduleView } from './jobs.js';

/** The kinds of dashboard alert, in the order the dashboard lists them within one severity. */
export const ALERT_KINDS = Object.freeze([
  'runner_stale',
  'clock_anomaly',
  'exposure_failed',
  'backup_missing',
  'backup_failed',
  'jobs_dead',
  'disk_low',
  'ops_attention',
  'ip_trust',
  'audit_broken',
  // 1d Task 29 (preflight S13)
  'keyset_full',
  'update_blocked',
  'bundled_ignored',
  'schema_hold',
  // ---- Phase 2 (catalog): Task 2 ----
  'search_index_mismatch',
  'oai_misconfigured',
] as const);

export type AlertKind = (typeof ALERT_KINDS)[number];

/** How bad an alert is; the dashboard lists `error` first, then `warning`, then `info`. */
export type AlertSeverity = 'info' | 'warning' | 'error';

/**
 * One alert. `messageKey` is `alert.<kind>` (the shared catalog; the texts take no placeholder); `params` carries what
 * the kind measured (`jobs_dead`: `count`; `ip_trust`: `suggestedHops` when the browser test found one); `link` is the
 * admin page that explains or fixes it.
 */
export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  messageKey: MessageKey;
  params?: Record<string, string | number>;
  link?: string;
}

// Every kind has its message in the catalog (a compile-time check: a kind without one fails here).
const _alertKey: (kind: AlertKind) => MessageKey = (kind) => `alert.${kind}`;
void _alertKey;

/** The run modes of the job runner (spec §10.2). */
export type DashboardRunMode = DiagnosticsRunMode;

/**
 * 1d Task 29: what the dashboard shows of updates (§9.6, §13.3 "versi/update"), for `system.update.read`.
 * - `available`: the release the last check of the current channel found to install, newer than the running one
 *   (`steppingStone`: a newer release follows it); null without one;
 * - `checkedAt`: when the last check ran (epoch ms), null before any;
 * - `entitled`: false only when this edition does not cover the release `available`; community: always true (also
 *   without an available release);
 * - `oneClick`: one-click updates are offered (not in image mode, §9.8);
 * - `pinned`: the version a manual rollback pinned (§9.7), or null.
 */
export interface DashboardUpdate {
  available: { version: string; releasedAt: string; notesUrl: string | null; steppingStone: boolean } | null;
  checkedAt: number | null;
  entitled: boolean;
  oneClick: boolean;
  pinned: string | null;
}

/** `GET dashboard`. A section the caller may not see is null (the version and the edition are everyone's). */
export interface DashboardResponse {
  /** The running release, its app.js and boot protocol; `update` (1d) null without `system.update.read`. */
  version: { current: string; appJs: string | null; bootProtocol: 1; update: DashboardUpdate | null };
  /** The running edition (always present, for every staff user): `{ edition: 'community', status: 'active' }` here. */
  edition: EditionView;
  /** The newest backup that is not deleted, whatever its status (as Diagnostik shows it); null without one. */
  lastBackup: BackupItem | null;
  /** The next run of `backup.daily`; null while it is off. */
  nextBackupAt: number | null;
  /** The job queue: counts by status and how long the oldest due job has waited. */
  queue: { queued: number; running: number; dead: number; oldestQueuedMs: number | null } | null;
  /** The runner (`external`: cron or nothing runs the jobs) with its run records, and the schedules (`GET schedules`). */
  scheduler: { runner: { mode: 'worker' | 'external'; lastRuns: Partial<Record<DashboardRunMode, number>> }; schedules: ScheduleView[] } | null;
  alerts: Alert[];
}
