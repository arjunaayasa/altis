import { openForeignMysql, type ForeignMysql, type ForeignMysqlConfig } from '@altis/db';

// How the SLiMS usage import reaches a SLiMS database: @altis/db's read-only foreign client. In the test build profile
// only, a test puts a fake server in its place (__setSlimsUsageConnect), so the connection test and an import from a
// database run without a network; a production build refuses the setter.

/** Opens a read-only session on a SLiMS database. */
export type SlimsUsageConnect = (cfg: ForeignMysqlConfig, o: { connectTimeoutMs: number }) => Promise<ForeignMysql>;

let connectOverride: SlimsUsageConnect | null = null;

function testProfile(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test';
}

/** The client the import connects with: the foreign client, or a test's fake (test profile). */
export function slimsUsageConnect(): SlimsUsageConnect {
  return connectOverride ?? openForeignMysql;
}

/**
 * Test build profile only: connects through `connect` until the next call; null puts the foreign client back.
 *
 * @throws TypeError outside the test build profile
 */
export function __setSlimsUsageConnect(connect: SlimsUsageConnect | null): void {
  if (!testProfile()) throw new TypeError('__setSlimsUsageConnect is a hook of the test build profile only');
  connectOverride = connect;
}
