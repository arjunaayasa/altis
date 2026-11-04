import { base32Decode, hotp } from '@altis/core';
import { describe, expect, it } from 'vitest';
import { Authenticator, type Clock } from '../lib/authenticator.js';

// RFC 6238 Appendix B: the SHA-1 seed "12345678901234567890" (ASCII) in base32. Its 8-digit TOTP at T = 59 s is
// 94287082, at T = 1111111109 s 07081804; six digits are the last six of those.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function fakeClock(startMs: number): Clock & { sleeps: number[] } {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const codeAt = (step: number): string => hotp(base32Decode(RFC_SECRET), step, 6);

describe('Authenticator (the authenticator app of the E2E users)', () => {
  it('gives the RFC 6238 code of the current step first', async () => {
    expect(await new Authenticator(RFC_SECRET, fakeClock(59_000)).nextCode()).toBe('287082');
    expect(await new Authenticator(RFC_SECRET, fakeClock(1_111_111_109_000)).nextCode()).toBe('081804');
  });

  it('never gives a step twice: the next code is the next step, which the server still accepts (±1 step)', async () => {
    const clock = fakeClock(59_000);
    const app = new Authenticator(RFC_SECRET, clock);
    expect(await app.nextCode()).toBe(codeAt(1));
    expect(await app.nextCode()).toBe(codeAt(2));
    expect(clock.sleeps).toEqual([]);
  });

  it('waits for the next step once the window ahead is used up (the server refuses a replayed step)', async () => {
    const clock = fakeClock(59_000);
    const app = new Authenticator(RFC_SECRET, clock);
    await app.nextCode(); // step 1
    await app.nextCode(); // step 2, one ahead
    expect(await app.nextCode()).toBe(codeAt(3));
    // It slept until step 2 had begun (60 000 ms), a little past it, and not a whole step longer.
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(clock.sleeps[0]).toBeLessThan(2500);
    expect(Math.floor(clock.now() / 30_000)).toBe(2);
  });

  it('takes the secret as the enrolment page shows it: groups of four, any case', async () => {
    const grouped = RFC_SECRET.toLowerCase().replace(/(.{4})(?=.)/g, '$1 ');
    expect(await new Authenticator(grouped, fakeClock(59_000)).nextCode()).toBe('287082');
  });

  it('refuses text that is not a base32 secret', () => {
    expect(() => new Authenticator('not a secret!', fakeClock(0))).toThrow(/base32/);
    expect(() => new Authenticator('   ', fakeClock(0))).toThrow(/empty/);
  });
});
