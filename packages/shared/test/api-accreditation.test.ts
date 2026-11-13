import { describe, expect, it } from 'vitest';
import { issueCode } from '../src/api/common.js';
import { newId } from '../src/index.js';
import {
  ACCRED_PROFILE_MAX_BYTES,
  AccredProfile,
  ActivityBody,
  ActivityPatchBody,
  AnswerPutBody,
  BudgetBody,
  DocumentBody,
  DocumentPatchBody,
  DossierBody,
  EvidenceCreateBody,
  FreezeBody,
  PartnershipBody,
  PeriodCreateBody,
  PeriodPatchBody,
  SlimsUsageStartBody,
  StaffBody,
  TrainingBody,
  UsageGroupsPutBody,
  UsagePutBody,
} from '../src/api/accreditation.js';

// The accreditation API contracts: every maximum is the column's width, a JSON value is bounded on its encoded length,
// a branch other than none is refused (accreditation is library-wide in this edition), and the cross-field rules of the
// bodies answer field errors at the field they are about.

interface Parser {
  safeParse(v: unknown): { success: boolean; error?: { issues: { code: string; path: PropertyKey[]; params?: Record<string, unknown> }[] } };
}

/** The `{path, code}` field errors the server would answer for `value`. */
function errorsOf(schema: Parser, value: unknown): { path: string; code: string }[] {
  const r = schema.safeParse(value);
  if (r.success) return [];
  return r.error!.issues.map((i) => ({ path: i.path.map(String).join('.'), code: issueCode(i) }));
}

const BRANCH = newId();
const UPLOAD = newId();
const PERIOD = newId();

describe('AccredProfile', () => {
  it('takes every field as optional or null', () => {
    expect(errorsOf(AccredProfile, {})).toEqual([]);
    const profile = {
      npp: '3204012345678901',
      status: 'negeri',
      foundedYear: 1985,
      foundingDecree: { number: '421/123/2001', date: '2001-07-16', issuer: 'Kepala Sekolah' },
      schoolName: 'SMA Negeri 1 Contoh',
      schoolLevel: 'sma_smk_ma',
      address: { street: 'Jl. Merdeka 1', province: 'Jawa Barat', postalCode: '40111' },
      website: 'https://sman1contoh.sch.id',
      previousAccreditation: { grade: 'B', year: 2021, certificateNo: 'AKR-1' },
      photos: { front: newId(), readingRoom: null },
      externalWebsiteFeatures: ['opac', 'faq'],
    };
    expect(errorsOf(AccredProfile, profile)).toEqual([]);
  });

  it('refuses a profile whose JSON is over 16 000 bytes, at the profile itself', () => {
    const big = { schoolName: 'x', address: { street: 'é'.repeat(95) }, extra: 'y'.repeat(ACCRED_PROFILE_MAX_BYTES) };
    expect(errorsOf(AccredProfile, big)).toEqual([{ path: '', code: 'too_big' }]);
  });

  it('refuses an unknown key, a field over its width, a second copy of a website feature and a non-http website', () => {
    expect(errorsOf(AccredProfile, { motto: 'x' })).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    expect(errorsOf(AccredProfile, { npp: '1'.repeat(33) })).toEqual([{ path: 'npp', code: 'too_big' }]);
    expect(errorsOf(AccredProfile, { externalWebsiteFeatures: ['opac', 'opac'] })).toEqual([{ path: 'externalWebsiteFeatures', code: 'duplicate' }]);
    expect(errorsOf(AccredProfile, { website: 'ftp://sman1.sch.id' }).map((e) => e.path)).toEqual(['website']);
  });
});

