import { addDays } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { MemberExtendBody, type MemberView } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field, ProblemAlert, TEXTAREA_CLASS } from '@/components/form-field';
import { InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { FORM_PARSE, fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { isStale } from '@/screens/catalog/masters/master-table';
import { todayLocal, useCalendarDate, useMemberTypes } from '@/screens/circulation/common';

/**
 * The member actions more than one screen offers (the member page and the desk): extending the membership, suspending
 * and reactivating a member, each an inline panel (never a dialog: nothing is destroyed) that reads the member first
 * (its `version`; the desk's panel has none), and the query keys every member write refreshes.
 */

/** The query key of one member (`GET members/:id`). */
export const memberKey = (id: string) => ['members', 'member', id] as const;

/** After any member or loan write: every member list, member page and desk panel is read again. */
export async function refreshMembers(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([queryClient.invalidateQueries({ queryKey: ['members'] }), queryClient.invalidateQueries({ queryKey: ['circulation'] })]);
}

/** One member, read for a page or a dialog. */
export function useMember(id: string, enabled = true) {
  return useApiQuery<MemberView>({ queryKey: memberKey(id), path: `members/${encodeURIComponent(id)}`, enabled });
}

type ExtendFrom = 'expiry' | 'today' | 'date';

/** `start` plus `days`, or null when `start` is not a calendar date. */
function endOf(start: string, days: number): string | null {
  try {
    return addDays(start, days);
  } catch {
    return null;
  }
}

/**
 * "Perpanjang masa keanggotaan": the new period starts on the current end date (while it has not passed), today, or
 * another date, and lasts the type's membership days unless other days are typed (a type that never expires needs
 * them). The join date never changes. The panel shows the period it will write before it is sent.
 */
export function ExtendPanel({ memberId, onClose, onDone }: { memberId: string; onClose(): void; onDone?(): void }) {
  const t = useT();
  const day = useCalendarDate();
  const queryClient = useQueryClient();
  const member = useMember(memberId);
  const types = useMemberTypes(true);
  const [from, setFrom] = useState<ExtendFrom | null>(null);
  const [date, setDate] = useState('');
  const [days, setDays] = useState('');
  const [daysError, setDaysError] = useState<TKey | null>(null);
  const [dateError, setDateError] = useState<TKey | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();

  const view = member.data;
  const typeDays = types.data?.items.find((x) => x.id === view?.type.id)?.membershipDays ?? null;
  const today = todayLocal();
  // The current end date is a start only while it has not passed.
  const expiryOpen = view?.expiresOn !== null && view?.expiresOn !== undefined && view.expiresOn >= today;
  const chosen: ExtendFrom = from ?? (expiryOpen ? 'expiry' : 'today');
  const start = chosen === 'today' ? today : chosen === 'date' ? date : expiryOpen ? view.expiresOn! : today;
  const length = days.trim() === '' ? typeDays : /^\d{1,5}$/.test(days.trim()) ? Number(days.trim()) : null;
  const end = start !== '' && length !== null ? endOf(start, length) : null;

  const close = (): void => {
    if (busy) return;
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (view === undefined) return;
    setProblem(null);
    setDaysError(null);
    setDateError(null);
    const body = { version: view.version, from: chosen === 'date' ? date : chosen, ...(days.trim() === '' ? {} : { days: Number(days.trim()) }) };
    const parsed = MemberExtendBody.safeParse(body, FORM_PARSE);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'days') setDaysError(issue.message as TKey);
        else if (issue.path[0] === 'from') setDateError(issue.message as TKey);
      }
      return;
    }
    if (length === null && days.trim() === '') {
      setDaysError('form.error.required');
      return;
    }
    setBusy(true);
    try {
      await api<StoreResponse>('POST', `members/${encodeURIComponent(view.id)}/extend`, parsed.data);
    } catch (e) {
      setBusy(false);
      const onDays = e instanceof ApiError ? e.errors?.find((f) => f.path === 'days') : undefined;
      if (onDays !== undefined) setDaysError(fieldErrorKey(onDays.code));
      else setProblem(e);
      if (isStale(e)) await member.refetch();
      return;
    }
    setBusy(false);
    await refreshMembers(queryClient);
    onDone?.();
    onClose();
  };

  return (
    <InlinePanel title={t('members.extend.title')} onSubmit={(e) => void submit(e)} onCancel={close} focusOnOpen={view !== undefined}>
      {member.isError && <ProblemAlert error={member.error} />}
      {view === undefined ? (
        !member.isError && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">{t('members.extend.from')}</legend>
            {(['expiry', 'today', 'date'] as const).map((value) => (
              <label key={value} className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${ids}-from`}
                  value={value}
                  checked={chosen === value}
                  disabled={value === 'expiry' && !expiryOpen}
                  onChange={() => setFrom(value)}
                  className="size-4 accent-primary"
                />
                {t(`members.extend.from.${value}`)}
                {value === 'expiry' && view.expiresOn !== null && ` (${day(view.expiresOn)})`}
                {value === 'today' && ` (${day(today)})`}
              </label>
            ))}
            {chosen === 'date' && (
              <Field label={t('members.extend.date')} error={dateError ?? undefined} className="ml-6 max-w-52">
                {(c) => <Input {...c} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
              </Field>
            )}
          </fieldset>
          <Field
            label={t('members.extend.days')}
            hint={typeDays === null ? t('members.extend.days_required') : t('members.extend.days_hint', { count: typeDays })}
            error={daysError ?? undefined}>
            {(c) => <Input {...c} inputMode="numeric" autoComplete="off" value={days} onChange={(e) => setDays(e.target.value)} className="max-w-36" />}
          </Field>
          {end !== null && start !== '' && (
            <p role="status" className="text-sm">
              {t('members.extend.preview', { from: day(start), to: day(end) })} {t('members.extend.join_unchanged')}
            </p>
          )}
          <ProblemAlert error={problem} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t(busy ? 'form.saving' : 'members.extend.submit')}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
              {t('form.cancel')}
            </Button>
          </div>
        </>
      )}
    </InlinePanel>
  );
}

/** "Tangguhkan": a suspension needs a note (why); lending and renewing stop, returns still work. */
export function SuspendPanel({ member, onClose, onDone }: { member: MemberView; onClose(): void; onDone?(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<TKey | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const close = (): void => {
    if (busy) return;
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setNoteError(null);
    if (note.trim() === '') {
      setNoteError('form.error.required');
      return;
    }
    setBusy(true);
    try {
      await api<StoreResponse>('PATCH', `members/${encodeURIComponent(member.id)}`, { version: member.version, status: 'suspended', statusNote: note.trim() });
    } catch (e) {
      setBusy(false);
      const onNote = e instanceof ApiError ? e.errors?.find((f) => f.path === 'statusNote') : undefined;
      if (onNote !== undefined) setNoteError(fieldErrorKey(onNote.code));
      else setProblem(e);
      if (isStale(e)) await refreshMembers(queryClient);
      return;
    }
    setBusy(false);
    setNote('');
    await refreshMembers(queryClient);
    onDone?.();
    onClose();
  };

  return (
    <InlinePanel title={t('members.suspend.panel_title')} onSubmit={(e) => void submit(e)} onCancel={close}>
      <p className="text-sm text-muted-foreground">{t('members.suspend.intro')}</p>
      <Field label={t('members.suspend.note')} error={noteError ?? undefined} className="max-w-xl">
        {(c) => <textarea {...c} rows={2} className={TEXTAREA_CLASS} maxLength={191} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {t(busy ? 'form.saving' : 'members.action.suspend')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}

/** "Aktifkan kembali": the member may borrow again; the suspension note is cleared. */
export function ReactivatePanel({ member, onClose, onDone }: { member: MemberView; onClose(): void; onDone?(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      await api<StoreResponse>('PATCH', `members/${encodeURIComponent(member.id)}`, { version: member.version, status: 'active' });
    } catch (e) {
      setBusy(false);
      setProblem(e);
      if (isStale(e)) await refreshMembers(queryClient);
      return;
    }
    setBusy(false);
    await refreshMembers(queryClient);
    onDone?.();
    onClose();
  };

  return (
    <InlinePanel title={t('members.reactivate.title', { name: member.name })} onSubmit={(e) => void submit(e)} onCancel={() => (busy ? undefined : onClose())}>
      {member.statusNote !== null && <p className="text-sm">{t('members.suspended_note', { note: member.statusNote })}</p>}
      <p className="text-sm text-muted-foreground">{t('members.reactivate.body')}</p>
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {t('members.action.reactivate')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}
