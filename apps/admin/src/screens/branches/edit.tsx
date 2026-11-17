import { BranchCreateBody, BranchPatchBody, type BranchItem, type BranchListResponse } from '@altis/shared/api/branches';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import type { z } from 'zod';
import { Field, Notice, NoticeAlert, ProblemAlert, RefetchProblem, TEXTAREA_CLASS } from '@/components/form-field';
import { BackLink, ErrorState, FORM_FULL, FormBar, FormSection, LoadingState, PageHead, StatusText } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { applyServerErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * A branch (spec §6.5, decision D6): add (`POST branches`) and edit (`PATCH branches/:id`) its code, name, address
 * and time zone. There is no `GET branches/:id`: the edit page finds the branch in the list (archived ones
 * included). The forms validate with the shared request schemas; an edit sends the row's `version` and only what
 * changed. Both return to the list. Without `system.branches.manage` both are read-only (no save button).
 */

type CreateInput = z.input<typeof BranchCreateBody>;
type PatchInput = z.input<typeof BranchPatchBody>;

/** The time zone a new branch starts with: Western Indonesia (WIB), where most ALTIS libraries are. */
const DEFAULT_TIMEZONE = 'Asia/Jakarta';

const addressValue = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);

/** The IANA zones this browser knows, for the time zone suggestions (empty where `Intl` cannot list them). */
function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

type BranchField = 'code' | 'name' | 'address' | 'timezone';

/** The four fields, shared by the create and the edit form (both have them under the same names). */
function BranchFields({
  register,
  errors,
}: {
  register: (name: BranchField, options?: { setValueAs(value: unknown): unknown }) => UseFormRegisterReturn<BranchField>;
  errors: Partial<Record<BranchField, { type?: string | number; message?: string }>>;
}) {
  const t = useT();
  const zonesId = useId();
  const zones = useMemo(timeZones, []);
  return (
    <>
      <Field label={t('branches.field.code')} hint={t('branches.field.code_hint')} error={errors.code}>
        {(c) => <Input {...c} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} {...register('code')} />}
      </Field>
      <Field label={t('branches.field.name')} error={errors.name}>
        {(c) => <Input {...c} autoComplete="off" maxLength={191} {...register('name')} />}
      </Field>
      <Field label={t('branches.field.address')} error={errors.address} className={FORM_FULL}>
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...register('address', { setValueAs: addressValue })} />}
      </Field>
      <Field label={t('branches.field.timezone')} hint={t('branches.field.timezone_hint')} error={errors.timezone}>
        {(c) => (
          <>
            <Input {...c} list={zonesId} autoComplete="off" spellCheck={false} maxLength={64} {...register('timezone')} />
            <datalist id={zonesId}>
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </>
        )}
      </Field>
    </>
  );
}

export function BranchCreateScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'system.branches.manage');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<CreateInput, unknown, BranchCreateBody>({
    resolver: zodResolver(BranchCreateBody),
    defaultValues: { code: '', name: '', address: null, timezone: DEFAULT_TIMEZONE },
  });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      await api<BranchItem>('POST', 'branches', values);
      await queryClient.invalidateQueries({ queryKey: ['branches'] });
      form.reset(values);
      await navigate({ href: '/admin/branches' });
    } catch (e) {
      if (e instanceof ApiError) applyServerErrors(form, e);
      setProblem(problemText(t, e));
    }
  });

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="grid gap-3">
        <BackLink to="/admin/branches">{t('branches.back')}</BackLink>
        <PageHead title={t('branches.new.title')} />
      </div>
      {/* The server would refuse (and record the refusal): say so before anything is typed. */}
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      {problem !== null && <Notice kind="error">{problem}</Notice>}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <FormSection title={t('branches.form.about')} intro={t('branches.form.about_intro')} disabled={!canManage}>
          <BranchFields register={(name, options) => form.register(name, options)} errors={errors} />
        </FormSection>
        {canManage && <FormButtons busy={isSubmitting} dirty={isDirty} />}
      </form>
    </div>
  );
}

