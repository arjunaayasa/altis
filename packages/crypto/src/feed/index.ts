/**
 * `@altis/crypto/feed`: the signed update feed and freshness formats, the calendar dates they carry and the
 * signed-document file reader.
 *
 * A subpath export that app.js never bundles (packages/bootloader/test/metafile.test.ts): app.js is frozen by contract
 * v1, these formats live in server.mjs and the tools. Pure code (node:crypto), no workspace dependency; errors are
 * `Error('<CODE>:<reason>')`, the crypto package's style, which core maps to DomainError.
 */
export {
  FEED_TYP,
  FRESHNESS_MAX_MS,
  FRESHNESS_TYP,
  entryMatchesManifest,
  floorHolds,
  parseFeedPayload,
  parseFreshnessPayload,
  verifyFeed,
} from './feed.js';
export type { FeedChannel, FeedEntry, FeedPayload, FreshnessPayload, VerifiedFeed, VerifyFeedOptions } from './feed.js';
export { isCalendarDate, jakartaDate } from './dates.js';
export { SIGNED_DOC_MAX_BYTES, parseSignedDocFile } from './signed-doc.js';
export type { SignedDoc } from './signed-doc.js';
