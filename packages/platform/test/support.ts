import { vi } from 'vitest';

/** An error shaped like the ones Node's fs functions reject with. */
export function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** Lets fake timers and real I/O take turns until `promise` settles. */
export async function drive(promise: Promise<unknown>, stepMs = 25): Promise<void> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; !settled && i < 4000; i += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