describe('PeriodCreateBody and PeriodPatchBody', () => {
  it('create: a kind with its span fields; a branch other than none is refused', () => {
    expect(errorsOf(PeriodCreateBody, { name: 'Tahun pelajaran 2025/2026', instrumentId: 'sch-sma-2025', kind: 'school_year', startYear: 2025 })).toEqual([]);
    expect(errorsOf(PeriodCreateBody, { name: 'P', instrumentId: 'general-stats', kind: 'rolling_12', endMonth: '2026-06', branchId: null })).toEqual([]);
    expect(errorsOf(PeriodCreateBody, { name: 'P', instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2026, branchId: BRANCH })).toEqual([
      { path: 'branchId', code: 'branch_scope_not_available' },
    ]);
    expect(errorsOf(PeriodCreateBody, { name: 'P', instrumentId: 'x', kind: 'rolling_12', endMonth: '2026-13' }).map((e) => e.path)).toEqual(['endMonth']);
  });

  it('patch: teachers using the library may not outnumber the teachers', () => {
    expect(errorsOf(PeriodPatchBody, { version: 3, teachers: 4, teachersUsing: 4 })).toEqual([]);
    expect(errorsOf(PeriodPatchBody, { version: 3, teachersUsing: 5, teachers: 4 })).toEqual([{ path: 'teachersUsing', code: 'too_big' }]);
  });

  it('patch: the widths of the facilities and the hours of a week', () => {
    expect(errorsOf(PeriodPatchBody, { version: 0, userPcs: 32_768 })).toEqual([{ path: 'userPcs', code: 'too_big' }]);
    expect(errorsOf(PeriodPatchBody, { version: 0, hoursPerWeek: 169 })).toEqual([{ path: 'hoursPerWeek', code: 'too_big' }]);
    expect(errorsOf(PeriodPatchBody, { version: 0, services: ['circulation', 'circulation'] })).toEqual([{ path: 'services', code: 'duplicate' }]);
  });
});

describe('AnswerPutBody', () => {
  it('a manual answer needs no note; an override without a non-blank note is refused at the note', () => {
    expect(errorsOf(AnswerPutBody, { answer: 'b', mode: 'manual', note: null })).toEqual([]);
    expect(errorsOf(AnswerPutBody, { answer: null, mode: 'manual', note: null })).toEqual([]);
    expect(errorsOf(AnswerPutBody, { answer: 'a', mode: 'override', note: 'Daftar baru sudah diserahkan.' })).toEqual([]);
    expect(errorsOf(AnswerPutBody, { answer: 'a', mode: 'override', note: null })).toEqual([{ path: 'note', code: 'required' }]);
    expect(errorsOf(AnswerPutBody, { answer: 'a', mode: 'override', note: '   ' })).toEqual([{ path: 'note', code: 'required' }]);
    expect(errorsOf(AnswerPutBody, { answer: 'e', mode: 'manual', note: null })).toEqual([{ path: 'answer', code: 'invalid_value' }]);
  });
});

describe('UsagePutBody and UsageGroupsPutBody', () => {
  const cell = (i: number) => ({ metric: 'visits', month: '2026-01', groupKey: i % 2 === 0 ? 'grp:student' : '', value: i });

  it('takes 1-500 cells of a known metric, month and group', () => {
    expect(errorsOf(UsagePutBody, { cells: Array.from({ length: 500 }, (_, i) => cell(i)) })).toEqual([]);
    expect(errorsOf(UsagePutBody, { cells: [{ metric: 'loans', month: null, groupKey: 'guest', value: null }] })).toEqual([]);
  });

  it('refuses 501 cells, an unknown group and a negative value', () => {
    expect(errorsOf(UsagePutBody, { cells: Array.from({ length: 501 }, (_, i) => cell(i)) })).toEqual([{ path: 'cells', code: 'too_big' }]);
    expect(errorsOf(UsagePutBody, { cells: [{ ...cell(0), groupKey: 'grp:alumni' }] })).toEqual([{ path: 'cells.0.groupKey', code: 'invalid_format' }]);
    expect(errorsOf(UsagePutBody, { cells: [{ ...cell(0), value: -1 }] })).toEqual([{ path: 'cells.0.value', code: 'too_small' }]);
  });

  it('groups: a SLiMS member type or the members a source no longer has, 1-200 rows', () => {
    expect(errorsOf(UsageGroupsPutBody, { groups: [{ groupKey: 'slims_type:3', accredGroup: 'teacher' }, { groupKey: 'member_unknown', accredGroup: null }] })).toEqual([]);
    expect(errorsOf(UsageGroupsPutBody, { groups: [{ groupKey: 'grp:student', accredGroup: 'student' }] }).map((e) => e.path)).toEqual(['groups.0.groupKey']);
    expect(errorsOf(UsageGroupsPutBody, { groups: [] })).toEqual([{ path: 'groups', code: 'too_small' }]);
  });
});

