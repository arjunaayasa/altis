import { AUDIT_ACTIONS } from '@altis/shared';
import { AUDIT_FILTER_KEYS, type AuditFilters, type AuditItem, type AuditListResponse, type AuditVerifyResponse } from '@altis/shared/api/audit';
import type { UserListResponse } from '@altis/shared/api/users';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { DownloadIcon, FilterIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { DataTable, useDateTime } from '@/components/data-table';
import { Badge, Field, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { FORM_PARSE, isMessageKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * Log audit (spec §13.3, §7.8; `system.audit.read`): the log, newest first, with
 *
 * - filters (action, actor, entity kind and id, a date range in the browser's time zone, both days included), applied
 *   with "Terapkan": the list and the export link follow the applied filters only;
 * - keyset paging (decision D8): each page's `nextBefore` is the `before` of the next one, loaded with "Muat lagi";
 * - the chain status of `GET audit/verify` (the whole chain is checked, so it is read once per visit unless asked
 *   again, never on window focus);
 * - with `system.audit.export`, a link to `GET audit/export` with the applied filters and the chosen delimiter
 *   (`semicolon` for Excel on Indonesian Windows, D28). It is a plain download: the browser sends the session cookie,
 *   and a GET needs no CSRF token.
 *
 * The actors offered are the staff users (`GET users`, with `system.users.read`) and the actors of the entries shown.
 */

type Delimiter = 'comma' | 'semicolon';

/** The entity kinds of Phase 1 (suggestions only: the filter takes any text, later phases add kinds). */
const ENTITIES = ['staff_users', 'roles', 'branches', 'settings', 'audit_log'] as const;

const ACTOR_TYPES = ['system', 'cli', 'anonymous'] as const;

/** `YYYY-MM-DD` as a date input gives it; empty is no bound. */
const DAY = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);

const FilterForm = z
  .strictObject({
    action: z.string(),
    actorId: z.string(),
    entity: z.string().trim().max(64),
    entityId: z.string().trim().max(191),
    from: DAY,
    to: DAY,
  })
  .refine((f) => f.from === '' || f.to === '' || f.from <= f.to, { path: ['to'], error: 'auditlog.filter.range_error' });

type FilterValues = z.infer<typeof FilterForm>;

const NO_FILTERS: FilterValues = { action: '', actorId: '', entity: '', entityId: '', from: '', to: '' };

/** Epoch ms of a local day's first (`start`) or last millisecond; undefined for no day. */
function dayBound(day: string, edge: 'start' | 'end'): number | undefined {
  if (day === '') return undefined;
  const ms = new Date(`${day}T${edge === 'start' ? '00:00:00' : '23:59:59.999'}`).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function filtersOf(v: FilterValues): AuditFilters {
  const f: AuditFilters = {};
  if (v.action !== '') f.action = v.action as AuditFilters['action'];
  if (v.actorId !== '') f.actorId = v.actorId;
  if (v.entity !== '') f.entity = v.entity;
  if (v.entityId !== '') f.entityId = v.entityId;
  const from = dayBound(v.from, 'start');
  if (from !== undefined) f.from = from;
  const to = dayBound(v.to, 'end');
  if (to !== undefined) f.to = to;
  return f;
}

/** The query string of `filters`, in the fixed order of AUDIT_FILTER_KEYS. */
function filterQuery(filters: AuditFilters): URLSearchParams {
  const q = new URLSearchParams();
  for (const key of AUDIT_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) q.set(key, String(value));
  }
  return q;
}

/** `GET audit` for one page: the filters, then `before` (the previous page's `nextBefore`). */
function listPath(filters: AuditFilters, before: number | null): string {
  const q = filterQuery(filters);
  if (before !== null) q.set('before', String(before));
  const s = q.toString();
  return s === '' ? 'audit' : `audit?${s}`;
}

/** The download link of `GET audit/export` (a same-origin path the browser opens itself). */
function exportHref(filters: AuditFilters, delimiter: Delimiter): string {
  const q = filterQuery(filters);
  q.set('delimiter', delimiter);
  return `/api/v1/audit/export?${q.toString()}`;
}

/** The label of an action: its `audit.<action>` text, or the stored text for an action this build does not know. */
function actionLabel(t: Translate, action: string): string {
  const key = `audit.${action}`;
  return isMessageKey(key) ? t(key) : action;
}

function entityLabel(t: Translate, entity: string): string {
  return (ENTITIES as readonly string[]).includes(entity) ? t(`auditlog.entity.${entity as (typeof ENTITIES)[number]}`) : entity;
}

/** Who acted: a staff user's current name, else what kind of actor it was. */
function actorLabel(t: Translate, item: AuditItem): string {
  if (item.actorType === 'staff') return item.actorName ?? t('auditlog.actor.gone');
  return (ACTOR_TYPES as readonly string[]).includes(item.actorType)
    ? t(`auditlog.actor.${item.actorType as (typeof ACTOR_TYPES)[number]}`)
    : item.actorType;
}

/**
 * The chain status of `GET audit/verify`. The check reads and hashes every entry (200k rows on a shared host), so it
 * runs once per visit and on "Periksa lagi" only: never again on its own, not even when the window regains focus.
 */
function ChainStatus() {
  const t = useT();
  const verify = useApiQuery<AuditVerifyResponse>({
    queryKey: ['audit', 'verify'],
    path: 'audit/verify',
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  let badge;
  let hint: string | null = null;
  if (verify.data !== undefined) {
    if (verify.data.ok) {
      badge = (
        <Badge tone="info">
          <ShieldCheckIcon className="mr-1 size-3.5" aria-hidden="true" />
          {t('auditlog.chain.ok')}
        </Badge>
      );
      hint = t('auditlog.chain.ok_hint', { head: verify.data.head });
    } else {
      badge = (
        <Badge tone="danger">
          <ShieldAlertIcon className="mr-1 size-3.5" aria-hidden="true" />
          {t('auditlog.chain.broken', { seq: verify.data.brokenAt })}
        </Badge>
      );
      hint = t('auditlog.chain.broken_hint', { seq: verify.data.brokenAt });
    }
  } else if (verify.isError) {
    badge = <Badge tone="neutral">{t('auditlog.chain.unknown')}</Badge>;
  } else {
    badge = <Badge tone="neutral">{t('auditlog.chain.checking')}</Badge>;
  }
  return (
    <div role="status" aria-label={t('auditlog.chain.label')} className="flex flex-wrap items-center gap-2 text-sm">
      {badge}
      {hint !== null && <span className="text-muted-foreground">{hint}</span>}
      <Button variant="ghost" size="sm" disabled={verify.isFetching} onClick={() => void verify.refetch()}>
        {t('auditlog.chain.recheck')}
      </Button>
    </div>
  );
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, AuditItem>();
const NO_ITEMS: AuditItem[] = [];

/** `/admin/audit`. */
export function AuditLogScreen() {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const entitiesId = useId();
  const canExport = holds(me, 'system.audit.export');
  const [applied, setApplied] = useState<AuditFilters>({});
  const [delimiter, setDelimiter] = useState<Delimiter>('comma');
  const form = useForm<FilterValues>({ resolver: zodResolver(FilterForm, FORM_PARSE), defaultValues: NO_FILTERS });
  const { errors } = form.formState;

  const list = useInfiniteQuery({
    queryKey: ['audit', 'list', applied],
    queryFn: ({ pageParam }) => api<AuditListResponse>('GET', listPath(applied, pageParam)),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.nextBefore,
    enabled: me !== undefined,
    // Every loaded page would be read again: a list that is being read does not change under the reader's eyes.
    refetchOnWindowFocus: false,
  });
  const users = useApiQuery<UserListResponse>({
    queryKey: ['users', 'list', { pageSize: 100 }],
    path: 'users?pageSize=100',
    enabled: holds(me, 'system.users.read'),
    staleTime: 60_000,
  });

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? NO_ITEMS, [list.data]);

  /**
   * Every actor seen on this visit, by name: the staff users, and the staff actors of the entries shown so far. An
   * actor stays once seen: the filter applied from a row reloads the list (its entries may all be gone), and the
   * select must keep showing that actor, or the list and the export would follow a filter the select hides.
   */
  const seenActors = useRef(new Map<string, string>());
  const actors = useMemo(() => {
    const byId = seenActors.current;
    for (const user of users.data?.items ?? []) byId.set(user.id, user.name);
    for (const item of items) if (item.actorType === 'staff' && item.actorId !== null && item.actorName !== null) byId.set(item.actorId, item.actorName);
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [users.data, items]);

  const apply = form.handleSubmit((values) => setApplied(filtersOf(values)));

  const clear = (): void => {
    form.reset(NO_FILTERS);
    setApplied({});
  };

  const columns = useMemo(() => {
    /** Shows only the entries of this actor (the filter field follows). */
    const byActor = (actorId: string): void => {
      form.setValue('actorId', actorId);
      setApplied((current) => ({ ...current, actorId }));
    };
    return column.columns([
      column.accessor('seq', {
        header: t('auditlog.col.seq'),
        cell: (info) => <span className="font-mono text-xs whitespace-nowrap">#{info.getValue()}</span>,
      }),
      column.accessor('at', {
        header: t('auditlog.col.at'),
        cell: (info) => (
          <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
            {dateTime(info.getValue())}
          </time>
        ),
      }),
      column.display({
        id: 'actor',
        header: t('auditlog.col.actor'),
        cell: (info) => {
          const item = info.row.original;
          const name = actorLabel(t, item);
          const actorId = item.actorType === 'staff' ? item.actorId : null;
          return (
            <span className="flex items-center gap-1">
              <span>{name}</span>
              {actorId !== null && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  title={t('auditlog.actor.filter', { name })}
                  aria-label={t('auditlog.actor.filter', { name })}
                  onClick={() => byActor(actorId)}
                >
                  <FilterIcon className="size-3.5" aria-hidden="true" />
                </Button>
              )}
            </span>
          );
        },
      }),
      column.accessor('action', {
        header: t('auditlog.col.action'),
        cell: (info) => <span title={info.getValue()}>{actionLabel(t, info.getValue())}</span>,
      }),
      column.display({
        id: 'entity',
        header: t('auditlog.col.entity'),
        cell: (info) => {
          const { entity, entityId } = info.row.original;
          if (entity === null) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="flex flex-col">
              <span>{entityLabel(t, entity)}</span>
              {entityId !== null && <span className="font-mono text-xs break-all text-muted-foreground">{entityId}</span>}
            </span>
          );
        },
      }),
      column.accessor('ip', {
        header: t('auditlog.col.ip'),
        cell: (info) => <span className="font-mono text-xs">{info.getValue() ?? '—'}</span>,
      }),
      column.accessor('meta', {
        header: t('auditlog.col.meta'),
        cell: (info) => {
          const meta = info.getValue();
          if (Object.keys(meta).length === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <details>
              <summary className="cursor-pointer text-primary">{t('auditlog.meta.show')}</summary>
              <pre className="mt-1 max-w-xs overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">
                {JSON.stringify(meta, null, 2)}
              </pre>
            </details>
          );
        },
      }),
    ]);
  }, [t, dateTime, form]);

  const table = useTable({ features, columns, data: items, getRowId: (item) => String(item.seq) });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('nav.audit')}</h1>
        <p className="text-sm text-muted-foreground">{t('auditlog.description')}</p>
        <ChainStatus />
      </header>

      <form
        noValidate
        aria-label={t('auditlog.filters')}
        className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(e) => void apply(e)}
      >
        <Field label={t('auditlog.filter.action')} error={errors.action}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register('action')}>
              <option value="">{t('auditlog.filter.action_all')}</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {actionLabel(t, action)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('auditlog.filter.actor')} error={errors.actorId}>
          {(c) => (
            <select {...c} className={SELECT_CLASS} {...form.register('actorId')}>
              <option value="">{t('auditlog.filter.actor_all')}</option>
              {actors.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('auditlog.filter.entity')} hint={t('auditlog.filter.entity_hint')} error={errors.entity}>
          {(c) => (
            <>
              <Input {...c} list={entitiesId} autoComplete="off" spellCheck={false} maxLength={64} {...form.register('entity')} />
              <datalist id={entitiesId}>
                {ENTITIES.map((entity) => (
                  <option key={entity} value={entity} label={entityLabel(t, entity)} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label={t('auditlog.filter.entity_id')} error={errors.entityId}>
          {(c) => <Input {...c} autoComplete="off" spellCheck={false} maxLength={191} {...form.register('entityId')} />}
        </Field>
        <Field label={t('auditlog.filter.from')} error={errors.from}>
          {(c) => <Input {...c} type="date" {...form.register('from')} />}
        </Field>
        <Field label={t('auditlog.filter.to')} error={errors.to}>
          {(c) => <Input {...c} type="date" {...form.register('to')} />}
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
          <Button type="submit">{t('auditlog.filter.apply')}</Button>
          <Button type="button" variant="outline" onClick={clear}>
            {t('auditlog.filter.reset')}
          </Button>
        </div>
      </form>

      {canExport && (
        <section className="flex flex-wrap items-end gap-3">
          <Field label={t('auditlog.export.delimiter')} className="w-full max-w-xs">
            {(c) => (
              <select {...c} className={SELECT_CLASS} value={delimiter} onChange={(e) => setDelimiter(e.target.value as Delimiter)}>
                <option value="comma">{t('auditlog.export.comma')}</option>
                <option value="semicolon">{t('auditlog.export.semicolon')}</option>
              </select>
            )}
          </Field>
          <Button asChild variant="outline">
            <a href={exportHref(applied, delimiter)} download>
              <DownloadIcon aria-hidden="true" />
              {t('auditlog.export')}
            </a>
          </Button>
          <p className="w-full text-xs text-muted-foreground">{t('auditlog.export.hint')}</p>
        </section>
      )}

      {list.isError ? (
        <ProblemAlert error={list.error}>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>
            {t('table.retry')}
          </Button>
        </ProblemAlert>
      ) : list.data === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <DataTable table={table} caption={t('auditlog.caption')} empty={t('auditlog.empty')} />
          {list.hasNextPage ? (
            <div>
              <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t(list.isFetchingNextPage ? 'shell.loading' : 'auditlog.load_more')}
              </Button>
            </div>
          ) : (
            items.length > 0 && <p className="text-sm text-muted-foreground">{t('auditlog.end')}</p>
          )}
        </div>
      )}
    </div>
  );
}
