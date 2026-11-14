import type { AltisMigration } from '../migrator.js';
import { metaAndLocks } from './0001_meta_and_locks.js';
import { orgAndIdentity } from './0002_org_and_identity.js';
import { sessionsAndLimits } from './0003_sessions_and_limits.js';
import { settingsAndAudit } from './0004_settings_and_audit.js';
import { jobsEventsNotifications } from './0005_jobs_events_notifications.js';
import { filesCustomIdempotency } from './0006_files_custom_idempotency.js';
import { licenseReleasesBackups } from './0007_license_releases_backups.js';
import { accessIndexes } from './0008_access_indexes.js';
import { opsJobs } from './0009_ops_jobs.js';
import { fixtureMigrations } from './test/index.js';
// ---- Phase 2 (catalog): Task 1 ----
import { catalogAuthorities } from './0020_catalog_authorities.js';
import { catalogRecords } from './0021_catalog_records.js';
import { catalogItems } from './0022_catalog_items.js';
import { opacPages } from './0023_opac_pages.js';
import { searchIndex } from './0024_search_index.js';
import { catalogRunsMigration } from './0025_catalog_runs_migration.js';
import { customFieldsI18n } from './0026_custom_fields_i18n.js';
import { catalogSeed } from './0027_catalog_seed.js';
// Phase 2 (catalog), Task 39: the indexes the perf seed of K9 asked for.
import { catalogPerfIndexes } from './0028_catalog_perf_indexes.js';
// Phase 2 (catalog), big review: the token format of the search index.
import { searchTokenVersion } from './0029_search_token_version.js';
// ---- Komunitas K1 (tables) ----
import { reportsCore } from './0030_reports_core.js';
import { accreditation } from './0031_accreditation.js';
import { libraryRegisters } from './0032_library_registers.js';
import { catalogAccredFields } from './0033_catalog_accred_fields.js';
// ---- Komunitas (members and circulation) ----
import { membersCirculation } from './0040_members_circulation.js';
// ---- Komunitas K2 (visits) ----
import { visits } from './0041_visits.js';

/**
 * The Phase 1 tables (spec §6.5), their indexes and the columns added since, keyed by migration name (= file stem). All of them are expand-only
 * (no `contract`) and idempotent: each step checks the catalog before it creates anything, so a run that stopped
 * halfway (MySQL/MariaDB and SQLite apply DDL statement by statement) is completed by running it again.
 *
 * A shipped migration is frozen: it names each table and its class as literals (ruling R44), never through the
 * live TABLE_CLASSES or `DB`, which describe the current schema (a test checks they agree after all migrations).
 *
 * Phase 2 (decision P2-06) appends its migrations 0020–0029 (range 0020–0039) to this same frozen map, keeping its
 * name so that its consumers stay unchanged; 0010–0019 are Phase 1d's. Komunitas K1 appends 0030–0033 (range 0030–0039:
 * reports and accreditation) the same way, and the members and circulation milestone 0040 (members, loan rules and
 * loans in one migration) and 0041 (visits and guestbook stations). Tests that need the latest migration take the last key of the map rather
 * than naming one.
 */
export const PHASE1_MIGRATIONS: Readonly<Record<string, AltisMigration>> = Object.freeze({
  '0001_meta_and_locks': metaAndLocks,
  '0002_org_and_identity': orgAndIdentity,
  '0003_sessions_and_limits': sessionsAndLimits,
  '0004_settings_and_audit': settingsAndAudit,
  '0005_jobs_events_notifications': jobsEventsNotifications,
  '0006_files_custom_idempotency': filesCustomIdempotency,
  '0007_license_releases_backups': licenseReleasesBackups,
  '0008_access_indexes': accessIndexes,
  '0009_ops_jobs': opsJobs,
  // ---- Phase 2 (catalog): Task 1 ----
  '0020_catalog_authorities': catalogAuthorities,
  '0021_catalog_records': catalogRecords,
  '0022_catalog_items': catalogItems,
  '0023_opac_pages': opacPages,
  '0024_search_index': searchIndex,
  '0025_catalog_runs_migration': catalogRunsMigration,
  '0026_custom_fields_i18n': customFieldsI18n,
  '0027_catalog_seed': catalogSeed,
  // Phase 2 (catalog), Task 39.
  '0028_catalog_perf_indexes': catalogPerfIndexes,
  // Phase 2 (catalog), big review.
  '0029_search_token_version': searchTokenVersion,
  // ---- Komunitas K1 (tables) ----
  '0030_reports_core': reportsCore,
  '0031_accreditation': accreditation,
  '0032_library_registers': libraryRegisters,
  '0033_catalog_accred_fields': catalogAccredFields,
  // ---- Komunitas (members and circulation) ----
  '0040_members_circulation': membersCirculation,
  // ---- Komunitas K2 (visits) ----
  '0041_visits': visits,
});

// ---------------------------------------------------------------------------------------------------------------
// Release fixtures (decision D1d-26, spec §12.5)

/**
 * The release fixture level: 0 in production; in a test build 1 for `0.1.0-test` (PHASE1_MIGRATIONS), 2 for
 * `0.2.0-test` (+ 9001_test_expand), 3 for `0.3.0-test` (+ 9002_test_contract).
 */
export type TestFixtureLevel = 0 | 1 | 2 | 3;

/**
 * The fixture level this build was made for: 0 unless `__BUILD_PROFILE__ === 'test'`; then the build define
 * `__TEST_FIXTURE__` (Vitest: 1), or 1 when the bundle has no such define (tooling other than the release build).
 */
export function buildFixtureLevel(): TestFixtureLevel {
  // Inline, so that a production build folds the condition to false and drops the block (R57).
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    if (typeof __TEST_FIXTURE__ === 'undefined') return 1;
    const level: unknown = __TEST_FIXTURE__;
    return level === 0 || level === 1 || level === 2 || level === 3 ? level : 1;
  }
  return 0;
}

/**
 * Every migration of fixture `level`, whatever the build profile: PHASE1_MIGRATIONS below level 2, plus
 * 9001_test_expand at level 2, plus 9002_test_contract at level 3; frozen. For the release build, which runs as a
 * plain script (no profile) and states a test release's schema in its manifest (`schemaFacts(level)`). Code that runs
 * in a release calls {@link releaseMigrations}, never this.
 */
export function migrationsForLevel(level: TestFixtureLevel): Readonly<Record<string, AltisMigration>> {
  if (level < 2) return PHASE1_MIGRATIONS;
  return Object.freeze({ ...PHASE1_MIGRATIONS, ...fixtureMigrations(level) });
}

/**
 * The migrations of this release: PHASE1_MIGRATIONS, plus the fixture migrations of `level` (default: the build's,
 * {@link buildFixtureLevel}) under the test profile only. A production build drops the test branch as dead code, and
 * with it every fixture migration, whatever `level` a caller passes.
 */
export function releaseMigrations(level: TestFixtureLevel = buildFixtureLevel()): Readonly<Record<string, AltisMigration>> {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') return migrationsForLevel(level);
  return PHASE1_MIGRATIONS;
}
