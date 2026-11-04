import type { Runtime } from './runtime.js';

export type PoolPurpose = 'server' | 'cli';

export interface ConnectionLimits {
  /** `max_user_connections` of the database account; 0 (or less) means no per-account limit. */
  maxUserConnections: number;
  /** `max_connections` of the database server. */
  maxConnections: number;
}

/**
 * Pool ceiling per process (spec P17, ruling R8): 1 for the CLI; 3 for `passenger` and `litespeed`, which
 * serve requests from many small worker processes; 8 for the runtimes that run a single server process
 * (`pm2`, `docker`, `service`, `standalone`).
 */
function defaultPoolSize(runtime: Runtime, purpose: PoolPurpose): number {
  if (purpose === 'cli') return 1;
  return runtime === 'passenger' || runtime === 'litespeed' ? 3 : 8;
}

/**
 * Database pool size for one process (P17).
 *
 * - `limit` is `max_user_connections` when it is greater than 0, otherwise `floor(max_connections * 0.9)`.
 * - The limit is split between processes: the divisor is 7 for `passenger` and `litespeed`, 2 for the rest.
 * - The result is `floor(limit / divisor)` clamped to `[1, default]`. Limits that cannot be read (NaN)
 *   give the smallest pool, 1.
 */
export function poolSize(runtime: Runtime, purpose: PoolPurpose, limits: ConnectionLimits): number {
  const limit =
    limits.maxUserConnections > 0
      ? limits.maxUserConnections
      : Math.floor((limits.maxConnections * 9) / 10); // 0.9 in integer arithmetic
  const divisor = runtime === 'passenger' || runtime === 'litespeed' ? 7 : 2;
  const share = Math.floor(limit / divisor);
  if (Number.isNaN(share)) return 1;
  return Math.min(Math.max(share, 1), defaultPoolSize(runtime, purpose));
}
