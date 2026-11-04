import type { Permission } from '@altis/shared';
import { RoleCreateBody, type PermissionListResponse, type RoleItem, type RolePatchBody } from '@altis/shared/api/roles';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { ArrowLeftIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, CheckField, Field, Notice, ProblemAlert, RefetchProblem, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { grantable, holds, isSuperAdmin, roleLabel } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { applyServerErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { PermissionPicker } from './permission-picker';

/**
 * A role (spec §7.2, §13.3 "Peran"): create (`POST roles`), edit (`PATCH roles/:id`), delete (`DELETE roles/:id`).
 * Every write needs `system.roles.manage` and a fresh password confirmation (the API client opens the reauth dialog).
 *
 * - A custom role: name, description, the 2FA requirement and its permissions (PermissionPicker). When it holds a
 *   permission the signed-in user cannot grant, the whole role is read-only for them (rule 1: changing it would count
 *   as granting it).
 * - A system role (`super_admin`, `admin`): its permissions are shown read-only (computed from the catalog), and
 *   only its 2FA switch can change, for super admins only.
 * - The form validates with `RoleCreateBody`; an edit sends the role's `version` and only what changed.
 */

type RoleInput = z.input<typeof RoleCreateBody>;

const descriptionValue = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);

const INFO_CLASS = 'rounded-md border bg-muted/50 px-3 py-2 text-sm';

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sb = new Set(b);
  return a.length === sb.size && a.every((x) => sb.has(x));
}

function BackLink({ label }: { label: string }) {
  return (
    <Link to="/admin/roles" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {label}
    </Link>
  );
}

function Loading({ t }: { t: Translate }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {t('shell.loading')}
    </p>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {hint !== undefined && <p className="text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function roleValues(role: RoleItem | null): RoleInput {
  return {
    name: role?.name ?? '',
    description: role?.description ?? null,
    permissions: role?.permissions ?? [],
    mfaRequired: role?.mfaRequired ?? false,
  };
}

/**
 * The editable form of a new or a custom role. `role` is the role as the form was loaded (and as each save answered
 * it): its `version` is the one a PATCH sends, so a role changed elsewhere meanwhile is CONFLICT_STALE, never
 * overwritten.
 */
function CustomRoleForm({ initial, catalog, readOnly = false }: { initial: RoleItem | null; catalog: PermissionListResponse['items']; readOnly?: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [role, setRole] = useState(initial);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const form = useForm<RoleInput, unknown, RoleCreateBody>({ resolver: zodResolver(RoleCreateBody), defaultValues: roleValues(role) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async (values) => {
    setNotice(null);
    try {
      if (role === null) {
        const created = await api<RoleItem>('POST', 'roles', values);
        queryClient.setQueryData(['roles', 'detail', created.id], created);
        void queryClient.invalidateQueries({ queryKey: ['roles', 'list'] });
        form.reset(roleValues(created));
        await navigate({ href: `/admin/roles/${encodeURIComponent(created.id)}`, state: { created: true } });
        return;
      }
      const before = roleValues(role);
      const body: RolePatchBody = { version: role.version };
      if (values.name !== before.name) body.name = values.name;
      if ((values.description ?? null) !== (before.description ?? null)) body.description = values.description ?? null;
      if (!sameSet(values.permissions, before.permissions)) body.permissions = values.permissions;
      if ((values.mfaRequired ?? false) !== before.mfaRequired) body.mfaRequired = values.mfaRequired ?? false;
      if (Object.keys(body).length === 1) {
        form.reset(values);
        return;
      }
      const updated = await api<RoleItem>('PATCH', `roles/${encodeURIComponent(role.id)}`, body);
      queryClient.setQueryData(['roles', 'detail', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['roles', 'list'] });
      setRole(updated);
      form.reset(roleValues(updated));
      setNotice({ kind: 'success', text: t('form.saved') });
    } catch (e) {
      if (e instanceof ApiError) applyServerErrors(form, e);
      setNotice({ kind: 'error', text: problemText(t, e) });
    }
  });

  const remove = async (): Promise<void> => {
    if (role === null) return;
    await api('DELETE', `roles/${encodeURIComponent(role.id)}`);
    queryClient.removeQueries({ queryKey: ['roles', 'detail', role.id] });
    await queryClient.invalidateQueries({ queryKey: ['roles', 'list'] });
    form.reset(roleValues(role));
    await navigate({ href: '/admin/roles' });
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)}>
      {/* Without system.roles.manage (a deep link to "Buat peran") every field is disabled and nothing can be sent. */}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
        {notice !== null && <Notice kind={notice.kind}>{notice.text}</Notice>}
        <div className="grid gap-4 rounded-lg border bg-card p-4">
          <Field label={t('roles.field.name')} error={errors.name}>
            {(c) => <Input {...c} autoComplete="off" maxLength={100} {...form.register('name')} />}
          </Field>
          <Field label={t('roles.field.description')} error={errors.description}>
            {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('description', { setValueAs: descriptionValue })} />}
          </Field>
          <CheckField asSwitch label={t('roles.field.mfa_required')} hint={t('roles.field.mfa_required_hint')} {...form.register('mfaRequired')} />
        </div>
        <Section title={t('roles.permissions')} hint={t('roles.permissions_hint')}>
          <Controller
            control={form.control}
            name="permissions"
            render={({ field }) => <PermissionPicker catalog={catalog} value={field.value as Permission[]} onChange={field.onChange} />}
          />
          {errors.permissions !== undefined && <p className="text-sm text-destructive">{t('form.error.invalid')}</p>}
        </Section>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={isSubmitting}>
              {t(isSubmitting ? 'form.saving' : 'form.save')}
            </Button>
            {role === null ? (
              <Button asChild variant="outline">
                <Link to="/admin/roles">{t('form.cancel')}</Link>
              </Button>
            ) : (
              <Button type="button" variant="outline" className="ml-auto text-destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon aria-hidden="true" />
                {t('roles.delete')}
              </Button>
            )}
          </div>
        )}
      </fieldset>
      {role !== null && (
        <ConfirmDialog
          open={deleting}
          destructive
          title={t('roles.confirm.delete.title', { name: role.name })}
          description={t('roles.confirm.delete.body')}
          confirmLabel={t('roles.delete')}
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      )}
    </form>
  );
}

