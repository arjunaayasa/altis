// @altis/core: framework-free domain code (D1). Never imports Hono or apps/*; HTTP concepts stay in apps/server.

export { runnerFor, securityAudit, txCtx } from './context.js';
export type { Actor, AuditInput, CoreLogger, TxCtx, TxRunner } from './context.js';
export { SCRYPT, createPasswordHasher, normalizePassword } from './crypto/password.js';
export type { PasswordHasher, PasswordHasherOptions, ScryptFn, ScryptParams } from './crypto/password.js';
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, checkPasswordPolicy, isCommonPassword } from './crypto/policy.js';
export type { PasswordWeakness } from './crypto/policy.js';
export { openValue, sealValue, secretAad } from './crypto/secret-box.js';
export type { KeyringEntry } from './crypto/secret-box.js';
export { hmacB64u, randomToken, safeEqual, sha256hex } from './crypto/tokens.js';
export { generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash, temporaryPassword } from './crypto/codes.js';
export {
  TOTP,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  otpauthUri,
  totpStep,
} from './auth/totp.js';
export { BUCKETS, bucketKey, clearBucket, hit, refund } from './auth/rate-limit.js';
export type { BucketName, Hit } from './auth/rate-limit.js';
export { sweepVolatile } from './maintenance/sweep.js';
export type { SweepResult } from './maintenance/sweep.js';
export { SETTINGS, allSettingKeys, groupKeys, isSettingKey } from './settings/registry.js';
export type { SettingDef, SettingKey, SettingsGroup } from './settings/registry.js';
export { createSettingsCache, readSecret, readSettings, writeSettings } from './settings/service.js';
export type { SettingsCache, WriteSettingsOptions } from './settings/service.js';
// ---- Komunitas K1 (settings) ----
export { loadAccredSettings } from './settings/accreditation.js';
export type { AccredSettings } from './settings/accreditation.js';
export {
  PRE_MFA_MS,
  ROTATION_GRACE_MS,
  SESSION_ABSOLUTE_MS,
  TOUCH_INTERVAL_MS,
  createSession,
  findSession,
  listSessions,
  markReauth,
  revokeSession,
  revokeSubject,
  rotateSession,
  touchSession,
} from './auth/sessions.js';
export type { CreateSessionInput, RotatePatch, SessionToken, SessionView } from './auth/sessions.js';
export { DEVICE_MAX_MACS, deviceCookieAfterLogin, deviceKnows, deviceMac, parseDeviceCookie } from './auth/device.js';
export type { DeviceCookie } from './auth/device.js';
export {
  REMEMBER_GRACE_MS,
  REMEMBER_MS,
  issueRememberToken,
  rememberSessionToken,
  useRememberToken,
} from './auth/remember.js';
export type { RememberOutcome } from './auth/remember.js';
export { loadStaffAuthView, mfaNeeded, stageOf } from './auth/staff.js';
export type { StaffAuthView } from './auth/staff.js';
export { login } from './auth/login.js';
export type { LoginCtx, LoginOutcome } from './auth/login.js';
export { bumpAuthzVersion, can, createGrantsCache, grantSubset, loadGrants } from './authz/grants.js';
export type { Grants, GrantsCache } from './authz/grants.js';
export { ensureSystemRoles } from './authz/system-roles.js';
export { assertCanAssign, assertCanManageUser, assertCanWriteRole } from './authz/escalation.js';
export type { ActorAuthz, RoleSnapshot } from './authz/escalation.js';
export { guardSuperAdmins } from './authz/super-admin-guard.js';
export { authorizeChannels } from './authz/channels.js';
export { DEFAULT_SMTP_TIMEOUT_MS, createSmtpMailer, loadSmtpConfig, smtpTransportOptions } from './mail/smtp.js';
export type { Mailer, SmtpConfig, SmtpMailerOptions, SmtpSecurity, SmtpTransportOptions } from './mail/smtp.js';
export { renderMail } from './mail/templates.js';
export type { MailKind, MailOverride } from './mail/templates.js';
export {
  beginTotpSetup,
  checkSecondFactor,
  disableTotp,
  disableTotpWithCredentials,
  enableTotp,
  reauthenticate,
  regenerateRecoveryCodes,
  verifySecondFactor,
} from './auth/mfa.js';
export type { DisableTotpInput, ReauthInput, SecondFactor, SecondFactorInput, VerifyInput, VerifyOutcome } from './auth/mfa.js';
export {
  adminResetPassword,
  adminResetTotp,
  createUser,
  getUser,
  listUsers,
  replaceUserRoles,
  setUserStatus,
  updateUser,
} from './users/service.js';
export type { CliActor, CreateUserInput, ServiceActor } from './users/service.js';
export { createRole, deleteRole, getRole, listPermissions, listRoles, updateRole } from './roles/service.js';
export { archiveBranch, createBranch, listBranches, updateBranch } from './branches/service.js';
export { AUDIT_EXPORT_BATCH, auditBatches, listAudit } from './audit/query.js';
export { CSV_BOM, csvCell, csvRow } from './export/csv.js';
export { lockStaffRow } from './auth/staff.js';
export { revokeSessionLineage } from './auth/sessions.js';
export { revokeRememberToken } from './auth/sessions.js';
export { restoreRememberedSession } from './auth/remember.js';
export type { RestoreInput, RestoreOutcome } from './auth/remember.js';
export {
  PASSWORD_RESET_TTL_MS,
  changePassword,
  completePasswordReset,
  passwordResetSubject,
  revokeOwnSession,
  startPasswordReset,
  updateOwnProfile,
} from './auth/password.js';
export type { ChangePasswordInput, PasswordResetStart, ProfilePatch } from './auth/password.js';
export { inRotationGrace, rotatedInto } from './auth/sessions.js';
// 1c Task 4: events (publish, cursor, reader, durable consumers, retention).
export { EVENT_PAYLOAD_MAX, RESERVED_EVENT_TYPES, createRealtimeTransport, isEventType, publish } from './events/publish.js';
export type { EventInput, RealtimeTransport } from './events/publish.js';
export { formatCursor, parseCursor } from './events/cursor.js';
export { EVENT_OVERLAP_MS, EVENT_PAGE, EVENT_SETTLE_MS, readEvents } from './events/reader.js';
export type { EventItem, ReadEventsOptions } from './events/reader.js';
export { CONSUMER_HOLD_MS, runConsumers } from './events/consumers.js';
export type { EventConsumer } from './events/consumers.js';
export { EVENT_KEEP_MS, EVENT_MAX_AGE_MS, purgeEvents } from './events/retention.js';
// 1c Task 7: notifications (per user and per permission, read markers, event hints).
export {
  NOTIFICATION_LINK_MAX,
  NOTIFICATION_MARK_BATCH,
  NOTIFICATION_PARAMS_MAX,
  NOTIFICATION_TTL_MS,
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  notify,
} from './notifications/service.js';
export type { NotificationAudience, NotificationInput, NotificationItem } from './notifications/service.js';
// 1c Task 6: OpsMachine (op.json, maintenance flag, data epoch, freeze, op kinds migrate/install-migrate/reset).
export {
  MAINTENANCE_REASONS,
  activeOp,
  bumpDataEpoch,
  clearMaintenance,
  readDataEpoch,
  readMaintenance,
  readOpFile,
  writeMaintenance,
} from './ops/files.js';
export type { MaintenanceFlag, OpActor, OpFile } from './ops/files.js';
export { FREEZE_SETTLE_MS, FREEZE_WAIT_MS, liveLeases } from './ops/freeze.js';
export { OPS_STALL_MS, controlPending, createOpsMachine, withControlLock } from './ops/machine.js';
export type { OpHandle, OpKindHandler, OpStatus, OpStepContext, OpsMachine, OpsMachineOptions } from './ops/machine.js';
export { migrateKind } from './ops/kinds/migrate.js';
export type { MigrationKindDeps } from './ops/kinds/migrate.js';
export { installMigrateKind } from './ops/kinds/install-migrate.js';
export { resetKind } from './ops/kinds/reset.js';
// 1c Task 9: chunked uploads, magic bytes, file serving and the local storage driver.
export { CHUNK_DEFAULT_BYTES, CHUNK_MIN_BYTES, UPLOADS_PER_SUBJECT, UPLOAD_CONTEXTS, UPLOAD_TTL_MS, uploadContext } from './files/contexts.js';
export type { UploadContext } from './files/contexts.js';
// ---- Komunitas K1 (uploads) ----
export { ORPHAN_UPLOAD_CONTEXTS } from './files/orphan-contexts.js';
export type { OrphanUploadContext } from './files/orphan-contexts.js';
export { MAGIC_HEAD_BYTES, detectType } from './files/magic.js';
export type { DetectedKind, DetectedType } from './files/magic.js';
export {
  abortUpload,
  acceptChunk,
  completeUpload,
  createUpload,
  prepareUpload,
  stagedUploadFile,
  takeStagedUpload,
  uploadOwner,
} from './files/uploads.js';
export type { StagedUpload } from './files/uploads.js';
export { contentDisposition, fileResponseHeaders, localStorageDriver, safeFileName } from './files/serve.js';
export type { StorageDriver } from './files/serve.js';
// 1c Task 10: install code, claim and gate (spec §7.7, §9.5 step 0; decision C19).
export {
  EXAMPLE_INSTALL_CODE,
  INSTALL_CODE_TTL_MS,
  currentInstallCode,
  ensureInstallCode,
  envInstallCode,
  formatInstallCode,
  generateInstallCode,
  normalizeInstallCode,
} from './install/code.js';
export type { InstallCodeInfo } from './install/code.js';
export {
  CLAIM_ATTEMPTS,
  CLAIM_WINDOW_MS,
  INSTALL_SESSION_IDLE_MS,
  claimInstall,
  installCsrfToken,
  probeHmac,
  readInstallSession,
} from './install/session.js';
export type { ClaimResult, InstallSession } from './install/session.js';
export { dbInstallId, installGate, installLockExists } from './install/gate.js';
export type { InstallGate, InstallGateOptions } from './install/gate.js';
// 1c Task 27: the wizard's steps (preflight checks, step order, exposure verdict, scheduler test, migration progress)
// and its state in the install session.
export { EMPTY_WIZARD_STATE, currentInstallSession, updateInstallWizard } from './install/session.js';
export type { InstallWizardState } from './install/session.js';
export {
  MIN_NODE_VERSION,
  PREFLIGHT_HEADROOM_BYTES,
  PREFLIGHT_MIN_RAM_BYTES,
  failedChecks,
  nodeVersionSupported,
  preflightChecks,
} from './install/preflight.js';
export type { PreflightOptions } from './install/preflight.js';
export {
  CRON_SEEN_FRESH_MS,
  appliedMigrationNames,
  assertInstallStep,
  cronStatus,
  ensureInstallProbe,
  exposedBy,
  exposureTargets,
  migrationCounts,
  panelWarningFor,
  removeInstallProbe,
} from './install/steps.js';
export type { CronStatusOptions, ExposureTarget } from './install/steps.js';
// 1c Task 5: job queue (registry, enqueue, claim, lease, fencing, slice results, job sessions).
export {
  DEFAULT_MAX_ATTEMPTS,
  HEAVY_LOCK,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  JOB_PAYLOAD_MAX,
  JOB_SECRET_MAX,
  JOB_STATUSES,
  SLICE_BUDGET_MS,
  retryDelayMs,
} from './jobs/types.js';
export type {
  ClaimedJob,
  EnqueueInput,
  JobContext,
  JobHandler,
  JobOutcome,
  JobRegistry,
  JobRow,
  JobStatus,
  RunMode,
  SliceResult,
} from './jobs/types.js';
export { JOB_TYPE, createJobRegistry } from './jobs/registry.js';
export { enqueue } from './jobs/enqueue.js';
export { claimById, claimNext } from './jobs/claim.js';
export type { ClaimOptions } from './jobs/claim.js';
export { closeJobSessions, pruneJobSessions, runSlice } from './jobs/slice.js';
export type { RunSliceOptions } from './jobs/slice.js';
export { JOBS_PAGE_MAX, getJob, listJobs, requestCancel, retryJob } from './jobs/service.js';
// 1c Task 11: backup format and resumable exporter (canonical JSONL parts, checksums without secrets, HMAC manifest,
// content-addressed blobs, backups list).
export {
  BACKUP_PATH_TABLES,
  backupRowIncluded,
  backupTables,
  canonicalLine,
  canonicalRow,
  checksumLine,
  tableChecksumFromDb,
} from './backup/canonical.js';
export type { BackupClass, BackupTable } from './backup/canonical.js';
export {
  BACKUP_FORMAT,
  backupManifestSchema,
  manifestHmac,
  readManifest,
  verifyManifestHmac,
  writeManifest,
} from './backup/manifest.js';
export type { BackupKind, BackupManifest, BackupManifestTable, BackupPart } from './backup/manifest.js';
export { EXPORT_BATCH, PART_CLOSE_MARGIN_MS, PART_MAX_ROWS, createExporter, exportCheckpointSchema } from './backup/exporter.js';
export type { ExportCheckpoint, ExportStepResult, Exporter, ExporterOptions } from './backup/exporter.js';
export { blobPath, gcBlobs, linkBlob } from './backup/blobs.js';
export type { BlobSource } from './backup/blobs.js';
export { listBackups, newestBackup } from './backup/catalog.js';
export type { BackupItem } from './backup/catalog.js';
// 1c Task 13: runner modes (worker, cron, drive, piggyback), run records and the /_cron single-flight.
export { JOBS_RUN_DEFAULT_S, LIGHT_PER_PROCESS, createRunner, runnerMode } from './jobs/runner.js';
export type { PassReport, Runner, RunnerOptions } from './jobs/runner.js';
export { PIGGYBACK_BUDGET_MS, PIGGYBACK_MIN_GAP_MS, PIGGYBACK_YIELD_MS, createPiggyback } from './jobs/piggyback.js';
export type { Piggyback, PiggybackOptions } from './jobs/piggyback.js';
export {
  CRON_FLIGHT_MS,
  RUNNER_STALE_MS,
  RUN_MODES,
  RUN_RECORD_MIN_GAP_MS,
  cronFlight,
  lastRuns,
  readCronSeen,
  recordRun,
  runnerFresh,
  writeCronSeen,
} from './jobs/run-records.js';
// 1c Task 12: `.altisbak` archive codec (resumable ZIP64 writer, STREAM AES-GCM chunks, scrypt-wrapped DEK, guarded
// zip reader on yauzl). The entry grammar ALTISBAK_ENTRY stays in @altis/platform (one definition).
export {
  NONCE_PREFIX_BYTES,
  STREAM_CHUNK,
  STREAM_TAG_BYTES,
  decryptChunk,
  decryptStream,
  encryptChunk,
  encryptedSize,
  plainSizeOf,
  streamChunkCount,
} from './archive/stream-cipher.js';
export {
  ARCHIVE_SALT_BYTES,
  ARCHIVE_SCRYPT,
  DEK_BYTES,
  PASSPHRASE_MIN_CODE_POINTS,
  columnKey,
  deriveKek,
  newArchiveSalt,
  newDek,
  openArchiveValue,
  sealArchiveValue,
  unwrapDek,
  wrapDek,
} from './archive/kdf.js';
export { ARCHIVE_MAX_ENTRIES, DEFLATE_MAX_RATIO, openArchive } from './archive/zip-reader.js';
export type { ArchiveEntry, ArchiveReader, OpenArchiveOptions } from './archive/zip-reader.js';
export { altisbakCheckpointSchema, openAltisbakWriter } from './archive/zip64-writer.js';
export type { AltisbakCheckpoint, AltisbakWriter, OpenAltisbakWriterOptions } from './archive/zip64-writer.js';
export { ALTISBAK_HEADER_ENTRY, ALTISBAK_STREAM_ALG, altisbakHeaderSchema, openAltisbak, readAltisbakHeader } from './archive/altisbak.js';
export type { AltisbakHeader, AltisbakSource, ExtractCheckpoint, OpenAltisbakOptions } from './archive/altisbak.js';
// 1c Task 14: scheduler (cron expressions in library time, the schedule definitions, seeding, compare-and-set ticks
// with one catch-up run) and clock_anomaly (detection, admin confirmation, signed-time clearing).
export { nextRun, parseCronExpr, periodMs } from './scheduler/cron-expr.js';
export type { CronExpr } from './scheduler/cron-expr.js';
export { SCHEDULES, scheduleWindowSchema } from './scheduler/registry.js';
export type { ScheduleDef, ScheduleWindow } from './scheduler/registry.js';
export { createScheduler, seedSchedules, tickSchedules } from './scheduler/tick.js';
export type { Scheduler, SchedulerOptions, TickOptions } from './scheduler/tick.js';
export {
  CLOCK_TOLERANCE_MS,
  clearClockAnomaly,
  confirmClock,
  detectClockAnomaly,
  readClockAnomaly,
  refreshClockAnomaly,
} from './scheduler/clock.js';
export type { ClockAnomaly } from './scheduler/clock.js';
// 1c Task 24: `secrets:rotate` (decision C32); the `reset` kind's step lives in ops/kinds/reset.ts (exported above).
export { ROTATE_BATCH, ROTATE_SETTLE_MS, rotateSecrets } from './secrets/rotate.js';
export type { RotateSecretsOptions } from './secrets/rotate.js';
// 1c Task 23: Diagnostik (the §11 report, the browser probes' XFF analysis, WASM, the exposure, ip_trust and usage
// jobs, the search-provider interface).
export { XFF_HOPS_MAX, analyzeXff, xffClientAt } from './diagnostics/xff.js';
export { WASM_HINT, wasmProbe } from './diagnostics/wasm.js';
export {
  EXPOSURE_FETCH_TIMEOUT_MS,
  EXPOSURE_MAX_BYTES,
  EXPOSURE_MAX_LEVELS,
  EXPOSURE_MIN_FETCH_MS,
  exposureCandidates,
  exposureJob,
  exposurePayload,
  fetchBounded,
  pathSuffixes,
} from './diagnostics/exposure.js';
export type { ExposureCandidate, ExposureFetch, ExposureJobDeps, ExposureKind, ExposurePayload, ExposureResponse } from './diagnostics/exposure.js';
export {
  IP_TRUST_DOMINANCE,
  IP_TRUST_MIN_SESSIONS,
  IP_TRUST_RECOVERY_MIN_SESSIONS,
  IP_TRUST_WINDOW_MS,
  ipTrustJob,
  refreshIpTrust,
  sessionDominance,
} from './diagnostics/ip-trust.js';
export { recordProbeResult, setRealtime, sseNeedsProbe } from './diagnostics/probes.js';
export type { ProbeOutcome, StoredProbe } from './diagnostics/probes.js';
export { collectDiagnostics, diagnosticsJobs, fullTextCapability, usageJob } from './diagnostics/collect.js';
export type { CollectOptions, DiagnosticsJobDeps, SearchProvider } from './diagnostics/collect.js';
// 1c Task 18: housekeeping and retention jobs (volatile, events, notifications, jobs, files, audit anchor and
// retention), and the password-reset mail through the queue (sweepVolatile stays above; createSweeper is gone).
export { housekeepingJobs } from './housekeeping/handlers.js';
export type { HousekeepingDeps } from './housekeeping/handlers.js';
export { LOCK_KEEP_MS, purgeVolatile } from './housekeeping/volatile.js';
export type { VolatileResult } from './housekeeping/volatile.js';
export { NOTIFICATION_PURGE_BATCH, purgeNotifications } from './housekeeping/notifications.js';
export { DEAD_JOB_KEEP_MS, FINISHED_JOB_KEEP_MS, purgeJobs } from './housekeeping/jobs.js';
export { FILES_PHASES, cleanFiles, filesCheckpointSchema } from './housekeeping/files.js';
export type { CleanFilesOptions, FilesCheckpoint, FilesPhase } from './housekeeping/files.js';
export { anchorAudit } from './housekeeping/audit-anchor.js';
export type { AuditVerified } from './housekeeping/audit-anchor.js';
export { AUDIT_PURGE_BATCH, AUDIT_RETENTION_MS, auditPurgeCheckpointSchema, purgeAudit } from './housekeeping/audit-retention.js';
export type { AuditPurgeCheckpoint } from './housekeeping/audit-retention.js';
export { MAIL_PASSWORD_RESET, enqueuePasswordResetMail, mailJobs, passwordResetMailSchema } from './mail/jobs.js';
export type { MailJobDeps, PasswordResetMail } from './mail/jobs.js';
// 1c Task 20: backup creation (snapshot job, frozen op, the daily schedule's job, mode and estimate, retention).
export {
  BACKUP_FROZEN_SKIP_MS,
  BACKUP_PASSENGER_SNAPSHOT_MAX_MS,
  BACKUP_SNAPSHOT_LOCK,
  BACKUP_SNAPSHOT_LOCK_MS,
  backupEstimateMs,
  chooseConsistency,
  decideBackupMode,
  estimateBackupMs,
  lastBackupRate,
  snapshotBackupRunning,
} from './backup/mode.js';
export {
  BACKUP_CHANNEL,
  BACKUP_CREATE_JOB,
  BACKUPS_LINK,
  CONVERTED_TO_FROZEN,
  backupCreateJob,
  backupCreatePayload,
  backupHeadroomBytes,
  snapshotCopyPath,
} from './backup/create-job.js';
export type { BackupCreatePayload, BackupDeps, BackupJobDeps } from './backup/create-job.js';
export { backupKind } from './backup/frozen-op.js';
export type { BackupOpDeps } from './backup/frozen-op.js';
export { BACKUP_SCHEDULE_JOB, backupScheduleJob, enqueueSnapshotBackup, startBackup } from './backup/schedule-job.js';
export type { StartedBackup } from './backup/schedule-job.js';
export { applyBackupRetention, isoWeekOf } from './backup/retention.js';
export { orphanBackups } from './backup/orphans.js';
// 1c Task 26: the system dashboard (permission-scoped sections and alerts, decision C33).
export { ALERT_PERMISSION, dashboardSummary } from './dashboard/summary.js';
export type { DashboardOptions } from './dashboard/summary.js';
// Beranda's library figures: today at a desk's branch, and the permission-scoped library sections.
export { deskDashboard, libraryDashboard } from './dashboard/home.js';
// 1c Task 21: the download preparation (`backup.prepare_download`, the preparer's own `.altisbak`), its prepared files
// for the ranged download, and the archive upload (an `external` backup).
export {
  BACKUP_PREPARE_DOWNLOAD_JOB,
  backupPrepareDownloadJob,
  backupPrepareDownloadPayload,
  deriveDownloadKey,
  downloadSecrets,
  enqueuePrepareDownload,
  markDownloadCompleted,
  preparedDownloadPath,
  readPreparedDownload,
} from './backup/prepare-download.js';
export type {
  BackupPrepareDownloadPayload,
  DownloadKey,
  DownloadSecrets,
  PrepareDownloadDeps,
  PreparedDownload,
} from './backup/prepare-download.js';
export {
  moveUploadedArchive,
  readUploadedHeader,
  registerUploadedBackup,
  uploadedArchivePath,
  uploadedArchiveSource,
} from './backup/upload.js';
// 1c Task 22: restore (the `restore` op kind: source, read-only pre-pass, kept rows, load, secret branches, files,
// finalizing, failure back to `pre_restore`).
export { openRestoreSource } from './restore/source.js';
export type { OpenRestoreSourceOptions, RestoreSource } from './restore/source.js';
export { CONFLICTS_MAX, TRIMMED_MAX, checkRow, prepassStep, readRestoreReport, rekey } from './restore/prepass.js';
export type { Conflict, ConflictDetail, PrepassCheckpoint, RestoreReport } from './restore/prepass.js';
export { CHECKLIST_MAX, restoreSecretColumns, secretsBranch } from './restore/secrets.js';
export type { RestoreChecklist, SecretsBranch } from './restore/secrets.js';
export { KEPT_TABLES } from './restore/keep.js';
export { LOAD_TX_ROWS, loadTables } from './restore/load.js';
export { VOLATILE_TABLES } from './restore/finalize.js';
export { restoreKind } from './restore/kind.js';
export type { RestoreKindDeps, RestoreParams, SqliteSwap } from './restore/kind.js';
// 1c Task 25: restore on SQLite (the work file and its swap into place, the rename back).
export { SQLITE_RELEASE_WAIT_MS, createSqliteSwap } from './restore/sqlite-swap.js';
export type { SqliteSwapOptions } from './restore/sqlite-swap.js';
// 1d Task 11: the OpsMachine for updates (maintenance and the freeze from a state, entry states, beforeMaintenance;
// in ops/machine.ts) and the boot plan of the op a starting server finds (decision D1d-14).
export { KIND_MAINTENANCE_FROM, effectiveState, holdsMaintenance, opBootPlan } from './ops/boot-plan.js';
export type { BootPlan } from './ops/boot-plan.js';
// 1d Task 5: the remaining 1c follow-ups (the audit anchor's sliced run, the audit retention's run fixed first, one
// referenced-blobs rule, the external backup row shared by the upload route and the CLI).
export type { AnchorResume, AnchorRun, AnchorWalk } from './housekeeping/audit-anchor.js';
export { startAuditPurge } from './housekeeping/audit-retention.js';
export { referencedBlobs } from './backup/blob-refs.js';
export type { BlobReferences } from './backup/blob-refs.js';
export { insertExternalBackupRow } from './backup/upload.js';
// 1d Task 6: the generic exporter's columns (the database's catalog; a schemaHold `pre_update` backup) and the backup
// manifest's fields of a later release.
export { CATALOG_COLUMN_SINCE, catalogBackupTables, catalogColumnSpecs, columnSpecOf } from './backup/generic-columns.js';
export type { CatalogBackupTable } from './backup/generic-columns.js';
export { unknownManifestFields } from './backup/manifest.js';
// 1d Task 12: the restore runner (the update revert's restore inside its op: targetSchema 'backup', secrets branch a,
// the drop by schema_tables; C44, D1d-44) and the one tolerant manifest reader of ruling R1d-3.
export { RESTORE_SUB_STATES, createRestoreRunner } from './restore/runner.js';
export type { RestoreRun, RestoreRunParams, RestoreRunner, RestoreSubState, SqliteSwapWait } from './restore/runner.js';
export { parseManifestJson, signedManifestObject, unverifiedManifestFields } from './backup/manifest.js';
// 1d Task 10: the keyset store, DATA_DIR/releases/keyset.json (spec §8.3; D1d-27): verified root-signed
// documents appended under releases/keyset.lock within the frozen limits, the `system.keyset_full` alert, and the
// keyset documents of the installation's releases.
export { appendKeysetDocs, persistKeysetDocs, releaseKeysetDocs } from './updates/keyset-store.js';
export type { AppendKeysetOptions, AppendKeysetResult } from './updates/keyset-store.js';
// 1d Task 21: the update prechecks (spec §9.6 step 2: stepping stones, bootProtocol, minNode, minDb, the entitlement,
// a running snapshot backup, the estimate and the headroom; D1d-32, D1d-43) and the one-pass verified extraction of a
// release package into the update's staging folder (§9.1, §9.6; preflight S9, S10).
export { candidateOf, pickCandidate, reachableFrom } from './updates/candidate.js';
export type { Candidate } from './updates/candidate.js';
export {
  BOOT_PROTOCOL,
  PRECHECK_FAILURES,
  PRECHECK_MIGRATION_MS,
  bootProtocolRefusal,
  precheck,
  runPrecheck,
  throwPrecheck,
} from './updates/precheck.js';
export type { PrecheckEngine, PrecheckFailure, PrecheckInput, PrecheckReport, RunPrecheckDeps } from './updates/precheck.js';
export { PACKAGE_RELEASE_DIR, extractVerifiedRelease, readPackageManifest } from './updates/package.js';
export type { ExtractReleaseOptions } from './updates/package.js';
// 1d Task 20: the feed client, UpdateSource (spec §9.6, §13.8; D1d-29; preflight 1D-12, 1D-18): node:https requests
// with a timeout, a size limit and https-only redirects (P18), the per-channel feed state (seq anti-rollback), the
// verified feed with its keyset documents persisted and its signed time reported, and resumable package downloads.
export { DOWNLOAD_IDLE_TIMEOUT_MS, FETCH_MAX_BYTES, FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, fetchRange, fetchText } from './updates/https.js';
export type { FetchFailureReason, FetchRangeOptions, FetchRangeResult, FetchTextOptions } from './updates/https.js';
export { raiseFeedSeq, readFeedState } from './updates/feed-state.js';
export type { FeedSeen } from './updates/feed-state.js';
export { FEED_FETCH_TIMEOUT_MS, createUpdateSource } from './updates/source.js';
export type { DownloadResult, UpdateSource, UpdateSourceOptions } from './updates/source.js';
// 1d Task 24: the `update` op kind up to its point of no return (spec §9.4, §9.6; D1d-15, D1d-38; preflight B5, B7, S3,
// S5, S21, 1D-07, 1D-18, 1D-23), its end (`releases_log`, `update.apply`, the notification), the release log, and where
// the releases come from (`ALTIS_RELEASE_SOURCE`, §9.8; preflight B6).
export { RELEASE_SOURCE_ENV, releaseSourceMode } from './updates/source-mode.js';
export { RELEASE_LOG_FINAL, insertReleaseLog, readReleaseLog, setReleaseLogStatus } from './updates/releases-log.js';
export type { ReleaseLogAction, ReleaseLogRow, ReleaseLogStatus } from './updates/releases-log.js';
export { finishUpdate } from './updates/finish.js';
export type { UpdateOutcome } from './updates/finish.js';
export {
  UPDATE_DOWNLOAD_TRIES,
  UPDATE_RESTART_INTERVAL_MS,
  downloadBackoffMs,
  parseUpdateParams,
  updateKind,
  updateParamsSchema,
} from './updates/kind.js';
export type { BootHooks, UpdateKindDeps, UpdateParams } from './updates/kind.js';
// 1d Task 26: the manual rollback (spec §9.7; D1d-33; preflight 1D-22): its availability, the `rollback` op kind and
// its begin, and the command line's revert of a pending release (`release:rollback`; preflight 1D-02, 1D-03).
export {
  beginRollback,
  checkRollback,
  parseRollbackParams,
  revertPending,
  rollbackAvailability,
  rollbackKind,
  rollbackUnavailable,
} from './updates/rollback.js';
export type {
  RevertPendingOptions,
  RollbackAvailability,
  RollbackKindDeps,
  RollbackParams,
  RollbackUnavailableReason,
} from './updates/rollback.js';
// 1d Task 25: the update op after its point of no return: the boot of the target (in kind.ts) and the automatic revert
// (spec §9.7; D1d-17, D1d-21, D1d-42; preflight B8, S3, 1D-02): the pointer alone when the database accepts the release,
// else the "terlalu lama" restore of the `pre_update` backup.
export { revertRestoreParams, schemaCompat } from './updates/revert.js';
// 1d Task 27: the different bundled release (spec §9.8; D1d-24; preflight B7, S9, S12, 1D-04): row 1's plan and the
// bundled candidate, row 2's blocked record, row 3's (`schemaHold`) failed-before check and instruction; the adoption of
// the bundled release (§9.3) and release retention with the staging sweep (D1d-16, D1d-23; preflight 1D-20), with the
// `release.adopt` and `release.retention` jobs.
export {
  UPDATE_FAILED_STATUSES,
  bundledAttempt,
  bundledCandidate,
  bundledUpdatePlan,
  clearBundledBlocked,
  failedBefore,
  recordBundledBlocked,
  schemaHoldInstruction,
} from './updates/bundled.js';
export type { BundledUpdatePlan, UpdateAttempt } from './updates/bundled.js';
export { ADOPT_LOCK_WAIT_MS, adoptRelease, releaseAdoptJob } from './updates/adopt.js';
export type { AdoptJobDeps, AdoptOutcome, AdoptReleaseOptions } from './updates/adopt.js';
export {
  RETENTION_LOCK_WAIT_MS,
  SWEEP_LOCK_WAIT_MS,
  releaseRetention,
  releaseRetentionJob,
  runReleaseRetention,
  sweepReleaseStaging,
  sweepStagingLocked,
} from './updates/retention.js';
export type { RetentionRun } from './updates/retention.js';
// 1d Task 28: the update check (spec §9.6 step 1; D1d-30): the job `update.check` (the daily schedule, the dashboard at
// most hourly, by hand at most once a minute), its `update_available` notification once per version, and the queueing.
export {
  DASHBOARD_CHECK_INTERVAL_MS,
  UPDATE_CHECK_JOB,
  UPDATE_CHECK_THROTTLE_MS,
  UPDATE_CHECK_UNIQUE_KEY,
  checkOfChannel,
  dashboardCheckDue,
  enqueueDashboardCheck,
  enqueueUpdateCheck,
  offeredUpdate,
  runUpdateCheck,
  updateCheckJob,
  updateCheckPayload,
  updateCheckThrottle,
} from './updates/check-job.js';
export type { StoredUpdateCheck, UpdateCheckDeps, UpdateCheckPayload, UpdateCheckReason, UpdateCheckResult } from './updates/check-job.js';
// 1d Task 29: Diagnostik's releases (the bundled release, the keyset store) and the dashboard's alert tables.
export { bundledRelation, bundledReleaseBeside, bundledReleaseFact } from './diagnostics/collect.js';
export type { BundledFactOptions } from './diagnostics/collect.js';
export { ALERT_LINK, ALERT_SEVERITY } from './dashboard/summary.js';
// The edition seam (ruling R1): the community edition answers every check, enforces nothing and needs no DB.
export { COMMUNITY_EDITION, createCommunityEdition } from './edition/edition.js';
export type { CommunityEditionOptions, EditionCheck, EditionService } from './edition/edition.js';
// ---- Phase 2 (catalog): Task 5 ----
// The pure catalog library (identifiers, title key, barcode, slugs, class numbers, similarity, names) and the bounded
// streaming XML reader/writer.
export * from './catalog/lib/index.js';
export * from './xml/index.js';
// ---- Phase 2 (catalog): Task 1 ----
export * from './catalog/data/index.js';
// ---- Phase 2 (catalog): Task 3 ----
// The Phase 2 barrels: each area's names come through its own barrel, filled by the task that
// owns it, so no later task edits this file. `catalog/index.ts` joins the catalog areas but neither `catalog/data`
// (Task 1) nor `catalog/lib` (Task 5), which have their own lines. test/barrels.test.ts refuses a name two barrels
// export (M14).
export * from './catalog/index.js';
export * from './search/index.js';
export * from './marc/index.js';
export * from './print/index.js';
export * from './html/index.js';
export * from './net/index.js';
export * from './migration/index.js';
export * from './opac-pages/index.js';
// ---- Komunitas K1 (reports and accreditation) ----
// The report framework (definitions, registry, runs, export, housekeeping) and the accreditation workspace (instruments,
// metrics, periods, registers, evidence, usage, evaluation, documents): each area's names come through its own barrel,
// filled by the change that owns it, so no later change edits this file.
export * from './reports/index.js';
export * from './accreditation/index.js';
// ---- Komunitas (members and circulation) ----
// Members (member types, members, the CSV member import) and circulation (loan rules, the desk, the loan list).
export * from './members/index.js';
export * from './circulation/index.js';
// ---- Komunitas K2 (members extended and visits) ----
export * from './visits/index.js';
export * from './members/ext/index.js';
// ---- Komunitas K4 (stocktake) ----
export * from './stocktake/index.js';
// ---- Komunitas (OPAC home page) ----
// The home page's content and the popular titles.
export * from './opac-home/index.js';
