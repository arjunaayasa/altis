// Stub: replaced by a later change in this milestone.
// The scoring engine: a value's suggested answer, the final answers, the estimated score, the prerequisites and the
// school standards. The signatures are final; every body throws until the engine is written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { NoteRef, PrerequisitesView, ScoreView, SnpResultView } from '@altis/shared/api/accreditation';
import type { AccredIndicator, AccredInstrument, AccredMetricValue, Letter, SnpCheck } from '../types.js';

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** The answer a value suggests for `ind` (with its size value for a sized band), and the scoring notes. */
export function suggestAnswer(
  ind: AccredIndicator,
  v: AccredMetricValue | null,
  size: AccredMetricValue | null,
): { suggestion: Letter | null; notes: NoteRef[] } {
  return notImplemented();
}

/** Each indicator's final answer: a stored answer wins, else the suggestion, else none. */
export function finalAnswers(
  instr: AccredInstrument,
  suggestions: ReadonlyMap<string, Letter | null>,
  answers: ReadonlyMap<string, { answer: Letter | null; mode: 'manual' | 'override' }>,
): Map<string, Letter | null> {
  return notImplemented();
}

/** The estimated score of `instr` from the final answers. */
export function scoreInstrument(instr: AccredInstrument, finals: ReadonlyMap<string, Letter | null>, o: { prerequisitesMet: boolean }): ScoreView {
  return notImplemented();
}

/** The registration prerequisites at `D`. */
export function evaluatePrerequisites(v: {
  titles: AccredMetricValue;
  npp: AccredMetricValue;
  foundingDecree: AccredMetricValue;
  D: string;
}): PrerequisitesView {
  return notImplemented();
}

/** The outcome of one school standard. */
export function evaluateSnp(check: SnpCheck, v: AccredMetricValue | null, size: AccredMetricValue | null, classes: number | null): SnpResultView {
  return notImplemented();
}
