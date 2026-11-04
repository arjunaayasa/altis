// Values the release build (tools/release, Task 17) substitutes with esbuild `define` when it bundles server.mjs. Not
// defined under Vitest or in a bundle made by other tooling: read them only behind `typeof … !== 'undefined'`.

/**
 * The root keys embedded in app.js (spec §8.3, ruling R65), embedded in server.mjs as well (ruling R62) so that
 * `doctor` can verify the release on its own, as app.js does: from these roots and the root-signed keyset documents
 * of DATA_DIR/releases/keyset.json and of the release itself.
 */
declare const __TRUSTED_KEYS__: import('@altis/crypto').TrustedKey[];

/**
 * The update feed base the release build embedded (`--feed-url` / `ALTIS_RELEASE_FEED_URL`, required for a production
 * build; spec §9.6 "URL feed tertanam saat build"). `''` when the build had none (a test build): no feed. Overridden
 * by config.json's `update.feedUrl` and by `ALTIS_UPDATE_FEED_URL` (config.ts `feedBaseOf`, decision D1d-2).
 */
declare const __FEED_URL__: string;
