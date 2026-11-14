export { newId, isUlid, ulidTime } from './ids.js';
export { DomainError, ERROR_CODES, isDomainError } from './errors.js';
export type { ErrorCode, DomainErrorOptions } from './errors.js';
export { compareSemver, isSemver } from './semver.js';
export { normalizeKey, IP_TRUST_VALUES } from './keys.js';
export type { IpTrust } from './keys.js';
export {
  PERMISSIONS,
  ADMIN_EXCLUDED,
  SUPER_ADMIN_ONLY_GRANTS,
  SYSTEM_ROLE_KEYS,
  permissionCatalog,
  isPermission,
  isSystemRoleKey,
  systemRolePermissions,
} from './permissions.js';
export type { Permission, PermissionScope, PermissionDef, SystemRoleKey } from './permissions.js';
export { AUDIT_ACTIONS, isAuditAction } from './audit-actions.js';
export type { AuditAction } from './audit-actions.js';
export {
  NEEDS_ATTENTION,
  OP_KINDS,
  OP_KIND_PERMISSION,
  OP_SCHEMA,
  OP_STATES,
  OP_TERMINAL_STATES,
  isOpState,
  isTerminal,
} from './ops.js';
export type { OpKind, OpState } from './ops.js';
export { FIXED_CHANNEL_NAMES, ID_CHANNEL_PREFIXES, parseChannel } from './channels.js';
export type { ChannelRule } from './channels.js';
export { DEFAULT_LOCALE, LOCALES, MESSAGES, isLocale, resolveLocale, t } from './i18n/index.js';
export type { Locale, MessageKey } from './i18n/index.js';
export { EDITION_COMMUNITY, COMMUNITY_SOURCE_URL, COMMUNITY_LICENSE_SPDX } from './edition.js';
export type { EditionView } from './edition.js';
// ---- Phase 2 (catalog): Task 4 ----
// The catalog vocabularies (no Zod: the API contracts are imported as `@altis/shared/api/catalog/<area>`).
export {
  ACQ_SOURCES,
  AGENT_TYPES,
  ATTACHMENT_ACCESS,
  ATTACHMENT_KINDS,
  ATTACHMENT_MEDIA,
  BODY_FORMATS,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  EXPORT_FORMATS,
  FACETS,
  FIELD_STATES,
  IDENTIFIER_TYPES,
  IMPORT_FORMATS,
  ITEM_EVENT_TYPES,
  ITEM_STATUSES,
  ITEM_TRANSITIONS,
  LOCATION_KINDS,
  PAGE_KINDS,
  PAGE_LOCALES,
  PAGE_STATUSES,
  RDA_CARRIER_CODES,
  RDA_CARRIER_TYPES,
  RDA_CONTENT_CODES,
  RDA_CONTENT_TYPES,
  RDA_MEDIA_CODES,
  RDA_MEDIA_TYPES,
  RECORD_FIELD_NAMES,
  RELATION_TYPES,
  RELATOR_ROLES,
  RUN_KINDS,
  RUN_STATUSES,
  SUBJECT_EXPORT_TAG,
  SUBJECT_TYPES,
  THESAURUS_RECIPROCAL,
  THESAURUS_RELS,
  VOCAB_LISTS,
  canTransition,
  vocabKey,
} from './catalog-vocab.js';
export type {
  AcqSource,
  AgentType,
  AttachmentAccess,
  AttachmentKind,
  AttachmentMedia,
  BodyFormat,
  CustomFieldEntity,
  CustomFieldType,
  ExportFormat,
  FacetName,
  FieldState,
  IdentifierType,
  ImportFormat,
  ItemEventType,
  ItemStatus,
  LocationKind,
  PageKind,
  PageLocale,
  PageStatus,
  RdaCarrierCode,
  RdaContentCode,
  RdaMediaCode,
  RdaTerm,
  RecordFieldName,
  RelationType,
  RelatorRole,
  RunKind,
  RunStatus,
  SubjectType,
  ThesaurusRel,
  VocabList,
  VocabMessageKey,
  VocabValue,
} from './catalog-vocab.js';
// ---- Komunitas K1 (reports and accreditation) ----
// The accreditation vocabularies, the calendar-date helpers and the DDC reader (no Zod: the API contracts are imported
// as `@altis/shared/api/<area>`).
export {
  ACCRED_GROUPS,
  ACCREDITATION_VOCAB_LISTS,
  ACTIVITY_KINDS,
  ANSWER_MODES,
  AUDIENCES,
  DOCUMENT_ASPECTS,
  DOCUMENT_KINDS,
  EDUCATION_LEVELS,
  EMPLOYMENTS,
  EVIDENCE_ENTITIES,
  EVIDENCE_KINDS,
  L12_FEATURES,
  LOCAL_WORKS,
  LOCAL_WORK_KINDS,
  PARTNERSHIP_KINDS,
  PERIOD_KINDS,
  PERIOD_STATUSES,
  REFERENCE_KINDS,
  REPORT_FORMATS,
  REPORT_RUN_STATUSES,
  SCHOOL_LEVELS,
  SCHOOL_STATUSES,
  SERVICE_CODES,
  STAFF_ROLES,
  USAGE_METRICS,
} from './accreditation-vocab.js';
export type {
  AccredGroup,
  ActivityKind,
  AnswerMode,
  Audience,
  DocumentKind,
  EducationLevel,
  Employment,
  EvidenceEntity,
  EvidenceKind,
  L12Feature,
  LocalWork,
  LocalWorkKind,
  PartnershipKind,
  PeriodKind,
  PeriodStatus,
  ReferenceKind,
  ReportFormat,
  ReportRunStatus,
  SchoolLevel,
  SchoolStatus,
  ServiceCode,
  StaffRole,
  UsageMetric,
} from './accreditation-vocab.js';
export { addDays, addMonths, diffDays, endOfMonth, isCalendarDate, isoWeekday, localDate, monthOf, monthsBetween } from './dates.js';
export { DDC_MAINS, compareDdcRowKeys, ddcClassOf, ddcDivisionKey, ddcRowKind, foldByDdc } from './ddc.js';
export type { DdcClass, DdcMain, DdcRowKey } from './ddc.js';
// ---- Komunitas K1 (contracts) ----
// The types of the report and accreditation contracts the domain code shares (types only: the Zod schemas are imported
// as `@altis/shared/api/reports` and `@altis/shared/api/accreditation`, so the root pulls no Zod in).
export type { AnswerLetter, NoteRef, PrerequisitesView, SnpOutcome } from './api/accreditation.js';
// ---- Komunitas (members and circulation) ----
// The member and circulation vocabularies (no Zod: the API contracts are imported as `@altis/shared/api/members` and
// `@altis/shared/api/circulation`).
export {
  CIRCULATION_VOCAB_LISTS,
  CIRCULATION_WARNINGS,
  GENDERS,
  LIMIT_SCOPES,
  LOAN_OUTCOMES,
  LOAN_STATES,
  MEMBER_EVENT_TYPES,
  MEMBER_IMPORT_FORMATS,
  MEMBER_IMPORT_MODES,
  MEMBER_IMPORT_REFUSALS,
  MEMBER_IMPORT_WARNINGS,
  MEMBER_STATUSES,
  MEMBER_STORED_STATUSES,
  NOT_LOANABLE_REASONS,
  RENEW_REFUSALS,
} from './circulation-vocab.js';
export type {
  CirculationWarning,
  Gender,
  LimitScope,
  LoanOutcome,
  LoanState,
  MemberEventType,
  MemberImportFormat,
  MemberImportMode,
  MemberImportRefusal,
  MemberImportWarning,
  MemberStatus,
  MemberStoredStatus,
  NotLoanableReason,
  RenewRefusal,
} from './circulation-vocab.js';
// ---- Komunitas (holds) ----
export { ACTIVE_HOLD_STATUSES, HOLD_CLOSE_REASONS, HOLD_REFUSALS, HOLD_SOURCES, HOLD_STATUSES } from './circulation-vocab.js';
export type { HoldCloseReason, HoldRefusal, HoldSource, HoldStatus } from './circulation-vocab.js';
// ---- Komunitas (circulation core) ----
export {
  CALENDAR_KINDS,
  CLEARANCE_PURPOSES,
  CLEARANCE_REFUSALS,
  FORCEABLE_REASONS,
  OVERRIDE_REASONS,
  POLICY_RANK_REASONS,
  VOID_REFUSALS,
} from './circulation-vocab.js';
export type { CalendarKind, ClearancePurpose, ClearanceRefusal, ForceableReason, OverrideReason, PolicyRankReason, VoidRefusal } from './circulation-vocab.js';
// ---- Komunitas K2 (members extended and visits) ----
export {
  CARD_FIELDS,
  CARD_SHEETS,
  MEMBER_BULK_ACTIONS,
  MEMBER_BULK_REFUSALS,
  VISIT_GROUP_EXTRA,
  VISIT_PURPOSES,
  VISIT_SOURCES,
} from './visits-vocab.js';
export type { CardField, CardSheet, MemberBulkAction, MemberBulkRefusal, VisitPurpose, VisitSource } from './visits-vocab.js';
export { QR_MAX_VERSION, qrMatrix } from './qr.js';
export type { QrMatrix } from './qr.js';
// ---- Komunitas (charges and payments) ----
export {
  CHARGE_ADJUSTMENT_KINDS,
  CHARGE_KINDS,
  CHARGE_SOURCES,
  CHARGE_STATE_REFUSALS,
  CHARGE_STATUSES,
  MANUAL_CHARGE_KINDS,
  MEMBER_BLOCK_REASONS,
  PAYMENT_METHODS,
} from './circulation-vocab.js';
export type {
  ChargeAdjustmentKind,
  ChargeKind,
  ChargeSource,
  ChargeStateRefusal,
  ChargeStatus,
  ManualChargeKind,
  MemberBlockReason,
  PaymentMethod,
} from './circulation-vocab.js';
export type { ReportCell, ReportColumnType, ReportColumnView, ReportParamKind, ReportParamSpec } from './api/reports.js';
