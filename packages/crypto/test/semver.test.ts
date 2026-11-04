import { describe, expect, it } from 'vitest';
import { compareSemverText, isSemverText } from '../src/semver.js';

// crypto's own SemVer (preflight B2: @altis/crypto never imports @altis/shared). compareSemverText follows SemVer 2.0.0
// rule 11, exactly as @altis/shared's compareSemver.

describe('isSemverText', () => {
  it('accepts SemVer 2.0.0 and refuses the rest', () => {
    for (const v of ['0.1.0', '1.2.3-test', '0.2.0-test.1+build.5', '10.20.30']) expect(isSemverText(v)).toBe(true);
    for (const v of ['v1.0.0', '1.0', '01.0.0', '1.0.0-', '1.0.0-01', '', null, 1]) expect(isSemverText(v)).toBe(false);
  });
});

describe('compareSemverText', () => {
  it('orders numbers numerically, not as text', () => {
    expect(compareSemverText('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemverText('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemverText('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareSemverText('1.0.10', '1.0.9')).toBeGreaterThan(0);
  });

  it('ranks a pre-release below its release', () => {
    expect(compareSemverText('0.2.0-test', '0.2.0')).toBeLessThan(0);
    expect(compareSemverText('0.2.0', '0.2.0-test')).toBeGreaterThan(0);
    expect(compareSemverText('0.2.0-test', '0.1.9')).toBeGreaterThan(0);
  });

  it('equal versions compare 0, build metadata ignored', () => {
    expect(compareSemverText('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemverText('0.2.0-test', '0.2.0-test')).toBe(0);
    expect(compareSemverText('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('orders pre-release identifiers by rule 11 (the semver.org example chain)', () => {
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(Math.sign(compareSemverText(chain[i] as string, chain[j] as string)), `${chain[i]} vs ${chain[j]}`).toBe(Math.sign(i - j));
      }
    }
  });

  it('compares numbers beyond 2^53 exactly', () => {
    expect(compareSemverText('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(0);
    expect(compareSemverText('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBeGreaterThan(0);
  });

  it('refuses a text that is not SemVer with a TypeError', () => {
    expect(() => compareSemverText('v1.0.0', '1.0.0')).toThrow(TypeError);
    expect(() => compareSemverText('1.0.0', '1.0')).toThrow(TypeError);
  });
});
