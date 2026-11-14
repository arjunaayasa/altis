// Members beyond the record itself: restore and the bulk actions, the photo, member cards, the personal-data export and
// anonymisation (by staff and by the daily job), and the registries other modules add their member rows to.
export { bulkMembers, memberInUse, restoreMember } from './bulk.js';
export { MEMBER_PHOTO_CONTEXT, MEMBER_PHOTO_OWNER, claimSettingsFiles, setMemberPhoto } from './photo.js';
export { buildMemberCardsPdf, cardBarcodeModules, cardMembers, storedPicture } from './cards.js';
export type { CardMember, CardSheetInput } from './cards.js';
export { ANONYMIZED_NAME, anonymizeMember, anonymizedMemberNo, exportMemberData } from './privacy.js';
export { ANONYMIZE_BATCH, privacyAnonymizeJob, privacyAnonymizePayload, registerHistoryAnonymizeStep, yearsBefore } from './anonymize-job.js';
export type { HistoryAnonymizeStep, PrivacyAnonymizePayload, PrivacyJobDeps } from './anonymize-job.js';
export {
  memberBalanceMinor,
  memberDataSections,
  memberErasureSteps,
  registerMemberBalanceProvider,
  registerMemberDataSection,
  registerMemberErasureStep,
} from './hooks.js';
export type { MemberBalanceProvider, MemberDataSection, MemberErasureStep } from './hooks.js';
