import { addDays } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { MemberExtendBody, type MemberView } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field, ProblemAlert, TEXTAREA_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { FORM_PARSE, fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import { isStale } from '@/screens/catalog/masters/master-table';
import { todayLocal, useCalendarDate, useMemberTypes } from '@/screens/circulation/common';

/**
 * The member actions more than one screen offers (the member page, the list, the desk): extending the membership and
 * suspending a member, each a dialog that reads the member first (its `version`; the desk's panel has none), and the
 * query keys every member write refreshes.
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
 * them). The join date never changes. The dialog shows the period it will write before it is sent.
 */
export function ExtendDialog({ memberId, open, onClose, onDone }: { memberId: string; open: boolean; onClose(): void; onDone?(): void }) {
  const t = useT();
  const day = useCalendarDate();
  const queryClient = useQueryClient();
  const focus = useReturnFocus();
  const member = useMember(memberId, open);
  const types = useMemberTypes(true);
  const [from, setFrom] = useState<ExtendFrom>('expiry');
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
  const start =
    from === 'today' ? today : from === 'date' ? date : view?.expiresOn !== null && view?.expiresOn !== undefined && view.expiresOn >= today ? view.expiresOn : today;
  const length = days.trim() === '' ? typeDays : /^\d{1,5}$/.test(days.trim()) ? Number(days.trim()) : null;
  const end = start !== '' && length !== null ? endOf(start, length) : null;

  const close = (): void => {
    if (busy) return;
    setProblem(null);
    setDaysError(null);
    setDateError(null);
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (view === undefined) return;
    setProblem(null);
    setDaysError(null);
    setDateError(null);
    const body = { version: view.version, from: from === 'date' ? date : from, ...(days.trim() === '' ? {} : { days: Number(days.trim()) }) };
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
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('members.extend.title')}</DialogTitle>
            <DialogDescription>{view === undefined ? t('shell.loading') : t('members.extend.intro', { name: view.name, date: day(view.expiresOn) })}</DialogDescription>
          </DialogHeader>
          {member.isError && <ProblemAlert error={member.error} />}
          {view !== undefined && (
            <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">{t('members.extend.from')}</legend>
                {(['expiry', 'today', 'date'] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2 text-sm">
                    <input type="radio" name={`${ids}-from`} value={value} checked={from === value} onChange={() => setFrom(value)} className="size-4 accent-primary" />
                    {t(`members.extend.from.${value}`)}
                  </label>
                ))}
                {from === 'date' && (
                  <Field label={t('members.extend.date')} error={dateError ?? undefined}>
                    {(c) => <Input {...c} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
                  </Field>
                )}
              </fieldset>
              <Field
                label={t('members.extend.days')}
                hint={typeDays === null ? t('members.extend.days_required') : t('members.extend.days_hint', { count: typeDays })}
                error={daysError ?? undefined}>
                {(c) => <Input {...c} inputMode="numeric" autoComplete="off" value={days} onChange={(e) => setDays(e.target.value)} className="max-w-40" />}
              </Field>
              {end !== null && start !== '' && (
                <p role="status" className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                  {t('members.extend.preview', { from: day(start), to: day(end) })}
                </p>
              )}
              <ProblemAlert error={problem} />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {t('form.cancel')}
                </Button>
                <Button type="submit" disabled={busy}>
                  {t(busy ? 'form.saving' : 'members.extend.submit')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Tangguhkan": a suspension needs a note (why); lending and renewing stop, returns still work. */
export function SuspendDialog({ member, open, onClose, onDone }: { member: MemberView; open: boolean; onClose(): void; onDone?(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const focus = useReturnFocus();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<TKey | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const close = (): void => {
    if (busy) return;
    setProblem(null);
    setNoteError(null);
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
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('members.suspend.title', { name: member.name })}</DialogTitle>
            <DialogDescription>{t('members.suspend.intro')}</DialogDescription>
          </DialogHeader>
          <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
            <Field label={t('members.suspend.note')} error={noteError ?? undefined}>
              {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={191} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <ProblemAlert error={problem} />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                {t(busy ? 'form.saving' : 'members.action.suspend')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
