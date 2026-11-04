import { describe, expect, it } from 'vitest';
import { poolSize } from '../src/pool.js';
import type { Runtime } from '../src/runtime.js';

type Row = [runtime: Runtime, purpose: 'server' | 'cli', maxUserConnections: number, maxConnections: number, result: number];

describe('poolSize', () => {
  const table: Row[] = [
    // The brief's table
    ['passenger', 'server', 10, 151, 1],
    ['passenger', 'server', 0, 151, 3],
    ['pm2', 'server', 0, 151, 8],
    ['pm2', 'server', 4, 151, 2],
    ['standalone', 'cli', 0, 151, 1],
    ['docker', 'server', 1, 151, 1],

    // limit = max_user_connections when > 0, otherwise floor(max_connections * 0.9)
    ['pm2', 'server', 16, 151, 8],
    ['pm2', 'server', 15, 151, 7], // floor(15 / 2)
    ['pm2', 'server', 100, 20, 8], // max_user_connections wins over a smaller max_connections
    ['pm2', 'server', 0, 20, 8], // floor(20 * 0.9) = 18 -> 9 -> clamped to 8
    ['pm2', 'server', 0, 10, 4], // floor(10 * 0.9) = 9 -> 4
    ['pm2', 'server', 0, 8, 3], // floor(7.2) = 7 -> 3
    ['pm2', 'server', 0, 1, 1], // floor(0.9) = 0 -> clamped up to 1
    ['pm2', 'server', 0, 0, 1],

    // divisor 7 for passenger and litespeed, 2 for the rest
    ['passenger', 'server', 7, 151, 1],
    ['passenger', 'server', 14, 151, 2],
    ['passenger', 'server', 21, 151, 3],
    ['passenger', 'server', 22, 151, 3],
    ['passenger', 'server', 200, 151, 3], // clamped to the Passenger default
    ['litespeed', 'server', 14, 151, 2],
    ['litespeed', 'server', 21, 151, 3],
    ['litespeed', 'server', 49, 151, 3], // clamped to the Passenger/LiteSpeed default (R8)
    ['litespeed', 'server', 56, 151, 3],
    ['litespeed', 'server', 0, 151, 3],
    ['service', 'server', 6, 151, 3],
    ['service', 'server', 0, 151, 8],
    ['docker', 'server', 0, 151, 8],
    ['standalone', 'server', 0, 151, 8],
    ['standalone', 'server', 2, 151, 1],
    ['standalone', 'server', 3, 151, 1],
    ['standalone', 'server', 4, 151, 2],

    // the CLI never uses more than one connection
    ['standalone', 'cli', 100, 151, 1],
    ['passenger', 'cli', 0, 151, 1],
    ['passenger', 'cli', 100, 151, 1],
    ['litespeed', 'cli', 0, 151, 1],
    ['pm2', 'cli', 0, 151, 1],
    ['docker', 'cli', 1, 151, 1],
    ['service', 'cli', 0, 0, 1],
  ];

  it.each(table)('%s %s maxUserConnections=%i maxConnections=%i -> %i', (runtime, purpose, user, max, result) => {
    expect(poolSize(runtime, purpose, { maxUserConnections: user, maxConnections: max })).toBe(result);
  });

  // limit = floor(0.9 * max_connections), pool = clamp(floor(limit / 2), 1, 8). Worked by hand, so the
  // expectations do not share code with the implementation. 13 -> 11 -> 5 shows floor (rounding would give 6).
  it.each<[maxConnections: number, limit: number, pool: number]>([
    [0, 0, 1],
    [1, 0, 1],
    [2, 1, 1],
    [3, 2, 1],
    [4, 3, 1],
    [5, 4, 2],
    [6, 5, 2],
    [7, 6, 3],
    [8, 7, 3],
    [9, 8, 4],
    [10, 9, 4],
    [11, 9, 4],
    [12, 10, 5],
    [13, 11, 5],
    [14, 12, 6],
    [15, 13, 6],
    [16, 14, 7],
    [17, 15, 7],
    [18, 16, 8],
    [19, 17, 8],
    [20, 18, 8], // 9 would exceed the default of 8
    [151, 135, 8],
    [1000, 900, 8],
  ])('max_connections=%i -> limit %i -> pm2 pool %i', (maxConnections, _limit, pool) => {
    expect(poolSize('pm2', 'server', { maxUserConnections: 0, maxConnections })).toBe(pool);
  });

  it('stays within [1, default] for every runtime and purpose', () => {
    const runtimes: Runtime[] = ['passenger', 'litespeed', 'pm2', 'docker', 'service', 'standalone'];
    for (const runtime of runtimes) {
      for (const purpose of ['server', 'cli'] as const) {
        for (const user of [0, 1, 2, 5, 7, 14, 50, 500]) {
          for (const max of [0, 1, 10, 100, 151, 1000]) {
            const n = poolSize(runtime, purpose, { maxUserConnections: user, maxConnections: max });
            const ceiling = purpose === 'cli' ? 1 : runtime === 'passenger' || runtime === 'litespeed' ? 3 : 8;
            expect(n).toBeGreaterThanOrEqual(1);
            expect(n).toBeLessThanOrEqual(ceiling);
            expect(Number.isInteger(n)).toBe(true);
          }
        }
      }
    }
  });

  it('falls back to one connection when the server limits are unknown or nonsensical', () => {
    expect(poolSize('pm2', 'server', { maxUserConnections: 0, maxConnections: Number.NaN })).toBe(1);
    expect(poolSize('pm2', 'server', { maxUserConnections: Number.NaN, maxConnections: Number.NaN })).toBe(1);
    expect(poolSize('pm2', 'server', { maxUserConnections: 0, maxConnections: -5 })).toBe(1);
  });

  it('treats a non-positive max_user_connections as "no per-user limit"', () => {
    expect(poolSize('pm2', 'server', { maxUserConnections: -1, maxConnections: 151 })).toBe(8);
    expect(poolSize('passenger', 'server', { maxUserConnections: -1, maxConnections: 10 })).toBe(1); // floor(9 / 7)
  });
});
