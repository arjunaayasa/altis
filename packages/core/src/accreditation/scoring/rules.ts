import type { NoteRef } from '@altis/shared/api/accreditation';
import type { AccredMetricValue, Letter } from '../types.js';

// The rule indicators: an answer decided by a rule over the facts of the metric value rather than by bands.
//
// - k7 (how the collection is processed and shelved): facts `live` (copies in stock at the snapshot date), `processed`
//   (those with a barcode, a call number, a classification and a location), `threshold` (the share in percent that
//   must be processed, 100 unless lowered in the settings) and `scanners` (the period's barcode scanners, or null).
//   No copy: no suggestion. Fewer processed than the threshold: d, because the decree gives a collection that is not
//   processed and shelved a d. Otherwise more than one scanner a, one b, none c. The manual d is never suggested: the
//   library system is ALTIS itself.
// - l11 (automation and reach): facts `class` of the base address (`public`, `private`, `localhost`, `unset`) and
//   `membersUsed`, `circulationUsed` (null while ALTIS keeps no members or loans). Public a, private b, localhost c,
//   unset no suggestion; each with a note that membership and loans are not checked yet, unless both are in use.
// - t1 (the head of library): facts `heads` (active heads at the period's end), `educationLevel`, `educationLibrary`,
//   `libraryTraining` of the head used. A bachelor or master (or a four-year diploma, or a doctorate, counted as
//   those) is an a in library science, a b with library training, else a d; a three-year diploma is a c in library
//   science or with training, else a d; any lower education a d.
// - t3 (staff roles): facts `librarians`, `ict`, `technical`, `technicalCertified` (technical staff with library
//   training or a competency certificate), optionally `active`. A librarian, ICT and technical staff a; a librarian and
//   technical staff b; certified technical staff c; anything else d.
// - g4 (regular reports over the three yearly slices): see {@link routineFacts}. Regular annual reports are an annual
//   report in every slice; semester reports at least 2 in every slice; periodic reports at least 4 quarterly or at
//   least 10 monthly reports in every slice (the two never added up). Not annual d; annual, semester and periodic a;
//   annual with one of the other two b; annual only c.

/** The facts of a metric value. */
export type Facts = NonNullable<AccredMetricValue['facts']>;

/** What a rule decides: a letter or no suggestion, and the notes that explain it. */
export interface RuleOutcome {
  suggestion: Letter | null;
  notes: NoteRef[];
}

export type AccredRule = 'k7' | 'l11' | 't1' | 't3' | 'g4';

