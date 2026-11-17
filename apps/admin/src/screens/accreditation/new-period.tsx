import { addDays, addMonths, endOfMonth, vocabKey, type PeriodKind, type SchoolLevel } from '@altis/shared';
import type { InstrumentsResponse, InstrumentView, PeriodCreateBody, PeriodSummaryView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type JSX } from 'react';
import { ProblemAlert } from '@/components/form-field';
import { BackLink, Callout, ErrorState, FORM_FULL, FormBar, LoadingState, PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { useFormats, useInstruments, usePeriods, useRefreshPeriods, type Formats } from './data';
import { SelectField, TextField } from './period-form';

/**
 * Periode akreditasi baru (spec §6 "Akreditasi", §10.2, §10.5), `/admin/accreditation/new`, for a holder of
 * `accreditation.workspace.manage`:
 *
 * - the name, the instrument (each by its decree: a school level's scored instrument, or the unscored statistics
 *   mode), the period kind the instrument accepts (a scored instrument takes a school year or twelve months; the
 *   statistics mode also a calendar year and a free span of up to 24 months), and the input that kind needs: the year
 *   a school year starts, a calendar year, the last of twelve months, or the first and last day; the span it makes is
 *   shown before sending;
 * - the school level of the profile (a school instrument needs its own level);
 * - which period the profile and the population are copied from (by default the latest).
 *
 * Whether the instrument fits the library is the server's to decide: its refusal (another library type or level) is
 * shown. A created period opens in the workspace.
 */

const BASE = '/admin/accreditation';

interface Draft {
  name: string;
  instrumentId: string;
  kind: PeriodKind | '';
  year: string;
  endMonth: string;
  startsOn: string;
  endsOn: string;
  schoolLevel: SchoolLevel | '';
  copyFrom: string;
}

/** The fields of the form a refusal can name, by the body path. */
const FIELDS: Readonly<Record<string, keyof Draft>> = {
  name: 'name',
  instrumentId: 'instrumentId',
  kind: 'kind',
  startYear: 'year',
  endMonth: 'endMonth',
  startsOn: 'startsOn',
  endsOn: 'endsOn',
  'profile.schoolLevel': 'schoolLevel',
  copyFromPeriodId: 'copyFrom',
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Today in the browser, `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The year a new period of `kind` starts by default: the school year under way, or this calendar year. */
function defaultYear(kind: PeriodKind | '', startMonth: number): string {
  const [y = 0, m = 1] = today().split('-').map(Number);
  if (kind === 'school_year') return String(m >= startMonth ? y : y - 1);
  return String(y);
}

/** The last full month before this one, `YYYY-MM`. */
function lastMonth(): string {
  return addMonths(`${today().slice(0, 7)}-01`, -1).slice(0, 7);
}

/** The instrument a new period starts with: the latest period's, else the first one for the library's type. */
function defaultInstrument(r: InstrumentsResponse, periods: readonly PeriodSummaryView[]): InstrumentView | undefined {
  const latest = periods[0];
  const ofLatest = latest === undefined ? undefined : r.instruments.find((i) => i.id === latest.instrumentId);
  if (ofLatest !== undefined) return ofLatest;
  const type = r.config.libraryType;
  return r.instruments.find((i) => type === null || i.libraryTypes.includes(type)) ?? r.instruments[0];
}

/** True for an instrument of school libraries only (it needs a school level). */
const isSchoolInstrument = (i: InstrumentView | undefined): boolean =>
  i !== undefined && i.libraryTypes.length > 0 && i.libraryTypes.every((x) => x === 'sekolah') && i.schoolLevels.length > 0;

/**
 * The draft for instrument `i`: its default kind with that kind's default year, and the school level: the one level of
 * a school instrument, else the level already chosen when `i` takes it, else none.
 */
function forInstrument(draft: Draft, i: InstrumentView | undefined, startMonth: number): Draft {
  const kind = i?.defaultPeriodKind ?? '';
  const levels = i?.schoolLevels ?? [];
  const only = isSchoolInstrument(i) && levels.length === 1 ? levels[0] : undefined;
  const level: SchoolLevel | '' = only ?? (draft.schoolLevel !== '' && levels.includes(draft.schoolLevel) ? draft.schoolLevel : '');
  return { ...draft, instrumentId: i?.id ?? '', kind, year: defaultYear(kind, startMonth), schoolLevel: level };
}

/** The label of an instrument in the picker: its decree, and the school levels it is for or that it is unscored. */
function instrumentLabel(t: Translate, i: InstrumentView): string {
  if (!i.scored) return t('accreditation.new.instrument_general', { decree: i.decree });
  const levels = i.schoolLevels.map((l) => t(vocabKey('school_level', l))).join(', ');
  return t('accreditation.new.instrument_school', { decree: i.decree, levels });
}

/** The span the draft makes, as the server will compute it; null while an input is missing or wrong. */
function spanOf(draft: Draft, startMonth: number): { from: string; to: string } | null {
  const year = /^\d{4}$/.test(draft.year) ? Number(draft.year) : null;
  switch (draft.kind) {
    case 'school_year': {
      if (year === null) return null;
      const from = `${year}-${pad2(startMonth)}-01`;
      return { from, to: addDays(addMonths(from, 12), -1) };
    }
    case 'calendar_year':
      return year === null ? null : { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'rolling_12':
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(draft.endMonth) ? { from: addMonths(`${draft.endMonth}-01`, -11), to: endOfMonth(draft.endMonth) } : null;
    case 'custom':
      return draft.startsOn !== '' && draft.endsOn !== '' && draft.endsOn >= draft.startsOn ? { from: draft.startsOn, to: draft.endsOn } : null;
    default:
      return null;
  }
}

export function PeriodCreateScreen(): JSX.Element {
  const t = useT();
  const me = useMe();
  const instruments = useInstruments();
  const periods = usePeriods();
  const canManage = holds(me, 'accreditation.workspace.manage');

  let body: JSX.Element;
  if (!canManage) body = <Callout tone="bad" role="alert" title={t('accreditation.new.forbidden')} />;
  else if (instruments.data === undefined || periods.data === undefined) {
    const failed = instruments.isError ? instruments : periods.isError ? periods : null;
    body = failed !== null ? <ErrorState error={failed.error} onRetry={() => void failed.refetch()} retrying={failed.isFetching} /> : <LoadingState />;
  } else body = <CreateForm instruments={instruments.data} periods={periods.data.periods} />;

  return (
    <div className="grid max-w-3xl gap-6">
      <BackLink to={BASE}>{t('accreditation.new.back')}</BackLink>
      <PageHead title={t('accreditation.new.title')} intro={t('accreditation.new.description')} />
      {body}
    </div>
  );
}

function CreateForm({ instruments, periods }: { instruments: InstrumentsResponse; periods: readonly PeriodSummaryView[] }) {
  const t = useT();
  const f = useFormats();
  const navigate = useNavigate();
  const refresh = useRefreshPeriods();
  const startMonth = instruments.config.schoolYearStartMonth;
  const [draft, setDraft] = useState<Draft>(() =>
    forInstrument(
      { name: '', instrumentId: '', kind: '', year: '', endMonth: lastMonth(), startsOn: '', endsOn: '', schoolLevel: '', copyFrom: '' },
      defaultInstrument(instruments, periods),
      startMonth,
    ),
  );
  const [errors, setErrors] = useState<Readonly<Partial<Record<keyof Draft, string>>>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const instrument = instruments.instruments.find((i) => i.id === draft.instrumentId);
  const school = isSchoolInstrument(instrument);
  const span = spanOf(draft, startMonth);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const setKind = (kind: PeriodKind): void => {
    setDraft((d) => ({ ...d, kind, year: d.kind === kind ? d.year : defaultYear(kind, startMonth) }));
    setErrors({});
  };

  const check = (): Partial<Record<keyof Draft, string>> => {
    const found: Partial<Record<keyof Draft, string>> = {};
    if (draft.name.trim() === '') found.name = 'form.error.required';
    if (draft.instrumentId === '') found.instrumentId = 'form.error.required';
    if (draft.kind === '') found.kind = 'form.error.required';
    if (draft.kind === 'school_year' || draft.kind === 'calendar_year') {
      if (draft.year.trim() === '') found.year = 'form.error.required';
      else if (!/^\d{4}$/.test(draft.year.trim()) || Number(draft.year) < 1900 || Number(draft.year) > 2100) found.year = 'form.error.invalid';
    }
    if (draft.kind === 'rolling_12' && draft.endMonth === '') found.endMonth = 'form.error.required';
    if (draft.kind === 'custom') {
      if (draft.startsOn === '') found.startsOn = 'form.error.required';
      if (draft.endsOn === '') found.endsOn = 'form.error.required';
      else if (draft.startsOn !== '' && draft.endsOn < draft.startsOn) found.endsOn = 'form.error.invalid';
    }
    if (school && draft.schoolLevel === '') found.schoolLevel = 'form.error.required';
    return found;
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    const found = check();
    setErrors(found);
    if (Object.keys(found).length > 0 || draft.kind === '') return;
    const body: PeriodCreateBody = { name: draft.name.trim(), instrumentId: draft.instrumentId, kind: draft.kind };
    if (draft.kind === 'school_year' || draft.kind === 'calendar_year') body.startYear = Number(draft.year);
    if (draft.kind === 'rolling_12') body.endMonth = draft.endMonth;
    if (draft.kind === 'custom') {
      body.startsOn = draft.startsOn;
      body.endsOn = draft.endsOn;
    }
    if (draft.schoolLevel !== '') body.profile = { schoolLevel: draft.schoolLevel };
    if (draft.copyFrom !== '') body.copyFromPeriodId = draft.copyFrom;
    setBusy(true);
    try {
      const created = await api<StoreResponse>('POST', 'accreditation/periods', body);
      await refresh();
      void navigate({ to: `${BASE}/${encodeURIComponent(created.id)}` });
    } catch (err) {
      const fields: Partial<Record<keyof Draft, string>> = {};
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        for (const { path, code } of err.errors ?? []) {
          const field = FIELDS[path];
          if (field !== undefined) fields[field] ??= fieldErrorKey(code);
        }
      }
      setErrors(fields);
      if (Object.keys(fields).length === 0) setProblem(err);
    } finally {
      setBusy(false);
    }
  };

  const levels = instrument?.schoolLevels ?? [];
  // The level matters to a school library (or one whose type is not set); a school instrument always asks for it.
  const libraryType = instruments.config.libraryType;
  const showLevel = levels.length > 0 && (school || libraryType === null || libraryType === 'sekolah');

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4">
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <TextField
          label={t('accreditation.new.name')}
          value={draft.name}
          error={errors.name}
          disabled={busy}
          maxLength={191}
          className={FORM_FULL}
          onChange={(v) => set('name', v)}
        />
        <SelectField
          label={t('accreditation.new.instrument')}
          {...(instrument?.sourceStatus === 'P-copy' ? { hint: t('accred.source.copy') } : {})}
          value={draft.instrumentId}
          error={errors.instrumentId}
          disabled={busy}
          className={FORM_FULL}
          options={instruments.instruments.map((i) => [i.id, instrumentLabel(t, i)] as const)}
          onChange={(id) => {
            setDraft((d) => forInstrument(d, instruments.instruments.find((i) => i.id === id), startMonth));
            setErrors({});
          }}
        />
        {instrument !== undefined && (
          <SelectField
            label={t('accreditation.new.kind')}
            value={draft.kind}
            error={errors.kind}
            disabled={busy}
            options={instrument.periodKinds.map((k) => [k, t(vocabKey('period_kind', k))] as const)}
            onChange={(k) => setKind(k as PeriodKind)}
          />
        )}
        <SpanInputs draft={draft} errors={errors} busy={busy} set={set} />
        {(span !== null || draft.kind === 'custom') && (
          <div className={cn('grid gap-1', FORM_FULL)}>
            {span !== null && <p className="text-sm text-muted-foreground">{t('accreditation.new.span', spanText(f, span))}</p>}
            {draft.kind === 'custom' && <p className="text-xs text-muted-foreground">{t('accreditation.new.custom_hint')}</p>}
          </div>
        )}
        {showLevel && (
          <SelectField
            label={t('accreditation.new.school_level')}
            value={draft.schoolLevel}
            error={errors.schoolLevel}
            disabled={busy}
            options={[
              ...(school ? [] : ([['', t('accreditation.new.school_level_none')]] as const)),
              ...levels.map((l) => [l, t(vocabKey('school_level', l))] as const),
            ]}
            onChange={(l) => set('schoolLevel', l as SchoolLevel | '')}
          />
        )}
        <SelectField
          label={t('accreditation.new.copy_from')}
          hint={t('accreditation.new.copy_hint')}
          value={draft.copyFrom}
          error={errors.copyFrom}
          disabled={busy}
          className={FORM_FULL}
          options={[['', t('accreditation.new.copy_latest')], ...periods.map((p) => [p.id, p.name] as const)]}
          onChange={(id) => set('copyFrom', id)}
        />
      </div>
      <ProblemAlert error={problem} />
      <FormBar>
        <Button type="submit" disabled={busy}>
          {t(busy ? 'accreditation.new.submitting' : 'accreditation.new.submit')}
        </Button>
      </FormBar>
    </form>
  );
}

const spanText = (f: Formats, span: { from: string; to: string }) => ({ from: f.day(span.from), to: f.day(span.to) });

/** The input the period kind needs: a year, the last month, or the first and last day. */
function SpanInputs({
  draft,
  errors,
  busy,
  set,
}: {
  draft: Draft;
  errors: Readonly<Partial<Record<keyof Draft, string>>>;
  busy: boolean;
  set<K extends keyof Draft>(key: K, value: Draft[K]): void;
}) {
  const t = useT();
  switch (draft.kind) {
    case 'school_year':
    case 'calendar_year':
      return (
        <TextField
          type="number"
          label={t(draft.kind === 'school_year' ? 'accreditation.new.start_year_school' : 'accreditation.new.year')}
          value={draft.year}
          error={errors.year}
          disabled={busy}
          onChange={(v) => set('year', v)}
        />
      );
    case 'rolling_12':
      return (
        <TextField
          type="month"
          label={t('accreditation.new.end_month')}
          value={draft.endMonth}
          error={errors.endMonth}
          disabled={busy}
          onChange={(v) => set('endMonth', v)}
        />
      );
    case 'custom':
      return (
        <>
          <TextField
            type="date"
            label={t('accreditation.new.starts_on')}
            value={draft.startsOn}
            error={errors.startsOn}
            disabled={busy}
            onChange={(v) => set('startsOn', v)}
          />
          <TextField
            type="date"
            label={t('accreditation.new.ends_on')}
            value={draft.endsOn}
            error={errors.endsOn}
            disabled={busy}
            onChange={(v) => set('endsOn', v)}
          />
        </>
      );
    default:
      return null;
  }
}
