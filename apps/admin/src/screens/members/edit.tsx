import { GENDERS, type Gender } from '@altis/shared';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { LoanListResponse } from '@altis/shared/api/circulation';
import { MemberBody, MemberPatchBody, type MemberEventsResponse, type MemberView } from '@altis/shared/api/members';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDateTime } from '@/components/data-table';
import { Field, Notice, ProblemAlert, RefetchProblem, RootError, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { changedFields, isFieldProblem, isStale, optionalText, putFieldErrors, serverIssues, zodIssues } from '@/screens/catalog/masters/master-table';
import { DueBadge, MemberStatusBadge, limitText, todayLocal, useCalendarDate, useMemberTypes, useTypeName } from '@/screens/circulation/common';
import { Callout, InlinePanel, MemberPhoto, MoreMenu, MoreMenuItem, MoreMenuRule, StatStrip, StatusText, TABLE } from '@/screens/circulation/parts';
import { ExtendPanel, ReactivatePanel, SuspendPanel, refreshMembers, useMember } from './common';
import { MemberCustomPanel, MemberPhotoPanel, MemberPrivacyPanel, RestoreButton } from './member-extras';
// ---- Komunitas (member area) ----
import { MemberPasswordDialog } from './password';
// ---- Komunitas (charges and payments) ----
import { MemberChargesTab } from '@/screens/circulation/charges';

/**
 * A member: Anggota baru (`/admin/anggota/baru`) and the member's page (`/admin/anggota/$memberId`).
 *
 * - **The form** (membership, personal data, contact, internal note) is checked with the shared contract before it is
 *   sent; the server's field errors land on their fields (a taken member number: "Sudah dipakai"). An edit sends the
 *   member's `version` and only the fields the user changed; someone else's change in between is CONFLICT_STALE, said
 *   above the form, which keeps what was typed ("Muat ulang data" reads the member again). Whenever the member is read
 *   at a new version (after Perpanjang, Tangguhkan, Aktifkan or "Muat ulang data"), the fields the user has not touched
 *   take the new values, so a later save never sends an old value back. Gender has no default.
 * - **The page** opens with the member's head (the photo at 3:4 or the initials, the name, number, type and class, the
 *   status) and its actions, then a strip of figures (on loan, valid until, joined, valid from, source), then the tabs:
 *   Data anggota (the form, one section per part), Pinjaman aktif, Riwayat pinjaman (both need
 *   `circulation.records.read`), Denda and Riwayat keanggotaan (the member's events).
 * - **Actions** for `members.records.manage`: extend the membership, suspend (a note is required) or reactivate, each
 *   opened in place under the head; archive asks first (a dialog: it removes the member from the lists) and a refusal
 *   while loans are open (MEMBER_IN_USE) is said on the page, with the way to the desk. "Layani di Meja Layanan" opens
 *   the member at the desk.
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
  // What the form started from, which a save compares with: the member as first read, the values just saved, or the
  // member read again at a new version, whose values the untouched fields then take (the typed ones and their errors
  // stay).
  const base = useRef<{ version: number | undefined; values: MemberForm }>({ version: member?.version, values: formOf(member) });
  useEffect(() => {
    if (member === null || member.version === base.current.version) return;
    base.current = { version: member.version, values: formOf(member) };
    form.reset(base.current.values, { keepDirtyValues: true, keepDirty: true, keepErrors: true });
  }, [member, form]);
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
      // Only what the user changed from what the form started from (never an untouched field's old value).
      const fields = changedFields(patchFields(values), patchFields(base.current.values));
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
    base.current = { ...base.current, values };
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
      {(c) => <Input {...c} type={o.type ?? 'text'} autoComplete="off" maxLength={o.max} className={o.mono === true ? 'font-semibold tracking-wide tabular-nums' : undefined} {...form.register(name)} />}
    </Field>
  );

  return (
    <form
      noValidate
      className="flex flex-col"
      onSubmit={(e) => {
        form.clearErrors();
        void submit(e);
      }}>
      {problem !== null && (
        <div className="mb-4">
          <ProblemAlert error={problem}>
            {isStale(problem) && (
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void reload()}>
                {t('members.form.reload')}
              </Button>
            )}
          </ProblemAlert>
        </div>
      )}
      <FormSection title={t('members.form.membership')} intro={t('members.form.membership_intro')} disabled={!canManage}>
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
      </FormSection>
      <FormSection title={t('members.form.personal')} intro={t('members.form.personal_intro')} disabled={!canManage}>
        {text('name', 'members.field.name', { max: 191, className: 'sm:col-span-2' })}
        <fieldset className="grid content-start gap-2 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">{t('members.field.gender')}</legend>
          <div className="flex flex-wrap gap-5">
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
      </FormSection>
      <FormSection title={t('members.form.contact')} intro={t('members.form.contact_intro')} disabled={!canManage}>
        {text('email', 'members.field.email', { max: 191, type: 'email' })}
        {text('phone', 'members.field.phone', { max: 64, type: 'tel' })}
        <Field label={t('members.field.address')} error={errors.address} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('address')} />}
        </Field>
        {text('postalCode', 'members.field.postal_code', { max: 16 })}
        <Field label={t('members.field.mailing_address')} error={errors.mailingAddress} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} {...form.register('mailingAddress')} />}
        </Field>
      </FormSection>
      <FormSection title={t('members.form.notes')} intro={t('members.field.notes_hint')} disabled={!canManage}>
        <Field label={t('members.field.notes')} error={errors.notes} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={5000} {...form.register('notes')} />}
        </Field>
      </FormSection>
      <RootError message={errors.root?.server?.message} />
      {canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button type="submit" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/anggota">{t('form.cancel')}</Link>
          </Button>
          {isDirty && <StatusText tone="warn" className="text-sm">{t('members.form.unsaved')}</StatusText>}
        </div>
      )}
    </form>
  );
}

/**
 * One part of the member form: its title and a sentence on the left (above on a narrow screen), its fields on the
 * right, a thin rule above every part but the first.
 */
function FormSection({ title, intro, disabled, children }: { title: string; intro: string; disabled: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-x-8 gap-y-4 border-t py-5 first:border-t-0 first:pt-1 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="grid content-start gap-1">
        <h2 id={id} className="text-base font-bold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      <fieldset disabled={disabled} className="grid min-w-0 content-start gap-x-5 gap-y-4 sm:grid-cols-2">
        <legend className="sr-only">{title}</legend>
        {children}
      </fieldset>
    </section>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/admin/anggota" className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground">
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
    <div className="grid max-w-5xl gap-6">
      <BackLink />
      <div className="grid gap-1">
        <h1 className="text-xl leading-tight font-bold">{t('members.new.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('members.new.intro')}</p>
      </div>
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      <MemberFormView member={null} canManage={canManage} onSaved={(id) => navigate({ href: `/admin/anggota/${encodeURIComponent(id)}`, state: { created: true } })} />
    </div>
  );
}

type DetailTab = 'data' | 'loans' | 'history' | 'charges' | 'events';

/** The panel open under the member's head (one at a time). */
type HeadPanel = 'extend' | 'suspend' | 'reactivate' | 'photo';

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
  const [panel, setPanel] = useState<HeadPanel | null>(null);
  const [dialog, setDialog] = useState<'archive' | 'password' | null>(null);
  const [notice, setNotice] = useState<string | null>(location.state.created === true ? t('members.created') : null);
  const [archiveRefused, setArchiveRefused] = useState(false);
  const canManage = holds(me, 'members.records.manage');
  const canLoans = holds(me, 'circulation.records.read');
  const canServe =
    holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));

  if (member.data === undefined) {
    return (
      <div className="grid max-w-6xl gap-6">
        <BackLink />
        {member.isError ? (
          member.error instanceof ApiError && member.error.status === 404 ? (
            <Callout tone="bad" role="alert" title={t('members.not_found')}>
              <p>{t('members.not_found_hint')}</p>
            </Callout>
          ) : (
            <Notice kind="error">{problemText(t, member.error)}</Notice>
          )
        ) : (
          <div aria-busy="true" className="flex flex-wrap items-start gap-5">
            <p role="status" className="sr-only">
              {t('shell.loading')}
            </p>
            <span className="h-32 w-24 shrink-0 rounded border bg-muted" />
            <div className="grid flex-1 gap-2 pt-1">
              <span className="h-5 w-60 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="h-3 w-36 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        )}
      </div>
    );
  }

  const m = member.data;
  const live = !m.archived && m.status !== 'anonymized';
  const toggle = (p: HeadPanel): void => setPanel((open) => (open === p ? null : p));
  const daysLeft = m.expiresOn === null ? null : daysUntil(todayLocal(), m.expiresOn);

  const archive = async (): Promise<void> => {
    setArchiveRefused(false);
    try {
      await api<StoreResponse>('DELETE', `members/${encodeURIComponent(m.id)}`, { version: m.version });
    } catch (e) {
      // Open loans (MEMBER_IN_USE): said on the page, with the way to the desk where they are returned.
      if (e instanceof ApiError && e.code === 'MEMBER_IN_USE') {
        setArchiveRefused(true);
        return;
      }
      // A stale version reads the member again; the dialog says it.
      if (isStale(e)) await member.refetch();
      throw e;
    }
    await refreshMembers(queryClient);
    await navigate({ href: '/admin/anggota' });
  };

  return (
    <div className="grid max-w-6xl gap-6">
      <BackLink />
      <RefetchProblem query={member} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {archiveRefused && (
        <Callout
          tone="bad"
          role="alert"
          title={m.openLoans > 0 ? t('members.archive.refused_title', { name: m.name, count: m.openLoans }) : t('error.MEMBER_IN_USE')}
          action={
            canServe ? (
              <Button asChild size="sm" variant="outline" className="bg-background">
                <Link to={`/admin/layanan?member=${encodeURIComponent(m.id)}`}>{t('members.action.serve_desk')}</Link>
              </Button>
            ) : undefined
          }>
          <p>{t('members.archive.refused_body')}</p>
        </Callout>
      )}
      <div className="flex flex-wrap items-start gap-5">
        <MemberPhoto name={m.name} fileId={m.photoFileId} size="lg" alt={m.photoFileId === null ? undefined : t('members.tools.photo.alt', { name: m.name })} />
        <div className="grid min-w-60 flex-1 gap-1">
          <h1 className="text-2xl leading-tight font-bold break-words">{m.name}</h1>
          <p className="text-muted-foreground">
            <span className="font-semibold tracking-wide text-foreground tabular-nums">{m.memberNo}</span> · {typeName(m.type)}
            {m.className !== null && `, ${m.className}`}
            {m.institution !== null && `, ${m.institution}`}
          </p>
          <p className="flex flex-wrap items-center gap-1.5">
            <MemberStatusBadge status={m.status} />
            {m.storedStatus === 'suspended' && m.statusNote !== null && <span className="text-sm text-muted-foreground">{m.statusNote}</span>}
          </p>
          {canManage && live && (
            <p>
              <Button type="button" variant="link" className="h-auto p-0 text-sm font-semibold" aria-expanded={panel === 'photo'} onClick={() => toggle('photo')}>
                {t('members.photo.change')}
              </Button>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canServe && live && (
            <Button asChild>
              <Link to={`/admin/layanan?member=${encodeURIComponent(m.id)}`}>{t('members.action.serve_desk')}</Link>
            </Button>
          )}
          {canManage && live && (
            <Button variant="outline" aria-expanded={panel === 'extend'} onClick={() => toggle('extend')}>
              {t('members.action.extend')}
            </Button>
          )}
          {canManage && live && (
            <MoreMenu label={t('members.action.more')}>
              {(close) => (
                <>
                  {m.storedStatus === 'suspended' ? (
                    <MoreMenuItem
                      onClick={() => {
                        close();
                        setPanel('reactivate');
                      }}>
                      {t('members.action.reactivate_ellipsis')}
                    </MoreMenuItem>
                  ) : (
                    <MoreMenuItem
                      onClick={() => {
                        close();
                        setPanel('suspend');
                      }}>
                      {t('members.action.suspend_ellipsis')}
                    </MoreMenuItem>
                  )}
                  {/* Komunitas (member area) */}
                  <MoreMenuItem
                    onClick={() => {
                      close();
                      setDialog('password');
                    }}>
                    {t('members.password.open')}
                  </MoreMenuItem>
                  <MoreMenuRule />
                  <MoreMenuItem
                    danger
                    onClick={() => {
                      close();
                      setDialog('archive');
                    }}>
                    {t('members.action.archive')}
                  </MoreMenuItem>
                </>
              )}
            </MoreMenu>
          )}
          {/* ---- Komunitas K2 (members extended) ---- */}
          {canManage && m.archived && m.status !== 'anonymized' && <RestoreButton member={m} onDone={setNotice} />}
        </div>
      </div>
      {panel === 'extend' && canManage && live && (
        <ExtendPanel
          memberId={m.id}
          onClose={() => setPanel(null)}
          onDone={() => {
            setNotice(t('members.extended'));
            setArchiveRefused(false);
          }}
        />
      )}
      {panel === 'suspend' && canManage && live && <SuspendPanel member={m} onClose={() => setPanel(null)} onDone={() => setNotice(t('members.suspended'))} />}
      {panel === 'reactivate' && canManage && live && <ReactivatePanel member={m} onClose={() => setPanel(null)} onDone={() => setNotice(t('members.reactivated'))} />}
      {panel === 'photo' && canManage && live && (
        <InlinePanel title={t('members.tools.photo.title')} onCancel={() => setPanel(null)} focusOnOpen>
          {/* ---- Komunitas K2 (members extended): the photo ---- */}
          <MemberPhotoPanel member={m} canManage onDone={setNotice} />
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => setPanel(null)}>
              {t('members.close')}
            </Button>
          </div>
        </InlinePanel>
      )}
      <StatStrip
        label={t('members.summary')}
        items={[
          {
            key: 'loans',
            label: t('members.summary.on_loan'),
            value: m.type.loanLimit === null ? String(m.openLoans) : t('circulation.member.loans_of', { count: m.openLoans, limit: m.type.loanLimit }),
          },
          {
            key: 'until',
            label: t('members.col.valid_until'),
            value: m.expiresOn === null ? t('members.never_expires') : day(m.expiresOn),
            ...(daysLeft !== null && daysLeft >= 0 && daysLeft <= 30 ? { note: <StatusText tone="warn">{t('circulation.due.left', { count: daysLeft })}</StatusText> } : {}),
            ...(m.status === 'expired' ? { tone: 'bad' as const } : {}),
          },
          { key: 'joined', label: t('members.summary.joined'), value: day(m.joinedOn) },
          { key: 'from', label: t('members.summary.valid_from'), value: day(m.validFrom) },
          { key: 'source', label: t('members.summary.source'), value: <span className="text-sm font-normal">{sourceText(t, m.source)}</span> },
        ]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="min-w-0">
        <TabsList className={WRAPPING_TABS.list} aria-label={t('members.tabs.label')}>
          <TabsTrigger value="data" className={WRAPPING_TABS.trigger}>
            {t('members.tab.data')}
          </TabsTrigger>
          {canLoans && (
            <TabsTrigger value="loans" className={WRAPPING_TABS.trigger}>
              {t('members.tab.loans', { count: m.openLoans })}
            </TabsTrigger>
          )}
          {canLoans && (
            <TabsTrigger value="history" className={WRAPPING_TABS.trigger}>
              {t('members.tab.history')}
            </TabsTrigger>
          )}
          {canLoans && (
            <TabsTrigger value="charges" className={WRAPPING_TABS.trigger}>
              {t('charges.member_page.tab')}
            </TabsTrigger>
          )}
          <TabsTrigger value="events" className={WRAPPING_TABS.trigger}>
            {t('members.tab.events')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="data" className="grid gap-6 pt-2">
          <MemberFormView key={m.id} member={m} canManage={canManage && live} onSaved={async () => setNotice(t('members.saved'))} />
          {/* ---- Komunitas K2 (members extended): custom fields ---- */}
          <MemberCustomPanel key={`custom-${m.id}-${m.version}`} member={m} canManage={canManage && live} onDone={setNotice} />
          {/* ---- Komunitas K2 (members extended): the member's own data and anonymisation ---- */}
          <MemberPrivacyPanel member={m} onDone={setNotice} />
        </TabsContent>
        {canLoans && (
          <TabsContent value="loans" className="pt-2">
            <MemberLoans memberId={m.id} state="open" />
          </TabsContent>
        )}
        {canLoans && (
          <TabsContent value="history" className="pt-2">
            <MemberLoans memberId={m.id} state="closed" />
          </TabsContent>
        )}
        {canLoans && (
          <TabsContent value="charges" className="pt-2">
            <MemberChargesTab memberId={m.id} />
          </TabsContent>
        )}
        <TabsContent value="events" className="pt-2">
          <MemberEvents memberId={m.id} />
        </TabsContent>
      </Tabs>
      <MemberPasswordDialog member={m} open={dialog === 'password'} onClose={() => setDialog(null)} onDone={setNotice} />
      {dialog === 'archive' && (
        <ConfirmDialog
          open
          destructive
          title={t('members.archive.title', { name: m.name })}
          description={t('members.archive.body')}
          confirmLabel={t('members.action.archive_confirm')}
          onConfirm={archive}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** The days from `from` to `to` (calendar dates), or null when either is not one. */
function daysUntil(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86_400_000);
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
      <div className={TABLE.wrap}>
        <table className={TABLE.table}>
          <caption className="sr-only">{t(state === 'open' ? 'members.tab.loans_caption' : 'members.tab.history')}</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                {t('circulation.col.barcode')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t('circulation.col.title')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t('circulation.col.loaned')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t(state === 'open' ? 'circulation.col.due' : 'circulation.col.returned')}
              </th>
              {state === 'open' && (
                <th scope="col" className={TABLE.th}>
                  {t('circulation.col.renewals')}
                </th>
              )}
              <th scope="col" className={TABLE.th}>
                {t(state === 'open' ? 'circulation.col.state' : 'circulation.col.remark')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={state === 'open' ? 6 : 5} className={TABLE.empty}>
                  {t(state === 'open' ? 'members.loans.empty' : 'members.history.empty')}
                </td>
              </tr>
            ) : (
              rows.map((loan) => (
                <tr key={loan.id}>
                  <td className={`${TABLE.td} font-semibold tracking-wide whitespace-nowrap`}>{loan.item?.barcode ?? '—'}</td>
                  <td className={TABLE.td}>{loan.record?.title ?? '—'}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{day(loan.loanedOn)}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{day(state === 'open' ? loan.dueOn : loan.returnedOn)}</td>
                  {state === 'open' && <td className={`${TABLE.td} whitespace-nowrap`}>{t('circulation.loans.renewals', { count: loan.renewals, limit: loan.renewLimit })}</td>}
                  <td className={TABLE.td}>
                    {state === 'open' ? (
                      <DueBadge dueOn={loan.dueOn} daysLate={loan.daysLate} />
                    ) : loan.daysLate > 0 ? (
                      <StatusText tone="bad">{t('circulation.due.late', { count: loan.daysLate })}</StatusText>
                    ) : (
                      <span className="text-muted-foreground">{loan.outcome === null ? t('circulation.due.on_time') : t(`vocab.loan_outcome.${loan.outcome}`)}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {state === 'open' && rows.length > 0 && <p className="text-sm text-muted-foreground">{t('members.loans.at_desk')}</p>}
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
  if (rows.length === 0) return <p className="rounded-lg border px-3 py-7 text-sm text-muted-foreground">{t('members.events.empty')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label={t('members.tab.events')} className="flex flex-col divide-y rounded-lg border">
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
