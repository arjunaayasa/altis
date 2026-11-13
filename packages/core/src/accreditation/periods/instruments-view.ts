import type { DB } from '@altis/db';
import type { SchoolLevel } from '@altis/shared';
import type { IndicatorView, InstrumentsResponse, InstrumentView } from '@altis/shared/api/accreditation';
import { LIBRARY_TYPES, type LibraryType } from '@altis/shared/api/settings';
import type { Kysely } from 'kysely';
import type { AccredSettings } from '../../settings/accreditation.js';
import { ACCRED_INSTRUMENTS } from '../instruments/index.js';
import type { AccredIndicator, AccredInstrument } from '../types.js';
import { instrumentMismatch, periodFieldErrors } from './errors.js';

// The instruments as the workspace lists them (labels as message keys; the screen translates them) with the settings it
// needs, so that a reader of the workspace does not need the settings permission; and which instrument fits a library.
//
// An indicator's catalogue code is `SCH-<concept>` (`SCH-K1`): the code the answers, results, evidence and the screens
// use, whatever number the instrument's own decree prints (`officialNo`).

/** The catalogue code of an indicator. */
export function catalogueCode(indicator: AccredIndicator): string {
  return `SCH-${indicator.code}`;
}

/** The catalogue codes of `instrument`'s indicators, in the instrument's order. */
export function catalogueCodes(instrument: AccredInstrument): string[] {
  return instrument.components.flatMap((c) => c.indicators.map(catalogueCode));
}

/** True for an instrument of school libraries only (it needs the profile's school level). */
export function isSchoolInstrument(instrument: AccredInstrument): boolean {
  return instrument.schoolLevels !== undefined && instrument.libraryTypes.length > 0 && instrument.libraryTypes.every((t) => t === 'sekolah');
}

/**
 * Checks that `instrument` fits a library of `libraryType` (`library.type`; an unset type fits only an instrument for
 * every type) whose profile names `schoolLevel`: the type must be one of the instrument's, and a school instrument needs
 * a level it is for.
 *
 * @throws DomainError `ACCRED_INSTRUMENT_MISMATCH {libraryType, schoolLevel}` for another type or level;
 *   `VALIDATION_FAILED {path: 'profile.schoolLevel', code: 'required'}` for a school instrument without a level
 */
export function assertInstrumentFits(instrument: AccredInstrument, libraryType: LibraryType | null, schoolLevel: SchoolLevel | null): void {
  const typeFits = libraryType === null ? LIBRARY_TYPES.every((t) => instrument.libraryTypes.includes(t)) : instrument.libraryTypes.includes(libraryType);
  if (!typeFits) throw instrumentMismatch(libraryType, schoolLevel);
  assertSchoolLevelFits(instrument, libraryType, schoolLevel);
}

/**
 * The school level part of {@link assertInstrumentFits}: a school instrument needs a level it is for; any other
 * instrument takes no level or one of its own.
 *
 * @throws DomainError as {@link assertInstrumentFits}, `libraryType` only named in the refusal
 */
export function assertSchoolLevelFits(instrument: AccredInstrument, libraryType: LibraryType | null, schoolLevel: SchoolLevel | null): void {
  if (!isSchoolInstrument(instrument)) {
    if (schoolLevel !== null && instrument.schoolLevels !== undefined && !instrument.schoolLevels.includes(schoolLevel)) {
      throw instrumentMismatch(libraryType, schoolLevel);
    }
    return;
  }
  if (schoolLevel === null) throw periodFieldErrors([{ path: 'profile.schoolLevel', code: 'required' }]);
  if (!(instrument.schoolLevels ?? []).includes(schoolLevel)) throw instrumentMismatch(libraryType, schoolLevel);
}

function indicatorView(i: AccredIndicator): IndicatorView {
  return {
    code: catalogueCode(i),
    officialNo: i.officialNo,
    labelKey: i.labelKey,
    manual: i.metric === undefined,
    window: i.window,
    optionKeys: i.optionKeys === undefined ? null : [...i.optionKeys],
    evidence: i.evidence.map((e) => ({
      code: e.code,
      labelKey: e.labelKey,
      kind: e.kind,
      primary: e.primary === true,
      reportId: e.reportId ?? null,
      screen: e.screen ?? null,
    })),
  };
}

function instrumentView(instrument: AccredInstrument, settings: AccredSettings): InstrumentView {
  return {
    id: instrument.id,
    decree: instrument.decree,
    effectiveFrom: instrument.effectiveFrom,
    sourceStatus: instrument.sourceStatus,
    libraryTypes: [...instrument.libraryTypes],
    schoolLevels: [...(instrument.schoolLevels ?? [])],
    periodKinds: [...instrument.periodKinds],
    defaultPeriodKind: instrument.defaultPeriodKind({ libraryType: settings.libraryType, schoolLevel: null }),
    scored: instrument.scored,
    components: instrument.components.map((c) => ({ code: c.code, labelKey: c.labelKey, weight: c.weight, indicators: c.indicators.map(indicatorView) })),
    snp: instrument.snp.map((s) => ({ code: s.code, labelKey: s.labelKey })),
  };
}

/**
 * The instruments of this build, in their order, and the accreditation settings the workspace reads (`settings` as
 * loadAccredSettings gives them). `db` is not read: every value comes from the instruments and `settings`.
 */
export function listInstruments(db: Kysely<DB>, settings: AccredSettings): InstrumentsResponse {
  return {
    instruments: ACCRED_INSTRUMENTS.map((i) => instrumentView(i, settings)),
    config: {
      libraryType: settings.libraryType,
      schoolYearStartMonth: settings.schoolYearStartMonth,
      usedUnit: settings.usedUnit,
      evidenceMaxMb: settings.evidenceMaxMb,
      componentLimitMb: settings.componentLimitMb,
      liveFrom: settings.liveFrom,
      unknownMemberGroupDefault: settings.unknownMemberGroupDefault,
      dedupeMinutes: settings.dedupeMinutes,
      dedupeLegacy: settings.dedupeLegacy,
    },
  };
}
