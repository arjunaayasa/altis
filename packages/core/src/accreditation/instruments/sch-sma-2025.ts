import type { AccredInstrument } from '../types.js';
import { SCH_SMA_2025_HEADER } from './headers.js';
import { atLeast, atMost, bands, between, buildSchoolInstrument, exactly } from './shared.js';
import { SNP_SMA } from './snp.js';

// The instrument for upper secondary school libraries (SMA/SMK/MA/MAK): 42 indicators, each numbered as its concept
// key. The website item counts seven features and the local works six kinds (with the abstract). In K2 the decree's a
// (25 %) and b (11–25 %) both hold 25 %; tested in order, 25 % is an a, and the indicator notes the overlap.

export const SCH_SMA_2025: AccredInstrument = buildSchoolInstrument({
  header: SCH_SMA_2025_HEADER,
  without: [],
  bands: {
    K1: bands(atLeast(1501), between(1001, 1500), exactly(1000)),
    K2: bands(exactly(25), between(11, 25), exactly(10)),
    K3: bands(atLeast(7), exactly(6), exactly(5)),
    K4: bands(atLeast(3), exactly(2), exactly(1)),
    K5: bands(atLeast(51), between(26, 50), exactly(25)),
    K8: bands(atLeast(5), exactly(4), exactly(3)),
    SP4: bands(atLeast(4), exactly(3), exactly(2)),
    SP5: bands(atLeast(70), between(51, 69), exactly(50)),
    SP6: bands(atLeast(51), between(31, 50), exactly(30)),
    SP7: bands(atLeast(6), exactly(5), exactly(4)),
    L1: bands(atLeast(4), exactly(3), exactly(2)),
    L2: bands(atLeast(6), exactly(5), exactly(4)),
    L3: bands(atLeast(5), exactly(4), exactly(3)),
    L4: bands(atLeast(6), exactly(5), exactly(4)),
    L5: bands(atLeast(5), exactly(4), exactly(3)),
    L6: bands(atLeast(5), exactly(4), exactly(3)),
    L7: bands(atLeast(3), exactly(2), exactly(1)),
    L8: bands(atLeast(3), exactly(2), exactly(1)),
    L9: bands(atLeast(4), exactly(3), exactly(2)),
    L10: bands(atLeast(3), exactly(2), exactly(1)),
    L12: bands(atLeast(6), exactly(5), exactly(4)),
    L13: bands(atLeast(10), exactly(9), exactly(8)),
    L14: bands(atLeast(76), between(51, 75), exactly(50)),
    T2: bands(atLeast(5), exactly(4), exactly(3)),
    T4: bands(atLeast(8), exactly(7), exactly(6)),
    T5: bands(atMost(35), between(36, 107), between(108, 144)),
    F1: bands(exactly(4), exactly(3), exactly(2)),
    F2: bands(atLeast(5), exactly(4), exactly(3)),
    F4: bands(atLeast(51), between(31, 50), exactly(30)),
    G1: bands(atLeast(5), exactly(4), exactly(3)),
    G2: bands(atLeast(5), exactly(4), exactly(3)),
    G3: bands(atLeast(11), between(6, 10), exactly(5)),
  },
  officialNo: {},
  labelKeys: {},
  metricParams: {
    L6: { countedKinds: ['written_work', 'clipping', 'short_stories', 'poetry', 'review', 'abstract'] },
    L12: { features: ['profile', 'opac', 'services', 'contact', 'databases', 'social', 'faq'] },
  },
  extraNotes: { K2: ['accred.note.k2_overlap'] },
  snp: SNP_SMA,
});
