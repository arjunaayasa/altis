// The scoring engine: a value's suggested answer (bands, sized bands, rules and required elements), the final answers,
// the estimated score with its range, predicate and gaps, the registration prerequisites and the school standards.
export { suggestAnswer } from './suggest.js';
export { finalAnswers, scoreInstrument } from './score.js';
export { evaluatePrerequisites } from './prerequisites.js';
export { evaluateSnp } from './snp.js';
