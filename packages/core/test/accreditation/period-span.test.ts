import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { periodSpan } from '../../src/accreditation/periods/span.js';

// The span of a new accreditation period from its kind: a school year from the configured start month, a calendar
// year, the twelve full months ending in a chosen month, or a free span of at most 24 calendar months.

/** What `fn` threw: `{code, errors?, meta?}` for a DomainError. */
function refusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return { code: e.code, ...(e.meta?.['errors'] === undefined ? { meta: e.meta } : { errors: e.meta['errors'] }) };
  }
  return 'returned';
}

describe('periodSpan', () => {
  it('a school year starts on the first day of the start month and ends the day before the same day a year later', () => {
    expect(periodSpan('school_year', { startYear: 2025 }, 7)).toEqual({ startsOn: '2025-07-01', endsOn: '2026-06-30' });
    expect(periodSpan('school_year', { startYear: 2025 }, 1)).toEqual({ startsOn: '2025-01-01', endsOn: '2025-12-31' });
    expect(periodSpan('school_year', { startYear: 2023 }, 3)).toEqual({ startsOn: '2023-03-01', endsOn: '2024-02-29' });
  });

  it('a calendar year runs from 1 January to 31 December', () => {
    expect(periodSpan('calendar_year', { startYear: 2026 }, 7)).toEqual({ startsOn: '2026-01-01', endsOn: '2026-12-31' });
  });

  it('twelve months: the twelve full months ending with the chosen month, a leap February included', () => {
    expect(periodSpan('rolling_12', { endMonth: '2026-02' }, 7)).toEqual({ startsOn: '2025-03-01', endsOn: '2026-02-28' });
    expect(periodSpan('rolling_12', { endMonth: '2024-02' }, 7)).toEqual({ startsOn: '2023-03-01', endsOn: '2024-02-29' });
    expect(periodSpan('rolling_12', { endMonth: '2025-12' }, 7)).toEqual({ startsOn: '2025-01-01', endsOn: '2025-12-31' });
  });

  it('a free span is taken as given up to 24 calendar months', () => {
    expect(periodSpan('custom', { startsOn: '2024-01-15', endsOn: '2025-12-31' }, 7)).toEqual({ startsOn: '2024-01-15', endsOn: '2025-12-31' });
    expect(periodSpan('custom', { startsOn: '2025-03-10', endsOn: '2025-03-10' }, 7)).toEqual({ startsOn: '2025-03-10', endsOn: '2025-03-10' });
  });

  it('a free span over 24 calendar months → ACCRED_PERIOD_SPAN with the months it touches', () => {
    expect(refusal(() => periodSpan('custom', { startsOn: '2024-01-01', endsOn: '2026-02-15' }, 7))).toEqual({
      code: 'ACCRED_PERIOD_SPAN',
      meta: { kind: 'custom', months: 26 },
    });
    expect(refusal(() => periodSpan('custom', { startsOn: '2024-01-01', endsOn: '2026-01-01' }, 7))).toEqual({
      code: 'ACCRED_PERIOD_SPAN',
      meta: { kind: 'custom', months: 25 },
    });
  });

  it('a free span that ends before it starts → endsOn invalid', () => {
    expect(refusal(() => periodSpan('custom', { startsOn: '2025-03-10', endsOn: '2025-03-09' }, 7))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'endsOn', code: 'invalid' }],
    });
  });

  it('the input a kind needs is required: startYear, endMonth, startsOn and endsOn', () => {
    const required = (path: string) => ({ code: 'VALIDATION_FAILED', errors: [{ path, code: 'required' }] });
    expect(refusal(() => periodSpan('school_year', { endMonth: '2026-06' }, 7))).toEqual(required('startYear'));
    expect(refusal(() => periodSpan('calendar_year', {}, 7))).toEqual(required('startYear'));
    expect(refusal(() => periodSpan('rolling_12', { startYear: 2025 }, 7))).toEqual(required('endMonth'));
    expect(refusal(() => periodSpan('custom', { endsOn: '2025-12-31' }, 7))).toEqual(required('startsOn'));
    expect(refusal(() => periodSpan('custom', { startsOn: '2025-01-01' }, 7))).toEqual(required('endsOn'));
    expect(refusal(() => periodSpan('custom', {}, 7))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [
        { path: 'startsOn', code: 'required' },
        { path: 'endsOn', code: 'required' },
      ],
    });
  });
});
