import { ACCRED_GROUPS } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { MemberTypeBody, MemberTypePatchBody, type MemberTypeView } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Field, Notice, ProblemAlert, RootError, SELECT_CLASS } from '@/components/form-field';
import { Callout, DenseTable, InlinePanel, PageHead, SkeletonTable, StatusText, Tag, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { changedFields, countsIn, isFieldProblem, isStale, optionalText, putFieldErrors, serverIssues, zodIssues } from '@/screens/catalog/masters/master-table';
import { useMemberTypes, useTypeName } from '@/screens/circulation/common';

/**
 * Tipe Anggota (`/admin/anggota/tipe`): the member types, each with its code, names, accreditation group, the most open
 * loans a member of the type may hold ("no limit" and "may not borrow" are explicit choices, never a magic number) and
 * the membership length ("never expires" explicit too). Saving a type never recalculates its members' dates: a new
 * length applies to a member when the membership is extended. A type live members still use cannot be archived (409
 * MEMBER_TYPE_IN_USE, with how many): said on the page. The loan period and renewals are the loan rules' (Aturan
 * Peminjaman): the table shows them read-only from the rule the type's loans of any collection fall under (its own
 * rule, else the general one), says when more specific rules apply to some of its loans, and links to the rules for a
 * user who may change them. The list is a dense table; adding or changing a type opens its form in the page, above the
 * table.
 */

const TYPES_KEY = ['members', 'types'] as const;

interface TypeForm {
  code: string;
  nameId: string;
  nameEn: string;
  accredGroup: string;
  limitMode: 'limit' | 'none' | 'zero';
  loanLimit: string;
  periodMode: 'days' | 'never';
  membershipDays: string;
  sortOrder: string;
  // ---- Komunitas (member area): the type's member services in the OPAC ----
  holdsAllowed: boolean;
  holdsLimit: string;
  onlineRenewal: boolean;
}

const count = (s: string): number | string => (/^\d{1,5}$/.test(s.trim()) ? Number(s.trim()) : s.trim());

function bodyOf(v: TypeForm): Record<string, unknown> {
  return {
    code: v.code.trim(),
    nameId: v.nameId.trim(),
    nameEn: optionalText(v.nameEn),
    accredGroup: v.accredGroup,
    loanLimit: v.limitMode === 'none' ? null : v.limitMode === 'zero' ? 0 : count(v.loanLimit),
    membershipDays: v.periodMode === 'never' ? null : count(v.membershipDays),
    sortOrder: v.sortOrder.trim() === '' ? 0 : count(v.sortOrder),
    holdsAllowed: v.holdsAllowed,
    holdsLimit: v.holdsLimit.trim() === '' ? 0 : count(v.holdsLimit),
    onlineRenewal: v.onlineRenewal,
  };
}

function formOf(row: MemberTypeView | null): TypeForm {
  if (row === null) {
    return {
      code: '',
      nameId: '',
      nameEn: '',
      accredGroup: 'student',
      limitMode: 'limit',
      loanLimit: '3',
      periodMode: 'days',
      membershipDays: '365',
      sortOrder: '0',
      holdsAllowed: true,
      holdsLimit: '2',
      onlineRenewal: true,
    };
  }
  return {
    code: row.code,
    nameId: row.nameId,
    nameEn: row.nameEn ?? '',
    accredGroup: row.accredGroup,
    limitMode: row.loanLimit === null ? 'none' : row.loanLimit === 0 ? 'zero' : 'limit',
    loanLimit: row.loanLimit === null || row.loanLimit === 0 ? '' : String(row.loanLimit),
    periodMode: row.membershipDays === null ? 'never' : 'days',
    membershipDays: row.membershipDays === null ? '' : String(row.membershipDays),
    sortOrder: String(row.sortOrder),
    holdsAllowed: row.holdsAllowed,
    holdsLimit: String(row.holdsLimit),
    onlineRenewal: row.onlineRenewal,
  };
}

function TypeFormBody({ row, canManage, onSaved, onCancel }: { row: MemberTypeView | null; canManage: boolean; onSaved(code: string): Promise<void>; onCancel(): void }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<TypeForm>({ defaultValues: formOf(row) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const limitMode = form.watch('limitMode');
  const periodMode = form.watch('periodMode');
  const holdsAllowed = form.watch('holdsAllowed');

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    const next = bodyOf(values);
    const fields = row === null ? next : changedFields(next, bodyOf(formOf(row)));
    if (row !== null && Object.keys(fields).length === 0) {
      onCancel();
      return;
    }
    const parsed = (row === null ? MemberTypeBody : MemberTypePatchBody).safeParse(row === null ? fields : { version: row.version, ...fields }, FORM_PARSE);
    if (!parsed.success) {
      putFieldErrors(form, zodIssues(parsed.error.issues));
      return;
    }
    try {
      if (row === null) await api<StoreResponse>('POST', 'members/types', parsed.data);
      else await api<StoreResponse>('PATCH', `members/types/${encodeURIComponent(row.id)}`, parsed.data);
    } catch (e) {
      if (isFieldProblem(e)) putFieldErrors(form, serverIssues(e));
      else setProblem(e);
      if (isStale(e)) await queryClient.invalidateQueries({ queryKey: TYPES_KEY });
      return;
    }
    form.reset(values);
    await onSaved(values.code.trim());
  });

  return (
    <InlinePanel
      title={row === null ? t('members.types.new_title') : t('members.types.edit_title', { code: row.code })}
      onCancel={onCancel}
      onSubmit={(e) => {
        form.clearErrors();
        void submit(e);
      }}>
      <fieldset disabled={!canManage} className="grid max-w-4xl min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('members.types.field.code')} error={errors.code}>
          {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} {...form.register('code')} />}
        </Field>
        <Field id={`${ids}-group`} label={t('members.types.field.accred_group')} hint={t('members.types.field.accred_group_hint')} error={errors.accredGroup}>
          <select id={`${ids}-group`} className={SELECT_CLASS} {...form.register('accredGroup')}>
            {ACCRED_GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`vocab.accred_group.${g}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('members.types.field.name_id')} error={errors.nameId}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('nameId')} />}
        </Field>
        <Field label={t('members.types.field.name_en')} error={errors.nameEn}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('nameEn')} />}
        </Field>
        <fieldset className="grid content-start gap-2">
          <legend className="mb-1 text-sm font-medium">{t('members.types.field.loan_limit')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="limit" className="size-4 accent-primary" {...form.register('limitMode')} />
            {t('members.types.limit.at_most')}
          </label>
          {limitMode === 'limit' && (
            <Field label={t('members.types.field.loan_limit_count')} error={errors.loanLimit} className="ml-6 max-w-40">
              {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('loanLimit')} />}
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="none" className="size-4 accent-primary" {...form.register('limitMode')} />
            {t('members.types.limit.none')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="zero" className="size-4 accent-primary" {...form.register('limitMode')} />
            {t('members.types.limit.zero')}
          </label>
        </fieldset>
        <fieldset className="grid content-start gap-2">
          <legend className="mb-1 text-sm font-medium">{t('members.types.field.period')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="days" className="size-4 accent-primary" {...form.register('periodMode')} />
            {t('members.types.period.days')}
          </label>
          {periodMode === 'days' && (
            <Field label={t('members.types.field.period_days')} error={errors.membershipDays} className="ml-6 max-w-40">
              {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('membershipDays')} />}
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="never" className="size-4 accent-primary" {...form.register('periodMode')} />
            {t('members.never_expires')}
          </label>
        </fieldset>
        {/* Komunitas (member area): the type's member services in the OPAC. */}
        <fieldset className="grid content-start gap-2 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">{t('members.types.field.opac')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" {...form.register('holdsAllowed')} />
            {t('members.types.field.holds_allowed')}
          </label>
          {holdsAllowed && (
            <Field label={t('members.types.field.holds_limit')} error={errors.holdsLimit} className="ml-6 max-w-40">
              {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('holdsLimit')} />}
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" {...form.register('onlineRenewal')} />
            {t('members.types.field.online_renewal')}
          </label>
        </fieldset>
        <Field label={t('members.types.field.sort_order')} error={errors.sortOrder}>
          {(c) => <Input {...c} inputMode="numeric" autoComplete="off" className="max-w-32" {...form.register('sortOrder')} />}
        </Field>
        <p className="text-sm text-muted-foreground sm:col-span-2">{t(row === null ? 'members.types.form_intro' : 'members.types.no_recount')}</p>
        <RootError message={errors.root?.server?.message} />
        <div className="sm:col-span-2">
          <ProblemAlert error={problem} />
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {canManage && (
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'members.types.save')}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t(canManage ? 'form.cancel' : 'members.close')}
        </Button>
      </div>
    </InlinePanel>
  );
}

export function MemberTypesScreen() {
  const t = useT();
  const me = useMe();
  const typeName = useTypeName();
  const queryClient = useQueryClient();
  const canManage = holds(me, 'members.types.manage');
  const [showArchived, setShowArchived] = useState(false);
  const list = useMemberTypes(showArchived);
  const [editing, setEditing] = useState<{ row: MemberTypeView | null } | null>(null);
  const [archiving, setArchiving] = useState<MemberTypeView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ name: string; count: number } | null>(null);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: TYPES_KEY });
  const open = (row: MemberTypeView | null): void => {
    setNotice(null);
    setInUse(null);
    setEditing({ row });
  };

  const archive = async (row: MemberTypeView): Promise<void> => {
    setNotice(null);
    setInUse(null);
    const current = list.data?.items.find((r) => r.id === row.id) ?? row;
    try {
      await api<StoreResponse>('DELETE', `members/types/${encodeURIComponent(row.id)}`, { version: current.version });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEMBER_TYPE_IN_USE') {
        setInUse({ name: typeName(row), count: countsIn(e.detail)[0] ?? current.memberCount });
        await refresh();
        return;
      }
      if (isStale(e)) await refresh();
      throw e;
    }
    setNotice(t('members.types.archived', { code: row.code }));
    await refresh();
  };

  const columns: DenseColumn<MemberTypeView>[] = [
    { id: 'code', header: t('members.types.col.code'), className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold tracking-wide">{r.code}</span> },
    {
      id: 'name',
      header: t('members.types.col.name'),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <strong>{typeName(r)}</strong>
          {r.archived && <Tag>{t('members.archived')}</Tag>}
        </span>
      ),
    },
    { id: 'group', header: t('members.types.col.accred_group'), cell: (r) => t(`vocab.accred_group.${r.accredGroup}`) },
    {
      id: 'limit',
      header: t('members.types.col.loan_limit'),
      cell: (r) =>
        r.loanLimit === null ? (
          t('members.types.limit.none')
        ) : r.loanLimit === 0 ? (
          <StatusText tone="warn">{t('members.types.limit.zero')}</StatusText>
        ) : (
          t('members.types.limit.items', { count: r.loanLimit })
        ),
    },
    // ---- Komunitas (staff screens' data): the general rule's loan period and renewals, read-only ----
    {
      id: 'loan_days',
      header: t('members.types.col.loan_days'),
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => {
        const rule = r.loanRule ?? null;
        if (rule === null) return <span className="text-muted-foreground">{t('members.types.rule.none')}</span>;
        return (
          <span className="grid justify-items-end">
            {!rule.loanable ? (
              <StatusText tone="warn">{t('members.types.rule.refuses')}</StatusText>
            ) : (
              <span className="whitespace-nowrap">{rule.loanDays === 0 ? t('members.types.rule.same_day') : t('members.types.days', { count: rule.loanDays })}</span>
            )}
            {rule.others > 0 && <span className="text-xs text-muted-foreground">{t('members.types.rule.others', { count: rule.others })}</span>}
          </span>
        );
      },
    },
    {
      id: 'renewals',
      header: t('members.types.col.renewals'),
      headClassName: 'text-right',
      className: 'text-right whitespace-nowrap',
      cell: (r) => {
        const rule = r.loanRule ?? null;
        if (rule === null || !rule.loanable) return <span className="text-muted-foreground">—</span>;
        return rule.renewLimit === 0 ? t('members.types.rule.no_renewal') : t('members.types.rule.renewals', { count: rule.renewLimit });
      },
    },
    {
      id: 'period',
      header: t('members.types.col.period'),
      className: 'whitespace-nowrap',
      cell: (r) => (r.membershipDays === null ? t('members.never_expires') : t('members.types.days', { count: r.membershipDays })),
    },
    { id: 'members', header: t('members.types.col.members'), headClassName: 'text-right', className: 'text-right', cell: (r) => String(r.memberCount) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (r) => (
        <>
          <Button variant="ghost" size="sm" aria-label={t('members.types.edit_named', { code: r.code })} onClick={() => open(r)}>
            {t(canManage ? 'members.types.edit' : 'members.types.view')}
          </Button>
          {canManage && !r.archived && (
            <Button variant="ghost" size="sm" aria-label={t('members.types.archive_named', { code: r.code })} onClick={() => setArchiving(r)}>
              {t('members.types.archive')}
            </Button>
          )}
        </>
      ),
    },
  ];

  const empty = list.data !== undefined && list.data.items.length === 0 && !showArchived;

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.members.types')}
        intro={t('members.types.intro')}
        actions={
          canManage && (
            <Button aria-expanded={editing !== null && editing.row === null} onClick={() => open(null)}>
              {t('members.types.add')}
            </Button>
          )
        }
      />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {inUse !== null && (
        <Callout tone="bad" role="alert" title={t('members.types.in_use_title', { name: inUse.name, count: inUse.count })}>
          <p>{t('members.types.in_use_body')}</p>
        </Callout>
      )}
      {editing !== null && (
        <TypeFormBody
          key={editing.row?.id ?? 'new'}
          row={editing.row}
          canManage={canManage}
          onCancel={() => setEditing(null)}
          onSaved={async (code) => {
            await refresh();
            setNotice(t('members.types.saved', { code }));
            setEditing(null);
          }}
        />
      )}
      {list.data === undefined ? (
        list.isError ? (
          <Callout
            tone="bad"
            role="alert"
            title={t('members.types.failed')}
            action={
              <Button variant="outline" size="sm" className="bg-background" onClick={() => void list.refetch()}>
                {t('table.retry')}
              </Button>
            }>
            <p>{problemText(t, list.error)}</p>
          </Callout>
        ) : (
          <SkeletonTable label={t('shell.loading')} columns={9} rows={4} />
        )
      ) : empty ? (
        <section className="grid max-w-[62ch] gap-3 py-4">
          <h2 className="text-base font-bold">{t('members.types.empty')}</h2>
          <p className="text-sm text-muted-foreground">{t('members.types.empty_hint')}</p>
        </section>
      ) : (
        <div className="grid gap-3">
          <CheckField label={t('members.types.show_archived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <DenseTable caption={t('members.types.caption')} columns={columns} rows={list.data.items} rowKey={(r) => r.id} empty={t('members.types.empty')} />
          <p className="text-meta text-muted-foreground">
            {t('members.types.rule.note')}{' '}
            {holds(me, 'circulation.policies.manage') && (
              <Link to="/admin/layanan/aturan" className="font-semibold text-accent-text underline-offset-4 hover:underline">
                {t('members.types.rule.open')}
              </Link>
            )}
          </p>
        </div>
      )}
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('members.types.confirm_archive', { code: archiving.code })}
          description={t('members.types.confirm_archive_body')}
          confirmLabel={t('members.types.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
