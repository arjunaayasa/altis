import { DomainError } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import type { z } from 'zod';

// The refusals of the period writers. Field errors are VALIDATION_FAILED with `errors [{path, code}]`; the problem body
// never carries `meta`, so the domain refusals also name their values in the bilingual detail.

/** One field error: where (`profile.photos.front`) and what (`required`, `not_found`, `invalid`, …). */
export interface PeriodFieldError {
  path: string;
  code: string;
}

/** VALIDATION_FAILED with `errors`. */
export function periodFieldErrors(errors: readonly PeriodFieldError[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data belum benar / The data is not valid',
    meta: { errors: errors.map((e) => ({ path: e.path, code: e.code })) },
  });
}

/** `body` parsed with the strict contract `schema`, or VALIDATION_FAILED with its issues as `{path, code}`. */
export function parsePeriodBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw periodFieldErrors(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
}

export function periodNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Periode akreditasi tidak ditemukan / The accreditation period was not found' });
}

export function periodStale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Periode ini sudah diubah orang lain; muat ulang / This period was changed by someone else; reload it',
  });
}

/** 422 ACCRED_PERIOD_SPAN: the instrument does not take a period of this kind or this length. */
export function periodSpanRefused(kind: string, months: number): DomainError {
  return new DomainError('ACCRED_PERIOD_SPAN', {
    detail:
      `Instrumen ini tidak menerima periode jenis ${kind} sepanjang ${months} bulan / ` +
      `This instrument does not take a ${kind} period of ${months} months`,
    meta: { kind, months },
  });
}

/** 422 ACCRED_INSTRUMENT_MISMATCH: the instrument is not for this library type or school level. */
export function instrumentMismatch(libraryType: string | null, schoolLevel: string | null): DomainError {
  const type = libraryType ?? '-';
  const level = schoolLevel ?? '-';
  return new DomainError('ACCRED_INSTRUMENT_MISMATCH', {
    detail:
      `Instrumen ini bukan untuk jenis perpustakaan ${type} dan jenjang ${level} / ` +
      `This instrument is not for library type ${type} and school level ${level}`,
    meta: { libraryType, schoolLevel },
  });
}
