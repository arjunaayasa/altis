import type { NoteRef } from '@altis/shared/api/accreditation';
import { ALWAYS_NOTES } from '../instruments/shared.js';
import type { AccredNoteKey } from '../notes.js';
import type { AccredIndicator, AccredMetricValue, Letter } from '../types.js';
import { evaluateRange, matchingAnswers, pickTier } from './bands.js';
import { elementLabels, elementsOf, mandatoryNote, missingMandatory } from './mandatory.js';
import { evaluateRule } from './rules.js';

// A value's suggested answer. No value, a value without data (`null`) or one marked not to suggest (`suggest: false`)
// gives none; an indicator answered by hand never gets one. Otherwise the bands (of the tier the size value picks, for a
// sized band) or the rule decide, and then the required elements: one missing makes the answer d.
//
// The notes returned are the scoring notes: the ones an indicator prints whatever its value, the overlap of two bands,
// the tier of a sized band, the rule's own and the missing required elements. The provider's notes stay on the value;
// a scoring note whose key the value already carries is left out.

/** The size from which the first tier of a sized band no longer stands in for a smaller collection. */
const SIZED_START_FLOOR = 1000;

/** The words of the units of the collection used, in the language of the documents. */
const USED_UNIT_WORDS: Readonly<Record<string, string>> = Object.freeze({ titles: 'judul', items: 'eksemplar' });

/** Notes gathered once each by key, never one the value already carries. */
class ScoringNotes {
  private readonly taken: Set<string>;
  readonly list: NoteRef[] = [];

  constructor(valueNotes: readonly NoteRef[]) {
    this.taken = new Set(valueNotes.map((n) => n.key));
  }

  add(n: NoteRef): void {
    if (this.taken.has(n.key)) return;
    this.taken.add(n.key);
    this.list.push(n);
  }
}

const listed = (ind: AccredIndicator, key: AccredNoteKey): boolean => ind.noteKeys?.includes(key) === true;

/** The note `key` that `ind` prints whatever its value, with its parameters, or null while they are not known. */
function alwaysNote(ind: AccredIndicator, key: AccredNoteKey, v: AccredMetricValue | null): NoteRef | null {
  const facts = v?.facts ?? {};
  switch (key) {
    case 'accred.note.fiction_rule': {
      const rule = facts['rule'];
      return typeof rule === 'string' ? { key, params: { rule } } : null;
    }
    case 'accred.note.usage_unit': {
      const unit = facts['unit'];
      return typeof unit === 'string' ? { key, params: { unit: USED_UNIT_WORDS[unit] ?? unit } } : null;
    }
    case 'accred.note.l6_kinds': {
      const kinds = ind.metricParams?.['countedKinds'];
      return Array.isArray(kinds) ? { key, params: { kinds: elementLabels(ind, kinds as string[]) } } : null;
    }
    case 'accred.note.l12_features': {
      if (!Array.isArray(facts['elements'])) return null;
      const found = elementsOf(v);
      return { key, params: { features: found.length === 0 ? '—' : elementLabels(ind, found) } };
    }
    default:
      return { key };
  }
}

/** Whether `v` can give a suggestion. */
const usable = (v: AccredMetricValue | null): v is AccredMetricValue & { value: number } => v !== null && v.value !== null && v.suggest !== false;

/** The answer a value suggests for `ind` (with its size value for a sized band), and the scoring notes. */
export function suggestAnswer(
  ind: AccredIndicator,
  v: AccredMetricValue | null,
  size: AccredMetricValue | null,
): { suggestion: Letter | null; notes: NoteRef[] } {
  const notes = new ScoringNotes(v?.notes ?? []);
  for (const key of ALWAYS_NOTES[ind.code] ?? []) {
    if (!listed(ind, key)) continue;
    const n = alwaysNote(ind, key, v);
    if (n !== null) notes.add(n);
  }

  let suggestion: Letter | null = null;
  const band = ind.band;
  switch (band.kind) {
    case 'manual':
      // The floor area is shown beside the building item, which is answered by hand.
      if (v !== null && v.value !== null && listed(ind, 'accred.note.sp1_floor')) notes.add({ key: 'accred.note.sp1_floor', params: { m2: v.value } });
      return { suggestion: null, notes: notes.list };
    case 'sized_range': {
      const s = size?.value ?? null;
      if (s !== null) notes.add({ key: 'accred.note.k6_tier', params: { count: s } });
      if (s === null || s <= 0) {
        notes.add({ key: 'accred.note.k6_no_start' });
        break;
      }
      if (s < SIZED_START_FLOOR) notes.add({ key: 'accred.note.k6_start_below_1000' });
      if (usable(v)) suggestion = evaluateRange(pickTier(band.tiers, s).bands, v.value);
      break;
    }
    case 'range':
      if (!usable(v)) break;
      suggestion = evaluateRange(band.bands, v.value);
      // The decree's bands overlap at this value; the first is suggested and the overlap noted.
      if (matchingAnswers(band.bands, v.value).filter((a) => a !== 'd').length > 1 && listed(ind, 'accred.note.k2_overlap')) {
        notes.add({ key: 'accred.note.k2_overlap' });
      }
      break;
    case 'rule': {
      if (!usable(v)) break;
      const r = evaluateRule(band.rule, v.facts ?? {});
      for (const n of r.notes) notes.add(n);
      suggestion = r.suggestion;
      break;
    }
  }

  if (suggestion !== null && v !== null) {
    const missing = missingMandatory(ind, v);
    if (missing.length > 0) {
      suggestion = 'd';
      notes.add(mandatoryNote(ind, missing));
    }
  }
  return { suggestion, notes: notes.list };
}
