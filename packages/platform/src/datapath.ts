import path from 'node:path';
import { DomainError, isSemver, isUlid, ulidTime } from '@altis/shared';
import { isInside, realpathNearest } from './pathutil.js';

// Typed paths inside DATA_DIR (spec §7.5). Every path the server builds under DATA_DIR comes from dataPath (or one
// of the typed builders below, which share its checks), which accepts only segments of a known type, so no request,
// database value or file name can steer a path out of the area it belongs to. The database never stores paths:
// they are derived from ids.
//
// This module is bundled into app.js (packages/bootloader): its syntax must lower to ES2017.

/**
 * The top-level folders of DATA_DIR. `root` is DATA_DIR itself, which holds a handful of fixed files. Phase 2 (Task 3,
 * decision P2-24): `exports`, the catalog export files (`exports/<runId>.<ext>`, {@link exportFilePath}).
 */
export const DATA_AREAS = ['root', 'releases', 'ops', 'uploads', 'backups', 'logs', 'cache', 'tmp', 'db', 'exports'] as const;

export type DataArea = (typeof DATA_AREAS)[number];

/**
 * A path built by {@link dataPath}, {@link uploadPath} or one of the typed builders: a string that passed the
 * segment and containment checks. It is a subtype of `string`, so it goes wherever a string does; the file helpers
 * of `data-files.ts` take only this type, so a path computed any other way needs a visible cast.
 */
export type DataPath = string & { readonly __dataPath: true };

/** The only file names accepted directly in DATA_DIR (area `root`). */
const ROOT_LITERALS: ReadonlySet<string> = new Set([
  'config.json',
  'config.lock',
  'install.lock',
  'altis-data-dir.txt',
  'install-code.txt', // spec §7.7: DATA_DIR/install-code.txt
]);

/** `config.json.bak-<epoch ms, 13 digits>`: the copy `install:reset` keeps of the config it moves aside (root only). */
const CONFIG_RESET_BACKUP = /^config\.json\.bak-\d{13}$/;

/** The closed list of file names accepted in every other area. */
const LITERALS: ReadonlySet<string> = new Set([
  'current.json',
  'current.lock',
  'schema-meta.json',
  'keyset.json',
  'feed-state.json',
  'revoked.json',
  'migrate.lock',
  'rotate.lock',
  'install-run.lock',
  'op.json',
  'maintenance.json',
  'data-epoch',
  'install-session.json',
  'altis.log',
  'audit-anchor.log',
  'altis.sqlite',
  'manifest.json',
  'manifest.sig',
  '.complete',
  // Phase 1c (Task 2, S14): backup, archive, restore, ops, cron and installer files and folders.
  'tables',
  'blobs',
  'keep',
  'downloads',
  'src',
  '.work',
  'archive.altisbak',
  // Phase 1c (Task 12, ruling R1c-6): the `.altisbak` writer's central-directory sidecar (altisbakCentralPath).
  'archive.central',
  'prepared.json',
  'upload.bin',
  'upload.midstate', // Task 9, ruling R1c-4: the SHA-256 midstate of the upload's bytes received so far
  'snapshot.sqlite',
  'restore.sqlite',
  'pre-restore.sqlite',
  'sqlite.lock',
  'sqlite-owner.json',
  'step.lock',
  'report.json',
  'cron-seen.json',
  'cron.lock',
  'cron-flight.json',
  'install-claims.json',
  'altisbak.json',
  // Phase 1c (Task 6): the ops once-marker of an unreadable op.json (onAttention once, M34).
  'corrupt-reported',
  // Phase 1c (Task 10): the lock of the install code's renewal, the claim counter and install-session.json.
  'install-session.lock',
  // Phase 1c (Task 11): the exporter's part log, `backups/<id>/parts.jsonl` (removed best effort once manifest.json is
  // written: the manifest, not the log, marks a finished backup; R1c-16).
  'parts.jsonl',
  // Phase 1c (final review): `ops/control-request`, a cancel, takeover or resume waiting for `ops/step.lock`.
  'control-request',
  // Phase 1d (Task 2): the update's files in `releases` (spec §9.3, §8.3, §9.6): the boot lock and the boot markers'
  // folder (`boot/<v>/<pid>-<startMs>`, bootMarkerPath), and the locks of the keyset and feed-state writers.
  // `clock.json` and its lock `clock.lock` are reserved for a commercial edition (the community edition writes neither):
  // they stay allowed so that a DATA_DIR of either edition keeps its names.
  'boot.lock',
  'boot',
  'clock.json',
  'keyset.lock',
  'feed-state.lock',
  'clock.lock',
]);

