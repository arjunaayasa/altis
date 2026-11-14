import type { CalendarKind } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { CalendarBody, type CalendarResponse, type CalendarRuleView } from '@altis/shared/api/circulation';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { todayLocal, useCalendarDate } from './common';

/**
 * Kalender (`/admin/layanan/kalender`): the days the library is closed, for every branch. A closed weekday every week,
 * a date or a range of dates (at most 366 days), or a range of days every year (`MM-DD`, within one year; 29 February
 * only in a leap year). Due dates skip these days; a due date cut at the end of a membership steps back to an open day.
 *
 * Reading needs the desk at any branch or the rules permission; changing it needs `circulation.policies.manage`.
 * Below the list, a month shows its closed days (`GET circulation/calendar?from=&to=`).
 */

const CALENDAR_KEY = ['circulation', 'calendar'] as const;
const KINDS: readonly CalendarKind[] = ['weekly', 'dates', 'yearly'];

/** The weekday names of the UI language, ISO order (1 Monday … 7 Sunday). */
function useWeekdays(): string[] {
  const locale = useLocale();
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { weekday: 'long', timeZone: 'UTC' });
    // 16 November 2026 is a Monday.
    return Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2026, 10, 16 + i)));
  }, [locale]);
}

/** A rule's days in words. */
function useRuleDays(): (r: CalendarRuleView) => string {
  const t = useT();
  const day = useCalendarDate();
  const weekdays = useWeekdays();
  return (r) => {
    if (r.kind === 'weekly') return t('circulation.calendar.every', { day: weekdays[(r.weekday ?? 1) - 1] ?? '' });
    if (r.kind === 'dates') return r.dateFrom === r.dateTo ? day(r.dateFrom) : t('circulation.calendar.range', { from: day(r.dateFrom), to: day(r.dateTo) });
    return r.monthDayFrom === r.monthDayTo
      ? t('circulation.calendar.yearly_one', { day: r.monthDayFrom ?? '' })
      : t('circulation.calendar.yearly_range', { from: r.monthDayFrom ?? '', to: r.monthDayTo ?? '' });
  };
}

/** The message key of a field error of the add form. */
function fieldMessage(code: string): TKey {
  const own: Record<string, TKey> = {
    too_many_closed: 'circulation.calendar.error.too_many_closed',
    range_too_long: 'circulation.calendar.error.range_too_long',
    crosses_year: 'circulation.calendar.error.crosses_year',
    before_from: 'circulation.calendar.error.before_from',
    required: 'form.error.required',
  };
  return own[code] ?? 'circulation.calendar.error.invalid';
}

