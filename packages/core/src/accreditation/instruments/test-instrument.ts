import type { AccredComponent, AccredIndicator, AccredInstrument } from '../types.js';

// The instrument of the test build profile (never in a production build: TEST_INSTRUMENTS builds it only under
// `__BUILD_PROFILE__ === 'test'`, the condition inline so a production build drops it, and instruments/index.ts spreads
// it under the same condition). It carries four indicators of the school instruments with their real codes,
// bands, labels, actions and evidence lists (the collection's titles, its fiction share and its development policy,
// and the manual answer on the building), so periods, answers, registers and evidence can be tested before the full
// instruments are in place.

/** `test-sch`: a scored school instrument for upper secondary schools with the components K (60) and SP (40). */
function testSchoolInstrument(): AccredInstrument {
  const K: AccredComponent = Object.freeze<AccredComponent>({
    code: 'K',
    labelKey: 'accred.component.K',
    weight: 60,
    indicators: Object.freeze<AccredIndicator[]>([
      Object.freeze<AccredIndicator>({
        code: 'K1',
        officialNo: 'K1',
        labelKey: 'accred.ik.K1',
        metric: 'collection.titles',
        window: 'snapshot',
        band: { kind: 'range', bands: [{ answer: 'a', min: 1501 }, { answer: 'b', min: 1001, max: 1500 }, { answer: 'c', min: 1000, max: 1000 }, { answer: 'd' }] },
        evidence: [
          { code: 'title_list', labelKey: 'accred.evidence.K1.title_list', kind: 'generated', primary: true, reportId: 'collection.title_list' },
          { code: 'catalogue_screenshot', labelKey: 'accred.evidence.K1.catalogue_screenshot', kind: 'screenshot', screen: 'catalog/records' },
          { code: 'ddc_recap', labelKey: 'accred.evidence.K1.ddc_recap', kind: 'generated', reportId: 'accreditation.annex.ddc' },
        ],
        noteKeys: ['accred.note.electronic_counted', 'accred.note.replacement_records', 'accred.note.items_without_received_date'],
        actionKey: 'accred.gap.action.K1',
      }),
      Object.freeze<AccredIndicator>({
        code: 'K2',
        officialNo: 'K2',
        labelKey: 'accred.ik.K2',
        metric: 'collection.fiction_pct',
        window: 'snapshot',
        band: { kind: 'range', bands: [{ answer: 'a', min: 25, max: 25 }, { answer: 'b', min: 11, max: 25 }, { answer: 'c', min: 10, max: 10 }, { answer: 'd' }] },
        evidence: [
          {
            code: 'fiction_list',
            labelKey: 'accred.evidence.K2.fiction_list',
            kind: 'generated',
            primary: true,
            reportId: 'collection.title_list',
            params: { fictionOnly: true },
          },
          { code: 'fiction_screenshot', labelKey: 'accred.evidence.K2.fiction_screenshot', kind: 'screenshot', screen: 'catalog/records' },
        ],
        noteKeys: ['accred.note.fiction_rule', 'accred.note.truncated', 'accred.note.k2_overlap'],
        actionKey: 'accred.gap.action.K2',
      }),
      Object.freeze<AccredIndicator>({
        code: 'K3',
        officialNo: 'K3',
        labelKey: 'accred.ik.K3',
        metric: 'registers.collection_policy_aspects',
        window: 'current',
        band: { kind: 'range', bands: [{ answer: 'a', min: 7 }, { answer: 'b', min: 6, max: 6 }, { answer: 'c', min: 5, max: 5 }, { answer: 'd' }] },
        mandatory: ['a1', 'a2', 'a3', 'a4', 'a5'],
        evidence: [{ code: 'policy_document', labelKey: 'accred.evidence.K3.policy_document', kind: 'signed_document', primary: true }],
        noteKeys: ['accred.note.mandatory_missing', 'accred.note.register_empty'],
        actionKey: 'accred.gap.action.K3',
      }),
    ]),
  });

  const SP: AccredComponent = Object.freeze<AccredComponent>({
    code: 'SP',
    labelKey: 'accred.component.SP',
    weight: 40,
    indicators: Object.freeze<AccredIndicator[]>([
      Object.freeze<AccredIndicator>({
        code: 'SP1',
        officialNo: 'SP1',
        labelKey: 'accred.ik.SP1',
        window: 'current',
        band: { kind: 'manual' },
        evidence: [
          { code: 'floor_plan', labelKey: 'accred.evidence.SP1.floor_plan', kind: 'upload', primary: true },
          { code: 'room_photos', labelKey: 'accred.evidence.SP1.room_photos', kind: 'photo' },
        ],
        noteKeys: ['accred.note.sp1_floor'],
        optionKeys: ['accred.ik.SP1.option.a', 'accred.ik.SP1.option.b', 'accred.ik.SP1.option.c', 'accred.ik.SP1.option.d'],
        actionKey: 'accred.gap.action.SP1',
      }),
    ]),
  });

  return Object.freeze<AccredInstrument>({
    id: 'test-sch',
    decree: 'Instrumen uji',
    decreeTitle: 'Instrumen uji untuk tes otomatis',
    effectiveFrom: '2026-01-02',
    sourceStatus: 'P-copy',
    libraryTypes: Object.freeze(['sekolah'] as const),
    schoolLevels: Object.freeze(['sma_smk_ma'] as const),
    periodKinds: Object.freeze(['school_year', 'rolling_12'] as const),
    defaultPeriodKind: () => 'school_year',
    components: Object.freeze([K, SP]),
    snp: Object.freeze([]),
    forms: Object.freeze(['submission', 'profile', 'certificate_name'] as const),
    scored: true,
  });
}

/** The instruments of the test build profile. */
export const TEST_INSTRUMENTS: readonly AccredInstrument[] = Object.freeze(
  typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? [testSchoolInstrument()] : [],
);
