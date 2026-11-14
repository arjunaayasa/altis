/**
 * The fixed vocabularies of members and desk circulation: member statuses and events, genders, the CSV member import's
 * modes and refusal reasons, loan states and outcomes, and the reasons a loan or a renewal is refused. Each list has a
 * shared label `vocab.<list>.<value>` in both languages: {@link CIRCULATION_VOCAB_LISTS} is joined into `VOCAB_LISTS`
 * (catalog-vocab.ts), so `i18n/id.ts` checks at compile time that none is missing.
 *
 * No Node built-ins here: the browser bundles this module.
 */

// ---- members ---------------------------------------------------------------------------------------------------------

/** What `members.status` stores: a member is active or suspended (a suspended member may not borrow or renew). */
export const MEMBER_STORED_STATUSES = Object.freeze(['active', 'suspended'] as const);

export type MemberStoredStatus = (typeof MEMBER_STORED_STATUSES)[number];

/**
 * The status a member is shown with, read from the row in this order: `anonymized` (anonymised_at set), `archived`
 * (archived_at set), `suspended` (status), `expired` (expires_on before today in the library's time zone), else `active`.
 */
export const MEMBER_STATUSES = Object.freeze(['active', 'expired', 'suspended', 'archived', 'anonymized'] as const);

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * The kinds of `member_events`. This milestone writes `created`, `updated`, `extended`, `suspended`, `reactivated`,
 * `archived` and `imported`; the others belong to later work (restore, OPAC password, photo, SLiMS migration, clearance
 * letters, anonymisation) and are listed so that their labels exist from the start.
 */
export const MEMBER_EVENT_TYPES = Object.freeze([
  'created',
  'updated',
  'extended',
  'suspended',
  'reactivated',
  'archived',
  'restored',
  'password',
  'photo',
  'imported',
  'migrated',
  'synced',
  'clearance',
  'anonymized',
] as const);

export type MemberEventType = (typeof MEMBER_EVENT_TYPES)[number];

/** `members.gender`; never filled in by default. */
export const GENDERS = Object.freeze(['female', 'male'] as const);

export type Gender = (typeof GENDERS)[number];

// ---- the CSV member import -------------------------------------------------------------------------------------------

/** The member import's file formats: the ALTIS CSV layout (a header row naming the columns, in any order). */
export const MEMBER_IMPORT_FORMATS = Object.freeze(['csv-members'] as const);

export type MemberImportFormat = (typeof MEMBER_IMPORT_FORMATS)[number];

/** `create_only` (default): a member number that exists is refused; `upsert`: it updates that member (empty cells keep the stored value). */
export const MEMBER_IMPORT_MODES = Object.freeze(['create_only', 'upsert'] as const);

export type MemberImportMode = (typeof MEMBER_IMPORT_MODES)[number];

/** Why one row of a member import was refused (the report names the row number, the member number and this code). */
export const MEMBER_IMPORT_REFUSALS = Object.freeze([
  'missing_member_no',
  'invalid_member_no',
  'missing_name',
  'missing_member_type',
  'unknown_member_type',
  'unknown_home_branch',
  'duplicate_in_file',
  'exists',
  'invalid_value',
] as const);

export type MemberImportRefusal = (typeof MEMBER_IMPORT_REFUSALS)[number];

/** A row that was imported with a value left out (an unreadable gender is stored empty, never guessed). */
export const MEMBER_IMPORT_WARNINGS = Object.freeze(['gender_unknown'] as const);

export type MemberImportWarning = (typeof MEMBER_IMPORT_WARNINGS)[number];

// ---- loans -----------------------------------------------------------------------------------------------------------

/** The filter of a loan list: open, closed, or open and past its due date in the time zone of the loan's branch. */
export const LOAN_STATES = Object.freeze(['open', 'closed', 'overdue'] as const);

export type LoanState = (typeof LOAN_STATES)[number];

/** `loans.outcome` of a closed loan: returned, declared lost, voided at the desk, or closed by a migration. */
export const LOAN_OUTCOMES = Object.freeze(['returned', 'lost', 'voided', 'closed_migration'] as const);

export type LoanOutcome = (typeof LOAN_OUTCOMES)[number];

/** `CIRC_NOT_LOANABLE.meta.reason`: the item's status, its collection type, or the loan rule forbids the loan. */
export const NOT_LOANABLE_REASONS = Object.freeze(['status', 'collection_type', 'policy'] as const);

export type NotLoanableReason = (typeof NOT_LOANABLE_REASONS)[number];

/** `CIRC_LIMIT_REACHED.meta.scope`: the member type's limit of open loans, or the loan rule's. */
export const LIMIT_SCOPES = Object.freeze(['member_type', 'policy'] as const);

export type LimitScope = (typeof LIMIT_SCOPES)[number];

