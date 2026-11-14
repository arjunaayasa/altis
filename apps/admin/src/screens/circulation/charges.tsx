import { MANUAL_CHARGE_KINDS, PAYMENT_METHODS, type ErrorCode, type ManualChargeKind, type PaymentMethod } from '@altis/shared';
import type {
  ChargeView,
  MemberChargesResponse,
  OpenBalancesResponse,
  PaymentListResponse,
  PaymentSummaryResponse,
  PaymentView,
  SlipBody,
} from '@altis/shared/api/charges';
import type { DeskMemberView } from '@altis/shared/api/circulation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PrinterIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Badge, Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { ApiError, api, csrfToken, setCsrfToken } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { amountOf } from './desk-dialogs';
import { newTransactionKey, todayLocal, useCalendarDate } from './common';

/**
 * Charges and payments in the admin.
 *
 * - The desk's Denda tab (MemberChargesPanel): the balance and the block that applies, the open charges (a row is
 *   focusable: B pays it, Shift+B pays all; a checkbox per row picks the charges a payment goes to), "Bayar" (amount,
 *   method, note; the payment goes to the oldest charge first and answers its receipt number, with a link to print the
 *   receipt), "Hapuskan" (with `circulation.charges.waive` at the branch: part or all of what is left, with a reason),
 *   "Biaya manual" (damage, a member card, anything else; optionally an item by barcode), and the last payments with
 *   their receipts and "Batalkan" (voiding, with the waive permission). A charge or payment of another branch is shown
 *   but not changed here.
 * - Denda & Pembayaran (`/admin/layanan/denda`, `circulation.records.read`): the members who owe, the daily cash summary
 *   (per day, per method and per staff member, printable) and the payments.
 * - The member page's Denda tab (MemberChargesTab): every charge, waive and payment of the member, read only.
 *
 * Money is typed as a decimal (`5000`, `5.000`, `2,5`) and sent as the API's decimal string; it is shown in the
 * library's currency, grouped in the reader's language.
 */

/** Shows a decimal amount of `currency` (`"12500.50"` → `Rp 12.500,50`). */
export function useMoney(): (amount: string, currency: string) => string {
  const locale = useLocale();
  return useCallback(
    (amount: string, currency: string) => {
      const n = Number(amount);
      const text = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
      return currency === 'IDR' ? `Rp ${text}` : `${currency} ${text}`;
    },
    [locale],
  );
}

/** The receipt of a payment as a PDF the browser opens (the session cookie authorises it). */
export function receiptHref(branchId: string, paymentId: string): string {
  return `/api/v1/branches/${encodeURIComponent(branchId)}/circulation/payments/${encodeURIComponent(paymentId)}/receipt`;
}

const PRICE = /^\d{1,13}(\.\d{1,2})?$/;

