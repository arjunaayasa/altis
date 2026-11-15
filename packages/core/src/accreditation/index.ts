// The accreditation barrel (spec §10): the instruments as data, the metric catalogue and its providers, the windows,
// the notes, the periods and their lock, the registers and the evidence, the monthly usage, the evaluation with its
// freeze and snapshots, the SLiMS usage import and the documents. Each area's names come through here only, so no later
// change edits packages/core/src/index.ts; names carry an accreditation word where a generic one could meet another
// barrel's (packages/core/test/barrels.test.ts).
export type {
  AccredBand,
  AccredComponent,
  AccredEvidenceItem,
  AccredIndicator,
  AccredInstrument,
  AccredMetricContext,
  AccredMetricProvider,
  AccredMetricUnit,
  AccredMetricValue,
  AccredValueBasis,
  AccredWindow,
  Letter,
  ProviderResume,
  ProviderStep,
  RangeBand,
  SnpCheck,
  SnpRule,
  UsageSource,
} from './types.js';
export { ACCRED_VALUE_BASES, AccredMetaPayload, AccredResultPayload, AccredStoredValue } from './types.js';
export { ACCRED_METRICS, ACCRED_PROVIDER_IDS, metricsOfProvider } from './metric-ids.js';
export type { AccredMetricDef, AccredMetricId, AccredProviderId } from './metric-ids.js';
export { ACCRED_NOTE_IN_DOSSIER, ACCRED_NOTE_KEYS } from './notes.js';
export type { AccredNoteKey } from './notes.js';
export { budgetYears, resolveWindow, snapshotDate } from './windows.js';
export type { DateSpan, ResolvedWindow } from './windows.js';
export { ACCRED_INSTRUMENTS, instrumentById } from './instruments/index.js';
export { GENERAL_STATS_HEADER, SCH_SD_2025_HEADER, SCH_SMA_2025_HEADER, SCH_SMP_2025_HEADER } from './instruments/headers.js';
export type { AccredInstrumentHeader } from './instruments/headers.js';
export { evaluatePrerequisites, evaluateSnp, finalAnswers, scoreInstrument, suggestAnswer } from './scoring/index.js';
export { ACCRED_METRIC_PROVIDERS } from './providers/index.js';
export { USAGE_SOURCES } from './usage-sources.js';
export {
  archivePeriod,
  catalogSyncedAt,
  createPeriod,
  getPeriod,
  lastChangeOf,
  listInstruments,
  listPeriods,
  lockOpenPeriod,
  putAnswer,
  updatePeriod,
} from './periods/index.js';
export {
  archiveRegisterRow,
  archiveTraining,
  createRegisterRow,
  createTraining,
  listRegister,
  updateRegisterRow,
  updateTraining,
} from './registers/index.js';
export type { RegisterShapes } from './registers/index.js';
export { archiveEvidence, createEvidence, evidenceChecklist, listEvidence } from './evidence/index.js';
export type { EvidenceChecklistItem, EvidenceListQuery } from './evidence/index.js';
export { getUsageGrid, getUsageGroups, putUsageCells, putUsageGroups, resolveUsage } from './usage/index.js';
export type { ResolvedCell, ResolvedUsage } from './usage/index.js';
export {
  copySnapshotDossier,
  enqueueEvaluate,
  evaluateJob,
  evaluatePayload,
  freezePeriod,
  getResults,
  getSnapshot,
  listSnapshots,
  openSnapshotDossier,
  unfreezePeriod,
} from './evaluate/index.js';
export type { EvaluatePayload } from './evaluate/index.js';
export {
  SLIMS_USAGE_JOB,
  importSlimsUsageJob,
  importSlimsUsagePayload,
  releaseCancelledUsageImport,
  slimsUsageRunSettings,
  startSlimsUsageImport,
  testSlimsUsageConnection,
} from './slims-usage/index.js';
export type { ImportSlimsUsagePayload, SlimsUsageRunSettings } from './slims-usage/index.js';
export { startDocumentRun } from './documents/index.js';
export type { AccredDocumentId } from './documents/index.js';
// ---- the stocktake minutes as evidence ----
export { attachMinutesEvidence, listMinutesForEvidence, minutesLinkedAsEvidence, stocktakeBranchOf } from './evidence/index.js';
