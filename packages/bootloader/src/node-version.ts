// The Node.js version check (ruling R56): the very first thing app.js does. Hosting panels still offer Node 10 to
// 20, so this module, like rescue.ts, uses nothing beyond what Node 10 has: no newer API and no import of another
// module. Everything else is loaded only after the check has passed.

/** The oldest supported Node.js (global constraints). */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 16;
/** How the minimum is named in messages. */
export const MIN_NODE_TEXT = MIN_NODE_MAJOR + '.' + MIN_NODE_MINOR;

/**
 * The Node.js version to judge: `process.versions.node`. Test builds only (dead code in production builds,
 * ruling R57): `ALTIS_TEST_FAKE_NODE_VERSION` stands in for it.
 */
export function nodeVersion(env: Readonly<Record<string, string | undefined>>): string {
  if (__BUILD_PROFILE__ === 'test') {
    const fake = env['ALTIS_TEST_FAKE_NODE_VERSION'];
    if (typeof fake === 'string' && fake !== '') return fake;
  }
  return process.versions.node;
}

/** True when `version` (`major.minor.patch`, anything may follow) is at least 22.16. Unreadable: false. */
export function isSupportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (match === null) return false;
  const major = parseInt(match[1] as string, 10);
  const minor = parseInt(match[2] as string, 10);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}
