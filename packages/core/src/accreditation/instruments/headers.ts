import { PERIOD_KINDS, SCHOOL_LEVELS } from '@altis/shared';
import { LIBRARY_TYPES } from '@altis/shared/api/settings';
import type { AccredInstrument } from '../types.js';

// The headers of the instruments this edition ships: everything of an instrument but its components and standards.
// The three school instruments of 2025 apply to school libraries, one level each, are scored, and accept a school
// year or the twelve months ending in a chosen month; `general-stats` is for every other library (and a school whose
// level has no instrument): it prints the statistics and the profile, unscored, over any period kind.

/** An instrument without its components and standards. */
export type AccredInstrumentHeader = Omit<AccredInstrument, 'components' | 'snp'>;

/** The forms the school instruments print: the submission form, the profile and the certificate's name. */
const SCHOOL_FORMS = Object.freeze(['submission', 'profile', 'certificate_name'] as const);

/** The period kinds a scored school instrument accepts. */
const SCHOOL_PERIOD_KINDS = Object.freeze(['school_year', 'rolling_12'] as const);

const schoolYear = (): 'school_year' => 'school_year';

/** The instrument for primary school libraries (SD/MI). */
export const SCH_SD_2025_HEADER: AccredInstrumentHeader = Object.freeze<AccredInstrumentHeader>({
  id: 'sch-sd-2025',
  decree: 'Kepka Perpusnas 157/2025',
  decreeTitle:
    'Keputusan Kepala Perpustakaan Nasional Nomor 157 Tahun 2025 tentang Instrumen Akreditasi Perpustakaan Sekolah Dasar/Madrasah Ibtidaiyah',
  effectiveFrom: '2026-01-02',
  sourceStatus: 'P-copy',
  libraryTypes: Object.freeze(['sekolah'] as const),
  schoolLevels: Object.freeze(['sd_mi'] as const),
  periodKinds: SCHOOL_PERIOD_KINDS,
  defaultPeriodKind: schoolYear,
  forms: SCHOOL_FORMS,
  scored: true,
});

/** The instrument for lower secondary school libraries (SMP/MTs). */
export const SCH_SMP_2025_HEADER: AccredInstrumentHeader = Object.freeze<AccredInstrumentHeader>({
  id: 'sch-smp-2025',
  decree: 'Kepka Perpusnas 158/2025',
  decreeTitle:
    'Keputusan Kepala Perpustakaan Nasional Nomor 158 Tahun 2025 tentang Instrumen Akreditasi Perpustakaan Sekolah Menengah Pertama/Madrasah Tsanawiyah',
  effectiveFrom: '2026-01-02',
  sourceStatus: 'P-copy',
  libraryTypes: Object.freeze(['sekolah'] as const),
  schoolLevels: Object.freeze(['smp_mts'] as const),
  periodKinds: SCHOOL_PERIOD_KINDS,
  defaultPeriodKind: schoolYear,
  forms: SCHOOL_FORMS,
  scored: true,
});

/** The instrument for upper secondary school libraries (SMA/SMK/MA/MAK). */
export const SCH_SMA_2025_HEADER: AccredInstrumentHeader = Object.freeze<AccredInstrumentHeader>({
  id: 'sch-sma-2025',
  decree: 'Kepka Perpusnas 159/2025',
  decreeTitle:
    'Keputusan Kepala Perpustakaan Nasional Nomor 159 Tahun 2025 tentang Instrumen Akreditasi Perpustakaan Sekolah Menengah Atas/Sekolah Menengah Kejuruan/Madrasah Aliyah/Madrasah Aliyah Kejuruan',
  effectiveFrom: '2026-01-02',
  sourceStatus: 'P-copy',
  libraryTypes: Object.freeze(['sekolah'] as const),
  schoolLevels: Object.freeze(['sma_smk_ma'] as const),
  periodKinds: SCHOOL_PERIOD_KINDS,
  defaultPeriodKind: schoolYear,
  forms: SCHOOL_FORMS,
  scored: true,
});

/**
 * The statistics mode for every library type and level: no indicators and no score, the profile form only, any
 * period kind; a school year by default for a school library, else a calendar year.
 */
export const GENERAL_STATS_HEADER: AccredInstrumentHeader = Object.freeze<AccredInstrumentHeader>({
  id: 'general-stats',
  decree: 'Peraturan Perpusnas 2/2022',
  decreeTitle: 'Peraturan Perpustakaan Nasional Nomor 2 Tahun 2022',
  effectiveFrom: '2026-01-02',
  sourceStatus: 'P',
  libraryTypes: LIBRARY_TYPES,
  schoolLevels: SCHOOL_LEVELS,
  periodKinds: PERIOD_KINDS,
  defaultPeriodKind: (o) => (o.libraryType === 'sekolah' ? 'school_year' : 'calendar_year'),
  forms: Object.freeze(['profile'] as const),
  scored: false,
});
