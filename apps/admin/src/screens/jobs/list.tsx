import type { MeResponse } from '@altis/shared/api/auth';
import { JOB_STATUS_VALUES, type JobListResponse, type JobStatusValue, type JobView } from '@altis/shared/api/jobs';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DataTable, useDateTime } from '@/components/data-table';
import { SELECT_CLASS } from '@/components/form-field';
import { ErrorState, FilterField, FilterRow, LinkTabs, PageHead, SkeletonTable, Tag, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds, meId } from '@/lib/access';
import { api } from '@/lib/api';
import { FORM_PARSE, isMessageKey } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

/**
 * Tugas dan Jadwal, the jobs list (spec §13.3 "Daftar, detail, ulangi/batalkan", §10.1; route `jobs.list`,
 * `system.jobs.read`): the background jobs, newest first, with
 *
 * - filters (status, job type), applied with "Terapkan": the list follows the applied filters only;
 * - keyset paging on the job id: each page's `nextBefore` is the `before` of the next one, loaded with "Muat lagi";
 * - a link per row to the job's page (screens/jobs/detail.tsx), where it is retried, cancelled or run.
 *
 * The list is read again when the realtime client resyncs (`['jobs']`); a job's own events refresh its page only
 * (`['jobs', id]`). The helpers below (labels, the status badge, the section tabs) serve the job page, the schedules
 * and the dashboard too.
 */

// ---- shared by the jobs screens --------------------------------------------------------------------------------

/** The React Query key of a job's page (the shell invalidates it on an event of `jobs.<id>`, lib/realtime.ts). */
export const jobKey = (id: string): readonly ['jobs', string] => ['jobs', id];

/** A job type as `jobs.type` holds it (the shared `jobTypeField`). */
const JOB_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

/** The label of a job type: its `jobs.type.<type>` text, or the type itself for one this build does not know. */
export function jobTypeLabel(t: Translate, type: string): string {
  const key = `jobs.type.${type}`;
  return isMessageKey(key) ? t(key) : type;
}

/**
 * The text of a job's `progressMessage`: its `jobs.message.<type>.<message>` text (spaces as `_`), the words a handler
 * of this build writes (a snapshot backup turned frozen, a phase of the files cleanup); null for anything else, an
 * internal word the user cannot read.
 */
export function jobMessageText(t: Translate, job: Pick<JobView, 'type' | 'progressMessage'>): string | null {
  if (job.progressMessage === null) return null;
  const key = `jobs.message.${job.type}.${job.progressMessage.replace(/ /g, '_')}`;
  return isMessageKey(key) ? t(key) : null;
}

/** The label of a schedule: its `jobs.schedule.<name>` text, or the name itself for one this build does not know. */
export function scheduleLabel(t: Translate, name: string): string {
  const key = `jobs.schedule.${name}`;
  return isMessageKey(key) ? t(key) : name;
}

const STATUS_TONE: Readonly<Record<JobStatusValue, TagTone>> = {
  queued: 'neutral',
  running: 'neutral',
  succeeded: 'ok',
  dead: 'bad',
  cancelled: 'neutral',
};

/** The status of a job as a tag: its word, in its colour. */
export function JobStatusBadge({ status }: { status: JobStatusValue }) {
  const t = useT();
  return <Tag tone={STATUS_TONE[status]}>{t(`jobs.status.${status}`)}</Tag>;
}

/** Whether a job still has work ahead (it can be cancelled or run). */
export function isActive(job: Pick<JobView, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running';
}

/**
 * Whether `me` may read the channel `jobs.<id>` of a job it has read: its creator, or a holder of `system.jobs.read`
 * (§10.7). `GET jobs/:id` also answers a holder of an interactive job's handler permission (C26/E22b), but the channel
 * does not: subscribing to it would refuse the tab's whole poll, so a screen subscribes only when this holds.
 */
export function hearsJob(me: MeResponse | undefined, job: Pick<JobView, 'createdBy'>): boolean {
  return (job.createdBy !== null && job.createdBy === meId(me)) || holds(me, 'system.jobs.read');
}

/** The heading of both parts of Tugas dan Jadwal, with the two as tabs: the jobs (`/admin/jobs`), the schedules. */
export function JobsHeader({ description }: { description: string }) {
  const t = useT();
  return (
    <div className="grid gap-4">
      <PageHead title={t('nav.jobs')} intro={description} />
      <LinkTabs
        label={t('jobs.sections')}
        items={[
          { to: '/admin/jobs', label: t('jobs.tab.jobs') },
          { to: '/admin/jobs/schedules', label: t('jobs.tab.schedules') },
        ]}
      />
    </div>
  );
}

/** A progress value (0-100) as a bar; `label` names it for screen readers. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-layer-2', className)}
    >
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---- the list ----------------------------------------------------------------------------------------------------

const FilterForm = z.strictObject({
  status: z.union([z.literal(''), z.enum(JOB_STATUS_VALUES)]),
  type: z.union([z.literal(''), z.string().regex(JOB_TYPE, { error: 'jobs.filter.type_error' })]),
});

type FilterValues = z.infer<typeof FilterForm>;

interface JobFilters {
  status?: JobStatusValue;
  type?: string;
}

const NO_FILTERS: FilterValues = { status: '', type: '' };

function filtersOf(v: FilterValues): JobFilters {
  const f: JobFilters = {};
  if (v.status !== '') f.status = v.status;
  if (v.type !== '') f.type = v.type;
  return f;
}

/** `GET jobs` for one page: the filters, then `before` (the previous page's `nextBefore`). */
function listPath(filters: JobFilters, before: string | null): string {
  const q = new URLSearchParams();
  if (filters.status !== undefined) q.set('status', filters.status);
  if (filters.type !== undefined) q.set('type', filters.type);
  if (before !== null) q.set('before', before);
  const s = q.toString();
  return s === '' ? 'jobs' : `jobs?${s}`;
}