/**
 * Phase 1d (Task 9, preflight S22): `tmp/fault-migrate-slow.json`, when the `migrate-slow` test fault was first armed
 * in this DATA_DIR. Test builds only, judged at call time (a child process that sets the profile after its imports
 * gets it too); a production build folds the condition and drops the name (R57).
 */
function isTestOnlySegment(area: DataArea, segment: string): boolean {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    return area === 'tmp' && segment === 'fault-migrate-slow.json';
  }
  return false;
}

/**
 * The real path of every DATA_DIR this process has built a path in (see {@link build}). A cache of derived facts,
 * no state of its own (P6): a server knows one, a test run one per temporary DATA_DIR.
 */
const DATA_ROOTS = new Set<string>();

/** `altis.log.1` ... `altis.log.9`: the logger's rotated files. */
const LOG_ROTATION = /^altis\.log\.[1-9]$/;
/** A SHA-256 digest in lower-case hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** `<digits>-<digits>`. */
const NUMBER_PAIR = /^\d+-\d+$/;

const SHOWN_MAX = 64;

/** A bounded, printable copy of a value for messages (a segment can be long, binary or not even a string). */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : `<${value === null ? 'null' : typeof value}>`;
  return text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX)}…` : text;
}

function invalidSegment(area: unknown, segment: unknown): DomainError {
  const what = shown(segment);
  const where = shown(area);
  return new DomainError('INVALID_PATH_SEGMENT', {
    detail:
      `Segmen path ${what} tidak diizinkan untuk area ${where} / ` +
      `The path segment ${what} is not allowed for area ${where}`,
    meta: { area: isArea(area) ? area : where, segment: what },
  });
}

function isArea(value: unknown): value is DataArea {
  return typeof value === 'string' && (DATA_AREAS as readonly string[]).includes(value);
}

function isAllowedSegment(area: DataArea, segment: unknown): segment is string {
  if (typeof segment !== 'string') return false;
  if (area === 'root') return ROOT_LITERALS.has(segment) || CONFIG_RESET_BACKUP.test(segment);
  return (
    LITERALS.has(segment) ||
    LOG_ROTATION.test(segment) ||
    isUlid(segment) ||
    isSemver(segment) ||
    SHA256_HEX.test(segment) ||
    NUMBER_PAIR.test(segment) ||
    isTestOnlySegment(area, segment)
  );
}

/**
 * `realpath(dataDir)/<area>/<segments>`, after two checks against that real area path (spec §7.5: the real
 * path of the result must stay under `DATA_DIR/<area>`):
 *
 * - the area folder itself must not be a symbolic link (nor lie behind one): its real path has to be
 *   `realpath(dataDir)/<area>` exactly, otherwise `reason: 'area_escape'`. To keep an area on another disk,
 *   mount that disk there (or point DATA_DIR at it) instead of linking;
 * - the real path of the result, symbolic links below the area included, must lie inside the area,
 *   otherwise `reason: 'escapes_area'`.
 *
 * The result is lexical (a link is not replaced by its target), and the checks are made at call time: a link
 * planted afterwards is not noticed by a path that is already in use.
 *
 * `realpath(dataDir)` is remembered (see {@link dataRootOf}), so that the file helpers can tell DATA_DIR and its area
 * folders from the paths below them.
 *
 * Exported for this package only (not re-exported by index.ts): the segments are not checked here.
 */
export function build(dataDir: string, area: DataArea, segments: readonly string[]): DataPath {
  const base = realpathNearest(dataDir);
  DATA_ROOTS.add(base);
  const areaDir = area === 'root' ? base : path.join(base, area);
  if (area !== 'root' && realpathNearest(areaDir) !== areaDir) {
    throw new DomainError('INVALID_PATH_SEGMENT', {
      detail:
        `Folder area ${areaDir} adalah tautan simbolik ke tempat lain; area data harus berada langsung di dalam DATA_DIR / ` +
        `The area folder ${areaDir} is a symbolic link to somewhere else; data areas must lie directly inside DATA_DIR`,
      meta: { area, reason: 'area_escape' },
    });
  }
  const result = path.join(areaDir, ...segments);
  if (segments.length > 0 && !isInside(realpathNearest(result), areaDir)) {
    throw new DomainError('INVALID_PATH_SEGMENT', {
      detail:
        `${result} mengarah ke luar area ${area} (tautan simbolik) / ` +
        `${result} leads out of the ${area} area (symbolic link)`,
      meta: { area, reason: 'escapes_area' },
    });
  }
  return result as DataPath;
}

/**
 * The DATA_DIR (real path, as remembered by {@link build}) that `p` lies in, or null when `p` is in none this process
 * knows. The innermost one wins should one DATA_DIR lie inside another. For this package's file helpers.
 */
export function dataRootOf(p: string): string | null {
  for (let dir = p; ; ) {
    if (DATA_ROOTS.has(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The area `p` lies in (`root` for DATA_DIR itself and the files directly in it), or null when `p` is in no
 * DATA_DIR this process knows. For this package's file helpers (the `disk-full` test fault counts writes per area).
 */
export function areaOf(p: string): DataArea | null {
  const root = dataRootOf(p);
  if (root === null) return null;
  const first = path.relative(root, p).split(path.sep)[0];
  return first !== undefined && first !== 'root' && isArea(first) ? first : 'root';
}

/** True for DATA_DIR itself and for its area folders (`<DATA_DIR>/backups`, ...), as the file helpers see them. */
export function isDataDirOrArea(p: string): boolean {
  const root = dataRootOf(p);
  if (root === null) return false;
  const rel = path.relative(root, p);
  return rel === '' || (isArea(rel) && rel !== 'root');
}

/**
 * The path of `segments` inside `area` of DATA_DIR. DATA_DIR need not exist yet.
 *
 * Accepted segments: a ULID; a SemVer; a SHA-256 digest (64 lower-case hex digits); `<digits>-<digits>`; and
 * the closed list of file names (`current.json`, `altis.sqlite`, `manifest.json`, `.complete`, `altis.log` and
 * `altis.log.1` to `altis.log.9`, the 1c names `tables`, `blobs`, `keep`, `downloads`, `src`, `.work`,
 * `archive.altisbak`, `restore.sqlite`, `step.lock` and so on). Area `root` accepts only `config.json`,
 * `config.lock`, `install.lock`, `altis-data-dir.txt`, `install-code.txt` and `config.json.bak-<13 digits>`, and
 * those names are accepted nowhere else. Anything else, including `..`, `.`, an empty segment, a separator, NUL, a
 * name with another extension, a table name or a backup part's file name (those come from the typed builders
 * below only, decision C10), is refused.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` for a segment or an area that is not allowed, when the area folder
 *   is a symbolic link (`meta.reason: 'area_escape'`), or when the real path of the result leaves the area
 *   through a symbolic link (`'escapes_area'`)
 */
