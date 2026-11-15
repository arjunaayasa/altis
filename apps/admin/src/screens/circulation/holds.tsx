import { HOLD_REFUSALS, type HoldRefusal } from '@altis/shared';
import type { RecordListResponse } from '@altis/shared/api/catalog/records';
import type { DeskMemberView } from '@altis/shared/api/circulation';
import type { HoldActionResponse, HoldCreateResponse, HoldShelfResponse, HoldView, ReturnHoldTrap, WaitingTitleView } from '@altis/shared/api/holds';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLocale, useT, type Translate } from '@/i18n';
import { holds as holdsPermission } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { newTransactionKey, todayLocal, useCalendarDate, useDeskBranch } from './common';
import './hold-slip.css';

/**
 * Holds at the desk and on the hold shelf (rak tunggu).
 *
 * - **Rak Tunggu & Reservasi** (`/admin/layanan/rak-tunggu`), at the desk branch: the copies kept for members (by
 *   pickup deadline; one past it is marked, the job expires it within 15 minutes), the copies to put back on the shelf
 *   ("Sudah di rak" clears them), and the titles with a queue ("Tandai siap…" keeps a scanned copy for the first in
 *   the queue).
 * - The desk's **Reservasi** tab (`MemberHoldsPanel`): the member's active holds with their place in the queue or
 *   pickup deadline, cancel (at the hold's own pickup branch), and "Tambah reservasi…" (`PlaceHoldDialog`: a title
 *   search over the catalogue, then "Pesan").
 * - The **slip** of a return that kept the copy for a hold: printed on its own (hold-slip.css) with the member number,
 *   the name, the title and the pickup deadline, to put in the book on the hold shelf.
 *
 * A member is named by id in every request; the search for titles sends only the words typed.
 */

const isHoldRefusal = (s: string | undefined): s is HoldRefusal => s !== undefined && (HOLD_REFUSALS as readonly string[]).includes(s);

/** The sentence for a refused hold action: the refusal's reason, the kept-copy refusal, or the problem's text. */
export function holdProblemText(t: Translate, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'CIRC_HOLD_REFUSED' && isHoldRefusal(e.reason)) return t(`vocab.hold_refusal.${e.reason}`);
    if (e.code === 'CIRC_ITEM_ON_HOLD') return t('holds.problem.item_on_hold');
  }
  return problemText(t, e);
}

const STATUS_TONE: Record<HoldView['status'], 'info' | 'neutral' | 'warning' | 'danger'> = {
  waiting: 'neutral',
  ready: 'info',
  fulfilled: 'neutral',
  cancelled: 'neutral',
  expired: 'danger',
};

/** The hold's status as a badge, with its place in the queue or its pickup deadline. */
function HoldStatus({ hold }: { hold: HoldView }) {
  const t = useT();
  const day = useCalendarDate();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone={STATUS_TONE[hold.status]}>{t(`vocab.hold_status.${hold.status}`)}</Badge>
      {hold.status === 'waiting' && hold.position !== null && <span className="text-xs text-muted-foreground">{t('holds.position', { position: hold.position })}</span>}
      {hold.status === 'ready' && hold.pickupUntil !== null && <span className="text-xs text-muted-foreground">{t('holds.ready_until', { date: day(hold.pickupUntil) })}</span>}
    </div>
  );
}

const TH = 'px-3 py-2 font-medium text-muted-foreground';

// ---- Rak Tunggu & Reservasi -----------------------------------------------------------------------------------------

