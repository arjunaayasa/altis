// Turns for the event loop during long runs of synchronous work (ruling R25). node:sqlite runs every statement
// synchronously, so a loop of awaited SQLite statements is one unbroken chain of microtasks: timers (the
// migrate.lock heartbeat, keep-alives) and I/O callbacks (/_health) would not run until it ends. Awaiting
// setImmediate lets a whole event-loop iteration pass first.

/** How often the SQLite path yields: at most this long between turns, in ms. */
const YIELD_EVERY_MS = 1000;

let everyMs: number | undefined;
let lastTurn = performance.now();

/**
 * {@link YIELD_EVERY_MS}, or in a test build ALTIS_TEST_SQLITE_YIELD_MS=<ms> (a dead branch in production builds),
 * so tests can scale the timing down together with the lock's stale time.
 */
function yieldEveryMs(): number {
  if (everyMs === undefined) {
    everyMs = YIELD_EVERY_MS;
    if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ !== 'production') {
      const value = Number(process.env['ALTIS_TEST_SQLITE_YIELD_MS']);
      if (Number.isInteger(value) && value > 0) everyMs = value;
    }
  }
  return everyMs;
}

/** Lets the event loop run one iteration (timers, I/O callbacks) before continuing. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  lastTurn = performance.now();
}

/** {@link yieldToEventLoop} when the last turn given here is at least a second (YIELD_EVERY_MS) ago. */
export async function yieldIfDue(): Promise<void> {
  if (performance.now() - lastTurn >= yieldEveryMs()) await yieldToEventLoop();
}
