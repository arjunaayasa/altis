import type { AccredInstrument } from '../types.js';
import { SCH_SD_2025_HEADER } from './headers.js';
import { atLeast, atMost, bands, between, buildSchoolInstrument, exactly } from './shared.js';
import { SNP_SD } from './snp.js';

// The instrument for primary school libraries (SD/MI): 41 indicators. It has no plagiarism item, so the service items
// of the concepts L8 to L14 are numbered L7 to L13 in its decree. The website item counts six features (no FAQ), the
// local works five kinds, and option d of L3 is read as "less than 2" (option c is 2).

export const SCH_SD_2025: AccredInstrument = buildSchoolInstrument({
  header: SCH_SD_2025_HEADER,
  without: ['L7'],
  bands: {
    K1: bands(atLeast(1501), between(1001, 1500), exactly(1000)),
    K2: bands(exactly(40), between(21, 39), exactly(20)),
    // Five required aspects make c (4 aspects) unreachable; written as the decree has it.
    K3: bands(atLeast(6), exactly(5), exactly(4)),
    K4: bands(atLeast(3), exactly(2), exactly(1)),
    K5: bands(atLeast(51), between(26, 50), exactly(25)),
    K8: bands(atLeast(5), exactly(4), exactly(3)),
    SP4: bands(atLeast(4), exactly(3), exactly(2)),
    SP5: bands(atLeast(70), between(51, 69), exactly(50)),
    SP6: bands(atLeast(51), between(31, 50), exactly(30)),
    SP7: bands(atLeast(6), exactly(5), exactly(4)),
    L1: bands(atLeast(4), exactly(3), exactly(2)),
    L2: bands(atLeast(6), exactly(5), exactly(4)),
    L3: bands(atLeast(4), exactly(3), exactly(2)),
    L4: bands(atLeast(3), exactly(2), exactly(1)),
    L5: bands(atLeast(4), exactly(3), exactly(2)),
    L6: bands(atLeast(4), exactly(3), exactly(2)),
    L8: bands(atLeast(3), exactly(2), exactly(1)),
    L9: bands(atLeast(4), exactly(3), exactly(2)),
    L10: bands(atLeast(3), exactly(2), exactly(1)),
    L12: bands(atLeast(5), exactly(4), exactly(3)),
    L13: bands(atLeast(6), exactly(5), exactly(4)),
    L14: bands(atLeast(76), between(51, 75), exactly(50)),
    T2: bands(atLeast(5), exactly(4), exactly(3)),
    T4: bands(atLeast(5), exactly(4), exactly(3)),
    T5: bands(atMost(27), between(28, 83), between(84, 112)),
    F1: bands(exactly(4), exactly(3), exactly(2)),
    F2: bands(atLeast(5), exactly(4), exactly(3)),
    F4: bands(atLeast(51), between(31, 50), exactly(30)),
    G1: bands(atLeast(5), exactly(4), exactly(3)),
    G2: bands(atLeast(3), exactly(2), exactly(1)),
    G3: bands(atLeast(11), between(6, 10), exactly(5)),
  },
  officialNo: { L8: 'L7', L9: 'L8', L10: 'L9', L11: 'L10', L12: 'L11', L13: 'L12', L14: 'L13' },
  labelKeys: { L4: 'accred.ik.L4.sd', L12: 'accred.ik.L12.sd' },
  metricParams: {
    L6: { countedKinds: ['written_work', 'clipping', 'short_stories', 'poetry', 'review'] },
    L12: { features: ['profile', 'opac', 'services', 'contact', 'databases', 'social'] },
  },
  extraNotes: { L3: ['accred.note.l3_sd_option_d'], SP3: ['accred.note.sp3_mandatory_hint'] },
  snp: SNP_SD,
});