export function HoldShelfScreen() {
  const t = useT();
  const day = useCalendarDate();
  const ids = useId();
  const queryClient = useQueryClient();
  const desk = useDeskBranch();
  const branchId = desk.branchId;
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [cancelling, setCancelling] = useState<HoldView | null>(null);
  const [marking, setMarking] = useState<WaitingTitleView | null>(null);

  const shelfKey = ['circulation', 'hold-shelf', branchId ?? ''] as const;
  const shelf = useApiQuery<HoldShelfResponse>({
    queryKey: shelfKey,
    path: `branches/${encodeURIComponent(branchId ?? '')}/circulation/hold-shelf`,
    enabled: branchId !== null,
  });
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['circulation'] });

  const clear = async (hold: HoldView): Promise<void> => {
    if (branchId === null) return;
    try {
      await api<HoldActionResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/hold-shelf/${encodeURIComponent(hold.id)}/clear`, undefined, {
        idempotencyKey: newTransactionKey('hold-clear'),
      });
      setNotice({ kind: 'success', text: t('holds.done.cleared') });
    } catch (e) {
      setNotice({ kind: 'error', text: holdProblemText(t, e) });
    }
    await refresh();
  };

  const data = shelf.data;
  const today = data?.today ?? todayLocal();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('nav.circulation.hold_shelf')}</h1>
          <p className="text-sm text-muted-foreground">{t('holds.shelf.intro')}</p>
        </div>
        {desk.branches !== undefined && desk.branches.length > 1 && (
          <div className="grid gap-1">
            <Label htmlFor={`${ids}-branch`}>{t('circulation.desk.branch')}</Label>
            <select id={`${ids}-branch`} className={cn(SELECT_CLASS, 'w-56')} value={branchId ?? ''} onChange={(e) => desk.choose(e.target.value)}>
              {desk.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {desk.branches !== undefined && desk.branches.length === 0 && <Notice kind="error">{t('circulation.desk.no_branch')}</Notice>}
      {notice !== null && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {shelf.isError && <Notice kind="error">{problemText(t, shelf.error)}</Notice>}
      {branchId !== null && data === undefined && !shelf.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      )}
      {data !== undefined && (
        <>
          <section aria-labelledby={`${ids}-ready`} className="flex flex-col gap-2">
            <h2 id={`${ids}-ready`} className="text-lg font-semibold">
              {t('holds.shelf.ready', { count: data.ready.length })}
            </h2>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th scope="col" className={TH}>
                      {t('holds.col.title')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('holds.col.member')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('holds.col.pickup_until')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('table.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.ready.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                        {t('holds.shelf.ready_empty')}
                      </td>
                    </tr>
                  ) : (
                    data.ready.map((h) => {
                      const late = h.pickupUntil !== null && h.pickupUntil < today;
                      return (
                        <tr key={h.id} className={cn('border-t align-top', late && 'bg-destructive/5')}>
                          <td className="px-3 py-2">
                            <p className="font-medium">{h.record.title}</p>
                            <p className="font-mono text-xs text-muted-foreground">{h.item?.barcode ?? '—'}</p>
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-mono">{h.member?.memberNo ?? '—'}</p>
                            <p className="text-xs text-muted-foreground">{h.member?.name ?? ''}</p>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <p>{day(h.pickupUntil)}</p>
                            {late && <Badge tone="danger">{t('holds.overdue_pickup')}</Badge>}
                          </td>
                          <td className="px-3 py-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => setCancelling(h)}>
                              {t('holds.action.cancel')}
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby={`${ids}-clear`} className="flex flex-col gap-2">
            <h2 id={`${ids}-clear`} className="text-lg font-semibold">
              {t('holds.shelf.to_clear', { count: data.toClear.length })}
            </h2>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th scope="col" className={TH}>
                      {t('holds.col.title')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('holds.col.reason')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('table.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.toClear.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                        {t('holds.shelf.to_clear_empty')}
                      </td>
                    </tr>
                  ) : (
                    data.toClear.map((h) => (
                      <tr key={h.id} className="border-t align-top">
                        <td className="px-3 py-2">
                          <p className="font-medium">{h.record.title}</p>
                          <p className="font-mono text-xs text-muted-foreground">{h.item?.barcode ?? '—'}</p>
                        </td>
                        <td className="px-3 py-2">{h.closeReason === null ? '—' : t(`vocab.hold_close_reason.${h.closeReason}`)}</td>
                        <td className="px-3 py-2">
                          <Button type="button" size="sm" variant="outline" onClick={() => void clear(h)}>
                            {t('holds.action.clear')}
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby={`${ids}-waiting`} className="flex flex-col gap-2">
            <h2 id={`${ids}-waiting`} className="text-lg font-semibold">
              {t('holds.shelf.waiting', { count: data.waitingTitles.length })}
            </h2>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th scope="col" className={TH}>
                      {t('holds.col.title')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('holds.col.waiting')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('holds.col.since')}
                    </th>
                    <th scope="col" className={TH}>
                      {t('table.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.waitingTitles.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                        {t('holds.shelf.waiting_empty')}
                      </td>
                    </tr>
                  ) : (
                    data.waitingTitles.map((w) => (
                      <tr key={w.record.id} className="border-t align-top">
                        <td className="px-3 py-2 font-medium">{w.record.title}</td>
                        <td className="px-3 py-2">{w.waiting}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{day(w.firstPlacedOn)}</td>
                        <td className="px-3 py-2">
                          <Button type="button" size="sm" variant="outline" onClick={() => setMarking(w)}>
                            {t('holds.action.mark_ready')}
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {branchId !== null && (
        <CancelHoldDialog
          hold={cancelling}
          branchId={branchId}
          onClose={() => setCancelling(null)}
          onDone={async () => {
            setNotice({ kind: 'success', text: t('holds.done.cancelled') });
            await refresh();
          }}
        />
      )}
      {branchId !== null && (
        <MarkReadyDialog
          title={marking}
          branchId={branchId}
          onClose={() => setMarking(null)}
          onDone={async (r) => {
            setNotice({ kind: 'success', text: t('holds.done.ready', { date: day(r.pickupUntil) }) });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** "Batalkan reservasi ini?" for `hold` at the desk of `branchId`. */
function CancelHoldDialog({ hold, branchId, onClose, onDone }: { hold: HoldView | null; branchId: string; onClose(): void; onDone(): Promise<void> }) {
  const t = useT();
  return (
    <ConfirmDialog
      open={hold !== null}
      title={t('holds.confirm.cancel_title')}
      description={hold === null ? '' : t('holds.confirm.cancel_body', { title: hold.record.title, member: hold.member?.memberNo ?? '—' })}
      confirmLabel={t('holds.confirm.cancel')}
      destructive
      onConfirm={async () => {
        if (hold === null) return;
        try {
          await api<HoldActionResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/holds/${encodeURIComponent(hold.id)}/cancel`, undefined, {
            idempotencyKey: newTransactionKey('hold-cancel'),
          });
        } catch (e) {
          throw new Error(holdProblemText(t, e), { cause: e });
        }
        await onDone();
      }}
      onClose={onClose}
    />
  );
}

