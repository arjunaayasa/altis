// The OPAC home page as the library's profile site: its content (one setting, edited on its own admin screen), the
// popular titles and the loans per class (two small aggregates the reports housekeeping rebuilds from the loans).
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
export { CLASS_ACTIVITY_KEEP, CLASS_MIN_BORROWERS, classActivityStep, refreshClassActivity, topClasses } from './class-activity.js';
export type { ClassActivity } from './class-activity.js';