/** A system role for a super admin: only the 2FA switch (§7.2: read-only but for `mfaRequired`). */
function SystemRoleMfaForm({ initial }: { initial: RoleItem }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [role, setRole] = useState(initial);
  const [mfaRequired, setMfaRequired] = useState(role.mfaRequired);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useDirtyGuard(mfaRequired !== role.mfaRequired);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const body: RolePatchBody = { version: role.version, mfaRequired };
      const updated = await api<RoleItem>('PATCH', `roles/${encodeURIComponent(role.id)}`, body);
      queryClient.setQueryData(['roles', 'detail', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['roles', 'list'] });
      setRole(updated);
      setMfaRequired(updated.mfaRequired);
      setNotice({ kind: 'success', text: t('form.saved') });
    } catch (e) {
      setNotice({ kind: 'error', text: problemText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      {notice !== null && <Notice kind={notice.kind}>{notice.text}</Notice>}
      <CheckField
        asSwitch
        label={t('roles.field.mfa_required')}
        hint={t('roles.field.mfa_required_hint')}
        checked={mfaRequired}
        onChange={(e) => setMfaRequired(e.target.checked)}
      />
      <div>
        <Button type="button" disabled={busy || mfaRequired === role.mfaRequired} onClick={() => void save()}>
          {t(busy ? 'form.saving' : 'form.save')}
        </Button>
      </div>
    </div>
  );
}

export function RoleCreateScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'system.roles.manage');
  const catalog = useApiQuery<PermissionListResponse>({ queryKey: ['permissions'], path: 'permissions', staleTime: Infinity });
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <BackLink label={t('roles.back')} />
      <h1 className="text-2xl font-semibold">{t('roles.new.title')}</h1>
      {/* The server would refuse (and record the refusal): say so before anything is typed. */}
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      {catalog.data !== undefined ? (
        <>
          <RefetchProblem query={catalog} />
          <CustomRoleForm initial={null} catalog={catalog.data.items} readOnly={!canManage} />
        </>
      ) : catalog.isError ? (
        <Notice kind="error">{problemText(t, catalog.error)}</Notice>
      ) : (
        <Loading t={t} />
      )}
    </div>
  );
}

export function RoleEditScreen() {
  const t = useT();
  const me = useMe();
  const { roleId = '' } = useParams({ strict: false }) as { roleId?: string };
  // Opened right after "Buat peran".
  const created = useRouterState({ select: (s) => s.location.state.created === true });
  const role = useApiQuery<RoleItem>({ queryKey: ['roles', 'detail', roleId], path: `roles/${encodeURIComponent(roleId)}` });
  const catalog = useApiQuery<PermissionListResponse>({ queryKey: ['permissions'], path: 'permissions', staleTime: Infinity });

  // The data wins over an error: a failed background refetch keeps the form and what was typed (RefetchProblem).
  const failed = role.data === undefined && role.isError ? role.error : catalog.data === undefined && catalog.isError ? catalog.error : null;
  if (failed !== null) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <BackLink label={t('roles.back')} />
        <Notice kind="error">{problemText(t, failed)}</Notice>
      </div>
    );
  }
  if (role.data === undefined || catalog.data === undefined) return <Loading t={t} />;

  const r = role.data;
  const canManage = holds(me, 'system.roles.manage');
  const cannotGrant = !r.isSystem && r.permissions.some((p) => grantable(me, p) !== 'ok');
  const editable = canManage && !r.isSystem && !cannotGrant;
  const mfaText = t('roles.mfa_status', { value: t(r.mfaRequired ? 'form.yes' : 'form.no') });

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <BackLink label={t('roles.back')} />
      <div className="flex flex-col gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {roleLabel(t, r)}
          {r.isSystem && <Badge tone="info">{t('roles.system')}</Badge>}
        </h1>
        {!editable && r.description !== null && <p className="text-muted-foreground">{r.description}</p>}
        <p className="text-sm text-muted-foreground">{t('roles.holders_hint', { count: r.holders })}</p>
      </div>

      {created && <Notice kind="success">{t('roles.created')}</Notice>}
      <RefetchProblem query={role} />
      <RefetchProblem query={catalog} />
      {r.isSystem && <p className={INFO_CLASS}>{t('roles.system_readonly')}</p>}
      {canManage && cannotGrant && <p className={INFO_CLASS}>{t('roles.cannot_edit')}</p>}

      {editable ? (
        <CustomRoleForm key={r.id} initial={r} catalog={catalog.data.items} />
      ) : (
        <>
          {r.isSystem && isSuperAdmin(me) ? (
            <SystemRoleMfaForm key={r.id} initial={r} />
          ) : (
            <p className="text-sm">
              {mfaText}
              {r.isSystem && <span className="block text-xs text-muted-foreground">{t('roles.system_mfa_super_admin')}</span>}
            </p>
          )}
          <Section title={t('roles.permissions')}>
            <PermissionPicker catalog={catalog.data.items} value={r.permissions} readOnly />
          </Section>
        </>
      )}
    </div>
  );
}
