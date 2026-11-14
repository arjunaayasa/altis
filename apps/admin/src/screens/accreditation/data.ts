import type {
  InstrumentsResponse,
  InstrumentView,
  PeriodListResponse,
  PeriodView,
  ResultsView,
  SnapshotListResponse,
} from '@altis/shared/api/accreditation';
import type { EventItem } from '@altis/shared/api/events';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useLocale, type TKey, type Translate } from '@/i18n';
import { ApiError } from '@/lib/api';
import { isMessageKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';

/**
 * The data of the accreditation workspace, shared by its frame and its tabs: the query keys and reads of the
 * instruments, the periods, one period, its results and its snapshots; what an `accreditation` event makes stale; and
 * the formatting the tabs share (the decree's own item number, numbers, scores and calendar days).
 *
 * Every read of a period sits under `['accreditation', 'periods']`, so one invalidation of that key reads the list, the
 * open period, its results and its snapshots again: the frame does it when an evaluation ends or the server says new
 * results are in, and a write of the period's data does it after it was stored.
 */

export const accreditationKeys = {
  all: () => ['accreditation'] as const,
  instruments: () => ['accreditation', 'instruments'] as const,
  periods: () => ['accreditation', 'periods'] as const,
  period: (id: string) => ['accreditation', 'periods', id] as const,
  results: (id: string) => ['accreditation', 'periods', id, 'results'] as const,
  snapshots: (id: string) => ['accreditation', 'periods', id, 'snapshots'] as const,
};

/** The API path of period `id`, with `rest` (`/results`, `/freeze`, …) after it. */
export function periodPath(id: string, rest = ''): string {
  return `accreditation/periods/${encodeURIComponent(id)}${rest}`;
}

/** A refusal is the answer; only a lost connection is worth asking again. */
export const retry = (count: number, e: unknown): boolean => !(e instanceof ApiError) && count < 2;

/** The instruments of this build and the accreditation settings the workspace reads. */
export function useInstruments() {
  return useApiQuery<InstrumentsResponse>({ queryKey: accreditationKeys.instruments(), path: 'accreditation/instruments', staleTime: 5 * 60_000, retry });
}

/** The live periods, newest first. */
export function usePeriods() {
  return useApiQuery<PeriodListResponse>({ queryKey: accreditationKeys.periods(), path: 'accreditation/periods', retry });
}

/** One period (its profile, population, facilities, status, when its results were computed and whether they are stale). */
export function usePeriod(id: string, enabled = true) {
  return useApiQuery<PeriodView>({ queryKey: accreditationKeys.period(id), path: periodPath(id), enabled: enabled && id !== '', retry });
}

/** A period's results: the indicators, the prerequisites, the score and the missing evidence. */
export function useResults(id: string, enabled = true) {
  return useApiQuery<ResultsView>({ queryKey: accreditationKeys.results(id), path: periodPath(id, '/results'), enabled: enabled && id !== '', retry });
}

/** A period's snapshots, newest first. */
export function useSnapshots(id: string, enabled = true) {
  return useApiQuery<SnapshotListResponse>({ queryKey: accreditationKeys.snapshots(id), path: periodPath(id, '/snapshots'), enabled: enabled && id !== '', retry });
}

/** The instrument `id` of `instruments`, when this build has it. */
export function instrumentOf(instruments: InstrumentsResponse | undefined, id: string): InstrumentView | undefined {
  return instruments?.instruments.find((i) => i.id === id);
}

/**
 * The query keys an event of the `accreditation` channel makes stale: new results of a period (`{periodId}`) are read
 * again with the period, the list and the snapshots, all under {@link accreditationKeys.periods}. Anything else, or an
 * event without a period, changes nothing.
 */
export function accreditationEventKeys(e: EventItem): QueryKey[] {
  if (e.type !== 'accreditation.results.changed' || typeof e.payload['periodId'] !== 'string') return [];
  return [accreditationKeys.periods()];
}

/** Reads every period query again (the list, the periods, their results and snapshots). */
export function useRefreshPeriods(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: accreditationKeys.periods() }), [queryClient]);
}

// ---- labels ----------------------------------------------------------------------------------------------------------

/** The short component names the decree's item numbers are printed with ("Pelayanan butir 7"). */
const COMPONENT_SHORT: Readonly<Record<string, TKey>> = {
  K: 'accreditation.workspace.component_short.K',
  SP: 'accreditation.workspace.component_short.SP',
  L: 'accreditation.workspace.component_short.L',
  T: 'accreditation.workspace.component_short.T',
  F: 'accreditation.workspace.component_short.F',
  G: 'accreditation.workspace.component_short.G',
  profil: 'accreditation.workspace.component_short.profil',
};

/** The short name of component `code` (the code itself for one this screen does not know). */
export function componentShort(t: Translate, code: string): string {
  const key = COMPONENT_SHORT[code];
  return key === undefined ? code : t(key);
}

/** The full name of component `code` (`accred.component.<code>`), else its short name. */
export function componentLabel(t: Translate, code: string): string {
  const key = `accred.component.${code}`;
  return isMessageKey(key) ? t(key) : componentShort(t, code);
}

/**
 * The decree's own number of an indicator with its component, as the instrument prints it: `L7 · Pelayanan butir 7`.
 * `officialNo` is the decree's number (`L7`); the item number is its digits.
 */
export function officialLabel(t: Translate, officialNo: string, component: string): string {
  const n = officialNo.replace(/^[A-Za-z]+/, '');
  return t('accreditation.workspace.official', { no: officialNo, component: componentShort(t, component), n: n === '' ? officialNo : n });
}

/** The text of a message key the server named (an indicator, an option, an evidence item, a note): the key when unknown. */
export function keyText(t: Translate, key: string, params?: Readonly<Record<string, string | number>>): string {
  return isMessageKey(key) ? t(key, params) : key;
}

// ---- formatting --------------------------------------------------------------------------------------------------------

export interface Formats {
  /** A whole number (`1.250`). */
  number(n: number): string;
  /** A decimal the server sends as text (`'70.45'` → `70,45`), with as many decimals as it has. */
  decimal(text: string): string;
  /** A calendar day `YYYY-MM-DD` (`30 Jun 2026`); the text itself when it is not one. */
  day(text: string): string;
  /** A month `YYYY-MM` (`Jun 2026`). */
  month(text: string): string;
  /** An instant (epoch milliseconds) as a day and a time. */
  dateTime(ms: number): string;
}

/** The number and date formats of the UI language. */
export function useFormats(): Formats {
  const locale = useLocale();
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'id-ID';
    const whole = new Intl.NumberFormat(tag, { maximumFractionDigits: 2 });
    const days = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' });
    const months = new Intl.DateTimeFormat(tag, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const times = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' });
    return {
      number: (n) => whole.format(n),
      decimal: (text) => {
        const value = Number(text);
        if (!Number.isFinite(value)) return text;
        const decimals = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
        return new Intl.NumberFormat(tag, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
      },
      day: (text) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
        return m === null ? text : days.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      },
      month: (text) => {
        const m = /^(\d{4})-(\d{2})$/.exec(text);
        return m === null ? text : months.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      },
      dateTime: (ms) => times.format(ms),
    };
  }, [locale]);
}

/** The parameters of a note with its numbers written in the UI language. */
export function noteParams(formats: Formats, params: Readonly<Record<string, string | number>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params ?? {})) out[name] = typeof value === 'number' ? formats.number(value) : value;
  return out;
}
