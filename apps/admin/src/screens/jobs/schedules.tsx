import type { SchedulePatchBody, ScheduleListResponse, ScheduleView } from '@altis/shared/api/jobs';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DataTable, useDateTime } from '@/components/data-table';
import { Notice, NoticeAlert, RefetchProblem } from '@/components/form-field';
import { ErrorState, SkeletonTable } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { JobsHeader, scheduleLabel } from './list';

/**
 * Tugas dan Jadwal, the schedules (spec §13.3 "aktif/nonaktifkan jadwal", §10.4, §10.5; routes `schedules.list`,
 * `schedules.update`; decision C2): every schedule of this release with its time, whether it runs, and its next and
 * last run.
 *
 * - The switch sends `PATCH schedules/<name> {enabled}`; it works for a holder of `system.jobs.manage` and of the
 *   schedule's own permission (§10.5 "Jadwal mendeklarasikan izinnya sendiri"), and is read-only for anyone else. The
 *   server records the change in the audit log.
 * - Only `backup.daily` has an editable time (C2: `exprEditable`): a time picker that writes the expression
 *   `M H * * *` (every day at H:M, library time), sent with "Simpan waktu".
 * - Times of day are the expression's, in the library's time zone (the scheduler evaluates them there); the next
 *   and last runs are instants, shown in the browser's own.
 */

/** The React Query key of the schedules (under `['jobs']`: a realtime resync reads them again). */
export const SCHEDULES_KEY = ['jobs', 'schedules'] as const;

const TWO = (n: number): string => String(n).padStart(2, '0');

/** `M H * * *` → `HH:MM`, or null for any other expression. */
export function dailyTime(expr: string): string | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr.trim());
  if (m === null) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  return minute <= 59 && hour <= 23 ? `${TWO(hour)}:${TWO(minute)}` : null;
}

/** `HH:MM` (a time input's value) → the expression `M H * * *`, or null when it is not a time. */
export function dailyExpr(time: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? `${minute} ${hour} * * *` : null;
}

/** An expression in words where it is one of the simple forms (every day at, every hour at, every n minutes). */
function describeExpr(t: Translate, expr: string): string | null {
  const daily = dailyTime(expr);
  if (daily !== null) return t('jobs.schedules.every_day', { time: daily });
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(expr.trim());
  if (hourly !== null && Number(hourly[1]) <= 59) return t('jobs.schedules.every_hour', { minute: Number(hourly[1]) });
  const every = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(expr.trim());
  if (every !== null && Number(every[1]) >= 1) {
    const minutes = Number(every[1]);
    return t(minutes === 1 ? 'jobs.schedules.every_minutes_one' : 'jobs.schedules.every_minutes', { minutes });
  }
  return null;
}

