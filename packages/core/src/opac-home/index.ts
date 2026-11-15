// The OPAC home page as the library's profile site: its content (one setting, edited on its own admin screen) and the
// popular titles (a small aggregate the reports housekeeping rebuilds from the loans).
export { OPAC_HOME_KEY, OPAC_HOME_PHOTO_CONTEXT, readOpacHome, saveOpacHome } from './content.js';
export type { OpacHomeState } from './content.js';
export {
  POPULAR_KEEP_PER_BRANCH,
  POPULAR_MIN_BORROWERS,
  POPULAR_WINDOW_DAYS,
  popularRecordIds,
  popularTitlesStep,
  refreshPopularTitles,
} from './popular.js';