export function dataPath(dataDir: string, area: DataArea, ...segments: string[]): DataPath {
  if (!isArea(area)) throw invalidSegment(area, area);
  for (const segment of segments) {
    if (!isAllowedSegment(area, segment)) throw invalidSegment(area, segment);
  }
  return build(dataDir, area, segments);
}

// Typed builders (decision C10): file names derived from table names exist only through these, each checked against
// the code's table registry, which the caller passes (`new Set(Object.keys(TABLE_COLUMNS))`).

/** A table name as the registry spells it (spec §6: lower-case snake case, at most 60 characters). */
const TABLE_NAME = /^[a-z][a-z0-9_]{0,59}$/;
/** The highest part number of a backup table (`99999.jsonl.gz`). */
const PART_MAX = 99_999;

/**
 * The entry names an `.altisbak` archive may hold (S14; Task 12's allowlist too): its clear header, the manifest,
 * one part of a table, one content-addressed upload blob. Anything else, any `..`, `\`, absolute or drive path, NUL
 * or line break included, does not match.
 */
export const ALTISBAK_ENTRY = /^(altisbak\.json|manifest\.json|tables\/[a-z][a-z0-9_]{0,59}\/\d{5}\.jsonl\.gz|blobs\/[0-9a-f]{64})$/;

