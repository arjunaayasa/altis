import { addDays, addMonths, endOfMonth, monthsBetween, type PeriodKind } from '@altis/shared';
import { periodFieldErrors, periodSpanRefused, type PeriodFieldError } from './errors.js';

// The span of an accreditation period from its kind (spec §10.5): a school year starts on the first day of the month
// `accreditation.schoolYearStartMonth` and lasts twelve months; a calendar year runs from 1 January to 31 December; the
// twelve months are the full calendar months ending with the chosen month; a free span is taken as given, up to 24
// calendar months (counted as the months it touches, both ends included). Each kind reads only its own inputs.

/** The longest free span, in calendar months. */
export const CUSTOM_SPAN_MAX_MONTHS = 24;

/** What a period's span is made from: `startYear` (school or calendar year), `endMonth` (twelve months), or the two days. */
export interface PeriodSpanInput {
  startYear?: number;
  endMonth?: string;
  startsOn?: string;
  endsOn?: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The first and last day of a period of `kind`.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'startYear' | 'endMonth' | 'startsOn' | 'endsOn', code: 'required'}`
 *   for an input the kind needs and the body lacks; `{path: 'endsOn', code: 'invalid'}` for a free span ending before
 *   it starts; `ACCRED_PERIOD_SPAN {kind: 'custom', months}` for a free span over 24 calendar months
 */
export function periodSpan(kind: PeriodKind, input: PeriodSpanInput, schoolYearStartMonth: number): { startsOn: string; endsOn: string } {
  switch (kind) {
    case 'school_year': {
      if (input.startYear === undefined) throw periodFieldErrors([{ path: 'startYear', code: 'required' }]);
      const startsOn = `${input.startYear}-${pad2(schoolYearStartMonth)}-01`;
      return { startsOn, endsOn: addDays(addMonths(startsOn, 12), -1) };
    }
    case 'calendar_year': {
      if (input.startYear === undefined) throw periodFieldErrors([{ path: 'startYear', code: 'required' }]);
      return { startsOn: `${input.startYear}-01-01`, endsOn: `${input.startYear}-12-31` };
    }
    case 'rolling_12': {
      if (input.endMonth === undefined) throw periodFieldErrors([{ path: 'endMonth', code: 'required' }]);
      return { startsOn: addMonths(`${input.endMonth}-01`, -11), endsOn: endOfMonth(input.endMonth) };
    }
    case 'custom': {
      const missing: PeriodFieldError[] = [];
      if (input.startsOn === undefined) missing.push({ path: 'startsOn', code: 'required' });
      if (input.endsOn === undefined) missing.push({ path: 'endsOn', code: 'required' });
      if (input.startsOn === undefined || input.endsOn === undefined) throw periodFieldErrors(missing);
      if (input.endsOn < input.startsOn) throw periodFieldErrors([{ path: 'endsOn', code: 'invalid' }]);
      const months = monthsBetween(input.startsOn, input.endsOn);
      if (months > CUSTOM_SPAN_MAX_MONTHS) throw periodSpanRefused('custom', months);
      return { startsOn: input.startsOn, endsOn: input.endsOn };
    }
  }
}

/** The calendar months a span touches, both ends included. */
export function spanMonths(span: { startsOn: string; endsOn: string }): number {
  return monthsBetween(span.startsOn, span.endsOn);
}