/** The time of a schedule: in words (with the expression), or the picker of an editable daily one. */
function TimeCell({ schedule, editable, pending, onSave }: { schedule: ScheduleView; editable: boolean; pending: boolean; onSave(expr: string): void }) {
  const t = useT();
  const current = dailyTime(schedule.expr);
  const [value, setValue] = useState(current ?? '');
  const words = describeExpr(t, schedule.expr);
  const expr = <span className="font-mono text-xs text-muted-foreground">{schedule.expr}</span>;
  if (!schedule.exprEditable) {
    return (
      <span className="flex flex-col">
        {words !== null && <span>{words}</span>}
        {expr}
      </span>
    );
  }
  const next = dailyExpr(value);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Input
          type="time"
          className="w-32"
          aria-label={t('jobs.schedules.time_label', { name: scheduleLabel(t, schedule.name) })}
          value={value}
          disabled={!editable || pending}
          onChange={(e) => setValue(e.target.value)}
        />
        {editable && (
          <Button size="sm" variant="outline" disabled={pending || next === null || value === current} onClick={() => next !== null && onSave(next)}>
            {t('jobs.schedules.time_save')}
          </Button>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{t('jobs.schedules.time_hint')}</span>
      {current === null && expr}
    </span>
  );
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, ScheduleView>();
const NO_ITEMS: ScheduleView[] = [];

type Outcome = { kind: 'success' | 'error'; text: string } | null;

/** `/admin/jobs/schedules`. */
export function SchedulesScreen() {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const queryClient = useQueryClient();
  const list = useApiQuery<ScheduleListResponse>({ queryKey: SCHEDULES_KEY, path: 'schedules' });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome>(null);

  const manage = holds(me, 'system.jobs.manage');

  const columns = useMemo(() => {
    const editable = (s: ScheduleView): boolean => manage && holds(me, s.permission);

    const save = async (s: ScheduleView, body: SchedulePatchBody): Promise<void> => {
      setPending((p) => new Set(p).add(s.name));
      setOutcome(null);
      try {
        const updated = await api<ScheduleView>('PATCH', `schedules/${encodeURIComponent(s.name)}`, body);
        queryClient.setQueryData<ScheduleListResponse>(SCHEDULES_KEY, (old) =>
          old === undefined ? old : { items: old.items.map((i) => (i.name === updated.name ? updated : i)) },
        );
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        setOutcome({ kind: 'success', text: t('jobs.schedules.saved', { name: scheduleLabel(t, s.name) }) });
      } catch (e) {
        setOutcome({ kind: 'error', text: problemText(t, e) });
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(s.name);
          return next;
        });
      }
    };

    return column.columns([
      column.accessor('name', {
        header: t('jobs.schedules.col.name'),
        cell: (info) => (
          <span className="flex flex-col">
            <span>{scheduleLabel(t, info.getValue())}</span>
            <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span>
          </span>
        ),
      }),
      column.display({
        id: 'time',
        header: t('jobs.schedules.col.time'),
        cell: (info) => {
          const s = info.row.original;
          return (
            <TimeCell
              key={s.expr}
              schedule={s}
              editable={editable(s)}
              pending={pending.has(s.name)}
              onSave={(expr) => void save(s, { expr })}
            />
          );
        },
      }),
      column.accessor('enabled', {
        header: t('jobs.schedules.col.enabled'),
        cell: (info) => {
          const s = info.row.original;
          return (
            <input
              type="checkbox"
              role="switch"
              aria-label={t('jobs.schedules.enabled_label', { name: scheduleLabel(t, s.name) })}
              checked={s.enabled}
              disabled={!editable(s) || pending.has(s.name)}
              onChange={(e) => void save(s, { enabled: e.target.checked })}
              className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          );
        },
      }),
      column.accessor('nextRunAt', {
        header: t('jobs.schedules.col.next'),
        cell: (info) =>
          info.row.original.enabled ? (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ) : (
            <span className="text-muted-foreground">{t('jobs.schedules.off')}</span>
          ),
      }),
      column.accessor('lastRunAt', {
        header: t('jobs.schedules.col.last'),
        cell: (info) => {
          const at = info.getValue();
          return at === null ? (
            <span className="text-muted-foreground">{t('jobs.schedules.never')}</span>
          ) : (
            <time dateTime={new Date(at).toISOString()} className="whitespace-nowrap">
              {dateTime(at)}
            </time>
          );
        },
      }),
    ]);
  }, [t, me, manage, dateTime, pending, queryClient]);

  const table = useTable({ features, columns, data: list.data?.items ?? NO_ITEMS, getRowId: (s) => s.name });

  return (
    <div className="grid gap-6">
      <JobsHeader description={t('jobs.schedules.description')} />
      {!manage && <NoticeAlert>{t('jobs.schedules.read_only')}</NoticeAlert>}
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
      <RefetchProblem query={list} />
      {list.data === undefined ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <SkeletonTable label={t('shell.loading')} columns={5} />
        )
      ) : (
        <DataTable table={table} caption={t('jobs.schedules.caption')} empty={t('jobs.schedules.empty')} />
      )}
    </div>
  );
}