export function CalendarScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const ids = useId();
  const weekdays = useWeekdays();
  const ruleDays = useRuleDays();
  const canManage = holds(me, 'circulation.policies.manage');
  const [month, setMonth] = useState(() => todayLocal().slice(0, 7));
  const from = `${month}-01`;
  const to = lastDayOf(month);
  const query = useApiQuery<CalendarResponse>({ queryKey: [...CALENDAR_KEY, { from, to }], path: `circulation/calendar?from=${from}&to=${to}` });

  const [kind, setKind] = useState<CalendarKind>('dates');
  const [name, setName] = useState('');
  const [weekday, setWeekday] = useState('7');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [mdFrom, setMdFrom] = useState('');
  const [mdTo, setMdTo] = useState('');
  const [errors, setErrors] = useState<Record<string, TKey>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<CalendarRuleView | null>(null);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: CALENDAR_KEY });

  const add = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setErrors({});
    setProblem(null);
    setNotice(null);
    const body: Record<string, unknown> = { kind, name: name.trim() };
    if (kind === 'weekly') body['weekday'] = Number(weekday);
    if (kind === 'dates') Object.assign(body, { dateFrom: dateFrom || null, ...(dateTo === '' ? {} : { dateTo }) });
    if (kind === 'yearly') Object.assign(body, { monthDayFrom: mdFrom.trim() || null, ...(mdTo.trim() === '' ? {} : { monthDayTo: mdTo.trim() }) });
    const parsed = CalendarBody.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, TKey> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? 'name')] = issue.path[0] === 'name' ? 'form.error.required' : 'circulation.calendar.error.invalid';
      setErrors(next);
      return;
    }
    setBusy(true);
    try {
      await api<StoreResponse>('POST', 'circulation/calendar', parsed.data);
      setNotice(t('circulation.calendar.added', { name: parsed.data.name }));
      setName('');
      setDateFrom('');
      setDateTo('');
      setMdFrom('');
      setMdTo('');
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_FAILED' && error.errors !== undefined) {
        setErrors(Object.fromEntries(error.errors.map((f) => [f.path, fieldMessage(f.code)])));
      } else setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: CalendarRuleView): Promise<void> => {
    await api<StoreResponse>('DELETE', `circulation/calendar/${encodeURIComponent(r.id)}`, { version: r.version });
    setNotice(t('circulation.calendar.removed', { name: r.name }));
    await refresh();
  };

  const closed = new Set(query.data?.closed ?? []);
  const rules = query.data?.rules ?? [];

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('nav.circulation.calendar')}</h1>
        <p className="text-sm text-muted-foreground">{t('circulation.calendar.intro')}</p>
      </div>
      {notice !== null && <Notice kind="success">{notice}</Notice>}

      {canManage && (
        <form noValidate onSubmit={(e) => void add(e)} aria-labelledby={`${ids}-add`} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h2 id={`${ids}-add`} className="text-lg font-semibold">
            {t('circulation.calendar.add')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${ids}-kind`} label={t('circulation.calendar.field.kind')}>
              <select id={`${ids}-kind`} className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as CalendarKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`vocab.calendar_kind.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('circulation.calendar.field.name')} hint={t('circulation.calendar.field.name_hint')} error={errors['name']}>
              {(c) => <Input {...c} value={name} maxLength={191} autoComplete="off" onChange={(e) => setName(e.target.value)} />}
            </Field>
            {kind === 'weekly' && (
              <Field id={`${ids}-weekday`} label={t('circulation.calendar.field.weekday')} error={errors['weekday']}>
                <select id={`${ids}-weekday`} className={SELECT_CLASS} value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                  {weekdays.map((w, i) => (
                    <option key={w} value={String(i + 1)}>
                      {w}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {kind === 'dates' && (
              <>
                <Field label={t('circulation.calendar.field.date_from')} error={errors['dateFrom']}>
                  {(c) => <Input {...c} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />}
                </Field>
                <Field label={t('circulation.calendar.field.date_to')} hint={t('circulation.calendar.field.date_to_hint')} error={errors['dateTo']}>
                  {(c) => <Input {...c} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />}
                </Field>
              </>
            )}
            {kind === 'yearly' && (
              <>
                <Field label={t('circulation.calendar.field.month_day_from')} hint={t('circulation.calendar.field.month_day_hint')} error={errors['monthDayFrom']}>
                  {(c) => <Input {...c} value={mdFrom} placeholder="08-17" maxLength={5} autoComplete="off" onChange={(e) => setMdFrom(e.target.value)} />}
                </Field>
                <Field label={t('circulation.calendar.field.month_day_to')} hint={t('circulation.calendar.field.date_to_hint')} error={errors['monthDayTo']}>
                  {(c) => <Input {...c} value={mdTo} placeholder="08-17" maxLength={5} autoComplete="off" onChange={(e) => setMdTo(e.target.value)} />}
                </Field>
              </>
            )}
          </div>
          <ProblemAlert error={problem} />
          <div>
            <Button type="submit" disabled={busy}>
              {t('circulation.calendar.add_button')}
            </Button>
          </div>
        </form>
      )}

      {query.isError && query.data === undefined ? (
        <Notice kind="error">{problemText(t, query.error)}</Notice>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('circulation.calendar.caption')}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                {(['circulation.calendar.col.kind', 'circulation.calendar.col.name', 'circulation.calendar.col.days'] as const).map((key) => (
                  <th key={key} scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                    {t(key)}
                  </th>
                ))}
                {canManage && (
                  <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                    {t('table.actions')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 4 : 3} className="px-3 py-6 text-center text-muted-foreground">
                    {query.data === undefined ? t('shell.loading') : t('circulation.calendar.empty')}
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2">{t(`vocab.calendar_kind.${r.kind}`)}</td>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2">{ruleDays(r)}</td>
                    {canManage && (
                      <td className="px-3 py-2">
                        <Button variant="outline" size="sm" aria-label={t('circulation.calendar.remove_named', { name: r.name })} onClick={() => setRemoving(r)}>
                          {t('circulation.calendar.remove')}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <MonthView month={month} closed={closed} weekdays={weekdays} onMonth={setMonth} />

      {removing !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('circulation.calendar.confirm_remove', { name: removing.name })}
          description={t('circulation.calendar.confirm_remove_body')}
          confirmLabel={t('circulation.calendar.remove')}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** `YYYY-MM-DD` of the last day of `month` (`YYYY-MM`). */
function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** `month` moved by `n` months. */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const at = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** One month as a grid of weeks (Monday first), its closed days marked in colour and in words. */
function MonthView({ month, closed, weekdays, onMonth }: { month: string; closed: ReadonlySet<string>; weekdays: string[]; onMonth(m: string): void }) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const title = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${month}-01T00:00:00Z`));
  const first = new Date(Date.parse(`${month}-01T00:00:00Z`));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = Number(lastDayOf(month).slice(8));
  const cells: (string | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${ids}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" aria-label={t('circulation.calendar.prev')} onClick={() => onMonth(shiftMonth(month, -1))}>
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" aria-label={t('circulation.calendar.next')} onClick={() => onMonth(shiftMonth(month, 1))}>
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <table className="w-full table-fixed text-center text-sm">
        <caption className="sr-only">{t('circulation.calendar.month_caption', { month: title })}</caption>
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th key={w} scope="col" className="py-1 text-xs font-medium text-muted-foreground">
                {w.slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w}>
              {week.map((d, i) => (
                <td key={d ?? `e${w}-${i}`} className="p-0.5">
                  {d !== null && (
                    <span
                      className={cn('block rounded-md py-1.5 tabular-nums', closed.has(d) ? 'bg-destructive/10 font-semibold text-destructive' : 'text-foreground')}
                      aria-label={closed.has(d) ? t('circulation.calendar.closed_day', { day: Number(d.slice(8)) }) : undefined}>
                      {Number(d.slice(8))}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">{t('circulation.calendar.legend')}</p>
    </section>
  );
}