function checkedId(area: DataArea, id: unknown): string {
  if (typeof id !== 'string' || !isUlid(id)) throw invalidSegment(area, id);
  return id;
}

function checkedTable(area: DataArea, table: unknown, tables: ReadonlySet<string>): string {
  if (typeof table !== 'string' || !TABLE_NAME.test(table) || !tables.has(table)) throw invalidSegment(area, table);
  return table;
}

/**
 * `backups/<backupId>/tables/<table>/<part, 5 digits>.jsonl.gz`: one part of one table of a backup.
 *
 * @param tables the code's table registry; `table` must be in it
 * @throws DomainError `INVALID_PATH_SEGMENT` when `backupId` is not a ULID, `table` is not a registered table name,
 *   `part` is not an integer from 0 to 99 999, or the path leaves the area (see {@link dataPath})
 */
export function backupPartPath(dataDir: string, backupId: string, table: string, part: number, tables: ReadonlySet<string>): DataPath {
  const id = checkedId('backups', backupId);
  const name = checkedTable('backups', table, tables);
  if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part > PART_MAX) throw invalidSegment('backups', part);
  return build(dataDir, 'backups', [id, 'tables', name, `${String(part).padStart(5, '0')}.jsonl.gz`]);
}

/**
 * `backups/<backupId>/imported-<table>.jsonl.gz`.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` as {@link backupPartPath}
 */
export function backupImportedPath(dataDir: string, backupId: string, table: string, tables: ReadonlySet<string>): DataPath {
  const id = checkedId('backups', backupId);
  const name = checkedTable('backups', table, tables);
  return build(dataDir, 'backups', [id, `imported-${name}.jsonl.gz`]);
}

/**
 * `ops/<opId>/keep/<table>.jsonl.gz`: the rows of `table` an op keeps aside (a restore's kept history).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `opId` is not a ULID, `table` is not a registered table name, or
 *   the path leaves the area
 */
export function opKeepPath(dataDir: string, opId: string, table: string, tables: ReadonlySet<string>): DataPath {
  const id = checkedId('ops', opId);
  const name = checkedTable('ops', table, tables);
  return build(dataDir, 'ops', [id, 'keep', `${name}.jsonl.gz`]);
}

/**
 * `tmp/<opId>/src/<entry>`: where the entry `entry` of an uploaded archive is extracted (S14; decision C17 spells
 * the spec's `tmp/<op>-<ulid>/` in segments `dataPath` accepts). `entry` must match {@link ALTISBAK_ENTRY}, and the
 * table of a `tables/<table>/...` entry must be in `tables`.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` for any other entry, an `opId` that is not a ULID, or a path that
 *   leaves the area
 */
export function extractedEntryPath(dataDir: string, opId: string, entry: string, tables: ReadonlySet<string>): DataPath {
  const id = checkedId('tmp', opId);
  if (typeof entry !== 'string' || !ALTISBAK_ENTRY.test(entry)) throw invalidSegment('tmp', entry);
  const segments = entry.split('/');
  if (segments[0] === 'tables') checkedTable('tmp', segments[1], tables);
  return build(dataDir, 'tmp', [id, 'src', ...segments]);
}

/** The file name of a `.altisbak` archive the server writes, and of its central-directory sidecar. */
const ALTISBAK_ARCHIVE = 'archive.altisbak';
const ALTISBAK_CENTRAL = 'archive.central';

