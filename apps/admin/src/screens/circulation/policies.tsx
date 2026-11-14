import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { PolicyBody, PolicyPatchBody, type PolicyListResponse, type PolicyView } from '@altis/shared/api/circulation';
import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, CheckField, Field, Notice, ProblemAlert, RootError, SELECT_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { MasterTable, changedFields, isFieldProblem, isStale, putFieldErrors, serverIssues, zodIssues, type MasterColumn } from '@/screens/catalog/masters/master-table';
import { useMemberTypes, useTypeName } from './common';

/**
 * Aturan Peminjaman (`/admin/layanan/aturan`): the loan rules. In this milestone a rule names a member type (or every
 * type: the general rule) and says whether that type may borrow, for how many days, how many items under the rule and
 * how many renewals. A loan takes the rule of the member's type, else the general rule; with neither the desk refuses
 * (CIRC_NO_POLICY). A rule's terms are copied into each loan: editing a rule never changes a running loan, and a new
 * rule counts its limit from zero.
 */

const POLICIES_KEY = ['circulation', 'policies'] as const;

interface PolicyForm {
  code: string;
  name: string;
  memberTypeId: string;
  loanable: boolean;
  loanDays: string;
  limitMode: 'limit' | 'none';
  loanLimit: string;
  renewLimit: string;
}

const count = (s: string): number | string => (/^\d{1,5}$/.test(s.trim()) ? Number(s.trim()) : s.trim());

function bodyOf(v: PolicyForm): Record<string, unknown> {
  return {
    code: v.code.trim(),
    name: v.name.trim(),
    memberTypeId: v.memberTypeId === '' ? null : v.memberTypeId,
    loanable: v.loanable,
    loanDays: count(v.loanDays),
    loanLimit: v.limitMode === 'none' ? null : count(v.loanLimit),
    renewLimit: count(v.renewLimit),
  };
}

function formOf(p: PolicyView | null): PolicyForm {
  if (p === null) return { code: '', name: '', memberTypeId: '', loanable: true, loanDays: '7', limitMode: 'none', loanLimit: '', renewLimit: '1' };
  return {
    code: p.code,
    name: p.name,
    memberTypeId: p.memberTypeId ?? '',
    loanable: p.loanable,
    loanDays: String(p.loanDays),
    limitMode: p.loanLimit === null ? 'none' : 'limit',
    loanLimit: p.loanLimit === null ? '' : String(p.loanLimit),
    renewLimit: String(p.renewLimit),
  };
}

/** A field check's own message on this form. */
const message = (path: string, code: string): TKey | undefined => {
  if (path === 'memberTypeId' && code === 'taken') return 'circulation.policies.error.type_taken';
  return undefined;
};

/** The field a server path lands on (the limit's number). */
const fieldOf = (path: string): string | undefined => (path === 'loanLimit' ? 'loanLimit' : undefined);

