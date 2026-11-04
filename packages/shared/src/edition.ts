// The edition this build is (the community edition, AGPL-3.0-only) and where its source lives (AGPL §13: the admin
// Tentang page and the OPAC footer link to it). A commercial edition is a private fork that changes these values.

export const EDITION_COMMUNITY = 'community';
export const COMMUNITY_SOURCE_URL = 'https://github.com/arjunaayasa/altis';
export const COMMUNITY_LICENSE_SPDX = 'AGPL-3.0-only';
/** What the dashboard and Diagnostik show of the edition. Community: { edition: 'community', status: 'active' }. */
export interface EditionView {
  readonly edition: string;
  readonly status: string;
}
