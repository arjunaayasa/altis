import type { DeskLoanView, LoanDueResponse, LoanLostResponse } from '@altis/shared/api/circulation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Field, ProblemAlert } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey } from '@/lib/form-errors';
import { newTransactionKey, useCalendarDate } from './common';

/**
 * The desk's dialogs for a loan in the member's panel: "Hilang" (the borrower declares the item lost: the loan closes,
 * the overdue fine to today and the replacement charge are booked, the item becomes lost) and "Ubah jatuh tempo" (a new
 * due date by hand, with a note; needs the override permission). Each is one request with its own Idempotency-Key.
 */

/**
 * The Idempotency-Key of a dialog's request: a fresh `newTransactionKey(prefix)` for each new request (`what`: the loan
 * and the body), the same one while that request is sent again after a failure. A key is at most 64 characters, so the
 * loan and the body are never appended to it.
 */
function useRequestKey(prefix: string): (what: unknown) => string {
  const last = useRef<{ what: string; key: string } | null>(null);
  return (what) => {
    const text = JSON.stringify(what);
    if (last.current?.what !== text) last.current = { what: text, key: newTransactionKey(prefix) };
    return last.current.key;
  };
}

/** A typed amount as the API's decimal: `85.000` and `85000` are eighty-five thousand, `2,5` is two and a half. */
export function amountOf(s: string): string {
  const t = s.trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return t.replace(/\./g, '').replace(',', '.');
  return t.replace(',', '.');
}

/** "Hilang": the replacement charge (empty: the item's price, when the library charges it) and a note. */
export function LostDialog({ branchId, loan, onClose, onDone }: { branchId: string; loan: DeskLoanView | null; onClose(): void; onDone(r: LoanLostResponse, loan: DeskLoanView): void }) {
  const t = useT();
  const ids = useId();
  const focus = useReturnFocus();
  const [replacement, setReplacement] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<TKey | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const keyFor = useRequestKey('desk-lost');

  const close = (): void => {
    if (busy) return;
    setReplacement('');
    setNote('');
    setError(null);
    setProblem(null);
    onClose();
  };

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (loan === null) return;
    setError(null);
    setProblem(null);
    const amount = amountOf(replacement);
    if (amount !== '' && !/^\d{1,13}(\.\d{1,2})?$/.test(amount)) {
      setError('circulation.lost.error.amount');
      return;
    }
    setBusy(true);
    try {
      const body = { ...(amount === '' ? {} : { replacement: amount }), ...(note.trim() === '' ? {} : { note: note.trim() }) };
      const done = await api<LoanLostResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/loans/${encodeURIComponent(loan.id)}/lost`, body, {
        idempotencyKey: keyFor([loan.id, body]),
      });
      setBusy(false);
      setReplacement('');
      setNote('');
      onDone(done, loan);
    } catch (err) {
      setBusy(false);
      const field = err instanceof ApiError ? err.errors?.find((f) => f.path === 'replacement') : undefined;
      if (field !== undefined) setError(field.code === 'required' ? 'circulation.lost.error.required' : fieldErrorKey(field.code));
      else setProblem(err);
    }
  };

  return (
    <Dialog open={loan !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {loan !== null && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('circulation.lost.title')}</DialogTitle>
            <DialogDescription>{t('circulation.lost.intro', { title: loan.record.title, barcode: loan.item.barcode })}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Field label={t('circulation.lost.field.replacement')} hint={t('circulation.lost.field.replacement_hint')} error={error ?? undefined}>
              {(c) => <Input {...c} id={`${ids}-amount`} inputMode="decimal" autoComplete="off" value={replacement} onChange={(e) => setReplacement(e.target.value)} />}
            </Field>
            <Field label={t('circulation.lost.field.note')}>
              {(c) => <Input {...c} maxLength={191} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <ProblemAlert error={problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                {t('circulation.lost.confirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Ubah jatuh tempo": a new due date (not before the day it was lent) and the reason. */
export function DueDialog({ branchId, loan, onClose, onDone }: { branchId: string; loan: DeskLoanView | null; onClose(): void; onDone(r: LoanDueResponse, loan: DeskLoanView): void }) {
  const t = useT();
  const day = useCalendarDate();
  const focus = useReturnFocus();
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ dueOn?: TKey; note?: TKey }>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const keyFor = useRequestKey('desk-due');

  const close = (): void => {
    if (busy) return;
    setDueOn('');
    setNote('');
    setErrors({});
    setProblem(null);
    onClose();
  };

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (loan === null) return;
    setErrors({});
    setProblem(null);
    const date = dueOn === '' ? loan.dueOn : dueOn;
    if (note.trim() === '') {
      setErrors({ note: 'form.error.required' });
      return;
    }
    setBusy(true);
    try {
      const body = { dueOn: date, note: note.trim() };
      const done = await api<LoanDueResponse>('PATCH', `branches/${encodeURIComponent(branchId)}/circulation/loans/${encodeURIComponent(loan.id)}/due`, body, {
        idempotencyKey: keyFor([loan.id, body]),
      });
      setBusy(false);
      setDueOn('');
      setNote('');
      onDone(done, loan);
    } catch (err) {
      setBusy(false);
      const field = err instanceof ApiError ? err.errors?.find((f) => f.path === 'dueOn') : undefined;
      if (field !== undefined) setErrors({ dueOn: field.code === 'before_loan' ? 'circulation.due_change.error.before_loan' : fieldErrorKey(field.code) });
      else setProblem(err);
    }
  };

  return (
    <Dialog open={loan !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {loan !== null && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('circulation.due_change.title')}</DialogTitle>
            <DialogDescription>{t('circulation.due_change.intro', { title: loan.record.title, date: day(loan.dueOn), loaned: day(loan.loanedOn) })}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Field label={t('circulation.due_change.field.due_on')} error={errors.dueOn}>
              {(c) => <Input {...c} type="date" min={loan.loanedOn} value={dueOn === '' ? loan.dueOn : dueOn} onChange={(e) => setDueOn(e.target.value)} />}
            </Field>
            <Field label={t('circulation.due_change.field.note')} hint={t('circulation.due_change.field.note_hint')} error={errors.note}>
              {(c) => <Input {...c} maxLength={191} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <ProblemAlert error={problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t('circulation.due_change.confirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