/** "Tandai siap": scan a copy of `title` from the shelf; it is kept for the first in its queue. */
function MarkReadyDialog({ title, branchId, onClose, onDone }: { title: WaitingTitleView | null; branchId: string; onClose(): void; onDone(r: HoldActionResponse): Promise<void> }) {
  const t = useT();
  const ids = useId();
  const [barcode, setBarcode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBarcode('');
    setError(null);
  }, [title]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (title === null || barcode.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<HoldActionResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/holds/${encodeURIComponent(title.firstHoldId)}/ready`, { barcode: barcode.trim() }, {
        idempotencyKey: newTransactionKey('hold-ready'),
      });
      onClose();
      await onDone(r);
    } catch (e) {
      setError(holdProblemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={title !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      {title !== null && (
        <DialogContent closeLabel={t('form.cancel')}>
          <DialogHeader>
            <DialogTitle>{t('holds.ready_dialog.title', { title: title.record.title })}</DialogTitle>
            <DialogDescription>{t('holds.ready_dialog.description')}</DialogDescription>
          </DialogHeader>
          <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <div className="grid gap-1">
              <Label htmlFor={`${ids}-barcode`}>{t('holds.ready_dialog.barcode')}</Label>
              <Input id={`${ids}-barcode`} autoFocus autoComplete="off" className="font-mono" value={barcode} maxLength={200} onChange={(e) => setBarcode(e.target.value)} />
            </div>
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" disabled={busy || barcode.trim() === ''}>
                {t('holds.ready_dialog.submit')}
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---- the desk: the member's holds --------------------------------------------------------------------------------------

/**
 * The desk's Reservasi tab: the member's active holds (ready first), cancel at the hold's pickup branch, and "Tambah
 * reservasi…". `onChanged` refreshes the panel; `onSaid` reports the outcome in the desk's feedback.
 */
export function MemberHoldsPanel({
  member,
  branchId,
  onChanged,
  onSaid,
  onDialog,
}: {
  member: DeskMemberView;
  branchId: string;
  onChanged(): Promise<void>;
  onSaid(tone: 'success' | 'error', text: string): void;
  /** Whether one of the panel's dialogs is open: the desk then takes no scan and no desk key (Esc closes the dialog only). */
  onDialog(open: boolean): void;
}) {
  const t = useT();
  const [cancelling, setCancelling] = useState<HoldView | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    onDialog(adding || cancelling !== null);
  }, [adding, cancelling]);
  // The panel leaves (another member, another tab) with a dialog open: the desk must not stay blocked.
  useEffect(() => () => onDialog(false), []);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          {t('holds.action.add')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('holds.member.caption', { name: member.name })}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className={TH}>
                {t('holds.col.title')}
              </th>
              <th scope="col" className={TH}>
                {t('holds.col.status')}
              </th>
              <th scope="col" className={TH}>
                {t('holds.col.branch')}
              </th>
              <th scope="col" className={TH}>
                {t('table.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {member.holds.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  {t('holds.member.empty')}
                </td>
              </tr>
            ) : (
              member.holds.map((h) => (
                <tr key={h.id} className={cn('border-t align-top', h.status === 'ready' && 'border-l-4 border-l-primary')}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{h.record.title}</p>
                    {h.item !== null && <p className="font-mono text-xs text-muted-foreground">{h.item.barcode}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <HoldStatus hold={h} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{h.pickupBranch.code}</td>
                  <td className="px-3 py-2">
                    {h.pickupBranch.id === branchId ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setCancelling(h)}>
                        {t('holds.action.cancel')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('holds.member.other_branch', { code: h.pickupBranch.code })}</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <CancelHoldDialog
        hold={cancelling}
        branchId={branchId}
        onClose={() => setCancelling(null)}
        onDone={async () => {
          onSaid('success', t('holds.done.cancelled'));
          await onChanged();
        }}
      />
      <PlaceHoldDialog
        open={adding}
        member={member}
        branchId={branchId}
        onClose={() => setAdding(false)}
        onPlaced={async (title, r) => {
          onSaid('success', t('holds.place.done', { title, position: r.position ?? 1 }));
          await onChanged();
        }}
      />
    </div>
  );
}

/** "Tambah reservasi": search the catalogue for a title, then place a hold on it for the member at this desk's branch. */
export function PlaceHoldDialog({
  open,
  member,
  branchId,
  onClose,
  onPlaced,
}: {
  open: boolean;
  member: DeskMemberView;
  branchId: string;
  onClose(): void;
  onPlaced(title: string, r: HoldCreateResponse): Promise<void>;
}) {
  const t = useT();
  const me = useMe();
  const ids = useId();
  const canSearch = holdsPermission(me, 'catalog.records.read');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setText('');
      setQ('');
      setError(null);
    }
  }, [open]);
  const results = useQuery({
    queryKey: ['catalog', 'records', 'hold-search', q],
    queryFn: () => api<RecordListResponse>('GET', `catalog/records?${new URLSearchParams({ q, hasItems: 'true', limit: '10' }).toString()}`),
    enabled: open && canSearch && q.length >= 2,
  });

  const place = async (recordId: string, title: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<HoldCreateResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/holds`, { memberId: member.id, recordId }, {
        idempotencyKey: newTransactionKey('hold-place'),
      });
      onClose();
      await onPlaced(title, r);
    } catch (e) {
      setError(holdProblemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const items = results.data?.items ?? [];
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')}>
          <DialogHeader>
            <DialogTitle>{t('holds.place.title', { name: member.name })}</DialogTitle>
            <DialogDescription>{t('holds.place.description')}</DialogDescription>
          </DialogHeader>
          {!canSearch ? (
            <Notice kind="error">{t('holds.place.no_catalog')}</Notice>
          ) : (
            <form
              noValidate
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setQ(text.trim());
              }}>
              <Label htmlFor={`${ids}-q`} className="sr-only">
                {t('holds.place.search')}
              </Label>
              <Input id={`${ids}-q`} autoFocus autoComplete="off" placeholder={t('holds.place.search')} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
              <Button type="submit" disabled={text.trim().length < 2}>
                {t('holds.place.search')}
              </Button>
            </form>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {results.isFetching && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('holds.place.searching')}
            </p>
          )}
          {results.isError && <Notice kind="error">{problemText(t, results.error)}</Notice>}
          {q.length >= 2 && results.data !== undefined && items.length === 0 && <p className="text-sm text-muted-foreground">{t('holds.place.no_results')}</p>}
          {items.length > 0 && (
            <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-md border">
              {items.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {[r.mainAgent, r.year, t('holds.place.copies', { count: r.itemCount })].filter((x) => x !== null && x !== '').join(' · ')}
                    </span>
                  </span>
                  <Button type="button" size="sm" disabled={busy} onClick={() => void place(r.id, r.title)}>
                    {t('holds.place.submit')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---- the hold shelf slip -------------------------------------------------------------------------------------------

/** The attribute on `<html>` that hold-slip.css reads while a slip prints. */
const PRINT_ATTRIBUTE = 'data-print';

/** A slip to print for a copy kept on the hold shelf. */
export interface HoldSlip {
  trap: ReturnHoldTrap;
  title: string;
  barcode: string;
}

/**
 * Prints `slip` once each time `printing` grows: the slip is put at the end of <body> and <html> is marked, so the
 * print holds the slip only; the mark goes once the browser says it printed.
 */
export function HoldSlipPrint({ slip, printing, onPrinted }: { slip: HoldSlip | null; printing: number; onPrinted(): void }) {
  const t = useT();
  const locale = useLocale();
  const day = useCalendarDate();
  useEffect(() => {
    if (printing === 0 || slip === null) return;
    const root = document.documentElement;
    const done = (): void => {
      window.removeEventListener('afterprint', done);
      root.removeAttribute(PRINT_ATTRIBUTE);
      onPrinted();
    };
    root.setAttribute(PRINT_ATTRIBUTE, 'hold-slip');
    window.addEventListener('afterprint', done);
    window.print();
    return () => window.removeEventListener('afterprint', done);
  }, [printing, slip, onPrinted]);
  if (slip === null) return null;
  return createPortal(
    <div className="hold-slip-copy" lang={locale} aria-hidden="true">
      <p className="hold-slip-heading">{t('holds.slip.heading')}</p>
      <p className="hold-slip-number">{slip.trap.memberNo}</p>
      <p>
        {t('holds.slip.for')}: {slip.trap.memberName}
      </p>
      <p>
        {t('holds.slip.until')}: {day(slip.trap.pickupUntil)}
      </p>
      <p>
        {t('holds.slip.item')}: {slip.barcode}
      </p>
      <p>{slip.title}</p>
    </div>,
    document.body,
  );
}
