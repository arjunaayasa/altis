import { GENDERS, type Gender } from '@altis/shared';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { LoanListResponse } from '@altis/shared/api/circulation';
import { MemberBody, MemberPatchBody, type MemberEventsResponse, type MemberView } from '@altis/shared/api/members';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDateTime } from '@/components/data-table';
import { Badge, Field, Notice, NoticeAlert, ProblemAlert, RefetchProblem, RootError, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { changedFields, isFieldProblem, isStale, optionalText, putFieldErrors, serverIssues, zodIssues } from '@/screens/catalog/masters/master-table';
import { DueBadge, MemberStatusBadge, limitText, useCalendarDate, useMemberTypes, useTypeName } from '@/screens/circulation/common';
import { ExtendDialog, SuspendDialog, refreshMembers, useMember } from './common';

/**
 * A member: Anggota baru (`/admin/anggota/baru`) and the member's page (`/admin/anggota/$memberId`).
 *
 * - **The form** (membership, personal data, contact, internal note) is checked with the shared contract before it is
 *   sent; the server's field errors land on their fields (a taken member number: "Sudah dipakai"). An edit sends the
 *   member's `version` and only what changed; someone else's change in between is CONFLICT_STALE, said above the form,
 *   which keeps what was typed ("Muat ulang data" reads the member again). Gender has no default.
 * - **The page** shows the status, the validity and the counts beside tabs: Data anggota (the form), Pinjaman aktif,
 *   Riwayat pinjaman (both need `circulation.records.read`) and Riwayat keanggotaan (the member's events).
 * - **Actions** for `members.records.manage`: extend the membership, suspend (a note is required) or reactivate, and
 *   archive (refused while loans are open: MEMBER_IN_USE). "Layani di Meja Layanan" opens the member at the desk.
 */

interface MemberForm {
  memberNo: string;
  memberTypeId: string;
  name: string;
  homeBranchId: string;
  gender: '' | 'female' | 'male';
  birthDate: string;
  identityNo: string;
  institution: string;
  className: string;
  email: string;
  phone: string;
  address: string;
  postalCode: string;
  mailingAddress: string;
  notes: string;
  locale: 'id' | 'en';
  joinedOn: string;
  expiresOn: string;
}

/** Female, male, or not stated: never filled in for the user. */
const GENDER_CHOICES: readonly (Gender | '')[] = [...GENDERS, ''];

const EMPTY: MemberForm = {
  memberNo: '',
  memberTypeId: '',
  name: '',
  homeBranchId: '',
  gender: '',
  birthDate: '',
  identityNo: '',
  institution: '',
  className: '',
  email: '',
  phone: '',
  address: '',
  postalCode: '',
  mailingAddress: '',
  notes: '',
  locale: 'id',
  joinedOn: '',
  expiresOn: '',
};

function formOf(m: MemberView | null): MemberForm {
  if (m === null) return EMPTY;
  return {
    memberNo: m.memberNo,
    memberTypeId: m.type.id,
    name: m.name,
    homeBranchId: m.homeBranchId ?? '',
    gender: m.gender ?? '',
    birthDate: m.birthDate ?? '',
    identityNo: m.identityNo ?? '',
    institution: m.institution ?? '',
    className: m.className ?? '',
    email: m.email ?? '',
    phone: m.phone ?? '',
    address: m.address ?? '',
    postalCode: m.postalCode ?? '',
    mailingAddress: m.mailingAddress ?? '',
    notes: m.notes ?? '',
    locale: m.locale,
    joinedOn: m.joinedOn,
    expiresOn: m.expiresOn ?? '',
  };
}

/** The fields both a new member and an edit send (an empty optional field is null). */
function commonBody(v: MemberForm): Record<string, unknown> {
  return {
    memberNo: v.memberNo,
    memberTypeId: v.memberTypeId,
    name: v.name.trim(),
    homeBranchId: v.homeBranchId === '' ? null : v.homeBranchId,
    gender: v.gender === '' ? null : v.gender,
    birthDate: v.birthDate === '' ? null : v.birthDate,
    identityNo: optionalText(v.identityNo),
    institution: optionalText(v.institution),
    className: optionalText(v.className),
    email: optionalText(v.email),
    phone: optionalText(v.phone),
    address: optionalText(v.address),
    postalCode: optionalText(v.postalCode),
    mailingAddress: optionalText(v.mailingAddress),
    notes: optionalText(v.notes),
    locale: v.locale,
  };
}

/** A new member's body: the dates only when typed (else the server counts them from today and the type). */
function createBody(v: MemberForm): Record<string, unknown> {
  return {
    ...commonBody(v),
    ...(v.joinedOn === '' ? {} : { joinedOn: v.joinedOn }),
    ...(v.expiresOn === '' ? {} : { expiresOn: v.expiresOn }),
  };
}

/** An edit's fields (the join date is not editable; the end date may be corrected or cleared). */
function patchFields(v: MemberForm): Record<string, unknown> {
  return { ...commonBody(v), expiresOn: v.expiresOn === '' ? null : v.expiresOn };
}

/** A field check's own message on this form. */
const message = (path: string, code: string): TKey | undefined => {
  if (path === 'birthDate' && code === 'future') return 'members.form.birth_future';
  if (path === 'memberNo' && code === 'invalid') return 'members.form.member_no_invalid';
  return undefined;
};

function MemberFormView({ member, canManage, onSaved }: { member: MemberView | null; canManage: boolean; onSaved(id: string): Promise<void> }) {
  const t = useT();
  const typeName = useTypeName();
  const queryClient = useQueryClient();
  const ids = useId();
  const types = useMemberTypes();
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<MemberForm>({ defaultValues: formOf(member) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const typeId = form.watch('memberTypeId');
  const type = types.data?.items.find((x) => x.id === typeId);

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    let id = member?.id ?? '';
    if (member === null) {
      const parsed = MemberBody.safeParse(createBody(values), FORM_PARSE);
      if (!parsed.success) {
        putFieldErrors(form, zodIssues(parsed.error.issues, message));
        return;
      }
      try {
        id = (await api<StoreResponse>('POST', 'members', parsed.data)).id;
      } catch (e) {
        if (isFieldProblem(e)) putFieldErrors(form, serverIssues(e, message));
        else setProblem(e);
        return;
      }
    } else {
      const fields = changedFields(patchFields(values), patchFields(formOf(member)));
      if (Object.keys(fields).length > 0) {
        const parsed = MemberPatchBody.safeParse({ version: member.version, ...fields }, FORM_PARSE);
        if (!parsed.success) {
          putFieldErrors(form, zodIssues(parsed.error.issues, message));
          return;
        }
        try {
          await api<StoreResponse>('PATCH', `members/${encodeURIComponent(member.id)}`, parsed.data);
        } catch (e) {
          if (isFieldProblem(e)) putFieldErrors(form, serverIssues(e, message));
          else setProblem(e);
          return;
        }
      }
    }
    form.reset(values);
    await refreshMembers(queryClient);
    await onSaved(id);
  });

  const reload = async (): Promise<void> => {
    setProblem(null);
    await refreshMembers(queryClient);
  };

  const text = (name: keyof MemberForm, label: TKey, o: { max: number; hint?: string; type?: string; className?: string; mono?: boolean } = { max: 191 }) => (
    <Field label={t(label)} error={errors[name]} {...(o.hint === undefined ? {} : { hint: o.hint })} {...(o.className === undefined ? {} : { className: o.className })}>
      {(c) => <Input {...c} type={o.type ?? 'text'} autoComplete="off" maxLength={o.max} className={o.mono === true ? 'font-mono' : undefined} {...form.register(name)} />}
    </Field>
  );

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        form.clearErrors();
        void submit(e);
      }}>
      {problem !== null && (
        <ProblemAlert error={problem}>
          {isStale(problem) && (
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void reload()}>
              {t('members.form.reload')}
            </Button>
          )}
        </ProblemAlert>
      )}
      <fieldset disabled={!canManage} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">{t('members.form.membership')}</legend>
        {text('memberNo', 'members.field.member_no', { max: 200, hint: t('members.field.member_no_hint'), mono: true })}
        <Field
          id={`${ids}-type`}
          label={t('members.field.type')}
          error={errors.memberTypeId}
          {...(type === undefined
            ? {}
            : {
                hint: t('members.field.type_summary', {
                  limit: limitText(t, type.loanLimit),
                  period: type.membershipDays === null ? t('members.never_expires') : t('members.types.days', { count: type.membershipDays }),
                }),
              })}>
          <select id={`${ids}-type`} className={SELECT_CLASS} aria-invalid={errors.memberTypeId === undefined ? undefined : true} {...form.register('memberTypeId')}>
            <option value="">{t('members.field.type_choose')}</option>
            {(types.data?.items ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} — {typeName(x)}
              </option>
            ))}
          </select>
        </Field>
        {member === null
          ? text('joinedOn', 'members.field.joined_on', { max: 10, type: 'date', hint: t('members.field.joined_on_hint') })
          : null}
        {text('expiresOn', 'members.field.expires_on', {
          max: 10,
          type: 'date',
          hint: t(member === null ? 'members.field.expires_on_hint_new' : 'members.field.expires_on_hint'),
        })}
        <Field id={`${ids}-branch`} label={t('members.field.home_branch')} error={errors.homeBranchId}>
          <select id={`${ids}-branch`} className={SELECT_CLASS} {...form.register('homeBranchId')}>
            <option value="">{t('members.field.no_branch')}</option>
            {(branches.data?.items ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-locale`} label={t('members.field.locale')} error={errors.locale}>
          <select id={`${ids}-locale`} className={SELECT_CLASS} {...form.register('locale')}>
            <option value="id">{t('members.field.locale_id')}</option>
            <option value="en">{t('members.field.locale_en')}</option>
          </select>
        </Field>
      </fieldset>
      <fieldset disabled={!canManage} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">{t('members.form.personal')}</legend>
        {text('name', 'members.field.name', { max: 191, className: 'sm:col-span-2' })}
        <fieldset className="grid content-start gap-2">
          <legend className="mb-1 text-sm font-medium">{t('members.field.gender')}</legend>
          <div className="flex flex-wrap gap-4">
            {GENDER_CHOICES.map((g) => (
              <label key={g} className="flex items-center gap-2 text-sm">
                <input type="radio" value={g} className="size-4 accent-primary" {...form.register('gender')} />
                {g === '' ? t('members.field.gender_unset') : t(`vocab.gender.${g}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {text('birthDate', 'members.field.birth_date', { max: 10, type: 'date' })}
        {text('identityNo', 'members.field.identity_no', { max: 64, hint: t('members.field.identity_no_hint') })}
        {text('className', 'members.field.class', { max: 64, hint: t('members.field.class_hint') })}
        {text('institution', 'members.field.institution', { max: 191, className: 'sm:col-span-2' })}
      </fieldset>
      <fieldset disabled={!canManage} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">{t('members.form.contact')}</legend>
        {text('email', 'members.field.email', { max: 191, type: 'email' })}
        {text('phone', 'members.field.phone', { max: 64, type: 'tel' })}
        <Field label={t('members.field.address')} error={errors.address} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('address')} />}
        </Field>
        {text('postalCode', 'members.field.postal_code', { max: 16 })}
        <Field label={t('members.field.mailing_address')} error={errors.mailingAddress} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('mailingAddress')} />}
        </Field>
      </fieldset>
      <fieldset disabled={!canManage} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">{t('members.form.notes')}</legend>
        <Field label={t('members.field.notes')} hint={t('members.field.notes_hint')} error={errors.notes}>
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={5000} {...form.register('notes')} />}
        </Field>
      </fieldset>
      <RootError message={errors.root?.server?.message} />
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/anggota">{t('form.cancel')}</Link>
          </Button>
          {isDirty && <p className="text-sm text-muted-foreground">{t('members.form.unsaved')}</p>}
        </div>
      )}
    </form>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/admin/anggota" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {t('members.back')}
    </Link>
  );
}

