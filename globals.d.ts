/**
 * Build profile, substituted at build time (esbuild `define`) and at test time (Vitest `define`).
 *
 * Test-only hooks (ALTIS_TEST_FAULT, ALTIS_TEST_FAKE_NODE_VERSION, ...) must sit behind
 * `if (__BUILD_PROFILE__ !== 'production')` so that production builds eliminate them as dead code.
 */
declare const __BUILD_PROFILE__: 'test' | 'production';

/**
 * The release fixture level of a test build (decision D1d-26, spec §12.5), substituted by the release build (esbuild
 * `define`: 1 for `0.1.0-test`, 2 for `0.2.0-test`, 3 for `0.3.0-test`, 0 in production) and by Vitest (1).
 * `buildFixtureLevel()` (@altis/db) reads it only under `__BUILD_PROFILE__ === 'test'`, behind `typeof … !==
 * 'undefined'`: a bundle made by other tooling has no such define (level 1).
 */
declare const __TEST_FIXTURE__: 0 | 1 | 2 | 3;
