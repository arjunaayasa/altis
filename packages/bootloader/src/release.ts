import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectInstalledKeysets,
  verifyReleaseWithRoots,
  type KeysetReport,
  type KeysetSource,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import type { SchemaMetaMirror } from '@altis/db';
import { dataPath, readJsonWithBak } from '@altis/platform';
import { compareSemver, isSemver } from '@altis/shared';
import type { BootLog } from './log.js';
import { releaseDir, type CurrentState, type ReleaseRef } from './current.js';

// Release trust and loading (spec §8.3, §9.2): the keys app.js trusts (ruling R65: its embedded root keys, and the
// keys that root-signed keyset documents add), the signed-release check, the import of server.mjs, and the
// schema-meta.json compatibility check that guards a fallback to `previous` (§9.7).

/** The exports of server.mjs, bootloader contract v1 (apps/server, Task 14). */
export interface ServerModule {
  bootProtocol: 1;
  start(ctx: unknown): Promise<void>;
  runCli(argv: string[], ctx: unknown): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** At most this many ignored keyset documents (and conflicting kids) are logged one by one per release. */
const MAX_LOGGED = 20;

/** The name of a release's keyset.json in reports. */
function keysetName(ref: ReleaseRef): string {
  return (ref.source === 'bundled' ? 'bundled-release/' : 'DATA_DIR/releases/') + ref.version + '/keyset.json';
}

/**
 * Every root-signed keyset document of the installation besides the release about to run (ruling R65a), read once
 * per boot: DATA_DIR/releases/keyset.json and its `.bak` (both), the keyset.json of every bundled release next to
 * app.js, and that of every release current.json names. Only root-signed documents count and revocation only grows,
 * so a revocation stays in force while any one copy of it is left. A release keyset.json that cannot be used is
 * logged and left out (that release then fails its own verification if it is run).
 *
 * @throws Error `KEYSET_CORRUPT` when DATA_DIR/releases/keyset.json and its `.bak` exist and neither can be used (fail
 *   closed: boot turns it into STATE_CORRUPT); an I/O error of that file other than a missing file
 */
export async function installedKeysets(appRoot: string, dataDir: string, state: CurrentState, log: BootLog): Promise<KeysetSource[]> {
  const named: ReleaseRef[] = [];
  for (const ref of [state.active, state.previous, state.pending]) if (ref !== null) named.push(ref);
  const found = await collectInstalledKeysets({
    appRoot,
    dataKeyset: dataPath(dataDir, 'releases', 'keyset.json'),
    releases: named.map((ref) => ({ name: keysetName(ref), dir: releaseDir(appRoot, dataDir, ref) })),
  });
  for (const skip of found.skipped) log.warn('keyset.json not usable; its documents do not count', { source: skip.name, err: skip.error });
  return found.sources;
}

/** Logs the keyset documents that had no effect and the kids bound to two keys (none of them is trusted). */
function logResolution(log: BootLog, ref: ReleaseRef, report: KeysetReport): void {
  for (const { source, index, reason } of report.rejected.slice(0, MAX_LOGGED)) {
    log.warn('keyset document ignored', { release: ref.version, source, index, reason });
  }
  if (report.rejected.length > MAX_LOGGED) {
    log.warn('more keyset documents ignored', { release: ref.version, count: report.rejected.length - MAX_LOGGED });
  }
  if (report.conflicts.length > 0) {
    log.warn('keyset documents bind a kid to two keys; it is not trusted', {
      release: ref.version,
      kids: report.conflicts.slice(0, MAX_LOGGED),
      count: report.conflicts.length,
    });
  }
}

/**
 * Verifies the release in `dir` before anything of it runs (spec §8.3, §9.2, ruling R65): `.complete`; the keys it may
 * be signed with, resolved from the embedded `roots` and the root-signed documents of the installation (`sources`, see
 * {@link installedKeysets}) and of the release's own keyset.json (a release vouches for nothing by itself: its
 * documents count only through a root signature); the manifest signature by one of those `release` keys; and the
 * hash of server.mjs (`check: 'executed'`; the whole-tree check `all` is for install and upgrade time). A production
 * app.js refuses every document that adds a `dev-` key (ruling R65b). Also checks that the manifest is the version
 * `ref` names.
 *
 * @throws Error `RELEASE_INVALID:<reason>` (`keyset` when the release's keyset.json is missing or malformed)
 */
export async function verify(dir: string, ref: ReleaseRef, roots: TrustedKey[], sources: KeysetSource[], log: BootLog): Promise<ReleaseManifest> {
  const manifest = await verifyReleaseWithRoots(dir, roots, {
    check: 'executed',
    sources,
    refuseDevKids: __BUILD_PROFILE__ === 'production',
    onResolved: (report) => logResolution(log, ref, report),
  });
  if (manifest.version !== ref.version) throw new Error('RELEASE_INVALID:version');
  return manifest;
}

/**
 * `import()` that survives the ES2017 build: dynamic import is ES2020 syntax, which neither the target nor the
 * acorn check accepts, and esbuild would turn it into `require()`, which cannot load server.mjs from a file URL.
 * The Function body is compiled at run time, by a Node that has passed the version check.
 */
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/**
 * Imports `<dir>/server.mjs` and checks its exports against contract v1.
 *
 * @throws Error `START_FAILED:<reason>` (the import's own error as `cause`)
 */
export async function importServer(dir: string): Promise<ServerModule> {
  let mod: unknown;
  try {
    mod = await importModule(pathToFileURL(path.join(dir, 'server.mjs')).href);
  } catch (error) {
    throw new Error('START_FAILED:import', { cause: error });
  }
  if (!isRecord(mod) || mod['bootProtocol'] !== 1) throw new Error('START_FAILED:bootProtocol');
  if (typeof mod['start'] !== 'function' || typeof mod['runCli'] !== 'function') throw new Error('START_FAILED:exports');
  return mod as unknown as ServerModule;
}

/** The schema-meta.json mirror kept by the migrator (Task 11), read the same way: a small file read, not @altis/db. */
function parseMirror(raw: unknown): SchemaMetaMirror {
  if (!isRecord(raw)) throw new TypeError('schema-meta.json: not an object');
  const { schemaVersion, minCodeVersion } = raw;
  if (typeof schemaVersion !== 'string' || !/^\d{4}$/.test(schemaVersion)) throw new TypeError('schemaVersion');
  if (typeof minCodeVersion !== 'string' || !isSemver(minCodeVersion)) throw new TypeError('minCodeVersion');
  return { schemaVersion, minCodeVersion };
}

/** `DATA_DIR/releases/schema-meta.json` (or its `.bak`); null when there is none. @throws STATE_CORRUPT */
export function readSchemaMetaMirror(dataDir: string): Promise<SchemaMetaMirror | null> {
  return readJsonWithBak(dataPath(dataDir, 'releases', 'schema-meta.json'), parseMirror);
}

/**
 * May `previous` run against the database (spec §9.7)? Yes when its version is at least `minCodeVersion` from
 * schema-meta.json, or when there is no mirror yet (nothing was migrated; the server still checks the database
 * itself). An unreadable mirror means no.
 */
export async function previousIsCompatible(dataDir: string, previous: ReleaseRef, log: BootLog): Promise<boolean> {
  let mirror: SchemaMetaMirror | null;
  try {
    mirror = await readSchemaMetaMirror(dataDir);
  } catch (error) {
    log.error('schema-meta.json cannot be read; no fallback to the previous release', { err: error });
    return false;
  }
  if (mirror === null) return true;
  if (compareSemver(previous.version, mirror.minCodeVersion) >= 0) return true;
  log.error('the previous release is older than the database allows; no fallback', {
    previous: previous.version,
    minCodeVersion: mirror.minCodeVersion,
  });
  return false;
}
