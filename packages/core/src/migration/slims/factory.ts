import * as sources from './source/index.js';
import type { SlimsStage } from './stage.js';

// The source factory seam of the SLiMS migration (Phase 2 Task 23, preflight B1): everything the framework (the job,
// the analyze stage, the test-connection route) calls from the source readers goes through slimsSources(), so the
// framework neither needs Task 10's readers to compile nor reaches them in its own tests.
//
// In the test build profile only (ruling R57) a test replaces some of the readers (__setSlimsSourceFactory) and the
// eight middle stages of Tasks 37 and 38 (__setSlimsStages) with fakes: the framework test, the route tests and the
// audit script then run a whole migration to its end, `catalog.migration.start` and `.finish` included, on an
// in-memory source. In a production build both setters only throw, and nothing ever replaces anything.

/** The source constructors of Task 3's signatures (source/index.ts), as the framework calls them. */
export interface SlimsSourceFactory {
  openDbSource: typeof sources.openDbSource;
  splitDump: typeof sources.splitDump;
  openStagedDumpSource: typeof sources.openStagedDumpSource;
  openFilesZip: typeof sources.openFilesZip;
  openFilesDir: typeof sources.openFilesDir;
  detectSlimsVersion: typeof sources.detectSlimsVersion;
}

const REAL: SlimsSourceFactory = Object.freeze({
  openDbSource: sources.openDbSource,
  splitDump: sources.splitDump,
  openStagedDumpSource: sources.openStagedDumpSource,
  openFilesZip: sources.openFilesZip,
  openFilesDir: sources.openFilesDir,
  detectSlimsVersion: sources.detectSlimsVersion,
});

let sourceOverride: Partial<SlimsSourceFactory> | null = null;
let stagesOverride: readonly SlimsStage[] | null = null;

function testProfile(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test';
}

/** The source constructors: the real ones of source/index.ts, each one a test replaced (test profile) excepted. */
export function slimsSources(): SlimsSourceFactory {
  if (sourceOverride === null) return REAL;
  return { ...REAL, ...sourceOverride };
}

/**
 * The middle stages a test put in place of the eight of Tasks 37 and 38 (test profile), or null: the framework's own
 * `split`, `analyze` and `report` always run around them.
 */
export function slimsStagesOverride(): readonly SlimsStage[] | null {
  return stagesOverride;
}

/**
 * Test build profile only (R57): replaces the named source constructors with `f`'s until the next call; null puts the
 * real ones back.
 *
 * @throws TypeError outside the test build profile
 */
export function __setSlimsSourceFactory(f: Partial<SlimsSourceFactory> | null): void {
  if (!testProfile()) throw new TypeError('__setSlimsSourceFactory is a hook of the test build profile only');
  sourceOverride = f === null ? null : Object.freeze({ ...f });
}

/**
 * Test build profile only (R57): runs `stages` in place of the eight middle stages (masters … archive) until the next
 * call; null puts the real ones back.
 *
 * @throws TypeError outside the test build profile
 */
export function __setSlimsStages(stages: readonly SlimsStage[] | null): void {
  if (!testProfile()) throw new TypeError('__setSlimsStages is a hook of the test build profile only');
  stagesOverride = stages === null ? null : Object.freeze([...stages]);
}