/**
 * `<folder>/archive.central` for the archive `<folder>/archive.altisbak`: the append-only sidecar in which the
 * `.altisbak` writer keeps one central-directory record per finished entry, so that its checkpoint (a job payload)
 * stays the same size however many entries the archive has (ruling R1c-6).
 *
 * `archive` is taken apart again and rebuilt with the sidecar's name, under the same checks as {@link dataPath}: its
 * folder segments must be ones dataPath accepts, in an area of a DATA_DIR this process has built a path in.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `archive` is not such a path ending in `archive.altisbak`, or the
 *   result leaves the area (see {@link dataPath})
 */
export function altisbakCentralPath(archive: DataPath): DataPath {
  const root = typeof archive === 'string' ? dataRootOf(archive) : null;
  if (root === null) throw invalidSegment('unknown', archive);
  const [area, ...rest] = path.relative(root, archive).split(path.sep);
  if (!isArea(area) || area === 'root') throw invalidSegment(area, area);
  const folder = rest.slice(0, -1);
  if (rest[rest.length - 1] !== ALTISBAK_ARCHIVE) throw invalidSegment(area, rest[rest.length - 1]);
  for (const segment of folder) {
    if (!isAllowedSegment(area, segment)) throw invalidSegment(area, segment);
  }
  return build(root, area, [...folder, ALTISBAK_CENTRAL]);
}

/**
 * Where the content of upload `id` lives: `uploads/<yyyy>/<mm>/<id>`, with year and month taken from the
 * ULID's timestamp in UTC (so the path does not depend on the server's time zone).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `id` is not a canonical ULID, or the path leaves `uploads`
 *   (see {@link dataPath})
 */
export function uploadPath(dataDir: string, id: string): DataPath {
  if (!isUlid(id)) throw invalidSegment('uploads', id);
  const created = new Date(ulidTime(id));
  const year = String(created.getUTCFullYear()).padStart(4, '0');
  const month = String(created.getUTCMonth() + 1).padStart(2, '0');
  return build(dataDir, 'uploads', [year, month, id]);
}

// Phase 1d (Task 2): the update's typed builders in `releases` (spec §9.3, §9.6; decision D1d-16). app.js bundles
// them (boot markers), so they stay ES2017 like the rest of this module.

/** The prefix of an update's staging folder, `releases/.tmp-<v>-<opId>/` (spec §9.6 "ke `releases/.tmp-<v>-<ulid>/`"). */
const STAGING_PREFIX = '.tmp-';
/** The length of a canonical ULID. */
const ULID_LENGTH = 26;
/** The files and the folder directly inside a staging folder: the download, its resume state, the extracted release. */
const STAGING_ENTRIES: readonly string[] = ['package.zip', 'download.json', 'release'];
/** The marker of a complete release folder, the only dot-name a staged release holds (in its top folder). */
const COMPLETE_FILE = '.complete';
/** The longest path inside a release (the manifest's own bound). */
const RELEASE_PATH_MAX = 1024;
/**
 * Windows device names: a file of such a name, whatever its case and extension (`con.js`, `NUL.txt`), opens the
 * device. COM and LPT take a digit, superscript ¹ ² ³ included; CONIN$ and CONOUT$ are the console's two halves.
 */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

function checkedVersion(area: DataArea, version: unknown): string {
  if (typeof version !== 'string' || !isSemver(version)) throw invalidSegment(area, version);
  return version;
}

/**
 * `releases/boot/<v>/<pid>-<startMs>`: the boot marker of the process `pid` (started at `startMs`, epoch ms) booting
 * release `<v>` (spec §9.3).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `version` is not SemVer, `pid` is not a positive safe integer,
 *   `startMs` is not a non-negative safe integer, or the path leaves the area
 */
export function bootMarkerPath(dataDir: string, version: string, pid: number, startMs: number): DataPath {
  const v = checkedVersion('releases', version);
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw invalidSegment('releases', pid);
  if (typeof startMs !== 'number' || !Number.isSafeInteger(startMs) || startMs < 0) throw invalidSegment('releases', startMs);
  return build(dataDir, 'releases', ['boot', v, `${pid}-${startMs}`]);
}

/**
 * `.tmp-<v>-<opId>`: the name of the staging folder in `releases` of the update op `opId` installing `<v>` (D1d-16:
 * beside its final `releases/<v>/`, so that the last rename stays on one file system).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `version` is not SemVer or `opId` is not a canonical ULID
 */