function patchValues(b: BranchItem): PatchInput {
  return { version: b.version, code: b.code, name: b.name, address: b.address, timezone: b.timezone };
}

/** Save and Cancel (back to the list). */
function FormButtons({ busy, dirty }: { busy: boolean; dirty: boolean }) {
  const t = useT();
  return (
    <FormBar>
      <Button type="submit" disabled={busy}>
        {t(busy ? 'form.saving' : 'form.save')}
      </Button>
      <Button asChild variant="outline">
        <Link to="/admin/branches">{t('form.cancel')}</Link>
      </Button>
      {dirty && <StatusText tone="warn">{t('system.unsaved')}</StatusText>}
    </FormBar>
  );
}

function BranchEditForm({ branch, canManage }: { branch: BranchItem; canManage: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<PatchInput, unknown, BranchPatchBody>({ resolver: zodResolver(BranchPatchBody), defaultValues: patchValues(branch) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    const before = form.formState.defaultValues ?? {};
    const body: BranchPatchBody = { version: values.version };
    if (values.code !== before.code) body.code = values.code;
    if (values.name !== before.name) body.name = values.name;
    if ((values.address ?? null) !== (before.address ?? null)) body.address = values.address ?? null;
    if (values.timezone !== before.timezone) body.timezone = values.timezone;
    try {
      if (Object.keys(body).length > 1) {
        await api<BranchItem>('PATCH', `branches/${encodeURIComponent(branch.id)}`, body);
        await queryClient.invalidateQueries({ queryKey: ['branches'] });
      }
      form.reset(values);
      await navigate({ href: '/admin/branches' });
    } catch (e) {
      if (e instanceof ApiError) applyServerErrors(form, e);
      setProblem(problemText(t, e));
    }
  });

  return (
    <>
      {problem !== null && <Notice kind="error">{problem}</Notice>}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <FormSection title={t('branches.form.about')} intro={t('branches.form.about_intro')} disabled={!canManage}>
          {/* The patch form has the same four fields (plus `version`, which is not shown). */}
          <BranchFields register={(name, options) => form.register(name, options)} errors={errors} />
        </FormSection>
        {canManage && <FormButtons busy={isSubmitting} dirty={isDirty} />}
      </form>
    </>
  );
}

export function BranchEditScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'system.branches.manage');
  const { branchId = '' } = useParams({ strict: false }) as { branchId?: string };
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: true }], path: 'branches?includeArchived=true' });
  const branch = branches.data?.items.find((b) => b.id === branchId);

  return (
    <div className="grid max-w-5xl gap-6">
      {/* The data wins over an error: a failed background refetch keeps the form and what was typed. */}
      {branches.data === undefined ? (
        <>
          <BackLink to="/admin/branches">{t('branches.back')}</BackLink>
          {branches.isError ? (
            <ErrorState title={problemText(t, branches.error)} error={null} onRetry={() => void branches.refetch()} retrying={branches.isFetching} />
          ) : (
            <LoadingState />
          )}
        </>
      ) : branch === undefined ? (
        <>
          <BackLink to="/admin/branches">{t('branches.back')}</BackLink>
          <ErrorState title={t('error.NOT_FOUND')} error={null} />
        </>
      ) : (
        <>
          <div className="grid gap-3">
            <BackLink to="/admin/branches">{t('branches.back')}</BackLink>
            <PageHead title={branch.name} intro={branch.code} />
          </div>
          <RefetchProblem query={branches} />
          {branch.archivedAt !== null && <NoticeAlert>{t('branches.archived_notice')}</NoticeAlert>}
          {!canManage && <NoticeAlert>{t('branches.read_only')}</NoticeAlert>}
          <BranchEditForm key={branch.id} branch={branch} canManage={canManage} />
        </>
      )}
    </div>
  );
}
