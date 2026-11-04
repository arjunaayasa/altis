// Phase 2 (catalog), Task 1: the catalog data primitives (decision P2-05). Records, items, imports, SRU copies and the
// SLiMS migration write through these: authority find-or-create, custom-field values, runs and their reports, the
// legacy map, defaults, location paths and URL attachments. Explicit names only (M14: no internal helper leaks).

export { CATALOG_KEY_MAX, agentNameKey, codeKey, publisherNameKey, subjectTermKey } from './keys.js';
export { CATALOG_AGENT_TYPES, CATALOG_SUBJECT_TYPES, resolveAgents, resolvePublisher, resolveSubjects } from './authorities.js';
export type { AgentRef, CatalogAgentType, CatalogSubjectType, PublisherRef, SubjectRef } from './authorities.js';
export { defaultCollectionTypeId, defaultMaterialTypeId } from './defaults.js';
export {
  CUSTOM_TEXT_MAX,
  CUSTOM_URL_MAX,
  CUSTOM_VALUE_MAX_BYTES,
  coerceCustomValues,
  customValuesSchema,
  loadCustomDefs,
  readCustomValues,
  writeCustomValues,
} from './custom-fields.js';
export type { CustomEntity, CustomFieldDef, CustomFieldType } from './custom-fields.js';
export {
  RUN_JSON_MAX_BYTES,
  RUN_REPORT_MAX_ROWS,
  RUN_WORK_KEEP_MS,
  attachRunJob,
  createRun,
  finishRun,
  getRun,
  protectedRunWorkIds,
  saveRunSummary,
  startRun,
  writeRunReport,
} from './runs.js';
export type { RunEnd, RunKind, RunRow } from './runs.js';
export { legacyTarget, lookupLegacy, mapLegacy } from './legacy-map.js';
export type { LegacyMapping } from './legacy-map.js';
export { locationPaths } from './locations.js';
export type { LocationPath } from './locations.js';
export { ATTACHMENT_URL_MAX, insertUrlAttachments } from './attachments.js';
