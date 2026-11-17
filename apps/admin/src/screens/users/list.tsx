import type { BranchListResponse } from '@altis/shared/api/branches';
import type { TemporaryPasswordResponse, UserListItem, UserListResponse, UserStatus } from '@altis/shared/api/users';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, Pager, useDateTime } from '@/components/data-table';
import { Notice, SELECT_CLASS } from '@/components/form-field';
import { ErrorState, FilterField, FilterRow, MoreMenu, MoreMenuItem, MoreMenuRule, PageHead, SkeletonTable, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds, meId, roleLabel } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { TempPasswordDialog } from './temp-password-dialog';

/**
 * Pengguna staf (spec §13.3; route catalog `users.*`): the list of staff users, searched and filtered by the server
 * (`GET users?q&status&page&pageSize`), a page at a time.
 *
 * The row actions (disable or enable, reset the password, reset 2FA) show only with `system.users.manage`, and never
 * on the signed-in user's own row (the server refuses those on oneself, D24). Disabling and the resets ask first; the
 * server may then ask for the password (reauth, §7.3), which the API client handles. A reset password is shown once
 * (TempPasswordDialog). Hiding is a convenience only: the server checks every request (rules 3-4 of §7.2).
 */

const PAGE_SIZE = 25;
const STATUS_FILTERS: readonly UserStatus[] = ['active', 'disabled', 'locked'];

const features = tableFeatures({});
const column = createColumnHelper<typeof features, UserListItem>();
const NO_USERS: UserListItem[] = [];

type Action = 'disable' | 'reset_password' | 'reset_2fa';

const STATUS_TONE = { active: 'ok', disabled: 'neutral', locked: 'bad' } as const;

const CONFIRM_LABEL: Record<Action, 'users.action.disable' | 'users.action.reset_password' | 'users.action.reset_2fa'> = {
  disable: 'users.action.disable',
  reset_password: 'users.action.reset_password',
  reset_2fa: 'users.action.reset_2fa',
};

function statusText(t: Translate, status: UserStatus): string {
  return t(`users.status.${status}`);
}

