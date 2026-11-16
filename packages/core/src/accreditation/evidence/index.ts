// The evidence files (spec §10.6, §10.9): a period's indicator evidence and a register row's attachments, their
// checklist per indicator and the size of each component's files. The writers live in service.ts (the period's lock
// first for a period's evidence), the checklist and the indicator/item rules in checklist.ts.
export { archiveEvidence, createEvidence, listEvidence } from './service.js';
export type { EvidenceListQuery } from './service.js';
export {
  PREREQUISITES_CODE,
  PROFILE_CODE,
  PROFILE_PHOTO_SLOTS,
  emptyComponentBytes,
  evidenceChecklist,
  evidenceComponentOf,
  evidenceItemsOf,
} from './checklist.js';
export type { EvidenceChecklistItem } from './checklist.js';
// ---- the stocktake minutes as evidence ----
export { attachMinutesEvidence, listMinutesForEvidence, minutesLinkedAsEvidence, stocktakeBranchOf } from './minutes.js';
