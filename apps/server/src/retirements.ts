// The retirements of start()'s request handlers still under way in this process (index.ts): once app.js stops serving
// a handler, it drains its job runtime and closes its database in the background (start() has resolved long before).
// Nothing in the app waits for them; a test does, before it removes the DATA_DIR they may still write in.

const pending = new Set<Promise<void>>();

/** Records `retirement` until it settles. */
export function trackRetirement(retirement: Promise<void>): void {
  pending.add(retirement);
  const settled = (): void => {
    pending.delete(retirement);
  };
  retirement.then(settled, settled);
}

/** Resolves once every retirement recorded so far, and any recorded meanwhile, has settled. */
export async function retirementsSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
