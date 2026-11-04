import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';

// Runs fixture child processes (concurrency-child.mjs, audit-child.mjs) against the test database: each child
// opens its own connection (SQLite: its own DatabaseSync on the same file), reports 'ready', and starts its work
// only once every child is ready, so that the processes really compete.

const ROOT = path.resolve(import.meta.dirname, '../../../..');

export interface ChildRun<R> {
  /** Exit code of each child, in start order. */
  codes: (number | null)[];
  /** What each child reported (undefined when it reported nothing). */
  reports: (R | undefined)[];
}

/**
 * Starts one child per entry of `options` (each gets its options as JSON in argv[2]), waits until all are ready,
 * sends 'go' to all of them and resolves once all have exited. Children still running when `timeoutMs` elapses
 * are killed: by default 25 s, before the db project's 30 s test timeout, so no child outlives its test (the
 * fixtures also exit when their parent's IPC channel closes).
 */
export async function runChildren<R>(fixture: string, options: object[], timeoutMs = 25_000): Promise<ChildRun<R>> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, fixture), [JSON.stringify(o)], {
        cwd: ROOT,
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: R | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as R;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<{ code: number | null; report: R | undefined }>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
      return { child, ready, exited };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    const done = await Promise.all(runs.map((r) => r.exited));
    return { codes: done.map((d) => d.code), reports: done.map((d) => d.report) };
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
