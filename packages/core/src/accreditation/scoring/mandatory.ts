import { t, type MessageKey } from '@altis/shared';
import type { NoteRef } from '@altis/shared/api/accreditation';
import type { AccredMetricId } from '../metric-ids.js';
import type { AccredIndicator, AccredMetricValue } from '../types.js';

// The required elements of an indicator: after the bands, an indicator whose metric value lacks one of its required
// element codes (in the value's `facts.elements`) answers d, and the note names the missing elements. The codes live in
// the namespace of the metric: the aspects of a document kind for the policy, the programme and the head's report,
// otherwise the document kinds and the profile's library number.

/** The label prefix of the aspect codes a metric counts; any other metric counts elements (`accred.element.<code>`). */
const ASPECT_LABELS: Partial<Record<AccredMetricId, string>> = {
  'registers.collection_policy_aspects': 'accred.aspect.collection_policy.',
  'registers.library_program_aspects': 'accred.aspect.library_program.',
  'registers.head_performance_aspects': 'accred.aspect.head_performance_report.',
};

/** The element codes `v` has, from its facts. */
export function elementsOf(v: AccredMetricValue | null): readonly string[] {
  const elements = v?.facts?.['elements'];
  return Array.isArray(elements) ? (elements as readonly string[]) : [];
}

/** The required codes of `ind` that `v` lacks, in the order the indicator lists them. */
export function missingMandatory(ind: AccredIndicator, v: AccredMetricValue | null): string[] {
  if (ind.mandatory === undefined) return [];
  const have = new Set(elementsOf(v));
  return ind.mandatory.filter((code) => !have.has(code));
}

/** The message key of the label of the element `code` that `ind` counts. */
export function elementLabelKey(ind: AccredIndicator, code: string): string {
  const prefix = (ind.metric === undefined ? undefined : ASPECT_LABELS[ind.metric]) ?? 'accred.element.';
  return `${prefix}${code}`;
}

/**
 * The labels of `codes` joined for a note, in Indonesian (the language of the accreditation documents, which print the
 * same notes).
 */
export function elementLabels(ind: AccredIndicator, codes: readonly string[]): string {
  return codes.map((code) => t('id', elementLabelKey(ind, code) as MessageKey)).join(', ');
}

/** The note for the missing required elements `missing` of `ind`. */
export function mandatoryNote(ind: AccredIndicator, missing: readonly string[]): NoteRef {
  return { key: 'accred.note.mandatory_missing', params: { items: elementLabels(ind, missing) } };
}
