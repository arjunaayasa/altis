import { describe, expect, it } from 'vitest';
import { compareSemver, isSemver } from '../src/semver.js';

describe('compareSemver', () => {
  it('compares numerically, not lexically', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1);
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1);
    expect(compareSemver('1.0.10', '1.0.9')).toBe(1);
  });

  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3-rc.1', '1.2.3-rc.1')).toBe(0);
  });

  it('ranks a pre-release below its release', () => {
    expect(compareSemver('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-beta.2')).toBe(1);
  });

  it('follows the precedence chain from semver.org section 11', () => {
    const ascending = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '2.0.0',
      '2.1.0',
      '2.1.1',
    ];
    for (let i = 0; i < ascending.length; i++) {
      for (let j = 0; j < ascending.length; j++) {
        const expected = i === j ? 0 : i < j ? -1 : 1;
        expect(compareSemver(ascending[i]!, ascending[j]!), `${ascending[i]} vs ${ascending[j]}`).toBe(expected);
      }
    }
  });

  it('ignores build metadata', () => {
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareSemver('1.0.0+build.5', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-rc.1+x', '1.0.0-rc.1')).toBe(0);
  });

  it('compares numeric identifiers beyond 2^53 exactly', () => {
    expect(compareSemver('9007199254740993.0.0', '9007199254740992.0.0')).toBe(1);
    expect(compareSemver('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(1);
  });

  it('ranks numeric identifiers below alphanumeric ones', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-a')).toBe(-1);
    expect(compareSemver('1.0.0-a', '1.0.0-1')).toBe(1);
  });

  it('throws on a string that is not a semantic version', () => {
    expect(() => compareSemver('1.2', '1.2.3')).toThrow(TypeError);
    expect(() => compareSemver('1.2.3', 'latest')).toThrow(TypeError);
  });
});

describe('isSemver', () => {
  it.each([
    '0.0.0',
    '1.2.3',
    '10.20.30',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0-x-y-z.--',
    '1.0.0+20130313144700',
    '1.0.0-beta+exp.sha.5114f85',
    '1.0.0+21AF26D3----117B344092BD',
  ])('accepts %s', (v) => {
    expect(isSemver(v)).toBe(true);
  });

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3-alpha.',
    '1.2.3+',
    '1.2.3+a..b',
    '1.2.3-ünï',
    ' 1.2.3',
    '1.2.3 ',
    '1.2.3\n',
    '-1.2.3',
    '1.2.-3',
  ])('rejects %j', (v) => {
    expect(isSemver(v)).toBe(false);
  });
});
