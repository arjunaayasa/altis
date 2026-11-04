import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createJobRegistry } from '../src/jobs/registry.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  HEAVY_LOCK,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  SLICE_BUDGET_MS,
  retryDelayMs,
  type JobHandler,
} from '../src/jobs/types.js';

// The arithmetic of the job queue (spec §10.1, decision C4) and the handler registry.

describe('job queue constants', () => {
  it('are the values of spec §10.1 and the plan', () => {
    expect(JOB_LEASE_MS).toBe(50_000);
    expect(JOB_HEARTBEAT_MS).toBe(15_000);
    expect(SLICE_BUDGET_MS).toBe(20_000);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    expect(HEAVY_LOCK).toBe('jobs:heavy');
  });
});

describe('retryDelayMs', () => {
  it('is min(2^attempts × 10 s, 1 h)', () => {
    expect(retryDelayMs(0)).toBe(10_000);
    expect(retryDelayMs(1)).toBe(20_000);
    expect(retryDelayMs(8)).toBe(2_560_000);
    expect(retryDelayMs(9)).toBe(3_600_000);
    expect(retryDelayMs(30)).toBe(3_600_000);
    expect(retryDelayMs(5000)).toBe(3_600_000);
  });

  it('refuses a count that is not a non-negative integer', () => {
    expect(() => retryDelayMs(-1)).toThrow(RangeError);
    expect(() => retryDelayMs(1.5)).toThrow(RangeError);
    expect(() => retryDelayMs(Number.NaN)).toThrow(RangeError);
  });
});

const handler = (type: string, extra: Partial<JobHandler<{ n: number }>> = {}): JobHandler<{ n: number }> => ({
  type,
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: z.strictObject({ n: z.number() }),
  run: () => Promise.resolve({ done: true }),
  ...extra,
});

describe('createJobRegistry', () => {
  it('finds handlers by type and lists the types', () => {
    const a = handler('test.a');
    const b = handler('test.b', { cpuHeavy: true });
    const reg = createJobRegistry([a, b]);
    expect(reg.get('test.a')).toBe(a);
    expect(reg.get('test.b')).toBe(b);
    expect(reg.get('test.c')).toBeUndefined();
    expect(reg.get('__proto__')).toBeUndefined();
    expect(reg.types()).toEqual(['test.a', 'test.b']);
  });

  it('refuses a duplicate type', () => {
    expect(() => createJobRegistry([handler('test.a'), handler('test.a')])).toThrow(TypeError);
  });

  it('refuses a handler that is not well formed', () => {
    expect(() => createJobRegistry([handler('Bad Type')])).toThrow(TypeError);
    expect(() => createJobRegistry([handler('x'.repeat(65))])).toThrow(TypeError);
    expect(() => createJobRegistry([handler('test.a', { permission: 'no.such.permission' as never })])).toThrow(TypeError);
    expect(() => createJobRegistry([handler('test.a', { retryable: 'never' as never })])).toThrow(TypeError);
    expect(() => createJobRegistry([handler('test.a', { maxAttempts: 0 })])).toThrow(TypeError);
    expect(() => createJobRegistry([handler('test.a', { payload: {} as never })])).toThrow(TypeError);
    expect(() => createJobRegistry([handler('test.a', { run: undefined as never })])).toThrow(TypeError);
  });
});