const num = (f: Facts, key: string): number | null => {
  const v = f[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const text = (f: Facts, key: string): string | null => {
  const v = f[key];
  return typeof v === 'string' ? v : null;
};
const note = (name: string, params?: Record<string, string | number>): NoteRef =>
  params === undefined ? { key: `accred.note.${name}` } : { key: `accred.note.${name}`, params };
const outcome = (suggestion: Letter | null, notes: NoteRef[] = []): RuleOutcome => ({ suggestion, notes });

/** The field named in the note that asks for the barcode scanners. */
const SCANNERS_FIELD = 'jumlah pemindai barkod';
/** The field named in the note that asks for the head's education. */
const HEAD_EDUCATION_FIELD = 'pendidikan kepala perpustakaan';
/** The processed share from which the note says the rest is close. */
const K7_ALMOST_PCT = 95;

function k7(f: Facts): RuleOutcome {
  const live = num(f, 'live');
  const processed = num(f, 'processed');
  const threshold = num(f, 'threshold') ?? 100;
  const lowered = threshold < 100 ? [note('k7_threshold_lowered', { threshold })] : [];
  if (live === null || processed === null) return outcome(null, lowered);
  if (live <= 0) return outcome(null, [note('collection_empty'), ...lowered]);
  // Exact: processed / live < threshold / 100, in whole numbers.
  if (processed * 100 < threshold * live) {
    const pct = Math.floor((processed * 100) / live);
    const notes = [note('k7_unprocessed', { pct, threshold })];
    if (pct >= K7_ALMOST_PCT) notes.push(note('k7_almost'));
    return outcome('d', [...notes, ...lowered]);
  }
  const scanners = num(f, 'scanners');
  if (scanners === null) return outcome(null, [note('input_missing', { field: SCANNERS_FIELD }), ...lowered]);
  return outcome(scanners > 1 ? 'a' : scanners === 1 ? 'b' : 'c', lowered);
}

function l11(f: Facts): RuleOutcome {
  const unverified = note('l11_unverified');
  switch (text(f, 'class')) {
    case 'unset':
      return outcome(null, [note('base_url_unset')]);
    case 'public':
      return f['membersUsed'] === true && f['circulationUsed'] === true ? outcome('a') : outcome('a', [unverified]);
    case 'private':
      return outcome('b', [note('l11_private'), unverified]);
    case 'localhost':
      return outcome('c', [note('l11_localhost'), unverified]);
    default:
      return outcome(null);
  }
}

/** The education levels read as a bachelor or a master, and the two of them read as the other one. */
const DEGREES: ReadonlySet<string> = new Set(['s1', 's2', 's3', 'd4']);
const EQUIVALENT: ReadonlySet<string> = new Set(['s3', 'd4']);

function t1(f: Facts): RuleOutcome {
  const heads = num(f, 'heads');
  if (heads === 0) return outcome(null, [note('head_missing')]);
  if (heads === null && !('educationLevel' in f)) return outcome(null);
  const notes = heads !== null && heads > 1 ? [note('head_multiple')] : [];
  const level = text(f, 'educationLevel');
  if (level === null) return outcome(null, [...notes, note('input_missing', { field: HEAD_EDUCATION_FIELD })]);
  const library = f['educationLibrary'] === true;
  const training = f['libraryTraining'] === true;
  if (DEGREES.has(level)) {
    if (EQUIVALENT.has(level)) notes.push(note('t1_equivalence'));
    return outcome(library ? 'a' : training ? 'b' : 'd', notes);
  }
  if (level === 'd3') return outcome(library || training ? 'c' : 'd', notes);
  return outcome('d', notes);
}

function t3(f: Facts): RuleOutcome {
  const librarians = num(f, 'librarians');
  const technical = num(f, 'technical');
  if (num(f, 'active') === 0 || librarians === null || technical === null) return outcome(null, [note('staff_missing')]);
  const ict = num(f, 'ict') ?? 0;
  const certified = num(f, 'technicalCertified') ?? 0;
  if (librarians >= 1 && ict >= 1 && technical >= 1) return outcome('a');
  if (librarians >= 1 && technical >= 1) return outcome('b');
  if (certified >= 1) return outcome('c');
  return outcome('d');
}

/** The report counts of one yearly slice. */
export interface RoutineSliceCounts {
  annual: number;
  semester: number;
  quarterly: number;
  monthly: number;
}

const ROUTINE_KINDS = ['annual', 'semester', 'quarterly', 'monthly'] as const;

/**
 * The facts of the report routine (metric `registers.report_routine_3p`): per yearly slice of the three periods
 * (oldest first) the count of each report kind issued in it, as `annual1` … `annual3`, `semester1` … `semester3`,
 * `quarterly1` … `quarterly3`, `monthly1` … `monthly3`, and `undated`, the report documents without an issue date
 * (never counted).
 */
export function routineFacts(slices: readonly [RoutineSliceCounts, RoutineSliceCounts, RoutineSliceCounts], undated = 0): Facts {
  const facts: Record<string, number> = { undated };
  slices.forEach((s, k) => {
    for (const kind of ROUTINE_KINDS) facts[`${kind}${k + 1}`] = s[kind];
  });
  return facts;
}

function g4(f: Facts): RuleOutcome {
  const slices: RoutineSliceCounts[] = [];
  for (const k of [1, 2, 3]) {
    const counts = ROUTINE_KINDS.map((kind) => num(f, `${kind}${k}`));
    if (counts[0] === null) return outcome(null);
    const [annual, semester, quarterly, monthly] = counts.map((c) => c ?? 0) as [number, number, number, number];
    slices.push({ annual, semester, quarterly, monthly });
  }
  const undated = num(f, 'undated') ?? 0;
  const notes = undated > 0 ? [note('g4_undated', { count: undated })] : [];
  const annual = slices.every((s) => s.annual >= 1);
  const semester = slices.every((s) => s.semester >= 2);
  const periodic = slices.every((s) => s.quarterly >= 4 || s.monthly >= 10);
  if (!annual) return outcome('d', notes);
  if (semester && periodic) return outcome('a', notes);
  if (semester || periodic) return outcome('b', notes);
  return outcome('c', notes);
}

const RULES: Readonly<Record<AccredRule, (f: Facts) => RuleOutcome>> = Object.freeze({ k7, l11, t1, t3, g4 });

/** The answer the rule `rule` gives for the facts `facts`, with its notes. */
export function evaluateRule(rule: AccredRule, facts: Facts): RuleOutcome {
  return RULES[rule](facts);
}
