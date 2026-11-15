/**
 * The fixed vocabularies of visits and of the member tools: where a visit was recorded, why the visitor came, the
 * bulk actions on members, the fields a member card may print and the reasons a member is left out of a bulk action
 * or an anonymisation. Each list has a shared label `vocab.<list>.<value>` in both languages:
 * {@link VISITS_VOCAB_LISTS} is joined into `VOCAB_LISTS` (catalog-vocab.ts), so `i18n/id.ts` checks at compile time
 * that none is missing.
 *
 * No Node built-ins here: the browser bundles this module.
 */

// ---- visits ----------------------------------------------------------------------------------------------------------

/**
 * Where a visit was recorded: a guestbook station, the circulation desk (the member's first desk action of the day at
 * that branch), the member's sign-in to the OPAC, a staff entry (a person or a whole class), or the SLiMS migration.
 */
export const VISIT_SOURCES = Object.freeze(['station', 'desk', 'online', 'manual', 'migrated'] as const);

export type VisitSource = (typeof VISIT_SOURCES)[number];

/** Why the visitor came (asked at the station only when the library turns it on). */
export const VISIT_PURPOSES = Object.freeze(['read', 'borrow', 'study', 'reference', 'ict', 'event', 'other'] as const);

export type VisitPurpose = (typeof VISIT_PURPOSES)[number];

/**
 * The population group a visit counts in: a member type's group, `guest` for a guest, `unknown` for a migrated visit
 * of a SLiMS member that no longer exists.
 */
export const VISIT_GROUP_EXTRA = Object.freeze(['guest', 'unknown'] as const);

// ---- member tools ----------------------------------------------------------------------------------------------------

/** The bulk actions of the member list. */
export const MEMBER_BULK_ACTIONS = Object.freeze(['set', 'promote', 'extend', 'archive', 'restore'] as const);

export type MemberBulkAction = (typeof MEMBER_BULK_ACTIONS)[number];

/**
 * Why one member of a bulk action was left as it was: gone (`not_found`), archived or anonymised (`not_live`), an
 * archive refused for open loans or a balance (`in_use`), a type that never expires and no days (`no_days`), a branch
 * or type that is not live (`invalid_target`), a suspension without a note (`note_required`), or a member that was
 * not archived for a restore (`not_archived`).
 */
export const MEMBER_BULK_REFUSALS = Object.freeze(['not_found', 'not_live', 'in_use', 'no_days', 'invalid_target', 'note_required', 'not_archived'] as const);

export type MemberBulkRefusal = (typeof MEMBER_BULK_REFUSALS)[number];

/** The fields the front of a member card may print, in the order chosen. */
export const CARD_FIELDS = Object.freeze(['memberNo', 'name', 'type', 'className', 'institution', 'identityNo', 'expiresOn'] as const);

export type CardField = (typeof CARD_FIELDS)[number];

/** The paper of a card sheet: ten ID-1 cards per page (2 × 5). */
export const CARD_SHEETS = Object.freeze(['A4', 'F4', 'Letter'] as const);

export type CardSheet = (typeof CARD_SHEETS)[number];

// ---- labels ----------------------------------------------------------------------------------------------------------

/**
 * The lists with shared labels, by the `<list>` of their message keys `vocab.<list>.<value>`; spread into
 * `VOCAB_LISTS` after the circulation lists.
 */
export const VISITS_VOCAB_LISTS = Object.freeze({
  visit_source: VISIT_SOURCES,
  visit_purpose: VISIT_PURPOSES,
  visit_group: VISIT_GROUP_EXTRA,
  member_bulk_action: MEMBER_BULK_ACTIONS,
  member_bulk_refusal: MEMBER_BULK_REFUSALS,
  card_field: CARD_FIELDS,
});
