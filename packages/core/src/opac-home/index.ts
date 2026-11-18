// The OPAC home page as the library's profile site: its content (one setting, edited on its own admin screen), the
// popular titles and the loans per class (two small aggregates the reports housekeeping rebuilds from the loans).
export { OPAC_HOME_KEY, OPAC_HOME_PHOTO_CONTEXT, readOpacHome, saveOpacHome } from './content.js';
export type { OpacHomeState } from './content.js';
// ---- Site identity ----
export {
  SITE_IDENTITY_KEY,
  publicSiteIdentity,
  readSiteIdentity,
  resolveSiteIdentity,
  saveSiteIdentity,
  siteIconPng,
  siteIconUrls,
  siteIdentityUrls,
  siteName,
} from './site-identity.js';
export type { SiteIdentityState } from './site-identity.js';
export { SiteImageError, defaultSiteIcon, siteIconVariant } from '../files/site-images.js';
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
// ---- Komunitas (OPAC look): what a card says of a title's copies ----
export { addShelfCopy, copyShelfState, emptyShelfCounts, shelfCounts, shelfStatusOf, shelfStatuses } from './shelf-status.js';
export type { CopyShelfState, ShelfCounts, ShelfStatus } from './shelf-status.js';
