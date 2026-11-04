import { describe, expect, it } from 'vitest';

describe('test runner, db project', () => {
  it('defines __BUILD_PROFILE__ as the test profile', () => {
    expect(__BUILD_PROFILE__).toBe('test');
  });
});