export function releaseStagingName(version: string, opId: string): string {
  const v = checkedVersion('releases', version);
  const id = checkedId('releases', opId);
  return `${STAGING_PREFIX}${v}-${id}`;
}

/**
 * `releases/.tmp-<v>-<opId>`, or with one entry inside it: `package.zip` (the download), `download.json` (its resume
 * state) or `release` (the extracted release, see {@link stagedReleaseFile}).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` as {@link releaseStagingName}, for any other entry or more than one, or
 *   when the path leaves the area
 */
export function releaseStagingPath(
  dataDir: string,
  version: string,
  opId: string,
  ...rest: ('package.zip' | 'download.json' | 'release')[]
): DataPath {
  const folder = releaseStagingName(version, opId);
  if (rest.length > 1) throw invalidSegment('releases', rest.join('/'));
  for (const entry of rest) {
    if (typeof entry !== 'string' || STAGING_ENTRIES.indexOf(entry) === -1) throw invalidSegment('releases', entry);
  }
  return build(dataDir, 'releases', [folder].concat(rest));
}

/**
 * The version and op id a staging folder name holds (see {@link releaseStagingName}), or null for any other name: the
 * boot sweep's test for the `.tmp-*` folders it may remove (spec §9.3 "`.tmp-*` dihapus saat boot").
 */
export function isReleaseStagingName(name: string): { version: string; opId: string } | null {
  if (typeof name !== 'string' || name.slice(0, STAGING_PREFIX.length) !== STAGING_PREFIX) return null;
  const cut = name.length - ULID_LENGTH - 1; // the `-` before the op id; a SemVer may hold `-` itself
  if (cut <= STAGING_PREFIX.length || name.charAt(cut) !== '-') return null;
  const version = name.slice(STAGING_PREFIX.length, cut);
  const opId = name.slice(cut + 1);
  return isSemver(version) && isUlid(opId) ? { version, opId } : null;
}

/**
 * True for a segment of a staged release that every file system the product runs on stores as written: not empty, not
 * starting with `.`, not ending in `.` or a space (Windows drops those, so `server.mjs.` and `server.mjs` would be one
 * file), and not a Windows device name, with or without an extension (the part before the first `.`, trailing
 * spaces dropped as Windows does: `nul .txt` is NUL too).
 */
function isPortableSegment(segment: string): boolean {
  if (segment === '' || segment.charAt(0) === '.') return false;
  const last = segment.charAt(segment.length - 1);
  if (last === '.' || last === ' ') return false;
  const dot = segment.indexOf('.');
  const base = (dot === -1 ? segment : segment.slice(0, dot)).replace(/ +$/, '');
  return !WINDOWS_DEVICE_NAME.test(base);
}

/**
 * True for a relative POSIX path of plain segments inside a release: no absolute path, `.` or `..`, empty segment,
 * control character (NUL included) or `\ : * ? " < > |` (so no drive letter either), at most 1024 characters (the
 * manifest's rule), no segment starting with `.` except `.complete` as the whole path, and no segment Windows would
 * rewrite or open as a device (see {@link isPortableSegment}).
 */
function isStagedRelPath(relPath: unknown): relPath is string {
  if (typeof relPath !== 'string' || relPath === '' || relPath.length > RELEASE_PATH_MAX) return false;
  for (let i = 0; i < relPath.length; i += 1) {
    const c = relPath.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || '\\:*?"<>|'.indexOf(relPath.charAt(i)) !== -1) return false;
  }
  if (relPath === COMPLETE_FILE) return true;
  return relPath.split('/').every(isPortableSegment);
}

/**
 * `releases/.tmp-<v>-<opId>/release/<relPath>`: where a file of the release `<v>` is extracted by update op `opId`.
 * `relPath` is the file's path in the release (`server.mjs`, `public/admin/assets/a.js`, `.complete`).
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` as {@link releaseStagingName}; for a `relPath` that is absolute, holds
 *   `..`, `.`, `\`, NUL or another control character, a drive letter (any `:`), an empty segment, a segment starting
 *   with `.` other than `.complete` at the top, a segment ending in `.` or a space, or a Windows device name (CON, PRN,
 *   AUX, NUL, COM0-9, LPT0-9, CONIN$, CONOUT$; any case, with or without an extension); or when the path leaves the
 *   area (a symbolic link)
 */
