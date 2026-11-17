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
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, InlinePanel, LoadingState, PageHead, Section, SectionHead, SkeletonTable, StatusText, TABLE, Tag } from '@/components/layout';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { ApiError, api, csrfToken, setCsrfToken } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { amountOf } from './desk-dialogs';
import { newTransactionKey, todayLocal, useCalendarDate } from './common';
// ---- Komunitas (member, visit and circulation reports) ----
import { ReportLinks } from '@/screens/reports/report-links';

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
 *   (per day, per method and per staff member, printable) and the payments ("Batalkan" opens its panel above the list).
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
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t('charges.member.balance')}: </span>
          <span className="text-base font-bold tabular-nums">{money(view.balance, view.currency)}</span>
          {view.blocked !== null && <Tag tone="bad">{t('charges.member.blocked', { reason: t(`vocab.member_block_reason.${view.blocked}`) })}</Tag>}
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
      <div className={TABLE.wrap}>
        <table className={TABLE.table}>
          <caption className="sr-only">{t('charges.panel.caption', { name: member.name })}</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(TABLE.th, 'w-8')}>
                <span className="sr-only">{t('charges.panel.select_all')}</span>
              </th>
              <th scope="col" className={TABLE.th}>
                {t('charges.col.charge')}
              </th>
              <th scope="col" className={TABLE.th}>
                {t('charges.col.charged_on')}
              </th>
              <th scope="col" className={cn(TABLE.th, 'text-right')}>
                {t('charges.col.balance')}
              </th>
              <th scope="col" className={TABLE.th}>
                <span className="sr-only">{t('table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.charges.length === 0 ? (
              <tr>
                <td colSpan={5} className={TABLE.empty}>
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
                    className={cn(TABLE.focusRow, selected.has(c.id) && 'bg-accent-soft')}>
                    <td className={TABLE.td}>
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
                    <td className={TABLE.td}>
                      <p className="font-semibold">{t(`vocab.charge_kind.${c.kind}`)}</p>
                      <p className="text-meta text-muted-foreground">{c.description}</p>
                      {!mine && <p className="text-meta text-muted-foreground">{t('charges.panel.other_branch')}</p>}
                    </td>
                    <td className={cn(TABLE.td, 'whitespace-nowrap')}>{day(c.chargedOn)}</td>
                    <td className={cn(TABLE.td, 'text-right whitespace-nowrap')}>
                      <p className="font-semibold">{money(c.balance, c.currency)}</p>
                      {c.balance !== c.amount && <p className="text-meta text-muted-foreground">{money(c.amount, c.currency)}</p>}
                    </td>
                    <td className={cn(TABLE.td, 'py-1.5')}>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button type="button" size="sm" variant="ghost" tabIndex={-1} disabled={!mine} onClick={() => setPaying([c])}>
                          {t('charges.action.pay')}
                        </Button>
                        {canWaive && (
                          <Button type="button" size="sm" variant="ghost" tabIndex={-1} disabled={!mine} onClick={() => setWaiving(c)}>
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
      <Section title={t('charges.payments.caption')}>
        <PaymentsTable payments={view.payments} branchId={branchId} canWaive={canWaive} onVoid={setVoiding} caption={t('charges.payments.caption')} />
      </Section>

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
  voidingId,
}: {
  payments: readonly (PaymentView & { member?: { memberNo: string; name: string } | null })[];
  branchId: string | null;
  canWaive: boolean;
  onVoid?(p: PaymentView): void;
  caption: string;
  showMember?: boolean;
  /** The payment whose void panel is open in the page (its row takes the selection colour). */
  voidingId?: string | null;
}) {
  const t = useT();
  const day = useCalendarDate();
  const money = useMoney();
  const me = useMe();
  return (
    <div className={TABLE.wrap}>
      <table className={TABLE.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={TABLE.th}>
              {t('charges.col.receipt')}
            </th>
            {showMember && (
              <th scope="col" className={TABLE.th}>
                {t('charges.col.member')}
              </th>
            )}
            <th scope="col" className={TABLE.th}>
              {t('charges.col.method')}
            </th>
            <th scope="col" className={TABLE.th}>
              {t('charges.col.staff')}
            </th>
            <th scope="col" className={cn(TABLE.th, 'text-right')}>
              {t('charges.col.amount')}
            </th>
            <th scope="col" className={TABLE.th}>
              <span className="sr-only">{t('table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 ? (
            <tr>
              <td colSpan={showMember ? 6 : 5} className={TABLE.empty}>
                {t('charges.payments.empty')}
              </td>
            </tr>
          ) : (
            payments.map((p) => {
              const atBranch = branchId === null ? p.branchId : branchId;
              const mine = p.branchId === atBranch;
              const printable = mine && holdsAt(me, 'circulation.desk.use', p.branchId);
              return (
                <tr key={p.id} className={cn(voidingId === p.id && 'bg-accent-soft')}>
                  <td className={TABLE.td}>
                    <p className="tracking-wide whitespace-nowrap">{p.receiptNo ?? '-'}</p>
                    <p className="text-meta text-muted-foreground">{day(p.paidOn)}</p>
                    {p.voided && (
                      <Tag tone="bad" className="mt-1">
                        {t('charges.payments.voided')}
                      </Tag>
                    )}
                  </td>
                  {showMember && (
                    <td className={TABLE.td}>
                      {p.member === null || p.member === undefined ? (
                        '-'
                      ) : (
                        <>
                          <p>{p.member.name}</p>
                          <p className="text-meta tracking-wide text-muted-foreground">{p.member.memberNo}</p>
                        </>
                      )}
                    </td>
                  )}
                  <td className={TABLE.td}>{t(`vocab.payment_method.${p.method}`)}</td>
                  <td className={TABLE.td}>{p.receivedBy ?? '-'}</td>
                  <td className={cn(TABLE.td, 'text-right whitespace-nowrap', p.voided && 'line-through')}>{money(p.amount, p.currency)}</td>
                  <td className={cn(TABLE.td, 'py-1.5')}>
                    <div className="flex flex-wrap justify-end gap-1">
                      {printable && p.receiptNo !== null && (
                        <Button asChild size="sm" variant="ghost">
                          <a href={receiptHref(p.branchId, p.id)} target="_blank" rel="noopener" aria-label={t('charges.action.receipt_named', { number: p.receiptNo })}>
                            {t('charges.action.receipt')}
                          </a>
                        </Button>
                      )}
                      {onVoid !== undefined && canWaive && mine && !p.voided && holdsAt(me, 'circulation.charges.waive', p.branchId) && (
                        <Button type="button" size="sm" variant="ghost" aria-expanded={voidingId === undefined ? undefined : voidingId === p.id} onClick={() => onVoid(p)}>
                          {t('charges.action.void')}
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

/**
 * "Batalkan" a payment: with a reason; what it paid is owed again. A dialog at the desk (whose scanner waits while one is
 * open); `inline` on the payments page, as a panel above the list.
 */
function VoidPaymentDialog({
  branchId,
  payment,
  onClose,
  onDone,
  inline = false,
}: {
  branchId: string;
  payment: PaymentView | null;
  onClose(): void;
  onDone(p: PaymentView): Promise<void>;
  inline?: boolean;
}) {
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

  if (inline) {
    if (payment === null) return null;
    return (
      <InlinePanel title={t('charges.void.title')} onSubmit={(e) => void submit(e)} onCancel={s.busy ? undefined : onClose}>
        <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('charges.void.intro', { number: payment.receiptNo ?? '-', amount: money(payment.amount, payment.currency) })}</p>
        <Field label={t('charges.void.reason')} error={error ?? undefined} className="max-w-md">
          {(c) => <Input {...c} maxLength={191} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <ProblemAlert error={s.problem} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="destructive" disabled={s.busy}>
            {t('charges.void.submit')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={s.busy}>
            {t('form.cancel')}
          </Button>
        </div>
      </InlinePanel>
    );
  }

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
    <div className="grid gap-6">
      <PageHead title={t('nav.circulation.charges')} intro={t('charges.page.intro')} />
      <ReportLinks reports={[{ id: 'circulation.payments_daily', permission: 'circulation.records.read' }, { id: 'circulation.charges', permission: 'circulation.records.read' }]} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as PageTab)} className="min-w-0">
        <TabsList className={cn(WRAPPING_TABS.list, 'print:hidden')} aria-label={t('nav.circulation.charges')}>
          <TabsTrigger value="open" className={WRAPPING_TABS.trigger}>
            {t('charges.page.tab.open')}
          </TabsTrigger>
          <TabsTrigger value="summary" className={WRAPPING_TABS.trigger}>
            {t('charges.page.tab.summary')}
          </TabsTrigger>
          <TabsTrigger value="payments" className={WRAPPING_TABS.trigger}>
            {t('charges.page.tab.payments')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="open" className="pt-3">
          <OpenBalances />
        </TabsContent>
        <TabsContent value="summary" className="pt-3">
          <CashSummary />
        </TabsContent>
        <TabsContent value="payments" className="pt-3">
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
  if (q.isError && q.data === undefined) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (q.data === undefined) return <SkeletonTable label={t('shell.loading')} columns={5} rows={4} />;
  const d = q.data;
  return (
    <div className="grid gap-3">
      <p className="text-sm font-semibold tabular-nums">{t('charges.open.total', { amount: money(d.total, d.currency) })}</p>
      {d.truncated && <p className="text-meta text-muted-foreground">{t('charges.open.truncated')}</p>}
      <DenseTable
        caption={t('charges.open.caption')}
        columns={[
          {
            id: 'member',
            header: t('charges.col.member'),
            cell: (i) => (
              <>
                <p className="font-semibold">{i.member.name}</p>
                <p className="text-meta text-muted-foreground">
                  <span className="tracking-wide">{i.member.memberNo}</span>
                  {i.member.className !== null && ` · ${i.member.className}`}
                </p>
              </>
            ),
          },
          { id: 'count', header: t('charges.col.open_charges'), headClassName: 'text-right', className: 'text-right', cell: (i) => i.openCharges },
          { id: 'oldest', header: t('charges.col.oldest'), className: 'whitespace-nowrap', cell: (i) => day(i.oldestChargedOn) },
          { id: 'balance', header: t('charges.col.balance'), headClassName: 'text-right', className: 'text-right font-semibold whitespace-nowrap', cell: (i) => money(i.balance, d.currency) },
          {
            id: 'actions',
            header: <span className="sr-only">{t('table.actions')}</span>,
            className: 'w-px py-1.5 text-right whitespace-nowrap',
            cell: (i) =>
              canServe ? (
                <Button asChild size="sm" variant="ghost">
                  <Link to={`/admin/layanan?member=${encodeURIComponent(i.member.id)}`}>{t('charges.action.serve')}</Link>
                </Button>
              ) : null,
          },
        ]}
        rows={d.items}
        rowKey={(i) => i.member.id}
        empty={t('charges.open.empty')}
      />
    </div>
  );
}

/** The filter of the summary and the payment list: a range of days and a method. */
function RangeFilter({ value, onApply }: { value: { from: string; to: string; method: string }; onApply(v: { from: string; to: string; method: string }): void }) {
  const t = useT();
  const ids = useId();
  const [draft, setDraft] = useState(value);
  return (
    <FilterRow
      label={t('charges.summary.show')}
      className="print:hidden"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(draft);
      }}
      actions={
        <Button type="submit" variant="outline">
          {t('charges.summary.show')}
        </Button>
      }>
      <FilterField id={`${ids}-from`} label={t('charges.summary.from')}>
        <Input id={`${ids}-from`} type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
      </FilterField>
      <FilterField id={`${ids}-to`} label={t('charges.summary.to')}>
        <Input id={`${ids}-to`} type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
      </FilterField>
      <FilterField id={`${ids}-method`} label={t('charges.summary.method')}>
        <select id={`${ids}-method`} className={SELECT_CLASS} value={draft.method} onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}>
          <option value="">{t('charges.summary.all_methods')}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`vocab.payment_method.${m}`)}
            </option>
          ))}
        </select>
      </FilterField>
    </FilterRow>
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
  const ids = useId();
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
    <th key={key} scope="col" className={cn(TABLE.th, right && 'text-right')}>
      {t(key)}
    </th>
  );
  const methodCells = (byMethod: Record<PaymentMethod, string>, currency: string, total = false) =>
    PAYMENT_METHODS.map((m) => (
      <td key={m} className={cn(total ? TABLE.group : TABLE.td, 'text-right whitespace-nowrap')}>
        {money(byMethod[m], currency)}
      </td>
    ));
  return (
    <div className="grid gap-4">
      <RangeFilter value={range} onApply={setRange} />
      {q.isError && d === undefined && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {d === undefined && !q.isError && <LoadingState />}
      {d !== undefined && (
        <section aria-labelledby={`${ids}-summary`} className="grid gap-3">
          <SectionHead
            id={`${ids}-summary`}
            title={t('charges.summary.title', { from: day(d.from), to: day(d.to) })}
            aside={
              <Button type="button" variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
                {t('charges.summary.print')}
              </Button>
            }
          />
          <div className={TABLE.wrap}>
            <table className={TABLE.table}>
              <caption className="sr-only">{t('charges.summary.caption')}</caption>
              <thead>
                <tr>
                  {head('charges.col.day')}
                  {head('charges.col.count', true)}
                  {PAYMENT_METHODS.map((m) => head(`vocab.payment_method.${m}`, true))}
                  {head('charges.col.total', true)}
                </tr>
              </thead>
              <tbody>
                {d.days.length === 0 ? (
                  <tr>
                    <td colSpan={PAYMENT_METHODS.length + 3} className={TABLE.empty}>
                      {t('charges.summary.empty')}
                    </td>
                  </tr>
                ) : (
                  <>
                    {d.days.map((x) => (
                      <tr key={x.day}>
                        <td className={cn(TABLE.td, 'whitespace-nowrap')}>{day(x.day)}</td>
                        <td className={cn(TABLE.td, 'text-right')}>{x.count}</td>
                        {methodCells(x.byMethod, d.currency)}
                        <td className={cn(TABLE.td, 'text-right font-semibold whitespace-nowrap')}>{money(x.total, d.currency)}</td>
                      </tr>
                    ))}
                    <tr className="font-bold">
                      <th scope="row" className={cn(TABLE.group, 'text-left')}>
                        {t('charges.summary.total_row')}
                      </th>
                      <td className={cn(TABLE.group, 'text-right')}>{d.all.count}</td>
                      {methodCells(d.all.byMethod, d.currency, true)}
                      <td className={cn(TABLE.group, 'text-right whitespace-nowrap')}>{money(d.all.total, d.currency)}</td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
          {d.byStaff.length > 0 && (
            <>
              <SectionHead id={`${ids}-staff`} title={t('charges.summary.staff_caption')} className="mt-3" />
              <div className={TABLE.wrap}>
                <table className={TABLE.table} aria-labelledby={`${ids}-staff`}>
                  <thead>
                    <tr>
                      {head('charges.col.staff')}
                      {head('charges.col.count', true)}
                      {PAYMENT_METHODS.map((m) => head(`vocab.payment_method.${m}`, true))}
                      {head('charges.col.total', true)}
                    </tr>
                  </thead>
                  <tbody>
                    {d.byStaff.map((x) => (
                      <tr key={x.staffId ?? ''}>
                        <td className={TABLE.td}>{x.name ?? t('charges.summary.unknown_staff')}</td>
                        <td className={cn(TABLE.td, 'text-right')}>{x.count}</td>
                        {methodCells(x.byMethod, d.currency)}
                        <td className={cn(TABLE.td, 'text-right font-semibold whitespace-nowrap')}>{money(x.total, d.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {d.voided.count > 0 && <p className="text-meta text-muted-foreground">{t('charges.summary.voided', { count: d.voided.count, amount: money(d.voided.total, d.currency) })}</p>}
        </section>
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
    <div className="grid gap-3">
      <RangeFilter value={range} onApply={setRange} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {voiding !== null && (
        <VoidPaymentDialog
          inline
          key={voiding.id}
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
      {q.isError && q.data === undefined && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {q.data === undefined && !q.isError && <SkeletonTable label={t('shell.loading')} columns={6} rows={4} />}
      {q.data !== undefined && (
        <PaymentsTable
          payments={items}
          branchId={null}
          canWaive={canWaiveAnywhere}
          onVoid={(p) => {
            setNotice(null);
            setVoiding(p);
          }}
          voidingId={voiding?.id ?? null}
          caption={t('charges.list.caption')}
          showMember
        />
      )}
      {q.hasNextPage && (
        <Button type="button" variant="outline" className="w-fit" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {t('charges.list.more')}
        </Button>
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
  if (q.isError && q.data === undefined) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (q.data === undefined) return <SkeletonTable label={t('shell.loading')} columns={5} rows={3} />;
  const d = q.data;
  return (
    <div className="grid gap-6">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-muted-foreground">{t('charges.member.balance')}: </span>
        <span className="text-base font-bold tabular-nums">{money(d.balance, d.currency)}</span>
      </p>
      <Section title={t('charges.member_page.caption')}>
        <DenseTable
          caption={t('charges.member_page.caption')}
          columns={[
            {
              id: 'charge',
              header: t('charges.col.charge'),
              cell: (c) => (
                <>
                  <p className="font-semibold">{t(`vocab.charge_kind.${c.kind}`)}</p>
                  <p className="text-meta text-muted-foreground">{c.description}</p>
                </>
              ),
            },
            { id: 'on', header: t('charges.col.charged_on'), className: 'whitespace-nowrap', cell: (c) => day(c.chargedOn) },
            {
              id: 'status',
              header: t('charges.col.status'),
              cell: (c) => (c.status === 'open' ? <StatusText tone="warn">{t(`vocab.charge_status.${c.status}`)}</StatusText> : <Tag>{t(`vocab.charge_status.${c.status}`)}</Tag>),
            },
            { id: 'amount', header: t('charges.col.amount'), headClassName: 'text-right', className: 'text-right whitespace-nowrap', cell: (c) => money(c.amount, c.currency) },
            { id: 'balance', header: t('charges.col.balance'), headClassName: 'text-right', className: 'text-right font-semibold whitespace-nowrap', cell: (c) => money(c.balance, c.currency) },
          ]}
          rows={d.charges}
          rowKey={(c) => c.id}
          empty={t('charges.member_page.empty')}
        />
      </Section>
      {d.adjustments.length > 0 && (
        <Section title={t('charges.member_page.adjustments')}>
          <ul className="grid rounded-lg border text-sm">
            {d.adjustments.map((a) => (
              <li key={a.id} className="border-b px-3 py-2.5 last:border-b-0">
                {t(`vocab.charge_adjustment_kind.${a.kind}`)} <span className="font-semibold tabular-nums">{money(a.amount, d.currency)}</span> — {a.reason}
                {a.by !== null && <span className="text-muted-foreground"> {t('charges.member_page.by', { name: a.by })}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t('charges.payments.caption')}>
        <PaymentsTable payments={d.payments} branchId={null} canWaive={false} caption={t('charges.payments.caption')} />
      </Section>
    </div>
  );
}
