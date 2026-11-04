import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';

// Starts job-child.mjs processes for the job queue's db tests (as rate-limit.test.ts's runChildren): each child opens
// the test database itself, reports 'ready', and all of them get 'go' at once.

export interface JobChildRun<R> {
  code: number | null;
  signal: NodeJS.Signals | null;
  report: R | undefined;
}

/**
 * Runs one job-child.mjs per entry of `options` (its JSON argument) with the environment `env(i)` (default: this
 * process's), starts them together and waits for all of them. Children still running after `timeoutMs` are killed.
 */
export async function runJobChildren<R>(
  options: readonly object[],
  o: { env?: (i: number) => NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<JobChildRun<R>[]> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, o.timeoutMs ?? 25_000);
  try {
    const runs = options.map((opts, i) => {
      const child = fork(path.join(import.meta.dirname, 'job-child.mjs'), [JSON.stringify(opts)], {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: o.env?.(i) ?? process.env,
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
        child.once('exit', (code, signal) => reject(new Error(`child exited (${String(code ?? signal)}) before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const closed = new Promise<JobChildRun<R>>((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal, report })),
      );
      return { child, ready, closed };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    return await Promise.all(runs.map((r) => r.closed));
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