export function stagedReleaseFile(dataDir: string, version: string, opId: string, relPath: string): DataPath {
  const folder = releaseStagingName(version, opId);
  if (!isStagedRelPath(relPath)) throw invalidSegment('releases', relPath);
  return build(dataDir, 'releases', [folder, 'release'].concat(relPath.split('/')));
}

// ---- Phase 2 (catalog): Task 3 ----
// The catalog's export files and the work files of a catalog run (decision P2-24, S3). Like the table-derived names
// above, these file names exist only through their typed builders: dataPath accepts none of them.

/** The extensions of a catalog export file (`catalog.export`: ISO 2709, MARCXML, MARC-in-JSON lines, CSV). */
export type ExportFileExt = 'mrc' | 'xml' | 'jsonl' | 'csv';

const EXPORT_EXTS: ReadonlySet<string> = new Set<ExportFileExt>(['mrc', 'xml', 'jsonl', 'csv']);

/**
 * The fixed work files of a run: an import's staged input, a SLiMS dump and files archive, the run's report CSV. A
 * SLiMS dump is also split into one `<table>.ndjson` per source table ({@link RUN_WORK_TABLE}), whose table list (the
 * columns and keys the split read) is `tables.json` (Task 23).
 */
const RUN_WORK_FILES: ReadonlySet<string> = new Set(['import.bin', 'dump.bin', 'files.bin', 'report.csv', 'tables.json']);

/** `<table>.ndjson`: a SLiMS source table name (lower-case snake case, at most 64 characters) and the extension. */
const RUN_WORK_TABLE = /^[a-z][a-z0-9_]{0,63}\.ndjson$/;

// ---- Komunitas K1 (usage import work files) ----
/**
 * The staged files of a SLiMS usage import, one per part of its work (`usage-visits-2025-07.bin`,
 * `usage-loans.json`): `part` is 1-40 of `a-z 0-9 -`.
 */
const RUN_WORK_USAGE = /^usage-[a-z0-9-]{1,40}\.(json|bin)$/;

/**
 * `exports/<runId>.<ext>`: the file a catalog export run writes (spec §5.4), removed by `catalog.housekeeping` once it
 * expired.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `runId` is not a ULID, `ext` is not one of `mrc`, `xml`, `jsonl`,
 *   `csv`, or the path leaves the area (see {@link dataPath})
 */
export function exportFilePath(dataDir: string, runId: string, ext: ExportFileExt): DataPath {
  const id = checkedId('exports', runId);
  if (typeof ext !== 'string' || !EXPORT_EXTS.has(ext)) throw invalidSegment('exports', ext);
  return build(dataDir, 'exports', [`${id}.${ext}`]);
}

/**
 * `tmp/<runId>`: the work folder of a catalog run (import input, SLiMS staging, report). `files.cleanup` leaves the
 * folder of a live run, and of a finished one for 7 days (S2), alone.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `runId` is not a ULID, or the path leaves the area
 */
export function runWorkDir(dataDir: string, runId: string): DataPath {
  return build(dataDir, 'tmp', [checkedId('tmp', runId)]);
}

/**
 * `tmp/<runId>/<name>`: one work file of a catalog run. `name` is `import.bin`, `dump.bin`, `files.bin`,
 * `report.csv`, `tables.json`, or `<table>.ndjson` with `<table>` matching `/^[a-z][a-z0-9_]{0,63}$/` (a SLiMS dump split per table).
 * A SLiMS usage import also stages `usage-<part>.json` and `usage-<part>.bin`, `<part>` 1-40 of `a-z 0-9 -`.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` for any other name, a `runId` that is not a ULID, or a path that leaves
 *   the area
 */