export function UsersListScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const formatDate = useDateTime();
  const ids = { search: useId(), status: useId() };
  const canManage = holds(me, 'system.users.manage');
  const selfId = meId(me);

  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<{ action: Action; user: UserListItem } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  // The temporary password of a reset: answered while the confirmation is still open, shown once it has closed (one
  // modal at a time; "Selesai" then returns the focus to the row's button). A ref, so that the closed confirmation
  // (already unmounted) still finds it.
  const answered = useRef<{ password: string; name: string } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [temporary, setTemporary] = useState<{ password: string; name: string } | null>(null);
  // From the question on, a password reset counts as a form being filled: its answer (the temporary password, shown
  // once) may be the first to come from a newer release, and a reload then would lose it (TempPasswordDialog holds
  // the page while it shows).
  useDirtyGuard(pending?.action === 'reset_password' || revealing);

  const reveal = (): void => {
    if (answered.current !== null) setTemporary(answered.current);
    answered.current = null;
    setRevealing(false);
  };

  const query = new URLSearchParams();
  if (q !== '') query.set('q', q);
  if (status !== '') query.set('status', status);
  query.set('page', String(page));
  query.set('pageSize', String(PAGE_SIZE));
  const list = useApiQuery<UserListResponse>({
    queryKey: ['users', 'list', { q, status, page }],
    path: `users?${query.toString()}`,
    placeholderData: keepPreviousData,
  });
  // Branch names for the role scopes (archived ones too: an assignment may still point at one).
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: true }], path: 'branches?includeArchived=true' });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['users'] });

  const enable = async (user: UserListItem): Promise<void> => {
    setNotice(null);
    try {
      await api('POST', `users/${encodeURIComponent(user.id)}/enable`);
      setNotice({ kind: 'success', text: t('users.done.enabled', { name: user.name }) });
      await refresh();
    } catch (e) {
      setNotice({ kind: 'error', text: problemText(t, e) });
    }
  };

  /** The confirmed action; a failure rejects, and the confirmation dialog shows it. */
  const run = async (action: Action, user: UserListItem): Promise<void> => {
    const id = encodeURIComponent(user.id);
    setNotice(null);
    if (action === 'disable') {
      await api('POST', `users/${id}/disable`);
      setNotice({ kind: 'success', text: t('users.done.disabled', { name: user.name }) });
    } else if (action === 'reset_password') {
      const answer = await api<TemporaryPasswordResponse>('POST', `users/${id}/reset-password`);
      answered.current = { password: answer.temporaryPassword, name: user.name };
      setRevealing(true);
    } else {
      await api('POST', `users/${id}/reset-2fa`);
      setNotice({ kind: 'success', text: t('users.done.reset_2fa', { name: user.name }) });
    }
    await refresh();
  };

  const columns = useMemo(() => {
    const branchName = new Map((branches.data?.items ?? []).map((b) => [b.id, b.name]));
    const base = [
      column.accessor('username', {
        header: t('users.col.username'),
        cell: (info) => (
          <Link to={`/admin/users/${encodeURIComponent(info.row.original.id)}`} className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('name', { header: t('users.col.name') }),
      column.accessor('email', { header: t('users.col.email'), cell: (info) => info.getValue() ?? '—' }),
      column.accessor('roles', {
        header: t('users.col.roles'),
        cell: (info) =>
          info.getValue().length === 0 ? (
            <span className="text-muted-foreground">{t('users.no_roles')}</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {info.getValue().map((r) => (
                <li key={`${r.roleId}:${r.branchId ?? ''}`}>
                  {roleLabel(t, r)}
                  {r.branchId !== null && <span className="text-muted-foreground"> · {branchName.get(r.branchId) ?? r.branchId}</span>}
                </li>
              ))}
            </ul>
          ),
      }),
      column.accessor('status', {
        header: t('users.col.status'),
        cell: (info) => <Tag tone={STATUS_TONE[info.getValue()]}>{statusText(t, info.getValue())}</Tag>,
      }),
      column.accessor('totpEnabled', {
        header: t('users.col.2fa'),
        cell: (info) => (
          <span className="whitespace-nowrap">
            {t(info.getValue() ? 'users.2fa.on' : 'users.2fa.off')}
            {info.row.original.mfaRequired && <span className="text-muted-foreground"> · {t('users.2fa.required')}</span>}
          </span>
        ),
      }),
      column.accessor('lastLoginAt', {
        header: t('users.col.last_login'),
        cell: (info) => {
          const at = info.getValue();
          return <span className="whitespace-nowrap">{at === null ? t('users.never') : formatDate(at)}</span>;
        },
      }),
    ];
    if (!canManage) return column.columns(base);
    return column.columns([
      ...base,
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('table.actions')}</span>,
        cell: (info) => {
          const user = info.row.original;
          if (user.id === selfId) return null;
          return (
            <MoreMenu small label={t('users.more_named', { name: user.name })}>
              {user.status !== 'active' && <MoreMenuItem onSelect={() => void enable(user)}>{t('users.action.enable')}</MoreMenuItem>}
              <MoreMenuItem onSelect={() => setPending({ action: 'reset_password', user })}>{t('users.action.reset_password')}</MoreMenuItem>
              {user.totpEnabled && <MoreMenuItem onSelect={() => setPending({ action: 'reset_2fa', user })}>{t('users.action.reset_2fa')}</MoreMenuItem>}
              {user.status !== 'disabled' && (
                <>
                  <MoreMenuRule />
                  <MoreMenuItem danger onSelect={() => setPending({ action: 'disable', user })}>
                    {t('users.action.disable')}
                  </MoreMenuItem>
                </>
              )}
            </MoreMenu>
          );
        },
      }),
    ]);
    // enable() reads `t` and stable setters only, which these dependencies cover.
  }, [t, canManage, selfId, branches.data, formatDate]);

  const table = useTable({ features, columns, data: list.data?.items ?? NO_USERS, getRowId: (user) => user.id });

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setQ(draft.trim());
    setPage(1);
  };

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.users')}
        intro={t('users.intro')}
        actions={
          canManage ? (
            <Button asChild>
              <Link to="/admin/users/new">{t('users.add')}</Link>
            </Button>
          ) : undefined
        }
      />
      {notice !== null && <Notice kind={notice.kind}>{notice.text}</Notice>}

      <FilterRow label={t('users.filters')} onSubmit={submitSearch} submitLabel={t('users.search_submit')}>
        <FilterField wide id={ids.search} label={t('users.search')}>
          <Input id={ids.search} type="search" maxLength={64} placeholder={t('users.search_placeholder')} value={draft} onChange={(e) => setDraft(e.target.value)} />
        </FilterField>
        <FilterField id={ids.status} label={t('users.status_filter')}>
          <select
            id={ids.status}
            className={SELECT_CLASS}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as UserStatus | '');
              setPage(1);
            }}
          >
            <option value="">{t('users.status.all')}</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {statusText(t, s)}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterRow>

      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={canManage ? 8 : 7} />
      ) : (
        <div className="grid gap-3">
          <DataTable table={table} caption={t('users.caption')} empty={t('users.empty')} />
          <Pager page={page} pages={pages} label={t(total === 1 ? 'users.paging_one' : 'users.paging', { page, pages, total })} onPage={setPage} />
        </div>
      )}

      {pending !== null && (
        <ConfirmDialog
          open
          destructive={pending.action !== 'reset_2fa'}
          title={t(`users.confirm.${pending.action}.title`, { name: pending.user.name })}
          description={t(`users.confirm.${pending.action}.body`)}
          confirmLabel={t(CONFIRM_LABEL[pending.action])}
          onConfirm={() => run(pending.action, pending.user)}
          onClose={() => setPending(null)}
          onClosed={reveal}
        />
      )}
      <TempPasswordDialog password={temporary?.password ?? null} userName={temporary?.name ?? ''} onClose={() => setTemporary(null)} />
    </div>
  );
}
