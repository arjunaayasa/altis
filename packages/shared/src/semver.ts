/**
 * Semantic Versioning 2.0.0 parsing and precedence (https://semver.org, rules 2 and 11).
 * Strict: no leading `v`, no leading zeros, all three numbers present.
 */

const NUMERIC = '0|[1-9]\\d*';
const PRERELEASE_ID = `${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*`;
const SEMVER_PATTERN = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-((?:${PRERELEASE_ID})(?:\\.(?:${PRERELEASE_ID}))*))?` +
    `(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
);

interface Parsed {
  core: [string, string, string];
  prerelease: string[];
}

function parse(version: string): Parsed {
  const m = typeof version === 'string' ? SEMVER_PATTERN.exec(version) : null;
  if (!m) throw new TypeError(`Not a semantic version: ${JSON.stringify(version)}`);
  return { core: [m[1]!, m[2]!, m[3]!], prerelease: m[4] === undefined ? [] : m[4].split('.') };
}

/** Compares digit strings without leading zeros, exactly and without limit on size (no Number round trip). */
function compareNumeric(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const isNumeric = (id: string): boolean => /^\d+$/.test(id);

function compareIdentifier(a: string, b: string): -1 | 0 | 1 {
  const aNum = isNumeric(a);
  const bNum = isNumeric(b);
  if (aNum && bNum) return compareNumeric(a, b);
  if (aNum) return -1; // numeric identifiers always rank below alphanumeric ones
  if (bNum) return 1;
  return a === b ? 0 : a < b ? -1 : 1; // ASCII order
}

/** True when `s` is a valid Semantic Version (build metadata allowed). */
export function isSemver(s: string): boolean {
  return typeof s === 'string' && SEMVER_PATTERN.test(s);
}

/**
 * Orders two versions by SemVer precedence: -1 if `a` is lower, 1 if higher, 0 if equal.
 * Build metadata is ignored. Throws a TypeError when either argument is not a valid version.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const c = compareNumeric(pa.core[i]!, pb.core[i]!);
    if (c !== 0) return c;
  }
  // A version without pre-release ranks above the same version with one.
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifier(pa.prerelease[i]!, pb.prerelease[i]!);
    if (c !== 0) return c;
  }
  // All shared identifiers are equal: the longer pre-release ranks higher.
  return pa.prerelease.length === pb.prerelease.length ? 0 : pa.prerelease.length < pb.prerelease.length ? -1 : 1;
}