/** The PDF a POST read answers (a slip), as bytes; a refusal (any answer that is not a PDF) as its ApiError. */
async function postPdf(path: string, body: unknown): Promise<Blob> {
  const token = csrfToken();
  const res = await fetch(`/api/v1/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/pdf, application/problem+json', 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-CSRF-Token': token }) },
    body: JSON.stringify(body),
  });
  const build = res.headers.get('X-Altis-Build');
  if (build !== null) buildSync.observe(build);
  const rotated = res.headers.get('X-CSRF-Token');
  if (rotated !== null && rotated !== '') setCsrfToken(rotated);
  if (res.ok && /^application\/pdf\b/i.test(res.headers.get('Content-Type') ?? '')) return res.blob();
  const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; reason?: string };
  throw new ApiError(res.status, (problem.code ?? 'INTERNAL') as ErrorCode, {
    ...(problem.detail === undefined ? {} : { detail: problem.detail }),
    ...(problem.reason === undefined ? {} : { reason: problem.reason }),
    problemJson: problem.code !== undefined,
  });
}

/**
 * Prints the transaction slip of a visit (F9): a tab is opened at once (a browser lets a key open one), then shows the
 * PDF. Resolves when the PDF is shown; rejects with the refusal.
 */
export async function printSlip(branchId: string, body: SlipBody): Promise<void> {
  let tab: Window | null;
  try {
    tab = window.open('', '_blank');
  } catch {
    tab = null;
  }
  try {
    const blob = await postPdf(`branches/${encodeURIComponent(branchId)}/circulation/slips`, body);
    const url = URL.createObjectURL(blob);
    if (tab !== null) tab.location.href = url;
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** The sum of decimal amounts, as a decimal with two places. */
function sumOf(amounts: readonly string[]): string {
  const cents = amounts.reduce((s, a) => s + Math.round(Number(a) * 100), 0);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// ---- the desk's Denda tab ------------------------------------------------------------------------------------------

/** What the desk panel's Denda tab does. `payNow` > 0 opens the pay dialog for every open charge at this branch. */
export function MemberChargesPanel({
  member,
  branchId,
  payNow,
  onChanged,
  onPaid,
  onSaid,
  onDialog,
}: {
  member: DeskMemberView;
  branchId: string;
  payNow: number;
  onChanged(): Promise<void>;
  onPaid(payment: PaymentView): void;
  onSaid(tone: 'success' | 'error', text: string): void;
  onDialog(open: boolean): void;
}) {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const money = useMoney();
  const canWaive = holdsAt(me, 'circulation.charges.waive', branchId);
  const view = member.charges;
  const here = view.charges.filter((c) => c.branchId === branchId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [paying, setPaying] = useState<ChargeView[] | null>(null);
  const [waiving, setWaiving] = useState<ChargeView | null>(null);
  const [manual, setManual] = useState(false);
  const [voiding, setVoiding] = useState<PaymentView | null>(null);
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);

  useEffect(() => {
    onDialog(paying !== null || waiving !== null || manual || voiding !== null);
  }, [paying, waiving, manual, voiding]);

  useEffect(() => {
    if (payNow > 0 && here.length > 0) setPaying(here);
  }, [payNow]);

  // The selection keeps only the charges still open.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => here.some((c) => c.id === id))));
  }, [member]);

  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onRowKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, index: number, charge: ChargeView): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows.current[index + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows.current[index - 1]?.focus();
    } else if ((e.key === 'b' || e.key === 'B') && charge.branchId === branchId) {
      e.preventDefault();
      setPaying(e.shiftKey ? here : [charge]);
    } else if (e.key === ' ' && charge.branchId === branchId) {
      e.preventDefault();
      toggle(charge.id);
    }
  };

  const chosen = here.filter((c) => selected.has(c.id));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="text-muted-foreground">{t('charges.member.balance')}: </span>
          <span className="text-lg font-semibold">{money(view.balance, view.currency)}</span>
          {view.blocked !== null && (
            <Badge tone="danger" className="ml-2">
              {t('charges.member.blocked', { reason: t(`vocab.member_block_reason.${view.blocked}`) })}
            </Badge>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={here.length === 0} onClick={() => setPaying(chosen.length > 0 ? chosen : here)}>
            {chosen.length > 0 ? t('charges.action.pay_selected') : t('charges.action.pay_all')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setManual(true)}>
            {t('charges.action.manual')}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('charges.panel.caption', { name: member.name })}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="w-8 px-3 py-2">
                <span className="sr-only">{t('charges.panel.select_all')}</span>
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('charges.col.charge')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('charges.col.charged_on')}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t('charges.col.balance')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                <span className="sr-only">{t('table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.charges.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  {t('charges.panel.empty')}
                </td>
              </tr>
            ) : (
              view.charges.map((c, i) => {
                const mine = c.branchId === branchId;
                return (
                  <tr
                    key={c.id}
                    ref={(el) => {
                      rows.current[i] = el;
                    }}
                    tabIndex={0}
                    aria-label={t('charges.panel.row', { description: c.description, amount: money(c.balance, c.currency) })}
                    onKeyDown={(e) => onRowKey(e, i, c)}
                    className="border-t align-top outline-none focus-visible:bg-accent">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        tabIndex={-1}
                        className="size-4 accent-primary"
                        disabled={!mine}
                        checked={selected.has(c.id)}
                        aria-label={t('charges.panel.select', { description: c.description })}
                        onChange={() => toggle(c.id)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{t(`vocab.charge_kind.${c.kind}`)}</p>
                      <p className="text-xs text-muted-foreground">{c.description}</p>
                      {!mine && <p className="text-xs text-muted-foreground">{t('charges.panel.other_branch')}</p>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{day(c.chargedOn)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <p className="font-medium">{money(c.balance, c.currency)}</p>
                      {c.balance !== c.amount && <p className="text-xs text-muted-foreground">{money(c.amount, c.currency)}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button type="button" size="sm" variant="outline" tabIndex={-1} disabled={!mine} onClick={() => setPaying([c])}>
                          {t('charges.action.pay')}
                        </Button>
                        {canWaive && (
                          <Button type="button" size="sm" variant="outline" tabIndex={-1} disabled={!mine} onClick={() => setWaiving(c)}>
                            {t('charges.action.waive')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <PaymentsTable payments={view.payments} branchId={branchId} canWaive={canWaive} onVoid={setVoiding} caption={t('charges.payments.caption')} />

      <PayDialog
        branchId={branchId}
        memberId={member.id}
        charges={paying}
        onClose={() => setPaying(null)}
        onDone={async (p) => {
          setPaying(null);
          setSelected(new Set());
          onPaid(p);
          await onChanged();
        }}
      />
      <WaiveDialog
        branchId={branchId}
        charge={waiving}
        onClose={() => setWaiving(null)}
        onDone={async (c) => {
          setWaiving(null);
          onSaid('success', t('charges.waive.done', { description: c.description }));
          await onChanged();
        }}
      />
      <ManualChargeDialog
        branchId={branchId}
        memberId={member.id}
        open={manual}
        onClose={() => setManual(false)}
        onDone={async (c) => {
          setManual(false);
          onSaid('success', t('charges.manual.done', { description: c.description, amount: money(c.amount, c.currency) }));
          await onChanged();
        }}
      />
      <VoidPaymentDialog
        branchId={branchId}
        payment={voiding}
        onClose={() => setVoiding(null)}
        onDone={async (p) => {
          setVoiding(null);
          onSaid('success', t('charges.void.done', { number: p.receiptNo ?? '-' }));
          await onChanged();
        }}
      />
    </div>
  );
}

/** A list of payments: receipt, day, amount, method, staff; the receipt and voiding where this branch allows. */
function PaymentsTable({
  payments,
  branchId,
  canWaive,
  onVoid,
  caption,
  showMember = false,
}: {
  payments: readonly (PaymentView & { member?: { memberNo: string; name: string } | null })[];
  branchId: string | null;
  canWaive: boolean;
  onVoid?(p: PaymentView): void;
  caption: string;
  showMember?: boolean;
}) {
  const t = useT();
  const day = useCalendarDate();
  const money = useMoney();
  const me = useMe();
  if (payments.length === 0) return <p className="rounded-md border px-3 py-4 text-center text-sm text-muted-foreground">{t('charges.payments.empty')}</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="px-3 py-2 text-left text-sm font-medium">{caption}</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
              {t('charges.col.receipt')}
            </th>
            {showMember && (
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('charges.col.member')}
              </th>
            )}
            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
              {t('charges.col.method')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
              {t('charges.col.staff')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
              {t('charges.col.amount')}
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">{t('table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const atBranch = branchId === null ? p.branchId : branchId;
            const mine = p.branchId === atBranch;
            const printable = mine && holdsAt(me, 'circulation.desk.use', p.branchId);
            return (
              <tr key={p.id} className="border-t align-top">
                <td className="px-3 py-2">
                  <p className="font-mono text-xs">{p.receiptNo ?? '-'}</p>
                  <p className="text-xs text-muted-foreground">{day(p.paidOn)}</p>
                  {p.voided && (
                    <Badge tone="danger" className="mt-1">
                      {t('charges.payments.voided')}
                    </Badge>
                  )}
                </td>
                {showMember && (
                  <td className="px-3 py-2">
                    {p.member === null || p.member === undefined ? '-' : (
                      <>
                        <p>{p.member.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{p.member.memberNo}</p>
                      </>
                    )}
                  </td>
                )}
                <td className="px-3 py-2">{t(`vocab.payment_method.${p.method}`)}</td>
                <td className="px-3 py-2">{p.receivedBy ?? '-'}</td>
                <td className={cn('px-3 py-2 text-right whitespace-nowrap', p.voided && 'line-through')}>{money(p.amount, p.currency)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1">
                    {printable && p.receiptNo !== null && (
                      <Button asChild size="sm" variant="outline">
                        <a href={receiptHref(p.branchId, p.id)} target="_blank" rel="noopener" aria-label={t('charges.action.receipt_named', { number: p.receiptNo })}>
                          {t('charges.action.receipt')}
                        </a>
                      </Button>
                    )}
                    {onVoid !== undefined && canWaive && mine && !p.voided && holdsAt(me, 'circulation.charges.waive', p.branchId) && (
                      <Button type="button" size="sm" variant="outline" onClick={() => onVoid(p)}>
                        {t('charges.action.void')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- dialogs ---------------------------------------------------------------------------------------------------------

function useDialogState() {
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return { problem, setProblem, busy, setBusy };
}

/** "Bayar": the amount (default: all the chosen charges leave), the method and a note. */
export function PayDialog({
  branchId,
  memberId,
  charges,
  onClose,
  onDone,
}: {
  branchId: string;
  memberId: string;
  charges: readonly ChargeView[] | null;
  onClose(): void;
  onDone(p: PaymentView): Promise<void>;
}) {
  const t = useT();
  const ids = useId();
  const money = useMoney();
  const focus = useReturnFocus();
  const s = useDialogState();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState<TKey | null>(null);
  const [key, setKey] = useState(() => newTransactionKey('desk-pay'));
  const total = charges === null ? '0.00' : sumOf(charges.map((c) => c.balance));
  const currency = charges?.[0]?.currency ?? 'IDR';

  useEffect(() => {
    if (charges !== null) {
      setAmount(total.replace(/\.00$/, ''));
      setMethod('cash');
      setNote('');
      setError(null);
      s.setProblem(null);
      setKey(newTransactionKey('desk-pay'));
    }
  }, [charges]);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (charges === null) return;
    setError(null);
    s.setProblem(null);
    const value = amountOf(amount);
    if (!PRICE.test(value) || Number(value) <= 0) {
      setError('charges.error.amount');
      return;
    }
    if (Math.round(Number(value) * 100) > Math.round(Number(total) * 100)) {
      setError('charges.error.exceeds');
      return;
    }
    s.setBusy(true);
    try {
      const body = { amount: value, method, chargeIds: charges.map((c) => c.id), ...(note.trim() === '' ? {} : { note: note.trim() }) };
      const done = await api<PaymentView>('POST', `branches/${encodeURIComponent(branchId)}/circulation/members/${encodeURIComponent(memberId)}/payments`, body, { idempotencyKey: key });
      s.setBusy(false);
      await onDone(done);
    } catch (err) {
      s.setBusy(false);
      if (err instanceof ApiError && err.errors?.some((f) => f.code === 'exceeds_balance') === true) setError('charges.error.exceeds');
      else s.setProblem(err);
    }
  };

  return (
    <Dialog open={charges !== null} onOpenChange={(open) => (open || s.busy ? undefined : onClose())}>
      {charges !== null && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('charges.pay.title')}</DialogTitle>
            <DialogDescription>{t('charges.pay.intro', { amount: money(total, currency) })}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <ul className="grid gap-1 rounded-md border p-2 text-sm">
              {charges.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{c.description}</span>
                  <span className="whitespace-nowrap">{money(c.balance, c.currency)}</span>
                </li>
              ))}
            </ul>
            <Field label={t('charges.pay.amount')} hint={t('charges.pay.amount_hint')} error={error ?? undefined}>
              {(c) => <Input {...c} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            <Field id={`${ids}-method`} label={t('charges.pay.method')}>
              <select id={`${ids}-method`} className={SELECT_CLASS} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`vocab.payment_method.${m}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('charges.pay.note')}>{(c) => <Input {...c} maxLength={191} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <ProblemAlert error={s.problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={s.busy}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={s.busy}>
                {t('charges.pay.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Hapuskan": part or all of what is left, with a reason. */
function WaiveDialog({ branchId, charge, onClose, onDone }: { branchId: string; charge: ChargeView | null; onClose(): void; onDone(c: ChargeView): Promise<void> }) {
  const t = useT();
  const money = useMoney();
  const focus = useReturnFocus();
  const s = useDialogState();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ amount?: TKey; reason?: TKey }>({});
  const [key, setKey] = useState(() => newTransactionKey('desk-waive'));

  useEffect(() => {
    if (charge !== null) {
      setAmount('');
      setReason('');
      setErrors({});
      s.setProblem(null);
      setKey(newTransactionKey('desk-waive'));
    }
  }, [charge]);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (charge === null) return;
    s.setProblem(null);
    const value = amountOf(amount);
    const next: { amount?: TKey; reason?: TKey } = {};
    if (value !== '' && (!PRICE.test(value) || Number(value) <= 0)) next.amount = 'charges.error.amount';
    if (reason.trim() === '') next.reason = 'charges.error.required';
    setErrors(next);
    if (next.amount !== undefined || next.reason !== undefined) return;
    s.setBusy(true);
    try {
      const done = await api<ChargeView>(
        'POST',
        `branches/${encodeURIComponent(branchId)}/circulation/charges/${encodeURIComponent(charge.id)}/waive`,
        { ...(value === '' ? {} : { amount: value }), reason: reason.trim() },
        { idempotencyKey: key },
      );
      s.setBusy(false);
      await onDone(done);
    } catch (err) {
      s.setBusy(false);
      if (err instanceof ApiError && err.errors?.some((f) => f.code === 'exceeds_balance') === true) setErrors({ amount: 'charges.error.exceeds' });
      else s.setProblem(err);
    }
  };

  return (
    <Dialog open={charge !== null} onOpenChange={(open) => (open || s.busy ? undefined : onClose())}>
      {charge !== null && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('charges.waive.title')}</DialogTitle>
            <DialogDescription>{t('charges.waive.intro', { description: charge.description, amount: money(charge.balance, charge.currency) })}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Field label={t('charges.waive.amount')} hint={t('charges.waive.amount_hint')} error={errors.amount}>
              {(c) => <Input {...c} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            <Field label={t('charges.waive.reason')} error={errors.reason}>
              {(c) => <Input {...c} maxLength={191} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <ProblemAlert error={s.problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={s.busy}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={s.busy}>
                {t('charges.waive.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Biaya manual": the kind, the amount, the description and optionally an item's barcode. */
function ManualChargeDialog({
  branchId,
  memberId,
  open,
  onClose,
  onDone,
}: {
  branchId: string;
  memberId: string;
  open: boolean;
  onClose(): void;
  onDone(c: ChargeView): Promise<void>;
}) {
  const t = useT();
  const ids = useId();
  const focus = useReturnFocus();
  const s = useDialogState();
  const [kind, setKind] = useState<ManualChargeKind>('damage');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [barcode, setBarcode] = useState('');
  const [errors, setErrors] = useState<{ amount?: TKey; description?: TKey }>({});
  const [key, setKey] = useState(() => newTransactionKey('desk-charge'));

  useEffect(() => {
    if (open) {
      setKind('damage');
      setAmount('');
      setDescription('');
      setBarcode('');
      setErrors({});
      s.setProblem(null);
      setKey(newTransactionKey('desk-charge'));
    }
  }, [open]);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    s.setProblem(null);
    const value = amountOf(amount);
    const next: { amount?: TKey; description?: TKey } = {};
    if (!PRICE.test(value) || Number(value) <= 0) next.amount = 'charges.error.amount';
    if (description.trim() === '') next.description = 'charges.error.required';
    setErrors(next);
    if (next.amount !== undefined || next.description !== undefined) return;
    s.setBusy(true);
    try {
      const body = { kind, amount: value, description: description.trim(), ...(barcode.trim() === '' ? {} : { barcode: barcode.trim() }) };
      const done = await api<ChargeView>('POST', `branches/${encodeURIComponent(branchId)}/circulation/members/${encodeURIComponent(memberId)}/charges`, body, { idempotencyKey: key });
      s.setBusy(false);
      await onDone(done);
    } catch (err) {
      s.setBusy(false);
      s.setProblem(err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next || s.busy ? undefined : onClose())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('charges.manual.title')}</DialogTitle>
            <DialogDescription>{t('charges.manual.intro')}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Field id={`${ids}-kind`} label={t('charges.manual.kind')}>
              <select id={`${ids}-kind`} className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as ManualChargeKind)}>
                {MANUAL_CHARGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`vocab.charge_kind.${k}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('charges.manual.amount')} error={errors.amount}>
              {(c) => <Input {...c} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            <Field label={t('charges.manual.description')} error={errors.description}>
              {(c) => <Input {...c} maxLength={191} autoComplete="off" value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
            <Field label={t('charges.manual.barcode')}>{(c) => <Input {...c} maxLength={200} autoComplete="off" className="font-mono" value={barcode} onChange={(e) => setBarcode(e.target.value)} />}</Field>
            <ProblemAlert error={s.problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={s.busy}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={s.busy}>
                {t('charges.manual.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Batalkan" a payment: with a reason; what it paid is owed again. */
function VoidPaymentDialog({ branchId, payment, onClose, onDone }: { branchId: string; payment: PaymentView | null; onClose(): void; onDone(p: PaymentView): Promise<void> }) {
  const t = useT();
  const money = useMoney();
  const focus = useReturnFocus();
  const s = useDialogState();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<TKey | null>(null);
  const [key, setKey] = useState(() => newTransactionKey('desk-void-payment'));

  useEffect(() => {
    if (payment !== null) {
      setReason('');
      setError(null);
      s.setProblem(null);
      setKey(newTransactionKey('desk-void-payment'));
    }
  }, [payment]);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (payment === null) return;
    s.setProblem(null);
    if (reason.trim() === '') {
      setError('charges.error.required');
      return;
    }
    setError(null);
    s.setBusy(true);
    try {
      const done = await api<PaymentView>('POST', `branches/${encodeURIComponent(branchId)}/circulation/payments/${encodeURIComponent(payment.id)}/void`, { reason: reason.trim() }, { idempotencyKey: key });
      s.setBusy(false);
      await onDone(done);
    } catch (err) {
      s.setBusy(false);
      s.setProblem(err);
    }
  };

  return (
    <Dialog open={payment !== null} onOpenChange={(open) => (open || s.busy ? undefined : onClose())}>
      {payment !== null && (
        <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('charges.void.title')}</DialogTitle>
            <DialogDescription>{t('charges.void.intro', { number: payment.receiptNo ?? '-', amount: money(payment.amount, payment.currency) })}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Field label={t('charges.void.reason')} error={error ?? undefined}>
              {(c) => <Input {...c} maxLength={191} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <ProblemAlert error={s.problem} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={s.busy}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={s.busy}>
                {t('charges.void.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---- Denda & Pembayaran ----------------------------------------------------------------------------------------------

type PageTab = 'open' | 'summary' | 'payments';

/** Denda & Pembayaran (`/admin/layanan/denda`): the members who owe, the daily cash summary and the payments. */
export function ChargesScreen() {
  const t = useT();
  const [tab, setTab] = useState<PageTab>('open');
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('nav.circulation.charges')}</h1>
        <p className="text-sm text-muted-foreground">{t('charges.page.intro')}</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as PageTab)}>
        <TabsList className="print:hidden">
          <TabsTrigger value="open">{t('charges.page.tab.open')}</TabsTrigger>
          <TabsTrigger value="summary">{t('charges.page.tab.summary')}</TabsTrigger>
          <TabsTrigger value="payments">{t('charges.page.tab.payments')}</TabsTrigger>
        </TabsList>
        <TabsContent value="open">
          <OpenBalances />
        </TabsContent>
        <TabsContent value="summary">
          <CashSummary />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OpenBalances() {
  const t = useT();
  const day = useCalendarDate();
  const money = useMoney();
  const me = useMe();
  const canServe = holds(me, 'circulation.desk.use') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.desk.use'));
  const q = useQuery({ queryKey: ['circulation', 'charges', 'open'], queryFn: () => api<OpenBalancesResponse>('GET', 'circulation/charges/open') });
  if (q.isError) return <Notice kind="error">{problemText(t, q.error)}</Notice>;
  if (q.data === undefined) return <p className="text-sm text-muted-foreground">{t('shell.loading')}</p>;
  const d = q.data;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t('charges.open.total', { amount: money(d.total, d.currency) })}</p>
      {d.truncated && <p className="text-sm text-muted-foreground">{t('charges.open.truncated')}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('charges.open.caption')}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('charges.col.member')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('charges.col.open_charges')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('charges.col.oldest')}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t('charges.col.balance')}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t('table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {d.items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  {t('charges.open.empty')}
                </td>
              </tr>
            ) : (
              d.items.map((i) => (
                <tr key={i.member.id} className="border-t">
                  <td className="px-3 py-2">
                    <p className="font-medium">{i.member.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{i.member.memberNo}</span>
                      {i.member.className !== null && ` · ${i.member.className}`}
                    </p>
                  </td>
                  <td className="px-3 py-2">{i.openCharges}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{day(i.oldestChargedOn)}</td>
                  <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{money(i.balance, d.currency)}</td>
                  <td className="px-3 py-2 text-right">
                    {canServe && (
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/admin/layanan?member=${encodeURIComponent(i.member.id)}`}>{t('charges.action.serve')}</Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The filter of the summary and the payment list: a range of days and a method. */
function RangeFilter({ value, onApply }: { value: { from: string; to: string; method: string }; onApply(v: { from: string; to: string; method: string }): void }) {
  const t = useT();
  const ids = useId();
  const [draft, setDraft] = useState(value);
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-2 print:hidden"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(draft);
      }}>
      <div className="grid gap-1">
        <Label htmlFor={`${ids}-from`}>{t('charges.summary.from')}</Label>
        <Input id={`${ids}-from`} type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} className="w-44" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${ids}-to`}>{t('charges.summary.to')}</Label>
        <Input id={`${ids}-to`} type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} className="w-44" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${ids}-method`}>{t('charges.summary.method')}</Label>
        <select id={`${ids}-method`} className={cn(SELECT_CLASS, 'w-44')} value={draft.method} onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}>
          <option value="">{t('charges.summary.all_methods')}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`vocab.payment_method.${m}`)}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit">{t('charges.summary.show')}</Button>
    </form>
  );
}

function rangeQuery(v: { from: string; to: string; method: string }): URLSearchParams {
  const q = new URLSearchParams();
  if (v.from !== '') q.set('from', v.from);
  if (v.to !== '') q.set('to', v.to);
  if (v.method !== '') q.set('method', v.method);
  return q;
}

/** The daily cash summary: per day and per staff member, per method; printable. */
function CashSummary() {
  const t = useT();
  const day = useCalendarDate();
  const money = useMoney();
  const today = todayLocal();
  const [range, setRange] = useState({ from: today, to: today, method: '' });
  const q = useQuery({
    queryKey: ['circulation', 'payments', 'summary', range],
    queryFn: () => api<PaymentSummaryResponse>('GET', `circulation/payments/summary?${rangeQuery(range).toString()}`),
  });
  const d = q.data;
  const head = (key: TKey, right = false) => (
    <th scope="col" className={cn('px-3 py-2 font-medium text-muted-foreground', right && 'text-right')}>
      {t(key)}
    </th>
  );
  const methodCells = (byMethod: Record<PaymentMethod, string>, currency: string) =>
    PAYMENT_METHODS.map((m) => (
      <td key={m} className="px-3 py-2 text-right whitespace-nowrap">
        {money(byMethod[m], currency)}
      </td>
    ));
  return (
    <div className="flex flex-col gap-3">
      <RangeFilter value={range} onApply={setRange} />
      {q.isError && <Notice kind="error">{problemText(t, q.error)}</Notice>}
      {d !== undefined && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('charges.summary.title', { from: day(d.from), to: day(d.to) })}</h2>
            <Button type="button" variant="outline" className="print:hidden" onClick={() => window.print()}>
              <PrinterIcon aria-hidden="true" />
              {t('charges.summary.print')}
            </Button>
          </div>
          {d.days.length === 0 ? (
            <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">{t('charges.summary.empty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <caption className="px-3 py-2 text-left font-medium">{t('charges.summary.caption')}</caption>
                <thead className="bg-muted/50 text-left">
                  <tr>
                    {head('charges.col.day')}
                    {head('charges.col.count', true)}
                    {PAYMENT_METHODS.map((m) => head(`vocab.payment_method.${m}`, true))}
                    {head('charges.col.total', true)}
                  </tr>
                </thead>
                <tbody>
                  {d.days.map((x) => (
                    <tr key={x.day} className="border-t">
                      <td className="px-3 py-2 whitespace-nowrap">{day(x.day)}</td>
                      <td className="px-3 py-2 text-right">{x.count}</td>
                      {methodCells(x.byMethod, d.currency)}
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{money(x.total, d.currency)}</td>
                    </tr>
                  ))}
                  <tr className="border-t bg-muted/30 font-semibold">
                    <td className="px-3 py-2">{t('charges.summary.total_row')}</td>
                    <td className="px-3 py-2 text-right">{d.all.count}</td>
                    {methodCells(d.all.byMethod, d.currency)}
                    <td className="px-3 py-2 text-right whitespace-nowrap">{money(d.all.total, d.currency)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {d.byStaff.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <caption className="px-3 py-2 text-left font-medium">{t('charges.summary.staff_caption')}</caption>
                <thead className="bg-muted/50 text-left">
                  <tr>
                    {head('charges.col.staff')}
                    {head('charges.col.count', true)}
                    {PAYMENT_METHODS.map((m) => head(`vocab.payment_method.${m}`, true))}
                    {head('charges.col.total', true)}
                  </tr>
                </thead>
                <tbody>
                  {d.byStaff.map((x) => (
                    <tr key={x.staffId ?? ''} className="border-t">
                      <td className="px-3 py-2">{x.name ?? t('charges.summary.unknown_staff')}</td>
                      <td className="px-3 py-2 text-right">{x.count}</td>
                      {methodCells(x.byMethod, d.currency)}
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{money(x.total, d.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.voided.count > 0 && <p className="text-sm text-muted-foreground">{t('charges.summary.voided', { count: d.voided.count, amount: money(d.voided.total, d.currency) })}</p>}
        </>
      )}
    </div>
  );
}

/** The payments of a range, newest first, with their receipts and voiding. */
function PaymentList() {
  const t = useT();
  const me = useMe();
  const today = todayLocal();
  const [range, setRange] = useState({ from: today, to: today, method: '' });
  const [voiding, setVoiding] = useState<PaymentView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['circulation', 'payments', 'list', range],
    queryFn: ({ pageParam }) => {
      const p = rangeQuery(range);
      p.set('limit', '50');
      if (pageParam !== null) p.set('cursor', pageParam);
      return api<PaymentListResponse>('GET', `circulation/payments?${p.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const canWaiveAnywhere = holds(me, 'circulation.charges.waive') || Object.values(me?.authenticated === true ? me.branchPermissions : {}).some((p) => p.includes('circulation.charges.waive'));
  return (
    <div className="flex flex-col gap-3">
      <RangeFilter value={range} onApply={setRange} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {q.isError && <Notice kind="error">{problemText(t, q.error)}</Notice>}
      {q.data !== undefined && <PaymentsTable payments={items} branchId={null} canWaive={canWaiveAnywhere} onVoid={setVoiding} caption={t('charges.list.caption')} showMember />}
      {q.hasNextPage && (
        <Button type="button" variant="outline" className="w-fit" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t('charges.list.more')}
        </Button>
      )}
      {voiding !== null && (
        <VoidPaymentDialog
          branchId={voiding.branchId}
          payment={voiding}
          onClose={() => setVoiding(null)}
          onDone={async (p) => {
            setVoiding(null);
            setNotice(t('charges.void.done', { number: p.receiptNo ?? '-' }));
            await q.refetch();
          }}
        />
      )}
    </div>
  );
}

// ---- the member page's Denda tab -----------------------------------------------------------------------------------

/** Every charge, waive and payment of the member, read only (`circulation.records.read`). */
export function MemberChargesTab({ memberId }: { memberId: string }) {
  const t = useT();
  const day = useCalendarDate();
  const money = useMoney();
  const q = useQuery({
    queryKey: ['circulation', 'charges', 'member', memberId],
    queryFn: () => api<MemberChargesResponse>('GET', `circulation/members/${encodeURIComponent(memberId)}/charges`),
  });
  if (q.isError) return <Notice kind="error">{problemText(t, q.error)}</Notice>;
  if (q.data === undefined) return <p className="text-sm text-muted-foreground">{t('shell.loading')}</p>;
  const d = q.data;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <span className="text-muted-foreground">{t('charges.member.balance')}: </span>
        <span className="text-lg font-semibold">{money(d.balance, d.currency)}</span>
      </p>
      {d.charges.length === 0 ? (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">{t('charges.member_page.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="px-3 py-2 text-left font-medium">{t('charges.member_page.caption')}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('charges.col.charge')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('charges.col.charged_on')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('charges.col.status')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                  {t('charges.col.amount')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">
                  {t('charges.col.balance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {d.charges.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <p className="font-medium">{t(`vocab.charge_kind.${c.kind}`)}</p>
                    <p className="text-xs text-muted-foreground">{c.description}</p>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{day(c.chargedOn)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={c.status === 'open' ? 'warning' : 'neutral'}>{t(`vocab.charge_status.${c.status}`)}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{money(c.amount, c.currency)}</td>
                  <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{money(c.balance, c.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.adjustments.length > 0 && (
        <div className="rounded-md border p-3 text-sm">
          <p className="mb-2 font-medium">{t('charges.member_page.adjustments')}</p>
          <ul className="grid gap-1">
            {d.adjustments.map((a) => (
              <li key={a.id}>
                {t(`vocab.charge_adjustment_kind.${a.kind}`)} {money(a.amount, d.currency)} — {a.reason}
                {a.by !== null && <span className="text-muted-foreground"> {t('charges.member_page.by', { name: a.by })}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <PaymentsTable payments={d.payments} branchId={null} canWaive={false} caption={t('charges.payments.caption')} />
    </div>
  );
}