describe('the register bodies', () => {
  const activity = { kind: 'promotion', title: 'Pekan literasi', heldOn: '2026-02-03', usesLibraryFacility: true, externalSpeaker: false };
  const staff = {
    name: 'Siti Aminah',
    role: 'head',
    isLibrarian: true,
    educationLibrary: true,
    libraryTraining: true,
    competencyCert: false,
    associationMember: false,
    startsOn: '2020-07-01',
  };

  it('take their fields; a patch takes a version and any of them', () => {
    expect(errorsOf(ActivityBody, activity)).toEqual([]);
    expect(errorsOf(StaffBody, staff)).toEqual([]);
    expect(errorsOf(TrainingBody, { title: 'Pelatihan katalogisasi', heldOn: '2025-11-12', hours: 32 })).toEqual([]);
    expect(errorsOf(PartnershipBody, { partner: 'Perpustakaan Daerah', kind: 'mou', startsOn: '2025-01-01' })).toEqual([]);
    expect(errorsOf(BudgetBody, { year: 2026, libraryMinor: 1_500_000_000, currency: 'IDR' })).toEqual([]);
    expect(errorsOf(ActivityPatchBody, { version: 2, title: 'Pekan literasi sekolah' })).toEqual([]);
  });

  it('every one refuses a branch other than none with branch_scope_not_available', () => {
    const bodies: [Parser, Record<string, unknown>][] = [
      [ActivityBody, activity],
      [StaffBody, staff],
      [TrainingBody, { title: 'T', heldOn: '2025-11-12' }],
      [PartnershipBody, { partner: 'P', kind: 'pks', startsOn: '2025-01-01' }],
      [BudgetBody, { year: 2026, libraryMinor: 1, currency: 'IDR' }],
      [DocumentBody, { kind: 'rules', title: 'Tata tertib' }],
      [ActivityPatchBody, { version: 0 }],
    ];
    for (const [schema, body] of bodies) {
      expect(errorsOf(schema, { ...body, branchId: null })).toEqual([]);
      expect(errorsOf(schema, { ...body, branchId: BRANCH })).toEqual([{ path: 'branchId', code: 'branch_scope_not_available' }]);
    }
  });

  it('a document names only the aspects of its kind, each refused at its own index', () => {
    expect(errorsOf(DocumentBody, { kind: 'collection_policy', title: 'Kebijakan', aspectCodes: ['a1', 'a8'] })).toEqual([]);
    expect(errorsOf(DocumentBody, { kind: 'collection_policy', title: 'Kebijakan', aspectCodes: ['a9'] })).toEqual([{ path: 'aspectCodes.0', code: 'invalid' }]);
    expect(errorsOf(DocumentBody, { kind: 'rules', title: 'Tata tertib', aspectCodes: ['a1'] })).toEqual([{ path: 'aspectCodes.0', code: 'invalid' }]);
    expect(errorsOf(DocumentPatchBody, { version: 1, kind: 'head_performance_report', aspectCodes: ['a6', 'a7'] })).toEqual([{ path: 'aspectCodes.1', code: 'invalid' }]);
  });

  it('a budget keeps money within the safe integers and its currency as three capitals', () => {
    expect(errorsOf(BudgetBody, { year: 2026, libraryMinor: Number.MAX_SAFE_INTEGER, currency: 'IDR' })).toEqual([]);
    expect(new Set(errorsOf(BudgetBody, { year: 2026, libraryMinor: Number.MAX_SAFE_INTEGER + 2, currency: 'IDR' }).map((e) => e.path))).toEqual(new Set(['libraryMinor']));
    expect(errorsOf(BudgetBody, { year: 2026, libraryMinor: 1, currency: 'idr' }).map((e) => e.path)).toEqual(['currency']);
  });
});

