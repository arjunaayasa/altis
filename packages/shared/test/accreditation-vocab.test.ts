import { describe, expect, it } from 'vitest';
import {
  ACCRED_GROUPS,
  ACCREDITATION_VOCAB_LISTS,
  ACTIVITY_KINDS,
  ANSWER_MODES,
  AUDIENCES,
  DOCUMENT_ASPECTS,
  DOCUMENT_KINDS,
  EDUCATION_LEVELS,
  EMPLOYMENTS,
  EVIDENCE_ENTITIES,
  EVIDENCE_KINDS,
  L12_FEATURES,
  LOCAL_WORKS,
  LOCAL_WORK_KINDS,
  PARTNERSHIP_KINDS,
  PERIOD_KINDS,
  PERIOD_STATUSES,
  REFERENCE_KINDS,
  REPORT_FORMATS,
  REPORT_RUN_STATUSES,
  SCHOOL_LEVELS,
  SCHOOL_STATUSES,
  SERVICE_CODES,
  STAFF_ROLES,
  USAGE_METRICS,
} from '../src/accreditation-vocab.js';
import { VOCAB_LISTS } from '../src/catalog-vocab.js';
import { DDC_MAINS } from '../src/ddc.js';
import { LOCALES, MESSAGES } from '../src/i18n/index.js';
import * as root from '../src/index.js';

// The fixed vocabularies of reports and accreditation: lists in code, each value labelled `vocab.<list>.<value>` in
// both languages (VOCAB_LISTS joins them, so the compile-time check of i18n/id.ts covers them too).

