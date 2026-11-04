// Values that build.ts substitutes when it builds app.js (esbuild `define`). Not defined when a module of this
// package runs under Vitest: read them only behind `typeof … !== 'undefined'`.

/**
 * The trust anchors of app.js (spec §8.3, ruling R65): `root` public keys only (the dev root in test builds only).
 * Release keys are trusted only through root-signed keyset documents.
 */
declare const __TRUSTED_KEYS__: import('@altis/crypto').TrustedKey[];

/** The version of the release shipped next to app.js in `bundled-release/<version>`. */
declare const __BUNDLED_VERSION__: string;
