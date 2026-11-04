import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { BootLog } from './log.js';
import { FATAL_EXIT_CODE, exitWith } from './rescue.js';
import { RESTART_EXIT_CODE } from './restart.js';

// The standalone supervisor (P14): with runtime `standalone` nobody else restarts ALTIS, so app.js forks itself
// (`ALTIS_SUPERVISED=1`) and watches the child:
// - exit 75: the child asked for a restart: fork a new one at once;
// - exit 0: the child stopped on its own: stop too;
// - exit 78 (FATAL_EXIT_CODE): the child's port is in use or unusable, which a restart cannot fix: stop with exit
//   code 1, no restart;
// - any other exit or a signal: a crash: fork again after 1, 2, then 4 s; the fifth crash within 60 s stops the
//   supervisor with exit code 1 and a bilingual message;
// - SIGINT/SIGTERM: forwarded to the child; the supervisor exits with the child's code (128 + signal number when
//   the child died of the signal), killing it after 10 s if it does not stop;
// - the child exits when the IPC channel to the supervisor closes, so it never outlives it (no orphans); the
//   channel itself does not keep the child alive (a child that has finished its work exits).

export const CRASH_LIMIT = 5;
export const CRASH_WINDOW_MS = 60_000;
/** Pause before the restart after the 1st, 2nd and later crashes in the window, in units of the base (1 s). */
const BACKOFF_STEPS = [1, 2, 4];
const BACKOFF_BASE_MS = 1000;
const SHUTDOWN_GRACE_MS = 10_000;

const CRASH_LIMIT_MESSAGE =
  'ALTIS berhenti: proses server berhenti tak terduga ' +
  CRASH_LIMIT +
  ' kali dalam 60 detik. Periksa log di atas, perbaiki masalahnya, lalu jalankan ulang.\n' +
  'ALTIS stopped: the server process exited unexpectedly ' +
  CRASH_LIMIT +
  ' times within 60 seconds. Check the log above, fix the problem, then start it again.\n';

/**
 * The base pause between crash restarts. Test builds only (dead code in production, ruling R57):
 * ALTIS_TEST_SUPERVISOR_BACKOFF_MS replaces the 1 s base so tests need not wait 11 s for five crashes.
 */
function backoffBaseMs(env: NodeJS.ProcessEnv): number {
  if (__BUILD_PROFILE__ === 'test') {
    const value = Number(env['ALTIS_TEST_SUPERVISOR_BACKOFF_MS']);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return BACKOFF_BASE_MS;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = (os.constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (number === undefined ? 15 : number);
}

export interface SupervisorOptions {
  /** app.js itself. */
  script: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  log: BootLog;
}

/** Runs the supervisor until it exits the process (see the rules above). */
export function runSupervisor(o: SupervisorOptions): void {
  const baseMs = backoffBaseMs(o.env);
  const crashes: number[] = [];
  let child: ChildProcess | undefined;
  let stopping: NodeJS.Signals | null = null;
  let restartTimer: NodeJS.Timeout | undefined;

  function startChild(): void {
    restartTimer = undefined;
    let forked: ChildProcess;
    try {
      forked = fork(o.script, o.args, { env: { ...o.env, ALTIS_SUPERVISED: '1' } });
    } catch (error) {
      o.log.error('server process could not be started', { err: error });
      childEnded(null, null);
      return;
    }
    child = forked;
    let ended = false;
    const end = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (ended) return;
      ended = true;
      child = undefined;
      childEnded(code, signal);
    };
    forked.on('error', (error) => {
      o.log.error('server process error', { err: error });
      if (forked.pid === undefined) end(null, null); // never spawned: no 'exit' follows
    });
    forked.on('exit', end);
    o.log.info('server process started', { pid: forked.pid });
  }

  function childEnded(code: number | null, signal: NodeJS.Signals | null): void {
    if (stopping !== null) {
      process.exit(code !== null ? code : signalExitCode(signal === null ? stopping : signal));
    }
    if (code === FATAL_EXIT_CODE) {
      o.log.error('server process stopped with a fatal error; not restarting', { code });
      exitWith(1, '');
      return;
    }
    if (code === RESTART_EXIT_CODE) {
      o.log.info('server process asked for a restart');
      startChild();
      return;
    }
    if (code === 0) {
      o.log.info('server process stopped');
      process.exit(0);
    }
    const now = performance.now();
    crashes.push(now);
    while (crashes.length > 0 && now - (crashes[0] as number) > CRASH_WINDOW_MS) crashes.shift();
    o.log.error('server process crashed', { code, signal, crashesInWindow: crashes.length });
    if (crashes.length >= CRASH_LIMIT) {
      exitWith(1, CRASH_LIMIT_MESSAGE);
      return;
    }
    const step = BACKOFF_STEPS[Math.min(crashes.length, BACKOFF_STEPS.length) - 1] as number;
    restartTimer = setTimeout(startChild, step * baseMs);
  }

  function shutdown(signal: NodeJS.Signals): void {
    if (stopping !== null) {
      if (child !== undefined) child.kill('SIGKILL'); // asked twice: do not wait any longer
      return;
    }
    stopping = signal;
    if (child === undefined) {
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      process.exit(signalExitCode(signal));
    }
    child.kill(signal);
    setTimeout(() => {
      if (child !== undefined) child.kill('SIGKILL');
    }, SHUTDOWN_GRACE_MS).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  startChild();
}

/**
 * In the supervised child: exit when the supervisor is gone (its IPC channel closed), so no orphan stays behind.
 * The 'disconnect' listener refs the channel, which would keep a child alive after a graceful shutdown (server
 * closed, nothing left to do) until the supervisor kills it; the channel is unref'd so that it never does. Its
 * 'disconnect' still arrives while anything else keeps the process running.
 */
export function exitWithSupervisor(log: BootLog): void {
  if (typeof process.send !== 'function') return;
  process.on('disconnect', () => {
    log.warn('the supervisor is gone; stopping');
    process.exit(0);
  });
  if (process.channel !== undefined) process.channel.unref();
}