/**
 * `CIRC_RENEW_REFUSED.meta.reason`, in the order the conditions are checked. This milestone checks `changed`,
 * `suspended`, `expired`, `same_day` and `limit`; `hold`, `blocked` and `not_online` come with holds, blocking and the
 * OPAC member area.
 */
export const RENEW_REFUSALS = Object.freeze(['changed', 'suspended', 'expired', 'same_day', 'limit', 'hold', 'blocked', 'not_online'] as const);

export type RenewRefusal = (typeof RENEW_REFUSALS)[number];

/** Warnings a loan, a renewal or a return answers with (the action itself succeeded). */
export const CIRCULATION_WARNINGS = Object.freeze([
  'member_expires_soon',
  'due_capped_by_expiry',
  'return_to_branch',
  // ---- Komunitas (circulation core) ----
  // The due date was moved past closed days of the library calendar; a due date set by hand falls on a closed day; an
  // item read in place is out on loan, or has a status that says it is not on the shelf.
  'due_moved_closed',
  'due_on_closed_day',
  'item_on_loan',
  'item_status',
] as const);

export type CirculationWarning = (typeof CIRCULATION_WARNINGS)[number];

// ---- Komunitas (circulation core) -------------------------------------------------------------------------------------

/**
 * Why a loan was made although a check refused it (`loans.overrides`, comma-separated): the member type's or the rule's
 * limit, a hold on the item for another member, an optional block of the member, a collection type that may not be
 * lent, a rule that forbids the loan; and `backdated`, a loan entered with an earlier day than today (not a check that
 * refused, recorded so that it shows).
 */
export const OVERRIDE_REASONS = Object.freeze(['limit', 'hold', 'blocked', 'collection_type', 'policy', 'backdated'] as const);

export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

/** The override reasons a desk may name when it forces a loan (`backdated` follows from the date itself). */
export const FORCEABLE_REASONS = Object.freeze(['limit', 'hold', 'blocked', 'collection_type', 'policy'] as const);

export type ForceableReason = (typeof FORCEABLE_REASONS)[number];

/** `calendars.kind`: a closed weekday, a closed date range, or a closed range of days every year (`MM-DD`). */
export const CALENDAR_KINDS = Object.freeze(['weekly', 'dates', 'yearly'] as const);

export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/** `CIRC_VOID_REFUSED.meta.reason`: past the void window, lent by another staff member, already renewed, or charged. */
export const VOID_REFUSALS = Object.freeze(['too_late', 'other_staff', 'renewed', 'charged'] as const);

export type VoidRefusal = (typeof VOID_REFUSALS)[number];

/** `member_clearances.purpose`: the reason a clearance letter is issued. */
export const CLEARANCE_PURPOSES = Object.freeze(['graduation', 'transfer', 'other'] as const);

export type ClearancePurpose = (typeof CLEARANCE_PURPOSES)[number];

/** Why a member gets no clearance letter: open loans, an unpaid balance, or a hold waiting on the hold shelf. */
export const CLEARANCE_REFUSALS = Object.freeze(['open_loans', 'balance', 'ready_hold'] as const);

export type ClearanceRefusal = (typeof CLEARANCE_REFUSALS)[number];

/**
 * Why a rule wins or loses for a combination of dimensions (the "which rule applies" tool): the only candidate, more
 * dimensions filled than the next, the same number but an earlier filled dimension; or, for the others, fewer
 * dimensions filled, or a later first filled dimension.
 */
export const POLICY_RANK_REASONS = Object.freeze(['only', 'more_specific', 'earlier_dimension', 'less_specific', 'later_dimension'] as const);

export type PolicyRankReason = (typeof POLICY_RANK_REASONS)[number];

// ---- labels ----------------------------------------------------------------------------------------------------------

/**
 * The lists with shared labels, by the `<list>` of their message keys `vocab.<list>.<value>`; spread into
 * `VOCAB_LISTS` after the accreditation lists.
 */
export const CIRCULATION_VOCAB_LISTS = Object.freeze({
  member_status: MEMBER_STATUSES,
  member_event: MEMBER_EVENT_TYPES,
  gender: GENDERS,
  member_import_mode: MEMBER_IMPORT_MODES,
  member_import_refusal: MEMBER_IMPORT_REFUSALS,
  member_import_warning: MEMBER_IMPORT_WARNINGS,
  loan_state: LOAN_STATES,
  loan_outcome: LOAN_OUTCOMES,
  not_loanable_reason: NOT_LOANABLE_REASONS,
  limit_scope: LIMIT_SCOPES,
  renew_refusal: RENEW_REFUSALS,
  circulation_warning: CIRCULATION_WARNINGS,
  // ---- Komunitas (circulation core) ----
  override_reason: OVERRIDE_REASONS,
  calendar_kind: CALENDAR_KINDS,
  void_refusal: VOID_REFUSALS,
  clearance_purpose: CLEARANCE_PURPOSES,
  clearance_refusal: CLEARANCE_REFUSALS,
  policy_rank_reason: POLICY_RANK_REASONS,
});