/** The job types a filter suggests: every type this build names. */
export const KNOWN_TYPES = [
  'backup.schedule',
  'backup.create',
  'backup.prepare_download',
  'housekeeping.volatile',
  'housekeeping.events',
  'housekeeping.notifications',
  'housekeeping.jobs',
  'housekeeping.files',
  'audit.anchor',
  'audit.retention',
  'mail.password_reset',
  'diagnostics.exposure',
  'diagnostics.ip_trust',
  'diagnostics.usage',
  // 1d Task 30: the update check (Task 28), the adoption and the retention of releases (Task 27).
  'update.check',
  'release.adopt',
  'release.retention',
] as const;

const features = tableFeatures({});
const column = createColumnHelper<typeof features, JobView>();
const NO_ITEMS: JobView[] = [];

/** `/admin/jobs`. */
export function JobsListScreen() {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const typesId = useId();
  const [applied, setApplied] = useState<JobFilters>({});
  const form = useForm<FilterValues>({ resolver: zodResolver(FilterForm, FORM_PARSE), defaultValues: NO_FILTERS });
  const { errors } = form.formState;

  const list = useInfiniteQuery({
    queryKey: ['jobs', 'list', applied],
    queryFn: ({ pageParam }) => api<JobListResponse>('GET', listPath(applied, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextBefore,
    enabled: me !== undefined,
    // Every loaded page would be read again: a list being read does not change under the reader's eyes.
    refetchOnWindowFocus: false,
  });

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? NO_ITEMS, [list.data]);

  const apply = form.handleSubmit((values) => setApplied(filtersOf(values)));
  const clear = (): void => {
    form.reset(NO_FILTERS);
    setApplied({});
  };

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('type', {
          header: t('jobs.col.type'),
          cell: (info) => (
            <span className="flex flex-col">
              <span>{jobTypeLabel(t, info.getValue())}</span>
              <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span>
            </span>
          ),
        }),
        column.accessor('status', {
          header: t('jobs.col.status'),
          cell: (info) => <JobStatusBadge status={info.getValue()} />,
        }),
        column.accessor('progress', {
          header: t('jobs.col.progress'),
          cell: (info) => <span className="whitespace-nowrap tabular-nums">{Math.round(info.getValue())} %</span>,
        }),
        column.display({
          id: 'attempts',
          header: t('jobs.col.attempts'),
          cell: (info) => (
            <span className="whitespace-nowrap">{t('jobs.attempts', { attempts: info.row.original.attempts, max: info.row.original.maxAttempts })}</span>
          ),
        }),
        column.accessor('createdAt', {
          header: t('jobs.col.created'),
          cell: (info) => (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ),
        }),
        column.accessor('updatedAt', {
          header: t('jobs.col.updated'),
          cell: (info) => (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ),
        }),
        column.display({
          id: 'open',
          header: () => <span className="sr-only">{t('table.actions')}</span>,
          cell: (info) => (
            <Link
              to={`/admin/jobs/${encodeURIComponent(info.row.original.id)}`}
              aria-label={t('jobs.open_label', { name: jobTypeLabel(t, info.row.original.type) })}
              className="font-semibold text-accent-text underline-offset-4 hover:underline"
            >
              {t('jobs.open')}
            </Link>
          ),
        }),
      ]),
    [t, dateTime],
  );

  const table = useTable({ features, columns, data: items, getRowId: (job) => job.id });

  return (
    <div className="grid gap-6">
      <JobsHeader description={t('jobs.description')} />

      <div className="grid gap-1.5">
        <FilterRow
          label={t('jobs.filters')}
          onSubmit={(e) => void apply(e)}
          actions={
            <>
              <Button type="submit" variant="outline">
                {t('jobs.filter.apply')}
              </Button>
              <Button type="button" variant="link" onClick={clear}>
                {t('jobs.filter.reset')}
              </Button>
            </>
          }
        >
          <FilterField label={t('jobs.filter.status')} error={errors.status}>
            {(c) => (
              <select {...c} className={SELECT_CLASS} {...form.register('status')}>
                <option value="">{t('jobs.filter.status_all')}</option>
                {JOB_STATUS_VALUES.map((status) => (
                  <option key={status} value={status}>
                    {t(`jobs.status.${status}`)}
                  </option>
                ))}
              </select>
            )}
          </FilterField>
          <FilterField wide label={t('jobs.filter.type')} error={errors.type}>
            {(c) => (
              <>
                <Input
                  {...c}
                  aria-describedby={[c['aria-describedby'], `${typesId}-hint`].filter(Boolean).join(' ')}
                  list={typesId}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  {...form.register('type')}
                />
                <datalist id={typesId}>
                  {KNOWN_TYPES.map((type) => (
                    <option key={type} value={type} label={jobTypeLabel(t, type)} />
                  ))}
                </datalist>
              </>
            )}
          </FilterField>
        </FilterRow>
        <p id={`${typesId}-hint`} className="text-xs text-muted-foreground">
          {t('jobs.filter.type_hint')}
        </p>
      </div>

      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={8} />
      ) : (
        <div className="grid gap-3">
          <DataTable table={table} caption={t('jobs.caption')} empty={t('jobs.empty')} />
          {list.hasNextPage ? (
            <div>
              <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t(list.isFetchingNextPage ? 'shell.loading' : 'jobs.load_more')}
              </Button>
            </div>
          ) : (
            items.length > 0 && <p className="text-meta text-muted-foreground">{t('jobs.end')}</p>
          )}
        </div>
      )}
    </div>
  );
}
