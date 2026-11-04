export { canonicalize } from './jcs.js';
export { MAX_JSON_DEPTH, parseStrictJson } from './strict-json.js';
export {
  KEY_USES,
  decodeBase64Url,
  encodeBase64Url,
  generateKeyPair,
  importPublicKey,
  isKeyUse,
  isTrustedKey,
  rawPublicKey,
} from './keys.js';
export type { KeyUse, TrustedKey } from './keys.js';
export { SIG_ALG, TYP_USE, signDetached, useForTyp, verifyDetached } from './envelope.js';
export type { Envelope, SignOptions } from './envelope.js';
export {
  KEYSET_MAX_DOCS,
  KEYSET_MAX_DOC_BYTES,
  KEYSET_TYP,
  isKeyset,
  parseKeysetDocs,
  resolveKeysetSources,
  resolveTrustedKeys,
} from './keyset.js';
export type {
  Keyset,
  KeysetDoc,
  KeysetRejection,
  KeysetReport,
  KeysetSource,
  ResolveTrustedKeysOptions,
  ResolvedKeys,
  SourcedRejection,
} from './keyset.js';
export {
  KEYSET_FILE,
  KEYSET_MAX_FILE_BYTES,
  collectInstalledKeysets,
  isInvalidKeysetFile,
  readKeysetFile,
  readKeysetWithBak,
} from './keyset-file.js';
export type { CollectedKeysets, InstalledKeysetsOptions, KeysetSkip } from './keyset-file.js';
export {
  COMPLETE_FILE,
  MANIFEST_FILE,
  RELEASE_TYP,
  SIGNATURE_FILE,
  buildManifest,
  readReleaseKeyset,
  validateManifest,
  verifyRelease,
  verifyReleaseWithRoots,
} from './manifest.js';
export type {
  BuildManifestOptions,
  ReleaseFile,
  ReleaseManifest,
  VerifyReleaseOptions,
  VerifyReleaseWithRootsOptions,
  WatermarkRange,
} from './manifest.js';
// 1d (Task 3): crypto's own SemVer (preflight B2). The update feed formats are the subpath @altis/crypto/feed, never
// re-exported here: app.js bundles this root.
export { compareSemverText, isSemverText } from './semver.js';
