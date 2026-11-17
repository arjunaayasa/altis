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

/**
 * The member import's file formats: the ALTIS CSV layout (a header row naming the columns, in any order) and the
 * member export of a SLiMS library (its 18 columns in their fixed order, with or without their names in the first row).
 */
export const MEMBER_IMPORT_FORMATS = Object.freeze(['csv-members', 'slims-members'] as const);

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

// ---- holds (Komunitas holds) -----------------------------------------------------------------------------------------

/**
 * `holds.status`: `waiting` in the queue, `ready` (a copy is kept on the hold shelf until `pickup_until`), then one of
 * `fulfilled` (the member borrowed a copy of the title), `cancelled` or `expired`.
 */
export const HOLD_STATUSES = Object.freeze(['waiting', 'ready', 'fulfilled', 'cancelled', 'expired'] as const);

export type HoldStatus = (typeof HOLD_STATUSES)[number];

/** The statuses of an active hold (one per member per title). */
export const ACTIVE_HOLD_STATUSES = Object.freeze(['waiting', 'ready'] as const);

/** `holds.close_reason`: why a hold was closed. */
export const HOLD_CLOSE_REASONS = Object.freeze([
  'loaned',
  'cancelled_member',
  'cancelled_staff',
  'expired_pickup',
  'expired_wait',
  'item_unavailable',
  'member_archived',
  'migrated',
] as const);

export type HoldCloseReason = (typeof HOLD_CLOSE_REASONS)[number];

/** `holds.source`: placed at the desk, by the member on the OPAC, or migrated. */
export const HOLD_SOURCES = Object.freeze(['desk', 'opac', 'migrated'] as const);

export type HoldSource = (typeof HOLD_SOURCES)[number];

/**
 * `CIRC_HOLD_REFUSED.meta.reason`, in the order a new hold is checked: holds are switched off (`disabled`), the member
 * is not active or has expired (`member`), the member type may not hold (`not_allowed`), the member holds as many as
 * allowed (`limit`), already holds this title (`duplicate`), has a copy of it on loan (`own_loan`), the title has no
 * copy that may be lent at the pickup branch (`no_copies`), or a copy is on the shelf now (`available`). `closed`: the
 * hold is no longer active (cancel, mark ready); `not_on_shelf`: the hold has no copy waiting to go back to the shelf.
 */
export const HOLD_REFUSALS = Object.freeze([
  'disabled',
  'member',
  'not_allowed',
  'limit',
  'duplicate',
  'own_loan',
  'no_copies',
  'available',
  'closed',
  'not_on_shelf',
] as const);

export type HoldRefusal = (typeof HOLD_REFUSALS)[number];
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

// ---- Komunitas (charges and payments) --------------------------------------------------------------------------------

/**
 * `charges.kind`: an overdue fine, a lost item's replacement (or its processing fee), damage, a member card, any other
 * charge the desk books by hand, or one carried over by a migration.
 */
export const CHARGE_KINDS = Object.freeze(['overdue', 'lost', 'damage', 'card', 'manual', 'migrated'] as const);

export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** The kinds the desk books by hand (the others are booked by the system or a migration). */
export const MANUAL_CHARGE_KINDS = Object.freeze(['damage', 'card', 'manual'] as const);

export type ManualChargeKind = (typeof MANUAL_CHARGE_KINDS)[number];

/** `charges.status`: something is left to pay (`open`), nothing is (`settled`), or the whole charge was cancelled. */
export const CHARGE_STATUSES = Object.freeze(['open', 'settled', 'cancelled'] as const);

export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** `charges.source`: booked at the desk, by the system (fines and lost items), or by a migration. */
export const CHARGE_SOURCES = Object.freeze(['desk', 'system', 'migrated'] as const);

export type ChargeSource = (typeof CHARGE_SOURCES)[number];

/** `charge_adjustments.kind`: a waive by staff, or a cancellation (a lost item that came back). */
export const CHARGE_ADJUSTMENT_KINDS = Object.freeze(['waive', 'cancel'] as const);

export type ChargeAdjustmentKind = (typeof CHARGE_ADJUSTMENT_KINDS)[number];

/** `payments.method`. */
export const PAYMENT_METHODS = Object.freeze(['cash', 'transfer', 'other'] as const);

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * `CIRC_MEMBER_BLOCKED.meta.reason`: the unpaid balance is above the library's limit (`unpaid`, blocks loans and
 * renewals), or the member has an overdue loan (`overdue`, blocks loans). Both blocks are off unless switched on.
 */
export const MEMBER_BLOCK_REASONS = Object.freeze(['unpaid', 'overdue'] as const);

export type MemberBlockReason = (typeof MEMBER_BLOCK_REASONS)[number];

/** `CIRC_CHARGE_STATE.meta.status`: the charge is no longer open, or the payment was voided already. */
export const CHARGE_STATE_REFUSALS = Object.freeze(['settled', 'cancelled', 'voided'] as const);

export type ChargeStateRefusal = (typeof CHARGE_STATE_REFUSALS)[number];

// ---- Komunitas (notices) ----

/** `notices.kind`: the e-mails the library sends members (one per member, kind and day). */
export const NOTICE_KINDS = Object.freeze(['due_soon', 'overdue', 'hold_ready'] as const);

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The kinds staff may send by hand (from the desk or the overdue list). */
export const MANUAL_NOTICE_KINDS = Object.freeze(['overdue', 'due_soon'] as const);

export type ManualNoticeKind = (typeof MANUAL_NOTICE_KINDS)[number];

/** `notices.status`: waiting, claimed by a sender, sent, failed (tried again while attempts allow), or not sent. */
export const NOTICE_STATUSES = Object.freeze(['queued', 'sending', 'sent', 'failed', 'skipped'] as const);

export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

/**
 * `notices.reason`: why a notice was skipped (no address, no SMTP server saved, the member archived or anonymised, the
 * library switched the kind off, nothing left to tell: the loans were returned or the hold is no longer ready) or why
 * its last attempt failed (the SMTP stage, or `error` for anything else).
 */
export const NOTICE_REASONS = Object.freeze([
  'no_email',
  'smtp_not_configured',
  'member_inactive',
  'setting_off',
  'resolved',
  'smtp_connect',
  'smtp_tls',
  'smtp_auth',
  'smtp_send',
  'error',
] as const);

export type NoticeReason = (typeof NOTICE_REASONS)[number];

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
  // ---- Komunitas (holds) ----
  hold_status: HOLD_STATUSES,
  hold_close_reason: HOLD_CLOSE_REASONS,
  hold_source: HOLD_SOURCES,
  hold_refusal: HOLD_REFUSALS,
  // ---- Komunitas (circulation core) ----
  override_reason: OVERRIDE_REASONS,
  calendar_kind: CALENDAR_KINDS,
  void_refusal: VOID_REFUSALS,
  clearance_purpose: CLEARANCE_PURPOSES,
  clearance_refusal: CLEARANCE_REFUSALS,
  policy_rank_reason: POLICY_RANK_REASONS,
  // ---- Komunitas (charges and payments) ----
  charge_kind: CHARGE_KINDS,
  charge_status: CHARGE_STATUSES,
  charge_adjustment_kind: CHARGE_ADJUSTMENT_KINDS,
  payment_method: PAYMENT_METHODS,
  member_block_reason: MEMBER_BLOCK_REASONS,
  charge_state_refusal: CHARGE_STATE_REFUSALS,
  // ---- Komunitas (notices) ----
  notice_kind: NOTICE_KINDS,
  notice_status: NOTICE_STATUSES,
  notice_reason: NOTICE_REASONS,
});
