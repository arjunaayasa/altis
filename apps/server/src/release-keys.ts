import { collectInstalledKeysets, type CollectedKeysets, type KeysetReport, type TrustedKey } from '@altis/crypto';
import { dataPath, readJsonWithBak } from '@altis/platform';
import { DomainError, isSemver } from '@altis/shared';

// The keys this server verifies its release with (spec §8.3, rulings R62 and R65), exactly as app.js does
// (packages/bootloader/src/release.ts): the root keys the release build embedded (the same `__TRUSTED_KEYS__` as
// app.js) are the only anchors; every other key is trusted through root-signed keyset documents only, gathered from
// every keyset.json of the installation (R65a) plus the release's own (verifyReleaseWithRoots of @altis/crypto).

/** The root keys embedded at build time; undefined when this code was not bundled by the release build. */
export function embeddedRootKeys(): readonly TrustedKey[] | undefined {
  return typeof __TRUSTED_KEYS__ === 'undefined' ? undefined : __TRUSTED_KEYS__;
}

/** A production server.mjs refuses every keyset document that adds a `dev-` key, as a production app.js does (R65b). */
export function refusesDevKids(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'production';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The versions of the data releases current.json names (active, previous, pending); entries that are not valid are skipped. */
function dataReleaseVersions(raw: unknown): string[] {
  const versions: string[] = [];
  if (!isRecord(raw)) return versions;
  for (const field of ['active', 'previous', 'pending']) {
    const ref = raw[field];
    if (isRecord(ref) && ref['source'] === 'data' && typeof ref['version'] === 'string' && isSemver(ref['version'])) versions.push(ref['version']);
  }
  return versions;
}

/**
 * Every root-signed keyset document of the installation besides the release being checked, gathered as app.js gathers
 * them (ruling R65a): DATA_DIR/releases/keyset.json and its `.bak`, the keyset.json of every bundled release next to
 * app.js, and of every data release current.json names (bundled ones are read with the bundled releases). A
 * current.json that cannot be read adds no release (app.js reports it before any command runs). Reads only.
 *
 * @throws DomainError `STATE_CORRUPT` when DATA_DIR/releases/keyset.json and its `.bak` exist and neither can be used
 *   (losing them could bring a revoked key back, so this fails closed, like app.js)
 */
export async function installedKeysets(appRoot: string, dataDir: string): Promise<CollectedKeysets> {
  let versions: string[];
  try {
    versions = (await readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), dataReleaseVersions)) ?? [];
  } catch {
    versions = [];
  }
  try {
    return await collectInstalledKeysets({
      appRoot,
      dataKeyset: dataPath(dataDir, 'releases', 'keyset.json'),
      releases: versions.map((version) => ({ name: `DATA_DIR/releases/${version}/keyset.json`, dir: dataPath(dataDir, 'releases', version) })),
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('KEYSET_CORRUPT')) throw error;
    throw new DomainError('STATE_CORRUPT', {
      detail:
        'DATA_DIR/releases/keyset.json dan salinan .bak-nya tidak dapat dipakai; pulihkan dari cadangan / ' +
        'DATA_DIR/releases/keyset.json and its .bak copy are not usable; restore them from a backup',
      meta: { reason: 'state_unreadable', path: 'releases/keyset.json' },
    });
  }
}

/** At most this many items of each kind in a report line. */
const MAX_LISTED = 5;

/** A kid for a report: JSON-quoted (control characters escaped) and cut to 64 characters. */
function shownKid(kid: string): string {
  const text = JSON.stringify(kid);
  return text.length > 64 ? `${text.slice(0, 63)}…` : text;
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ');
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

/**
 * What the keyset resolution left aside, as safe text for doctor (ruling R65f): the documents ignored (source, index,
 * reason), the kids bound to two keys, and the keyset.json files that could not be used. Empty when there is nothing.
 */
export function describeKeysets(report: KeysetReport | undefined, skipped: CollectedKeysets['skipped']): string {
  const parts: string[] = [];
  if (report !== undefined && report.rejected.length > 0) {
    parts.push(`${report.rejected.length} keyset document(s) ignored: ${listed(report.rejected.map((r) => `${r.source}#${r.index} ${r.reason}`))}`);
  }
  if (report !== undefined && report.conflicts.length > 0) {
    parts.push(`kid(s) bound to two keys, not trusted: ${listed(report.conflicts.map(shownKid))}`);
  }
  if (skipped.length > 0) parts.push(`keyset.json not usable: ${listed(skipped.map((s) => s.name))}`);
  return parts.join('; ');
}
