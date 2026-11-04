import type { Env } from '@altis/platform';

// Where this installation's releases come from (spec §9.8; plan Task 24, moved here from Task 27 by preflight B6 and
// 1D-25, so that Tasks 27 and 28, which both read it, can run side by side).
//
// - `data` (the default): releases are installed into DATA_DIR/releases (one-click update, offline upload, adoption of
//   the bundled release).
// - `image` (`ALTIS_RELEASE_SOURCE=image`, a Docker image): §9.8 "tidak ada adopsi, update satu klik disembunyikan, dan
//   setiap image baru melewati baris ketiga": a new release only ever arrives as a new image, so nothing is installed
//   into DATA_DIR/releases, the update routes answer UPDATE_HIDDEN and Pembaruan shows the `docker compose pull` path.
//
// Any other value of the variable (unset, empty, a typo) is `data`: only the exact word switches the mode.

/** The variable that names the source of the releases. */
export const RELEASE_SOURCE_ENV = 'ALTIS_RELEASE_SOURCE';

/** `image` when `ALTIS_RELEASE_SOURCE=image` (exactly that word), else `data`. */
export function releaseSourceMode(env: Env): 'data' | 'image' {
  return env[RELEASE_SOURCE_ENV] === 'image' ? 'image' : 'data';
}
