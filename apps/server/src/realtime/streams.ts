import type { Runtime } from '@altis/platform';

// The SSE transport's limits and its per-process stream count (spec §10.8, decision C6). Every open stream holds a
// connection of this process (on Passenger, a whole worker process), so the limit is counted per process: a full
// process answers 204 and the client falls back to polling. The count is in memory on purpose: it counts this
// process's own open connections, which no other process can see or close (P6 concerns shared state; this is not).

/** A stream is closed by the server at the latest this long after it opened; the browser then reconnects. */
export const SSE_MAX_MS = 25_000;
/** A stream reads the events table this often. */
export const SSE_READ_MS = 1_000;
/** A stream checks the session, the user, the rights, the channels and the data epoch this often (C6). */
export const SSE_AUTH_MS = 5_000;
/** The reconnection delay a stream asks the browser for (`retry:`), in ms. */
export const SSE_RETRY_MS = 1_000;
/** `realtime.maxStreams` (spec §10.8): open streams per process. */
export const SSE_MAX_STREAMS = 4;

/**
 * Whether SSE is on: `realtime.sse` when set (`PUT diagnostics/realtime`); while it is null (automatic), on everywhere
 * but `passenger` and `litespeed`, whose worker processes are too few to hold a connection each (§10.8, C6).
 */
export function sseEnabled(setting: boolean | null, runtime: Runtime): boolean {
  if (setting !== null) return setting;
  return runtime !== 'passenger' && runtime !== 'litespeed';
}

/** The open SSE streams of this process. */
export interface StreamCounter {
  /** Takes a slot: false when all of them are taken (the route then answers 204). */
  tryAcquire(): boolean;
  /** Gives back a slot taken by `tryAcquire` (once per slot; never below zero). */
  release(): void;
  /** The slots taken. */
  count(): number;
}

/**
 * A counter of at most `max` open streams (default {@link SSE_MAX_STREAMS}); one per app (`services.streams`).
 *
 * @throws TypeError for a `max` that is not a positive integer
 */
export function createStreamCounter(max = SSE_MAX_STREAMS): StreamCounter {
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('createStreamCounter: max must be a positive integer');
  let open = 0;
  return {
    tryAcquire() {
      if (open >= max) return false;
      open += 1;
      return true;
    },
    release() {
      if (open > 0) open -= 1;
    },
    count() {
      return open;
    },
  };
}
