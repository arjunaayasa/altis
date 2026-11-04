import { describe, expect, it } from 'vitest';
import { classInRange, classNumberKey } from '../../src/catalog/lib/index.js';

// Spec §3.4 (shelf suggestion): class_from <= class of the call number <= class_to, compared over the normalised
// leading numeric part.

describe('classNumberKey', () => {
  it('takes the leading numeric part, after a non-numeric prefix', () => {
    expect(classNumberKey('899.221 TOE b')).toBe(899.221);
    expect(classNumberKey('R 808.3')).toBe(808.3);
    expect(classNumberKey('REF 004.6 ABC')).toBe(4.6);
    expect(classNumberKey('297.4')).toBe(297.4);
    expect(classNumberKey('808 ABC')).toBe(808);
    expect(classNumberKey('(899.221) TOE')).toBe(899.221);
  });

  it('is null when there is no number', () => {
    expect(classNumberKey('')).toBeNull();
    expect(classNumberKey('TOE b')).toBeNull();
    expect(classNumberKey('FIK')).toBeNull();
  });
});

describe('classInRange', () => {
  it('compares the class number with the range, bounds included', () => {
    expect(classInRange('808.3 ABC', '800', '809')).toBe(true);
    expect(classInRange('810', '800', '809')).toBe(false);
    expect(classInRange('800', '800', '809')).toBe(true);
    expect(classInRange('799.99 X', '800', '809')).toBe(false);
    expect(classInRange('R 808.3', '800', '809')).toBe(true);
  });

  it('includes everything under the upper bound at its own precision', () => {
    expect(classInRange('809.9 X', '800', '809')).toBe(true);
    expect(classInRange('808.37', '808.3', '808.3')).toBe(true);
    expect(classInRange('808.4', '808.3', '808.3')).toBe(false);
    expect(classInRange('808.29', '808.3', '808.3')).toBe(false);
  });

  it('compares decimals exactly, not as floating point', () => {
    expect(classInRange('0.3', '0.1', '0.3')).toBe(true);
    expect(classInRange('004.6', '004', '006')).toBe(true);
    expect(classInRange('899.221 TOE', '899.2', '899.3')).toBe(true);
    expect(classInRange('899.30001', '899.2', '899.3')).toBe(true);
    expect(classInRange('899.4', '899.2', '899.3')).toBe(false);
  });

  it('is false when the call number or a bound has no number', () => {
    expect(classInRange('FIK TOE', '800', '809')).toBe(false);
    expect(classInRange('808.3', '', '809')).toBe(false);
    expect(classInRange('808.3', '800', 'x')).toBe(false);
  });
});