describe('EvidenceCreateBody', () => {
  const base = { uploadId: UPLOAD, caption: 'Kebijakan pengembangan koleksi' };

  it('links a file to a period indicator or to a register row', () => {
    expect(errorsOf(EvidenceCreateBody, { ...base, periodId: PERIOD, indicatorCode: 'SCH-K3', evidenceCode: 'policy_document' })).toEqual([]);
    expect(errorsOf(EvidenceCreateBody, { ...base, entity: 'library_staff', entityId: newId() })).toEqual([]);
  });

  it('refuses an entity outside the register tables, a missing period or entity, and codes without their parent', () => {
    expect(errorsOf(EvidenceCreateBody, { ...base, entity: 'members', entityId: newId() })).toEqual([{ path: 'entity', code: 'invalid_value' }]);
    expect(errorsOf(EvidenceCreateBody, base)).toEqual([{ path: 'periodId', code: 'required' }]);
    expect(errorsOf(EvidenceCreateBody, { ...base, entity: 'library_staff', entityId: newId(), indicatorCode: 'SCH-T1' })).toEqual([
      { path: 'periodId', code: 'required' },
    ]);
    expect(errorsOf(EvidenceCreateBody, { ...base, periodId: PERIOD, evidenceCode: 'policy_document' })).toEqual([{ path: 'indicatorCode', code: 'required' }]);
    expect(errorsOf(EvidenceCreateBody, { ...base, entity: 'library_staff' })).toEqual([{ path: 'entityId', code: 'required' }]);
  });
});

describe('the SLiMS usage import, the documents and the freeze', () => {
  it('SlimsUsageStartBody: a database or a dump upload, the cut-over day and the member type mapping', () => {
    const db = { host: 'slims.internal', port: 3306, user: 'baca', password: 'rahasia', database: 'slims', tls: false };
    expect(errorsOf(SlimsUsageStartBody, { source: { kind: 'db', db }, cutoverOn: '2026-07-01', memberTypeGroups: { '1': 'student', '2': null } })).toEqual([]);
    expect(errorsOf(SlimsUsageStartBody, { source: { kind: 'dump', uploadId: UPLOAD }, unknownMemberGroup: 'other' })).toEqual([]);
    const longKey = `t${'x'.repeat(36)}`;
    expect(errorsOf(SlimsUsageStartBody, { source: { kind: 'dump', uploadId: UPLOAD }, memberTypeGroups: { [longKey]: 'student' } }).map((e) => e.path)).toEqual([
      `memberTypeGroups.${longKey}`,
    ]);
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), 'public']));
    expect(errorsOf(SlimsUsageStartBody, { source: { kind: 'dump', uploadId: UPLOAD }, memberTypeGroups: many })).toEqual([{ path: 'memberTypeGroups', code: 'too_big' }]);
  });

  it('DossierBody: the request letter alone only as a PDF', () => {
    expect(errorsOf(DossierBody, { format: 'zip_components' })).toEqual([]);
    expect(errorsOf(DossierBody, { format: 'pdf', part: 'request_letter' })).toEqual([]);
    expect(errorsOf(DossierBody, { format: 'zip', part: 'request_letter' })).toEqual([{ path: 'part', code: 'invalid' }]);
  });

  it('FreezeBody: an optional note of at most 191 characters', () => {
    expect(errorsOf(FreezeBody, {})).toEqual([]);
    expect(errorsOf(FreezeBody, { note: 'n'.repeat(192) })).toEqual([{ path: 'note', code: 'too_big' }]);
  });
});
