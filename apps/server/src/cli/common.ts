import os from 'node:os';
import { MIN_NODE_VERSION, nodeVersionSupported } from '@altis/core';
import { isEnvSet, type Env } from '@altis/platform';
import { isDomainError } from '@altis/shared';

// What the CLI commands share: failures and how they are reported, the Node check, the test-only fault hook.
//
// Output rules (Task 15 rulings): humans get short bilingual lines ("Indonesia / English"); `--json` gives one JSON
// line. Neither ever shows a secret, a password, the content of config.json or of the input file, not even on error:
// a failure is its code plus a detail written to be shown (a DomainError's `detail`), never a driver message or meta.

/** The oldest Node.js ALTIS runs on (global constraints; core's MIN_NODE_VERSION, which the preflight checks use). */
export const MIN_NODE = MIN_NODE_VERSION;

/** Exit codes of runCli (bootloader contract v1). */
export const EXIT = { ok: 0, failure: 1, alreadyInstalled: 2, schemaTooNew: 3 } as const;

/**
 * A CLI failure that is not a DomainError: `USAGE`, `NODE_TOO_OLD`, `DATA_DIR_UNWRITABLE` (the last two named like
 * the bootloader's rescue reasons). `detail` is shown as it is.
 */
export class CliError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'CliError';
    this.code = code;
    this.detail = detail;
  }
}

export interface Failure {
  code: string;
  detail: string;
  exitCode: number;
}

/** An object key the CLI shows as it is (L51): short, and nothing a terminal could act on. */
const SHOWN_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * How a failure names an object key that came from the operator's input (L51: a Zod `unrecognized_keys` issue names
 * keys the schema does not know): the key itself when it matches `/^[A-Za-z0-9_.-]{1,64}$/`, else `<key>`, so that
 * an escape sequence or a screenful of text in an input file never reaches the terminal through describeFailure.
 */
export function describeKey(key: string): string {
  return SHOWN_KEY.test(key) ? key : '<key>';
}

/**
 * `text` with every control character (C0, DEL, C1, and the line and paragraph separators) as U+FFFD: a detail is one
 * line of prose, and nothing in it may move the cursor or recolour the terminal (L51; every detail is authored, so
 * this only ever catches a value that slipped into one).
 */
function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? String.fromCodePoint(0xfffd) : ch;
  }
  return out;
}

/**
 * How a failure is reported: the code and a detail that is safe to show, and the exit code (ALREADY_INSTALLED 2,
 * SCHEMA_TOO_NEW 3, anything else 1). A DomainError shows its `detail` (written for operators; it never repeats
 * values of the config or the input, and keys of the input only through {@link describeKey}), a MigrationError its
 * message (made safe by the migration runner); of any other error only its name and code are shown, as its message
 * may carry driver text. No detail carries a control character (L51).
 */
export function describeFailure(error: unknown): Failure {
  const failure = rawFailure(error);
  return { ...failure, detail: printable(failure.detail) };
}

function rawFailure(error: unknown): Failure {
  if (error instanceof CliError) return { code: error.code, detail: error.detail, exitCode: EXIT.failure };
  if (isDomainError(error)) {
    const exitCode = error.code === 'ALREADY_INSTALLED' ? EXIT.alreadyInstalled : error.code === 'SCHEMA_TOO_NEW' ? EXIT.schemaTooNew : EXIT.failure;
    return { code: error.code, detail: error.detail ?? '', exitCode };
  }
  if (error instanceof Error && error.name === 'MigrationError') {
    return { code: 'MIGRATION_FAILED', detail: error.message, exitCode: EXIT.failure };
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return {
    code: 'INTERNAL',
    detail: `galat tak terduga / unexpected error (${name}${typeof code === 'string' ? ` ${code}` : ''})`,
    exitCode: EXIT.failure,
  };
}

/** True when `version` (`process.versions.node` form) is at least {@link MIN_NODE}. */
export function nodeSupported(version: string): boolean {
  return nodeVersionSupported(version);
}

export function nodeTooOld(version: string): CliError {
  return new CliError(
    'NODE_TOO_OLD',
    `Node ${version} terlalu lama; ALTIS memerlukan Node 22.16 atau lebih baru (pilih di panel hosting, mis. Setup Node.js App) / ` +
      `Node ${version} is too old; ALTIS needs Node 22.16 or newer (choose it in the hosting panel, e.g. Setup Node.js App)`,
  );
}

/** The home directory the document-root rules look at: `$HOME` when set, else the OS's idea of it. */
export function homeDir(env: Env): string {
  return isEnvSet(env, 'HOME') ? env['HOME']! : os.homedir();
}

/** The points of `install` at which a test can have the process killed (ALTIS_TEST_FAULT). */
export type FaultPoint = 'after-config' | 'after-migrate' | 'after-seed' | 'after-complete';

/**
 * Test hook, compiled out of production builds (dead branch once `__BUILD_PROFILE__` is 'production'): with
 * ALTIS_TEST_FAULT=<point> in the CLI's environment the process kills itself with SIGKILL at that point, as a power
 * cut or an OOM kill would (spec P7, §12.5). Nothing runs after it: no finally block, no close.
 */
export function testFault(env: Env, point: FaultPoint): void {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ !== 'production') {
    if (env['ALTIS_TEST_FAULT'] === point) process.kill(process.pid, 'SIGKILL');
  }
}