export function MemberCreateScreen() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const canManage = holds(me, 'members.records.manage');
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <BackLink />
      <h1 className="text-2xl font-semibold">{t('members.new.title')}</h1>
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      <MemberFormView member={null} canManage={canManage} onSaved={(id) => navigate({ href: `/admin/anggota/${encodeURIComponent(id)}`, state: { created: true } })} />
    </div>
  );
}

type DetailTab = 'data' | 'loans' | 'history' | 'events';

export function MemberDetailScreen() {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const typeName = useTypeName();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { memberId = '' } = useParams({ strict: false }) as { memberId?: string };
  const member = useMember(memberId);
  const [tab, setTab] = useState<DetailTab>('data');
  const [dialog, setDialog] = useState<'extend' | 'suspend' | 'reactivate' | 'archive' | null>(null);
  const [notice, setNotice] = useState<string | null>(location.state.created === true ? t('members.created') : null);
  const canManage = holds(me, 'members.records.manage');
  const canLoans = holds(me, 'circulation.records.read');
  const canServe =
    holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));

  if (member.data === undefined) {
    return (
      <div className="flex max-w-4xl flex-col gap-4">
        <BackLink />
        {member.isError ? (
          <Notice kind="error">{member.error instanceof ApiError && member.error.status === 404 ? t('members.not_found') : problemText(t, member.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )}
      </div>
    );
  }

  const m = member.data;
  const live = !m.archived && m.status !== 'anonymized';

  const reactivate = async (): Promise<void> => {
    await api<StoreResponse>('PATCH', `members/${encodeURIComponent(m.id)}`, { version: m.version, status: 'active' });
    await refreshMembers(queryClient);
    setNotice(t('members.reactivated'));
  };

  const archive = async (): Promise<void> => {
    try {
      await api<StoreResponse>('DELETE', `members/${encodeURIComponent(m.id)}`, { version: m.version });
    } catch (e) {
      // MEMBER_IN_USE (open loans) stays in the dialog with its own sentence; a stale version reads the member again.
      if (isStale(e)) await member.refetch();
      throw e;
    }
    await refreshMembers(queryClient);
    await navigate({ href: '/admin/anggota' });
  };

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{m.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{m.memberNo}</span> · {typeName(m.type)}
            {m.className !== null && ` · ${m.className}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canServe && live && (
            <Button asChild>
              <Link to={`/admin/layanan?member=${encodeURIComponent(m.id)}`}>{t('members.action.serve_desk')}</Link>
            </Button>
          )}
          {canManage && live && (
            <>
              <Button variant="outline" onClick={() => setDialog('extend')}>
                {t('members.action.extend')}
              </Button>
              {m.storedStatus === 'suspended' ? (
                <Button variant="outline" onClick={() => setDialog('reactivate')}>
                  {t('members.action.reactivate')}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setDialog('suspend')}>
                  {t('members.action.suspend_ellipsis')}
                </Button>
              )}
              <Button variant="outline" onClick={() => setDialog('archive')}>
                {t('members.action.archive')}
              </Button>
            </>
          )}
        </div>
      </div>
      <RefetchProblem query={member} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {m.storedStatus === 'suspended' && m.statusNote !== null && <NoticeAlert>{t('members.suspended_note', { note: m.statusNote })}</NoticeAlert>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="min-w-0 lg:order-1">
          <TabsList className="flex-wrap">
            <TabsTrigger value="data">{t('members.tab.data')}</TabsTrigger>
            {canLoans && <TabsTrigger value="loans">{t('members.tab.loans', { count: m.openLoans })}</TabsTrigger>}
            {canLoans && <TabsTrigger value="history">{t('members.tab.history')}</TabsTrigger>}
            <TabsTrigger value="events">{t('members.tab.events')}</TabsTrigger>
          </TabsList>
          <TabsContent value="data">
            <MemberFormView key={m.id} member={m} canManage={canManage && live} onSaved={async () => setNotice(t('members.saved'))} />
          </TabsContent>
          {canLoans && (
            <TabsContent value="loans">
              <MemberLoans memberId={m.id} state="open" />
            </TabsContent>
          )}
          {canLoans && (
            <TabsContent value="history">
              <MemberLoans memberId={m.id} state="closed" />
            </TabsContent>
          )}
          <TabsContent value="events">
            <MemberEvents memberId={m.id} />
          </TabsContent>
        </Tabs>
        <aside aria-label={t('members.summary')} className="flex h-fit flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
          <dl className="grid gap-2">
            <div>
              <dt className="text-muted-foreground">{t('members.col.status')}</dt>
              <dd>
                <MemberStatusBadge status={m.status} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('members.col.valid_until')}</dt>
              <dd className="font-medium">{m.expiresOn === null ? t('members.never_expires') : day(m.expiresOn)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('members.summary.on_loan')}</dt>
              <dd className="font-medium">
                {m.openLoans}
                {m.type.loanLimit !== null && ` / ${m.type.loanLimit}`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('members.summary.joined')}</dt>
              <dd>{day(m.joinedOn)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('members.summary.valid_from')}</dt>
              <dd>{day(m.validFrom)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('members.summary.source')}</dt>
              <dd>{sourceText(t, m.source)}</dd>
            </div>
          </dl>
        </aside>
      </div>
      <ExtendDialog memberId={m.id} open={dialog === 'extend'} onClose={() => setDialog(null)} onDone={() => setNotice(t('members.extended'))} />
      <SuspendDialog member={m} open={dialog === 'suspend'} onClose={() => setDialog(null)} onDone={() => setNotice(t('members.suspended'))} />
      {dialog === 'reactivate' && (
        <ConfirmDialog
          open
          title={t('members.reactivate.title', { name: m.name })}
          description={t('members.reactivate.body')}
          confirmLabel={t('members.action.reactivate')}
          onConfirm={reactivate}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'archive' && (
        <ConfirmDialog
          open
          destructive
          title={t('members.archive.title', { name: m.name })}
          description={t('members.archive.body')}
          confirmLabel={t('members.action.archive')}
          onConfirm={archive}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function sourceText(t: (key: TKey) => string, source: string | null): string {
  if (source === null || source === 'manual') return t('members.source.manual');
  if (source.startsWith('import:')) return t('members.source.import');
  if (source.startsWith('slims:')) return t('members.source.slims');
  return source;
}

/** A member's open loans or loan history, a page at a time. */
function MemberLoans({ memberId, state }: { memberId: string; state: 'open' | 'closed' }) {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const list = useInfiniteQuery({
    queryKey: ['circulation', 'loans', { memberId, state }],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ state, memberId, limit: '50' });
      if (pageParam !== null) q.set('cursor', pageParam);
      return api<LoanListResponse>('GET', `circulation/loans?${q.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: me !== undefined,
  });
  if (list.isError) return <Notice kind="error">{problemText(t, list.error)}</Notice>;
  if (list.data === undefined) return <p role="status" className="text-sm text-muted-foreground">{t('shell.loading')}</p>;
  const rows = list.data.pages.flatMap((p) => p.items);
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t(state === 'open' ? 'members.tab.loans_caption' : 'members.tab.history')}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.item')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.loaned')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.due')}
              </th>
              {state === 'closed' && (
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('circulation.col.returned')}
                </th>
              )}
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.state')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={state === 'closed' ? 5 : 4} className="px-3 py-6 text-center text-muted-foreground">
                  {t(state === 'open' ? 'circulation.loans.empty' : 'circulation.history.empty')}
                </td>
              </tr>
            ) : (
              rows.map((loan) => (
                <tr key={loan.id} className={loan.overdue ? 'border-t border-l-4 border-l-destructive align-top' : 'border-t align-top'}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{loan.record?.title ?? '—'}</p>
                    <p className="font-mono text-xs text-muted-foreground">{loan.item?.barcode ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{day(loan.loanedOn)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{day(loan.dueOn)}</td>
                  {state === 'closed' && <td className="px-3 py-2 whitespace-nowrap">{day(loan.returnedOn)}</td>}
                  <td className="px-3 py-2">
                    {state === 'open' ? (
                      <DueBadge dueOn={loan.dueOn} daysLate={loan.daysLate} />
                    ) : loan.daysLate > 0 ? (
                      <Badge tone="danger">{t('circulation.due.late', { count: loan.daysLate })}</Badge>
                    ) : (
                      <Badge tone="neutral">{loan.outcome === null ? t('circulation.due.on_time') : t(`vocab.loan_outcome.${loan.outcome}`)}</Badge>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {list.hasNextPage && (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t('circulation.load_more')}
        </Button>
      )}
    </div>
  );
}

/** The member's history: created, edited, extended, suspended, reactivated, archived, imported; newest first. */
function MemberEvents({ memberId }: { memberId: string }) {
  const t = useT();
  const me = useMe();
  const when = useDateTime();
  const day = useCalendarDate();
  const list = useInfiniteQuery({
    queryKey: ['members', 'events', memberId],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' });
      if (pageParam !== null) q.set('cursor', pageParam);
      return api<MemberEventsResponse>('GET', `members/${encodeURIComponent(memberId)}/events?${q.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: me !== undefined,
  });
  if (list.isError) return <Notice kind="error">{problemText(t, list.error)}</Notice>;
  if (list.data === undefined) return <p role="status" className="text-sm text-muted-foreground">{t('shell.loading')}</p>;
  const rows = list.data.pages.flatMap((p) => p.items);
  if (rows.length === 0) return <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">{t('members.events.empty')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label={t('members.tab.events')} className="flex flex-col divide-y rounded-md border">
        {rows.map((ev) => {
          const from = typeof ev.meta['from'] === 'string' ? ev.meta['from'] : null;
          const to = typeof ev.meta['to'] === 'string' ? ev.meta['to'] : null;
          return (
            <li key={ev.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{t(`vocab.member_event.${ev.type}`)}</span>
                {ev.type === 'extended' && to !== null && (
                  <span className="text-muted-foreground">{t('members.events.extended', { from: day(from), to: day(to) })}</span>
                )}
              </span>
              <span className="text-muted-foreground">
                {when(ev.at)}
                {ev.actorName !== null && ` · ${ev.actorName}`}
              </span>
            </li>
          );
        })}
      </ol>
      {list.hasNextPage && (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {t('circulation.load_more')}
        </Button>
      )}
    </div>
  );
}
