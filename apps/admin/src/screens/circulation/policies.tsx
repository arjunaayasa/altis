import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { CollectionTypeView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { PolicyBody, PolicyPatchBody, type PolicyListResponse, type PolicyResolveResponse, type PolicyView } from '@altis/shared/api/circulation';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Field, Notice, ProblemAlert, RootError, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, InlinePanel, MoreMenu, MoreMenuItem, MoreMenuRule, PageError, PageHead, Section, SkeletonTable, StatusText, Tag, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { changedFields, isFieldProblem, isStale, putFieldErrors, serverIssues, useMasterList, zodIssues } from '@/screens/catalog/masters/master-table';
import { cn } from '@/lib/utils';
import { useMemberTypes, useTypeName } from './common';

/**
 * Aturan Peminjaman (`/admin/layanan/aturan`): the loan rules, a matrix of member type × collection type × material
 * type (each "all" when left empty). A rule says whether such a loan is allowed, for how many days, how many items
 * under the rule, how many renewals, and the fine per late day (its cap and the grace days). A loan takes the most
 * specific rule that fits; a tie goes to the rule whose first filled dimension comes earlier (member type, then
 * collection type, then material type). With none the desk refuses (CIRC_NO_POLICY). A rule's terms are copied into
 * each loan: editing a rule never changes a running loan, and a new rule counts its limit from zero.
 *
 * Adding or changing a rule opens its form in the page, above the table. "Aturan mana yang berlaku?" below the table asks the server for the ranking of a combination
 * (`GET circulation/policies/resolve`), so the librarian sees the winner and why the others lose.
 */

const POLICIES_KEY = ['circulation', 'policies'] as const;

interface PolicyForm {
  code: string;
  name: string;
  memberTypeId: string;
  collectionTypeId: string;
  materialTypeId: string;
  loanable: boolean;
  loanDays: string;
  limitMode: 'limit' | 'none';
  loanLimit: string;
  renewLimit: string;
  finePerDay: string;
  capMode: 'cap' | 'none';
  fineCap: string;
  graceDays: string;
}

const count = (s: string): number | string => (/^\d{1,5}$/.test(s.trim()) ? Number(s.trim()) : s.trim());

/** A typed amount as the API's decimal: `1.500` and `1500` are fifteen hundred, `2,5` is two and a half. */
const amount = (s: string): string => {
  const t = s.trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return t.replace(/\./g, '').replace(',', '.');
  return t.replace(',', '.');
};

/** A decimal of the API as typed in the form (`1500.00` → `1500`, `2.50` → `2.5`). */
const typed = (decimal: string): string => decimal.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

function bodyOf(v: PolicyForm): Record<string, unknown> {
  return {
    code: v.code.trim(),
    name: v.name.trim(),
    memberTypeId: v.memberTypeId === '' ? null : v.memberTypeId,
    collectionTypeId: v.collectionTypeId === '' ? null : v.collectionTypeId,
    materialTypeId: v.materialTypeId === '' ? null : v.materialTypeId,
    loanable: v.loanable,
    loanDays: count(v.loanDays),
    loanLimit: v.limitMode === 'none' ? null : count(v.loanLimit),
    renewLimit: count(v.renewLimit),
    finePerDay: amount(v.finePerDay === '' ? '0' : v.finePerDay),
    fineCap: v.capMode === 'none' ? null : amount(v.fineCap),
    graceDays: count(v.graceDays === '' ? '0' : v.graceDays),
  };
}

function formOf(p: PolicyView | null): PolicyForm {
  if (p === null) {
    return {
      code: '',
      name: '',
      memberTypeId: '',
      collectionTypeId: '',
      materialTypeId: '',
      loanable: true,
      loanDays: '7',
      limitMode: 'none',
      loanLimit: '',
      renewLimit: '1',
      finePerDay: '0',
      capMode: 'none',
      fineCap: '',
      graceDays: '0',
    };
  }
  return {
    code: p.code,
    name: p.name,
    memberTypeId: p.memberTypeId ?? '',
    collectionTypeId: p.collectionTypeId ?? '',
    materialTypeId: p.materialTypeId ?? '',
    loanable: p.loanable,
    loanDays: String(p.loanDays),
    limitMode: p.loanLimit === null ? 'none' : 'limit',
    loanLimit: p.loanLimit === null ? '' : String(p.loanLimit),
    renewLimit: String(p.renewLimit),
    finePerDay: typed(p.finePerDay),
    capMode: p.fineCap === null ? 'none' : 'cap',
    fineCap: p.fineCap === null ? '' : typed(p.fineCap),
    graceDays: String(p.graceDays),
  };
}

/** A field check's own message on this form. */
const message = (path: string, code: string): TKey | undefined => {
  if (path === 'scope' && code === 'taken') return 'circulation.rules.error.scope_taken';
  if ((path === 'finePerDay' || path === 'fineCap') && code !== 'required') return 'circulation.rules.error.amount';
  return undefined;
};

/** The field a server path lands on (a taken scope on the member type, the first dimension). */
const fieldOf = (path: string): string | undefined => (path === 'scope' ? 'memberTypeId' : path === 'loanLimit' || path === 'fineCap' ? path : undefined);

type Named = Pick<CollectionTypeView, 'id' | 'code' | 'nameId' | 'nameEn' | 'archived'>;

/** The collection types and material types (archived ones too, so an old rule still names them). */
function useDimensions() {
  const collections = useMasterList<CollectionTypeView>('collection-types', true);
  const materials = useMasterList<MaterialTypeView>('material-types', true);
  return { collections: (collections.data?.items ?? []) as Named[], materials: (materials.data?.items ?? []) as Named[] };
}

function PolicyForm({ row, canManage, onSaved, onCancel }: { row: PolicyView | null; canManage: boolean; onSaved(code: string): Promise<void>; onCancel(): void }) {
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
  const capMode = form.watch('capMode');
  const dims = useDimensions();
  const nameOf = useNameOf();

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
    <InlinePanel
      title={row === null ? t('circulation.policies.add') : t('circulation.policies.edit_title', { code: row.code })}
      onCancel={onCancel}
      onSubmit={(e) => {
        form.clearErrors();
        void submit(e);
      }}>
      <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('circulation.policies.form_intro')}</p>
      <fieldset disabled={!canManage} className="grid max-w-4xl min-w-0 gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('circulation.policies.field.code')} error={errors.code}>
          {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} {...form.register('code')} />}
        </Field>
        <Field label={t('circulation.policies.field.name')} error={errors.name}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('name')} />}
        </Field>
        <Field id={`${ids}-type`} label={t('circulation.policies.field.member_type')} error={errors.memberTypeId} hint={t('circulation.rules.field.scope_hint')} className="sm:col-span-2">
          <select id={`${ids}-type`} className={SELECT_CLASS} aria-invalid={errors.memberTypeId === undefined ? undefined : true} {...form.register('memberTypeId')}>
            <option value="">{t('circulation.policies.all_types')}</option>
            {(types.data?.items ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.code} — {typeName(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-collection`} label={t('circulation.rules.field.collection_type')} error={errors.collectionTypeId}>
          <select id={`${ids}-collection`} className={SELECT_CLASS} {...form.register('collectionTypeId')}>
            <option value="">{t('circulation.rules.all_collections')}</option>
            {dims.collections
              .filter((c) => !c.archived || c.id === row?.collectionTypeId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {nameOf(c)}
                </option>
              ))}
          </select>
        </Field>
        <Field id={`${ids}-material`} label={t('circulation.rules.field.material_type')} error={errors.materialTypeId}>
          <select id={`${ids}-material`} className={SELECT_CLASS} {...form.register('materialTypeId')}>
            <option value="">{t('circulation.rules.all_materials')}</option>
            {dims.materials
              .filter((m) => !m.archived || m.id === row?.materialTypeId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} — {nameOf(m)}
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
        <Field label={t('circulation.rules.field.fine_per_day')} hint={t('circulation.rules.field.fine_per_day_hint')} error={errors.finePerDay}>
          {(c) => <Input {...c} inputMode="decimal" autoComplete="off" {...form.register('finePerDay')} />}
        </Field>
        <Field label={t('circulation.rules.field.grace_days')} hint={t('circulation.rules.field.grace_days_hint')} error={errors.graceDays}>
          {(c) => <Input {...c} inputMode="numeric" autoComplete="off" {...form.register('graceDays')} />}
        </Field>
        <fieldset className="grid gap-2 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">{t('circulation.rules.field.fine_cap')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="none" className="size-4 accent-primary" {...form.register('capMode')} />
            {t('circulation.rules.cap.none')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" value="cap" className="size-4 accent-primary" {...form.register('capMode')} />
            {t('circulation.rules.cap.at_most')}
          </label>
          {capMode === 'cap' && (
            <Field label={t('circulation.rules.field.fine_cap_amount')} error={errors.fineCap} className="max-w-48">
              {(c) => <Input {...c} inputMode="decimal" autoComplete="off" {...form.register('fineCap')} />}
            </Field>
          )}
        </fieldset>
        <RootError message={errors.root?.server?.message} />
        <div className="sm:col-span-2">
          <ProblemAlert error={problem} />
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {canManage && (
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t(canManage ? 'form.cancel' : 'circulation.policies.close')}
        </Button>
      </div>
    </InlinePanel>
  );
}

export function PoliciesScreen() {
  const t = useT();
  const me = useMe();
  const typeName = useTypeName();
  const types = useMemberTypes(true);
  const queryClient = useQueryClient();
  const canManage = holds(me, 'circulation.policies.manage');
  const list = useApiQuery<PolicyListResponse>({ queryKey: [...POLICIES_KEY], path: 'circulation/policies' });
  const [editing, setEditing] = useState<{ row: PolicyView | null } | null>(null);
  const [archiving, setArchiving] = useState<PolicyView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: POLICIES_KEY });

  const dims = useDimensions();
  const typeOf = (id: string | null): string => {
    if (id === null) return t('circulation.policies.all_types');
    const type = types.data?.items.find((x) => x.id === id);
    return type === undefined ? '—' : `${type.code} — ${typeName(type)}`;
  };
  const codeIn = (list: readonly Named[], id: string | null): string | null => (id === null ? null : (list.find((x) => x.id === id)?.code ?? '—'));
  /** "Siswa · FIKSI · Semua jenis bahan": the rule's three dimensions, "all" spelled out. */
  const scopeOf = (r: PolicyView): string =>
    [
      r.memberTypeId === null ? t('circulation.rules.all_types_short') : typeOf(r.memberTypeId),
      codeIn(dims.collections, r.collectionTypeId) ?? t('circulation.rules.all_collections_short'),
      codeIn(dims.materials, r.materialTypeId) ?? t('circulation.rules.all_materials_short'),
    ].join(' · ');

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

  const open = (row: PolicyView | null): void => {
    setNotice(null);
    setEditing({ row });
  };

  const columns: DenseColumn<PolicyView>[] = [
    {
      id: 'rule',
      header: t('circulation.policies.col.rule'),
      className: 'min-w-40',
      cell: (r) => (
        <>
          <p className="font-semibold tracking-wide">{r.code}</p>
          <p className="text-meta text-muted-foreground">{r.name}</p>
        </>
      ),
    },
    {
      id: 'scope',
      header: t('circulation.rules.col.scope'),
      cell: (r) => (r.specificity === 0 ? <Tag>{t('circulation.rules.general')}</Tag> : scopeOf(r)),
    },
    {
      id: 'loanable',
      header: t('circulation.policies.col.loanable'),
      cell: (r) => (r.loanable ? t('circulation.policies.yes') : <StatusText tone="warn">{t('circulation.policies.no')}</StatusText>),
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
      cell: (r) => (r.loanLimit === null ? t('circulation.policies.limit.none') : String(r.loanLimit)),
    },
    {
      id: 'renew',
      header: t('circulation.policies.col.renew_limit'),
      cell: (r) => (r.renewLimit === 0 ? t('circulation.policies.renew_none') : t('circulation.policies.renew_times', { count: r.renewLimit })),
    },
    {
      id: 'fine',
      header: t('circulation.rules.col.fine'),
      cell: (r) =>
        Number(r.finePerDay) === 0
          ? t('circulation.rules.no_fine')
          : t('circulation.rules.fine_value', { amount: typed(r.finePerDay), currency: r.currency, grace: r.graceDays }),
    },
    { id: 'open', header: t('circulation.policies.col.open_loans'), headClassName: 'text-right', className: 'text-right', cell: (r) => String(r.openLoans) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right',
      cell: (r) => (
        <MoreMenu small label={t('circulation.policies.more_named', { code: r.code })}>
          <MoreMenuItem aria-label={t('circulation.policies.edit_named', { code: r.code })} onSelect={() => open(r)}>
            {t(canManage ? 'circulation.policies.edit' : 'circulation.policies.view')}
          </MoreMenuItem>
          {canManage && !r.archived && (
            <>
              <MoreMenuRule />
              <MoreMenuItem danger aria-label={t('circulation.policies.archive_named', { code: r.code })} onSelect={() => setArchiving(r)}>
                {t('circulation.policies.archive')}
              </MoreMenuItem>
            </>
          )}
        </MoreMenu>
      ),
    },
  ];

  const hasGeneral = list.data?.items.some((r) => r.specificity === 0 && !r.archived) ?? true;

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.circulation.policies')}
        intro={t('circulation.rules.intro')}
        actions={
          canManage && (
            <Button aria-expanded={editing !== null && editing.row === null} onClick={() => open(null)}>
              {t('circulation.policies.add')}
            </Button>
          )
        }
      />
      {!hasGeneral && <Notice kind="error">{t('circulation.policies.no_general')}</Notice>}
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {editing !== null && (
        <PolicyForm
          key={editing.row?.id ?? 'new'}
          row={editing.row}
          canManage={canManage}
          onCancel={() => setEditing(null)}
          onSaved={async (code) => {
            await refresh();
            setNotice(t('circulation.policies.saved', { code }));
            setEditing(null);
          }}
        />
      )}
      {list.data === undefined ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <SkeletonTable label={t('shell.loading')} columns={8} rows={3} />
        )
      ) : (
        <DenseTable caption={t('circulation.policies.caption')} columns={columns} rows={list.data.items} rowKey={(r) => r.id} empty={t('circulation.policies.empty')} />
      )}
      <ResolveTool collections={dims.collections} materials={dims.materials} scopeOf={scopeOf} />
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


/** A master's name in the UI language. */
function useNameOf(): (row: Pick<Named, 'nameId' | 'nameEn'>) => string {
  const english = useLocale() === 'en';
  return (row) => (english && row.nameEn !== '' ? row.nameEn : row.nameId);
}

/** "Aturan mana yang berlaku untuk…": a combination of dimensions, and the rules that fit it, the winner first. */
function ResolveTool({ collections, materials, scopeOf }: { collections: readonly Named[]; materials: readonly Named[]; scopeOf(r: PolicyView): string }) {
  const t = useT();
  const ids = useId();
  const types = useMemberTypes();
  const typeName = useTypeName();
  const nameOf = useNameOf();
  const [dims, setDims] = useState({ memberTypeId: '', collectionTypeId: '', materialTypeId: '' });
  const query = new URLSearchParams(Object.entries(dims).filter(([, v]) => v !== ''));
  const result = useApiQuery<PolicyResolveResponse>({ queryKey: ['circulation', 'policies', 'resolve', dims], path: `circulation/policies/resolve?${query.toString()}` });
  const pick = (key: keyof typeof dims) => (e: { target: { value: string } }) => setDims((d) => ({ ...d, [key]: e.target.value }));
  return (
    <Section title={t('circulation.rules.resolve.title')}>
      <p className="-mt-1 max-w-[75ch] text-sm text-muted-foreground">{t('circulation.rules.resolve.intro')}</p>
      <FilterRow label={t('circulation.rules.resolve.title')}>
        <FilterField id={`${ids}-m`} label={t('circulation.policies.field.member_type')}>
          <select id={`${ids}-m`} className={SELECT_CLASS} value={dims.memberTypeId} onChange={pick('memberTypeId')}>
            <option value="">{t('circulation.rules.resolve.none')}</option>
            {(types.data?.items ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} — {typeName(x)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${ids}-c`} label={t('circulation.rules.field.collection_type')}>
          <select id={`${ids}-c`} className={SELECT_CLASS} value={dims.collectionTypeId} onChange={pick('collectionTypeId')}>
            <option value="">{t('circulation.rules.resolve.none')}</option>
            {collections
              .filter((x) => !x.archived)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} — {nameOf(x)}
                </option>
              ))}
          </select>
        </FilterField>
        <FilterField id={`${ids}-t`} label={t('circulation.rules.field.material_type')}>
          <select id={`${ids}-t`} className={SELECT_CLASS} value={dims.materialTypeId} onChange={pick('materialTypeId')}>
            <option value="">{t('circulation.rules.resolve.none')}</option>
            {materials
              .filter((x) => !x.archived)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} — {nameOf(x)}
                </option>
              ))}
          </select>
        </FilterField>
      </FilterRow>
      {result.isError && <ErrorState error={result.error} onRetry={() => void result.refetch()} retrying={result.isFetching} />}
      {result.data !== undefined &&
        (result.data.winner === null ? (
          <PageError title={t('circulation.rules.resolve.no_rule')} />
        ) : (
          <ol aria-label={t('circulation.rules.resolve.ranking')} className="grid rounded-lg border text-sm">
            {result.data.candidates.map((c) => (
              <li key={c.policy.id} className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-2.5 last:border-b-0', c.rank === 1 && 'bg-accent-soft')}>
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{c.rank}.</span>
                  <span className="font-semibold tracking-wide">{c.policy.code}</span>
                  <span>{c.policy.specificity === 0 ? t('circulation.rules.general') : scopeOf(c.policy)}</span>
                  {c.rank === 1 && <Tag tone="ok">{t('circulation.rules.resolve.applies')}</Tag>}
                </span>
                <span className="text-meta text-muted-foreground">{t(`vocab.policy_rank_reason.${c.reason}`)}</span>
              </li>
            ))}
          </ol>
        ))}
    </Section>
  );
}
