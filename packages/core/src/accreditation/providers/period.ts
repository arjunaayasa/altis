import type { NoteRef } from '@altis/shared/api/accreditation';
import { metricsOfProvider, type AccredMetricId } from '../metric-ids.js';
import type { AccredMetricContext, AccredMetricProvider, AccredMetricValue } from '../types.js';
import { intDiv, metricValue, note, periodPopulation } from './registers-metrics.js';

// The `period` metric provider: the entries of the period itself (the school population from Dapodik/EMIS, the
// facilities, the services, the profile's NPP), as the librarian entered them. It reads no table.
//
// - The school population is students + teachers + education staff, and no value while any part is missing.
// - A share is cut to a whole percent once, at the end; a missing entry names itself in the note, so the librarian
//   knows what to fill in on the Population & Facilities tab (the names are Indonesian: the documents that print the
//   notes always are).
// - The services count each service code once.

type PeriodMetricId = Extract<AccredMetricId, `period.${string}`>;

/** The Indonesian names of the period's entries, for the note that one is missing. */
const FIELDS = Object.freeze({
  ict_devices: 'jumlah perangkat TIK milik perpustakaan',
  teachers: 'jumlah guru',
  teachers_using: 'jumlah guru yang memakai perpustakaan dalam RPP',
  services: 'jenis layanan perpustakaan',
  bandwidth_mbps: 'kecepatan internet (Mbps)',
  hours_per_week: 'jam layanan per minggu',
  classes: 'jumlah rombongan belajar',
  floor_m2: 'luas ruang perpustakaan (m²)',
  user_pcs: 'jumlah komputer untuk pemustaka',
  scanners: 'jumlah pemindai barkod',
} as const);

/** The note that the entries `fields` are missing (one note naming them all). */
const missing = (...fields: (keyof typeof FIELDS)[]): NoteRef => note('input_missing', { field: fields.map((f) => FIELDS[f]).join(' dan ') });

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

/** The distinct service codes of the stored JSON list, or null when there is none. */
function servicesOf(json: string | null): number | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return new Set(parsed.filter((c): c is string => typeof c === 'string' && c !== '')).size;
}

const manual = (id: AccredMetricId, value: number | null, o: Parameters<typeof metricValue>[3] = {}): AccredMetricValue => metricValue(id, value, 'manual', o);

/** A stored entry as it is: no value, and the note naming it, while it is empty. */
const stored =
  (field: keyof typeof FIELDS & keyof AccredMetricContext['period']) =>
  (ctx: AccredMetricContext, id: AccredMetricId): AccredMetricValue => {
    const v = num(ctx.period[field] as number | null);
    return v === null ? manual(id, null, { notes: [missing(field)] }) : manual(id, v);
  };

/** A share `num × 100 ÷ den` cut to a whole percent. */
const share = (id: AccredMetricId, numerator: number, denominator: number): AccredMetricValue =>
  manual(id, intDiv(numerator * 100, denominator), { numerator, denominator, notes: [note('truncated')] });

const PERIOD_METRICS: Readonly<Record<PeriodMetricId, (ctx: AccredMetricContext, id: AccredMetricId) => AccredMetricValue>> = Object.freeze({
  'period.population': (ctx, id) => {
    const population = periodPopulation(ctx.period);
    return population === null ? manual(id, null, { notes: [note('population_missing')] }) : manual(id, population);
  },
  'period.ict_devices_pct': (ctx, id) => {
    const devices = num(ctx.period.ict_devices);
    const population = periodPopulation(ctx.period);
    const notes: NoteRef[] = [];
    if (devices === null) notes.push(missing('ict_devices'));
    if (population === null || population === 0) notes.push(note('population_missing'));
    if (devices === null || population === null || population === 0) return manual(id, null, { notes });
    return share(id, devices, population);
  },
  'period.bandwidth_mbps': stored('bandwidth_mbps'),
  'period.services_count': (ctx, id) => {
    const count = servicesOf(ctx.period.services);
    return count === null ? manual(id, null, { notes: [missing('services')] }) : manual(id, count);
  },
  'period.teachers_using_pct': (ctx, id) => {
    const teachers = num(ctx.period.teachers);
    const using = num(ctx.period.teachers_using);
    const absent = [...(teachers === null ? (['teachers'] as const) : []), ...(using === null ? (['teachers_using'] as const) : [])];
    if (absent.length > 0) return manual(id, null, { notes: [missing(...absent)] });
    if (teachers === 0) return manual(id, null);
    return share(id, using!, teachers!);
  },
  'period.npp_present': (ctx, id) => manual(id, (ctx.profile.npp ?? '').trim() === '' ? 0 : 1),
  'period.hours_per_week': stored('hours_per_week'),
  'period.classes': stored('classes'),
  'period.floor_m2': stored('floor_m2'),
  'period.user_pcs': stored('user_pcs'),
  'period.scanners': stored('scanners'),
});

/** The period metrics among `ids`, in the order asked. */
function computePeriodMetrics(ctx: AccredMetricContext, ids: readonly AccredMetricId[]): Map<AccredMetricId, AccredMetricValue> {
  const out = new Map<AccredMetricId, AccredMetricValue>();
  for (const id of ids) {
    const fn = (PERIOD_METRICS as Partial<Record<AccredMetricId, (ctx: AccredMetricContext, id: AccredMetricId) => AccredMetricValue>>)[id];
    if (fn !== undefined && !out.has(id)) out.set(id, fn(ctx, id));
  }
  return out;
}

export const periodProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'period',
  metrics: metricsOfProvider('period'),
  compute: async (ctx, ids) => ({ done: true, values: computePeriodMetrics(ctx, ids) }),
});