describe('the accreditation vocabularies', () => {
  it('hold the values in their fixed order', () => {
    expect([...ACCRED_GROUPS]).toEqual(['student', 'teacher', 'edu_staff', 'public', 'other']);
    expect([...PERIOD_KINDS]).toEqual(['school_year', 'calendar_year', 'rolling_12', 'custom']);
    expect([...ACTIVITY_KINDS]).toEqual([
      'promotion',
      'reading_culture',
      'reading_guidance',
      'writing_guidance',
      'plagiarism_guidance',
      'innovation',
      'external_literacy',
      'needs_survey',
      'satisfaction_survey',
      'preservation',
      'learning_session',
      'stocktake',
      'weeding',
      'award',
      'uniqueness',
      'other',
    ]);
    expect([...DOCUMENT_KINDS]).toEqual([
      'rules',
      'sop_membership',
      'sop_loan',
      'sop_return',
      'sop_other',
      'collection_policy',
      'founding_decree',
      'npp_certificate',
      'duties',
      'org_structure',
      'school_program',
      'library_program',
      'pos_collection',
      'pos_organisation',
      'pos_service',
      'pos_preservation',
      'pos_promotion',
      'pos_partnership',
      'report_annual',
      'report_semester',
      'report_quarterly',
      'report_monthly',
      'head_performance_report',
      'library_request_letter',
      'other',
    ]);
    expect([...EVIDENCE_KINDS]).toEqual(['generated', 'upload', 'screenshot', 'signed_document', 'photo']);
    expect([...USAGE_METRICS]).toEqual([
      'visits',
      'visits_deduped',
      'visits_online',
      'loans',
      'in_library_uses',
      'distinct_visitors',
      'distinct_borrowers',
      'titles_used',
      'items_used',
      'members_active',
    ]);
    expect([...SERVICE_CODES]).toEqual([
      'reading_room',
      'circulation',
      'reference',
      'information_literacy',
      'speed_reading',
      'extension',
      'project_learning',
      'ict',
      'other',
    ]);
    expect([...LOCAL_WORK_KINDS]).toEqual(['written_work', 'clipping', 'short_stories', 'poetry', 'review', 'abstract', 'other']);
    expect([...AUDIENCES]).toEqual(['general', 'children', 'special_needs']);
    expect([...LOCAL_WORKS]).toEqual(['student', 'teacher', 'staff', 'school', 'local']);
    expect([...REFERENCE_KINDS]).toEqual(['encyclopedia', 'dictionary', 'handbook', 'atlas', 'globe', 'biography', 'almanac', 'directory', 'other']);
    expect([...REPORT_FORMATS]).toEqual(['csv', 'xlsx', 'pdf', 'zip']);
    expect([...REPORT_RUN_STATUSES]).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    expect([...STAFF_ROLES]).toEqual(['head', 'librarian', 'ict', 'technical', 'other']);
    expect([...EMPLOYMENTS]).toEqual(['civil_servant', 'contract', 'honorary', 'foundation', 'other']);
    expect([...EDUCATION_LEVELS]).toEqual(['sma', 'd1', 'd2', 'd3', 'd4', 's1', 's2', 's3', 'other']);
    expect([...PARTNERSHIP_KINDS]).toEqual(['mou', 'pks', 'other']);
    expect([...SCHOOL_LEVELS]).toEqual(['sd_mi', 'smp_mts', 'sma_smk_ma', 'slb', 'paud']);
    expect([...SCHOOL_STATUSES]).toEqual(['negeri', 'swasta']);
    expect([...ANSWER_MODES]).toEqual(['manual', 'override']);
    expect([...PERIOD_STATUSES]).toEqual(['open', 'frozen']);
  });

  it('are joined into VOCAB_LISTS under their list names, after the catalogue lists', () => {
    expect(ACCREDITATION_VOCAB_LISTS).toEqual({
      accred_group: ACCRED_GROUPS,
      period_kind: PERIOD_KINDS,
      activity_kind: ACTIVITY_KINDS,
      document_kind: DOCUMENT_KINDS,
      evidence_kind: EVIDENCE_KINDS,
      usage_metric: USAGE_METRICS,
      service_code: SERVICE_CODES,
      local_work_kind: LOCAL_WORK_KINDS,
      audience: AUDIENCES,
      local_work: LOCAL_WORKS,
      reference_kind: REFERENCE_KINDS,
      report_format: REPORT_FORMATS,
      report_run_status: REPORT_RUN_STATUSES,
      staff_role: STAFF_ROLES,
      employment: EMPLOYMENTS,
      education_level: EDUCATION_LEVELS,
      partnership_kind: PARTNERSHIP_KINDS,
      school_level: SCHOOL_LEVELS,
      school_status: SCHOOL_STATUSES,
      answer_mode: ANSWER_MODES,
      period_status: PERIOD_STATUSES,
      ddc_main: DDC_MAINS,
    });
    // Right after the catalogue's lists; the members and circulation lists follow them (circulation-vocab.test.ts).
    const names = Object.keys(VOCAB_LISTS);
    const first = names.indexOf('accred_group');
    expect(names.slice(first, first + Object.keys(ACCREDITATION_VOCAB_LISTS).length)).toEqual(Object.keys(ACCREDITATION_VOCAB_LISTS));
    expect(names[first + Object.keys(ACCREDITATION_VOCAB_LISTS).length]).toBe('member_status');
    for (const [list, values] of Object.entries(ACCREDITATION_VOCAB_LISTS)) {
      expect((VOCAB_LISTS as Record<string, readonly string[]>)[list], list).toBe(values);
      expect(Object.isFrozen(values), list).toBe(true);
      expect(new Set(values).size, list).toBe(values.length);
    }
  });

  it('every value of every list has a label in both languages, the two different', () => {
    for (const [list, values] of Object.entries(ACCREDITATION_VOCAB_LISTS)) {
      for (const value of values as readonly string[]) {
        const key = `vocab.${list}.${value}`;
        for (const locale of LOCALES) expect((MESSAGES[locale] as Record<string, string>)[key], `${locale}:${key}`).toBeTruthy();
        expect((MESSAGES.id as Record<string, string>)[key], key).not.toBe((MESSAGES.en as Record<string, string>)[key]);
      }
    }
  });

  it('DOCUMENT_ASPECTS: eight aspects of the collection policy and of the work programme, six of the head report, none elsewhere', () => {
    expect(DOCUMENT_ASPECTS.collection_policy).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    expect(DOCUMENT_ASPECTS.library_program).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    expect(DOCUMENT_ASPECTS.head_performance_report).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    expect(Object.keys(DOCUMENT_ASPECTS)).toEqual([...DOCUMENT_KINDS]);
    for (const kind of DOCUMENT_KINDS) {
      if (!['collection_policy', 'library_program', 'head_performance_report'].includes(kind)) expect(DOCUMENT_ASPECTS[kind], kind).toEqual([]);
      for (const code of DOCUMENT_ASPECTS[kind]) {
        for (const locale of LOCALES) {
          expect((MESSAGES[locale] as Record<string, string>)[`accred.aspect.${kind}.${code}`], `${locale}:${kind}.${code}`).toBeTruthy();
        }
      }
    }
    expect(Object.isFrozen(DOCUMENT_ASPECTS)).toBe(true);
  });

  it('the website features and the register tables that take evidence', () => {
    expect([...L12_FEATURES]).toEqual(['profile', 'opac', 'services', 'contact', 'databases', 'social', 'faq']);
    expect([...EVIDENCE_ENTITIES]).toEqual([
      'library_activities',
      'library_staff',
      'staff_trainings',
      'library_partnerships',
      'library_budgets',
      'library_documents',
    ]);
    // EVIDENCE_ENTITIES is a contract tuple, not a vocabulary: it has no labels.
    expect(Object.keys(VOCAB_LISTS)).not.toContain('evidence_entity');
  });

  it('the DDC main classes are labelled; 0 to 9 with the words the OPAC uses for its class browser', () => {
    expect((MESSAGES.id as Record<string, string>)['vocab.ddc_main.800']).toBe('Kesusastraan');
    expect((MESSAGES.en as Record<string, string>)['vocab.ddc_main.800']).toBe('Literature');
    expect((MESSAGES.id as Record<string, string>)['vocab.ddc_main.2X']).toMatch(/Islam/);
  });

  it('the package root re-exports the lists', () => {
    expect(root.ACTIVITY_KINDS).toBe(ACTIVITY_KINDS);
    expect(root.DOCUMENT_ASPECTS).toBe(DOCUMENT_ASPECTS);
    expect(root.EVIDENCE_ENTITIES).toBe(EVIDENCE_ENTITIES);
  });
});