export function runWorkPath(dataDir: string, runId: string, name: string): DataPath {
  const id = checkedId('tmp', runId);
  if (typeof name !== 'string' || !(RUN_WORK_FILES.has(name) || RUN_WORK_TABLE.test(name) || RUN_WORK_USAGE.test(name))) {
    throw invalidSegment('tmp', name);
  }
  return build(dataDir, 'tmp', [id, name]);
}

// ---- Komunitas K1 (report paths) ----
// A report run's file and its work files live in their own sub-folders, `exports/reports/` and `tmp/reports/`, which
// the catalogue's housekeeping never lists (it reads `exports/<runId>.<ext>` and `tmp/<runId>/` only) and the reports'
// housekeeping only sweeps. These builders are the only way to name a path there: dataPath accepts none of them.

/** The extensions of a report run's file. */
export type ReportFileExt = 'csv' | 'xlsx' | 'pdf' | 'zip';

const REPORT_EXTS: ReadonlySet<string> = new Set<ReportFileExt>(['csv', 'xlsx', 'pdf', 'zip']);

/** The folder of the report files, in `exports` and in `tmp`. */
const REPORTS_FOLDER = 'reports';

/** The fixed work files of a report run: its rows, the output being written and its central directory, a dossier. */
const REPORT_WORK_FILES: ReadonlySet<string> = new Set(['rows.ndjson', 'output.part', 'output.central', 'dossier.pdf']);

/** One component's ZIP of an evidence ZIP, and its central directory (`component-SP.zip`, `component-profil.central`). */
const REPORT_WORK_COMPONENT = /^component-(K|SP|L|T|F|G|profil)\.(zip|central)$/;

/** A generated PDF of an evidence ZIP: `entry-<n>.pdf`, n from 1 to 9 999. */
const REPORT_WORK_ENTRY = /^entry-[1-9]\d{0,3}\.pdf$/;

/** `exports/reports`: the folder of every report run's file. */
export function reportExportsDir(dataDir: string): DataPath {
  return build(dataDir, 'exports', [REPORTS_FOLDER]);
}

/**
 * `exports/reports/<runId>.<ext>`: the file a report run writes, removed by `reports.housekeeping` once it expired.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `runId` is not a ULID, `ext` is not one of `csv`, `xlsx`, `pdf`,
 *   `zip`, or the path leaves the area (see {@link dataPath})
 */
export function reportExportPath(dataDir: string, runId: string, ext: ReportFileExt): DataPath {
  const id = checkedId('exports', runId);
  if (typeof ext !== 'string' || !REPORT_EXTS.has(ext)) throw invalidSegment('exports', ext);
  return build(dataDir, 'exports', [REPORTS_FOLDER, `${id}.${ext}`]);
}

/** `tmp/reports`: the folder of every report run's work folder. */
export function reportWorkRoot(dataDir: string): DataPath {
  return build(dataDir, 'tmp', [REPORTS_FOLDER]);
}

/**
 * `tmp/reports/<runId>`: the work folder of a report run.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` when `runId` is not a ULID, or the path leaves the area
 */
export function reportWorkDir(dataDir: string, runId: string): DataPath {
  return build(dataDir, 'tmp', [REPORTS_FOLDER, checkedId('tmp', runId)]);
}

/**
 * `tmp/reports/<runId>/<name>`: one work file of a report run. `name` is `rows.ndjson`, `output.part`,
 * `output.central`, `dossier.pdf`, `component-<K|SP|L|T|F|G|profil>.zip` or `.central`, or `entry-<n>.pdf` with n from 1
 * to 9 999.
 *
 * @throws DomainError `INVALID_PATH_SEGMENT` for any other name, a `runId` that is not a ULID, or a path that leaves
 *   the area
 */
export function reportWorkPath(dataDir: string, runId: string, name: string): DataPath {
  const id = checkedId('tmp', runId);
  if (typeof name !== 'string' || !(REPORT_WORK_FILES.has(name) || REPORT_WORK_COMPONENT.test(name) || REPORT_WORK_ENTRY.test(name))) {
    throw invalidSegment('tmp', name);
  }
  return build(dataDir, 'tmp', [REPORTS_FOLDER, id, name]);
}
