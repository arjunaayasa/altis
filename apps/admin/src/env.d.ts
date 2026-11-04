/**
 * The release version the SPA was built as (Vite `define` from ALTIS_BUILD, `'dev'` without one; Vitest defines it as
 * `'0.1.0'`). The server answers every API request with its own version in `X-Altis-Build` (spec §4.8).
 * `__BUILD_PROFILE__` (globals.d.ts) comes from ALTIS_BUILD_PROFILE the same way.
 */
declare const __ALTIS_BUILD__: string;
