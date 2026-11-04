/**
 * SemVer 2.0.0 (also in @altis/shared; this package must stay free of other workspace packages).
 *
 * Bundled into the ES2017 bootloader: keep the syntax plain and the module dependency-free.
 */
const NUMERIC_ID = '0|[1-9]\\d*';
const PRERELEASE_ID = NUMERIC_ID + '|\\d*[a-zA-Z-][0-9a-zA-Z-]*';
const SEMVER = new RegExp(
  '^(' + NUMERIC_ID + ')\\.(' + NUMERIC_ID + ')\\.(' + NUMERIC_ID + ')' +
    '(?:-((?:' + PRERELEASE_ID + ')(?:\\.(?:' + PRERELEASE_ID + '))*))?' +
    '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$',
);

export function isSemverText(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

/** Digit strings without leading zeros, compared exactly at any size (no Number round trip). */
function compareNumericText(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const NUMERIC_TEXT = /^\d+$/;

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC_TEXT.test(a);
  const bNumeric = NUMERIC_TEXT.test(b);
  if (aNumeric && bNumeric) return compareNumericText(a, b);
  if (aNumeric) return -1; // numeric identifiers rank below alphanumeric ones
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1; // ASCII order
}

function parts(version: string): { core: string[]; prerelease: string[] } {
  const m = typeof version === 'string' ? SEMVER.exec(version) : null;
  if (m === null) throw new TypeError('compareSemverText: not a semantic version: ' + JSON.stringify(version));
  return { core: [m[1] as string, m[2] as string, m[3] as string], prerelease: m[4] === undefined ? [] : m[4].split('.') };
}

/**
 * SemVer 2.0.0 precedence (rule 11): a negative number when `a` ranks below `b`, positive when above, 0 when equal.
 * Build metadata is ignored; numbers compare exactly whatever their size. The same order as `compareSemver` of
 * @altis/shared (preflight B2: this package never imports it). Throws a TypeError when either text is not SemVer.
 */
export function compareSemverText(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const c = compareNumericText(pa.core[i] as string, pb.core[i] as string);
    if (c !== 0) return c;
  }
  // A version without a pre-release ranks above the same version with one.
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifiers(pa.prerelease[i] as string, pb.prerelease[i] as string);
    if (c !== 0) return c;
  }
  // Every shared identifier is equal: the longer pre-release ranks higher.
  return pa.prerelease.length === pb.prerelease.length ? 0 : pa.prerelease.length < pb.prerelease.length ? -1 : 1;
}
