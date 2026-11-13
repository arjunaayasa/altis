import type { MessageKey } from '@altis/shared';

// The notes an indicator or a standard may print beside its value: full sentences in the shared messages, each with
// its parameters (`NoteRef`). Some notes speak about the answer itself (they state, suggest or ask for one); the evidence
// file prints no answer at all, so those stay out of it, while the workspace and the simulation print every note.

/** Every note key of the indicators and the standards. */
export const ACCRED_NOTE_KEYS = Object.freeze([
  // ---- Komunitas K1 (indicator notes) ----
  'accred.note.truncated',
  'accred.note.mandatory_missing',
  'accred.note.register_empty',
  'accred.note.input_missing',
  'accred.note.population_missing',
  'accred.note.activity_multi',
  'accred.note.electronic_counted',
  'accred.note.replacement_records',
  'accred.note.fiction_rule',
  'accred.note.k2_overlap',
  'accred.note.items_without_received_date',
  'accred.note.undated_share_high',
  'accred.note.k6_tier',
  'accred.note.k6_start_below_1000',
  'accred.note.k6_no_start',
  'accred.note.k7_unprocessed',
  'accred.note.k7_almost',
  'accred.note.collection_empty',
  'accred.note.k7_threshold_lowered',
  'accred.note.l6_kinds',
  'accred.note.l6_manual',
  'accred.note.usage_no_data',
  'accred.note.usage_unit',
  'accred.note.school_months',
  'accred.note.school_months_prorated',
  'accred.note.member_unknown',
  'accred.note.visits_deduped',
  'accred.note.guests_excluded',
  'accred.note.staff_missing',
  'accred.note.head_missing',
  'accred.note.head_multiple',
  'accred.note.t1_equivalence',
  'accred.note.t4_scope',
  'accred.note.g2_distinct',
  'accred.note.budget_incomplete',
  'accred.note.g4_rule',
  'accred.note.g4_undated',
  'accred.note.l3_sd_option_d',
  'accred.note.l13_news',
  'accred.note.l11_unverified',
  'accred.note.l11_private',
  'accred.note.l11_localhost',
  'accred.note.base_url_unset',
  'accred.note.base_url_public_guess',
  'accred.note.l12_features',
  'accred.note.l12_not_public',
  'accred.note.l12_external',
  'accred.note.sp1_floor',
  'accred.note.sp3_mandatory_hint',
  // ---- Komunitas K1 (standard notes) ----
  'accred.note.snp_textbook_default',
  'accred.note.snp_serials_approx',
  'accred.note.snp_tier_outside',
  'accred.note.snp_start_below_1000',
  'accred.note.snp_no_previous',
  'accred.note.snp_not_available',
  'accred.note.snp_selected',
] as const satisfies readonly MessageKey[]);

export type AccredNoteKey = (typeof ACCRED_NOTE_KEYS)[number];

/** The notes that state, suggest or ask for an answer: never printed in the evidence file. */
const ANSWER_NOTES: ReadonlySet<AccredNoteKey> = new Set<AccredNoteKey>([
  'accred.note.mandatory_missing',
  'accred.note.register_empty',
  'accred.note.k2_overlap',
  'accred.note.undated_share_high',
  'accred.note.k7_unprocessed',
  'accred.note.l3_sd_option_d',
  'accred.note.l6_manual',
  'accred.note.l11_unverified',
  'accred.note.sp1_floor',
  'accred.note.sp3_mandatory_hint',
]);

/**
 * Whether a note is printed in the evidence file and on its indicator sheets: true for the data-quality notes (counts,
 * missing inputs, the rules used), false for the notes about the answer.
 */
export const ACCRED_NOTE_IN_DOSSIER: Readonly<Record<AccredNoteKey, boolean>> = Object.freeze(
  Object.fromEntries(ACCRED_NOTE_KEYS.map((key) => [key, !ANSWER_NOTES.has(key)])) as Record<AccredNoteKey, boolean>,
);
