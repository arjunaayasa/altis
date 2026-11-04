/**
 * The test entry of altis-sign (preflight M10: the test seam `devTrustedFile` stays out of `CliIo`). Not published:
 * the package's `exports` name src/index.ts only, which never imports this file. Tests import it by its relative path.
 *
 * `runCliForTest` runs the same command line as `runCli` with test hooks: `devTrustedFile` points the dev key check of
 * `keyset sign` (a production root) and `ceremony check` at another list than tools/keys/dev/trusted.json.
 */
import { runWithHooks } from './cli.js';
import type { CliIo, TestHooks } from './common.js';

export type { CliIo, TestHooks } from './common.js';

/** `runCli(argv, io)` with test hooks. Returns the exit code: 0 done, 1 failed, 2 wrong command line. */
export function runCliForTest(argv: string[], io: CliIo, hooks: TestHooks = {}): Promise<number> {
  return runWithHooks(argv, io, { ...hooks });
}
