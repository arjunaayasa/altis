import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from '@altis/platform';
import type { BootLog } from './log.js';

// ctx.requestRestart(reason) (P14): how this process gets replaced, per runtime.
// - passenger, litespeed: touch <appRoot>/tmp/restart.txt; the web server restarts the app on its next request.
//   The process does not exit (Passenger would only spawn it again).
// - pm2, docker, service, standalone (the supervised child): drain, then exit(75). PM2's autorestart, Docker's
//   `restart: unless-stopped`, the service wrapper and app.js's own supervisor start a new process.
// - the command line: never exits a CLI run on behalf of the server; it touches restart.txt where that works and
//   otherwise says what to do.

/**
 * How long a server process keeps serving after a restart was requested before it exits with 75: a pause in which
 * app.js's server goes on answering, so that in-flight requests can finish.
 */
export const DRAIN_MS = 2000;

/** The exit code that asks the process manager (or app.js's supervisor) for a restart. */
export const RESTART_EXIT_CODE = 75;

/** Creates `<appRoot>/tmp/restart.txt` when missing and sets its mtime to now. */
export async function touchRestartFile(appRoot: string): Promise<string> {
  const dir = path.join(appRoot, 'tmp');
  const file = path.join(dir, 'restart.txt');
  await fsp.mkdir(dir, { recursive: true });
  const handle = await fsp.open(file, 'a');
  await handle.close();
  const now = new Date();
  await fsp.utimes(file, now, now);
  return file;
}

export interface RequestRestartOptions {
  runtime: Runtime;
  appRoot: string;
  log: BootLog;
  /** `cli`: the process is a command, not the server. */
  mode: 'server' | 'cli';
}

/** ctx.requestRestart for this process (see the rules above). Repeated calls while a restart is pending do nothing more. */
export function createRequestRestart(o: RequestRestartOptions): (reason: string) => Promise<void> {
  let exitTimer: NodeJS.Timeout | undefined;
  return async (reason: string): Promise<void> => {
    if (o.runtime === 'passenger' || o.runtime === 'litespeed') {
      await touchRestartFile(o.appRoot);
      o.log.info('restart requested: touched tmp/restart.txt', { reason, runtime: o.runtime });
      return;
    }
    if (o.mode === 'cli') {
      o.log.warn('restart requested: restart the ALTIS service to apply it', { reason, runtime: o.runtime });
      return;
    }
    if (exitTimer !== undefined) return;
    o.log.info('restart requested: draining, then exit 75', { reason, runtime: o.runtime, drainMs: DRAIN_MS });
    exitTimer = setTimeout(() => process.exit(RESTART_EXIT_CODE), DRAIN_MS);
  };
}