function PolicyFormDialog({ row, canManage, onSaved, onCancel }: { row: PolicyView | null; canManage: boolean; onSaved(code: string): Promise<void>; onCancel(): void }) {
  const t = useT();
  const typeName = useTypeName();
  const types = useMemberTypes();
  const queryClient = useQueryClient();
  const ids = useId();
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<PolicyForm>({ defaultValues: formOf(row) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const limitMode = form.watch('limitMode');

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    const next = bodyOf(values);
    const fields = row === null ? next : changedFields(next, bodyOf(formOf(row)));
    if (row !== null && Object.keys(fields).length === 0) {
      onCancel();
      return;
    }
    const parsed = (row === null ? PolicyBody : PolicyPatchBody).safeParse(row === null ? fields : { version: row.version, ...fields }, FORM_PARSE);
    if (!parsed.success) {
      putFieldErrors(form, zodIssues(parsed.error.issues, message), fieldOf);
      return;
    }
    try {
      if (row === null) await api<StoreResponse>('POST', 'circulation/policies', parsed.data);
      else await api<StoreResponse>('PATCH', `circulation/policies/${encodeURIComponent(row.id)}`, parsed.data);
    } catch (e) {
      if (isFieldProblem(e)) putFieldErrors(form, serverIssues(e, message), fieldOf);
      else setProblem(e);
      if (isStale(e)) await queryClient.invalidateQueries({ queryKey: POLICIES_KEY });
      return;
    }
    form.reset(values);
    await onSaved(values.code.trim());
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        form.clearErrors();
        void submit(e);
      }}>
      <fieldset disabled={!canManage} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label={t('circulation.policies.field.code')} error={errors.code}>
          {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} {...form.register('code')} />}
        </Field>
        <Field label={t('circulation.policies.field.name')} error={errors.name}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('name')} />}
        </Field>
        <Field id={`${ids}-type`} label={t('circulation.policies.field.member_type')} error={errors.memberTypeId} hint={t('circulation.policies.field.member_type_hint')} className="sm:col-span-2">
          <select id={`${ids}-type`} className={SELECT_CLASS} aria-invalid={errors.memberTypeId === undefined ? undefined : true} {...form.register('memberTypeId')}>
            <option value="">{t('circulation.policies.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.code} — {typeName(type)}
              </option>
            ))}
          </select>
        </Field>
        <CheckField className="sm:col-span-2" label={t('circulation.policies.field.loanable')} hint={t('circulation.policies.field.loanable_hint')} {...form.register('loanable')} />
        <Field label={t('circulation.policies.field.loan_days')} hint={t('circulation.policies.field.loan_days_hint')} error={errors.loanDays}>
          {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('loanDays')} />}
        </Field>
        <Field label={t('circulation.policies.field.renew_limit')} hint={t('circulation.policies.field.renew_limit_hint')} error={errors.renewLimit}>
          {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('renewLimit')} />}
        </Field>
        <fieldset className="grid gap-2 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">{t('circulation.policies.field.loan_limit')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="none" className="size-4 accent-primary" {...form.register('limitMode')} />
            {t('circulation.policies.limit.none')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="limit" className="size-4 accent-primary" {...form.register('limitMode')} />
            {t('circulation.policies.limit.at_most')}
          </label>
          {limitMode === 'limit' && (
            <Field label={t('circulation.policies.field.loan_limit_count')} error={errors.loanLimit} className="max-w-48">
              {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('loanLimit')} />}
            </Field>
          )}
          <p className="text-xs text-muted-foreground">{t('circulation.policies.field.loan_limit_hint')}</p>
        </fieldset>
        <RootError message={errors.root?.server?.message} />
        <div className="sm:col-span-2">
          <ProblemAlert error={problem} />
        </div>
      </fieldset>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t(canManage ? 'form.cancel' : 'circulation.policies.close')}
        </Button>
        {canManage && (
          <Button type="submit" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

export function PoliciesScreen() {
  const t = useT();
  const me = useMe();
  const typeName = useTypeName();
  const types = useMemberTypes(true);
  const queryClient = useQueryClient();
  const focus = useReturnFocus();
  const canManage = holds(me, 'circulation.policies.manage');
  const list = useApiQuery<PolicyListResponse>({ queryKey: [...POLICIES_KEY], path: 'circulation/policies' });
  const [dialog, setDialog] = useState<{ row: PolicyView | null } | null>(null);
  const [archiving, setArchiving] = useState<PolicyView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: POLICIES_KEY });

  const typeOf = (id: string | null): string => {
    if (id === null) return t('circulation.policies.all_types');
    const type = types.data?.items.find((x) => x.id === id);
    return type === undefined ? '—' : `${type.code} — ${typeName(type)}`;
  };

  const archive = async (row: PolicyView): Promise<void> => {
    setNotice(null);
    const current = list.data?.items.find((r) => r.id === row.id) ?? row;
    try {
      await api<StoreResponse>('DELETE', `circulation/policies/${encodeURIComponent(row.id)}`, { version: current.version });
    } catch (e) {
      if (isStale(e)) await refresh();
      throw e;
    }
    setNotice(t('circulation.policies.archived', { code: row.code }));
    await refresh();
  };

  const columns: MasterColumn<PolicyView>[] = [
    { id: 'code', header: t('circulation.policies.col.code'), cell: (r) => <span className="font-mono font-medium">{r.code}</span> },
    { id: 'name', header: t('circulation.policies.col.name'), cell: (r) => r.name },
    {
      id: 'type',
      header: t('circulation.policies.col.member_type'),
      cell: (r) => (r.memberTypeId === null ? <Badge tone="info">{typeOf(null)}</Badge> : typeOf(r.memberTypeId)),
    },
    {
      id: 'loanable',
      header: t('circulation.policies.col.loanable'),
      cell: (r) => (r.loanable ? t('circulation.policies.yes') : <Badge tone="warning">{t('circulation.policies.no')}</Badge>),
    },
    {
      id: 'days',
      header: t('circulation.policies.col.loan_days'),
      className: 'whitespace-nowrap',
      cell: (r) => (r.loanDays === 0 ? t('circulation.policies.same_day') : t('circulation.policies.days', { count: r.loanDays })),
    },
    {
      id: 'limit',
      header: t('circulation.policies.col.loan_limit'),
      cell: (r) => (r.loanLimit === null ? <Badge tone="neutral">{t('circulation.policies.limit.none')}</Badge> : String(r.loanLimit)),
    },
    {
      id: 'renew',
      header: t('circulation.policies.col.renew_limit'),
      cell: (r) => (r.renewLimit === 0 ? t('circulation.policies.renew_none') : t('circulation.policies.renew_times', { count: r.renewLimit })),
    },
    { id: 'open', header: t('circulation.policies.col.open_loans'), cell: (r) => String(r.openLoans) },
    {
      id: 'actions',
      header: t('table.actions'),
      className: 'whitespace-nowrap',
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label={t('circulation.policies.edit_named', { code: r.code })}
            onClick={() => {
              setNotice(null);
              setDialog({ row: r });
            }}>
            {t(canManage ? 'circulation.policies.edit' : 'circulation.policies.view')}
          </Button>
          {canManage && !r.archived && (
            <Button variant="outline" size="sm" aria-label={t('circulation.policies.archive_named', { code: r.code })} onClick={() => setArchiving(r)}>
              {t('circulation.policies.archive')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  const hasGeneral = list.data?.items.some((r) => r.memberTypeId === null && !r.archived) ?? true;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('nav.circulation.policies')}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('circulation.policies.intro')}</p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setNotice(null);
              setDialog({ row: null });
            }}>
            <PlusIcon aria-hidden="true" />
            {t('circulation.policies.add')}
          </Button>
        )}
      </div>
      {!hasGeneral && <Notice kind="error">{t('circulation.policies.no_general')}</Notice>}
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {list.data === undefined ? (
        list.isError ? (
          <Notice
            kind="error"
            action={
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                {t('table.retry')}
              </Button>
            }>
            {problemText(t, list.error)}
          </Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <MasterTable caption={t('circulation.policies.caption')} columns={columns} rows={list.data.items} empty={t('circulation.policies.empty')} />
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? undefined : setDialog(null))}>
        {dialog !== null && (
          <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{dialog.row === null ? t('circulation.policies.add') : t('circulation.policies.edit_title', { code: dialog.row.code })}</DialogTitle>
              <DialogDescription>{t('circulation.policies.form_intro')}</DialogDescription>
            </DialogHeader>
            <PolicyFormDialog
              row={dialog.row}
              canManage={canManage}
              onCancel={() => setDialog(null)}
              onSaved={async (code) => {
                await refresh();
                setNotice(t('circulation.policies.saved', { code }));
                setDialog(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('circulation.policies.confirm_archive', { code: archiving.code })}
          description={t('circulation.policies.confirm_archive_body')}
          confirmLabel={t('circulation.policies.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  );
}

