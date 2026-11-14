import type { InstrumentsResponse, PeriodView } from '@altis/shared/api/accreditation';
import { useApiQuery } from '@/lib/me';

// The reads the Penggunaan Bulanan, Kepatuhan SNP and Cetak tabs share: their query keys and paths, so that a write in
// one place (a usage edit, an import, a mapping change) makes exactly the reads it changed stale.

const enc = encodeURIComponent;

export const accredKeys = {
  instruments: () => ['accreditation', 'instruments'] as const,
  period: (periodId: string) => ['accreditation', 'periods', periodId] as const,
  usage: (periodId: string) => ['accreditation', 'periods', periodId, 'usage'] as const,
  results: (periodId: string) => ['accreditation', 'periods', periodId, 'results'] as const,
  usageGroups: () => ['accreditation', 'usage-groups'] as const,
  evidence: (periodId: string) => ['accreditation', 'evidence', periodId] as const,
};

export const accredPaths = {
  instruments: () => 'accreditation/instruments',
  period: (periodId: string) => `accreditation/periods/${enc(periodId)}`,
  usage: (periodId: string) => `accreditation/periods/${enc(periodId)}/usage`,
  results: (periodId: string) => `accreditation/periods/${enc(periodId)}/results`,
  usageGroups: () => 'accreditation/usage-groups',
  evidence: (periodId: string) => `accreditation/evidence?periodId=${enc(periodId)}`,
};

/** `GET accreditation/periods/:id`. */
export function usePeriod(periodId: string) {
  return useApiQuery<PeriodView>({ queryKey: accredKeys.period(periodId), path: accredPaths.period(periodId) });
}

/** `GET accreditation/instruments`: the instruments and the accreditation settings the workspace needs. */
export function useInstruments() {
  return useApiQuery<InstrumentsResponse>({ queryKey: accredKeys.instruments(), path: accredPaths.instruments(), staleTime: 60_000 });
}
