import { HOLD_REFUSALS, type HoldRefusal } from '@altis/shared';
import type { RecordListResponse } from '@altis/shared/api/catalog/records';
import type { DeskMemberView } from '@altis/shared/api/circulation';
import type { HoldActionResponse, HoldCreateResponse, HoldShelfResponse, HoldView, WaitingTitleView } from '@altis/shared/api/holds';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, InlinePanel, PageError, PageHead, Section, SkeletonTable, StatusText, Tag, type DenseColumn, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds as holdsPermission } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { newTransactionKey, todayLocal, useCalendarDate, useDeskBranch } from './common';

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
 * - The **slip** of a copy kept for a hold (after the return that kept it, and on each ready row of the shelf): a
 *   58/80 mm roll PDF with the member number, the name, the title and the pickup deadline, to put in the book.
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

const STATUS_TONE: Record<HoldView['status'], TagTone> = {
  waiting: 'neutral',
  ready: 'ok',
  fulfilled: 'neutral',
  cancelled: 'neutral',
  expired: 'bad',
};

/** The hold's status as a badge, with its place in the queue or its pickup deadline. */
function HoldStatus({ hold }: { hold: HoldView }) {
  const t = useT();
  const day = useCalendarDate();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Tag tone={STATUS_TONE[hold.status]}>{t(`vocab.hold_status.${hold.status}`)}</Tag>
      {hold.status === 'waiting' && hold.position !== null && <span className="text-meta text-muted-foreground">{t('holds.position', { position: hold.position })}</span>}
      {hold.status === 'ready' && hold.pickupUntil !== null && <span className="text-meta text-muted-foreground">{t('holds.ready_until', { date: day(hold.pickupUntil) })}</span>}
    </div>
  );
}

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
  const titleCell = (h: HoldView) => (
    <>
      <p className="font-semibold">{h.record.title}</p>
      <p className="text-meta tracking-wide text-muted-foreground">{h.item?.barcode ?? '—'}</p>
    </>
  );
  const readyColumns: DenseColumn<HoldView>[] = [
    { id: 'title', header: t('holds.col.title'), cell: titleCell },
    {
      id: 'member',
      header: t('holds.col.member'),
      cell: (h) => (
        <>
          <p className="font-semibold tracking-wide">{h.member?.memberNo ?? '—'}</p>
          <p className="text-meta text-muted-foreground">{h.member?.name ?? ''}</p>
        </>
      ),
    },
    {
      id: 'until',
      header: t('holds.col.pickup_until'),
      className: 'whitespace-nowrap',
      cell: (h) => (
        <>
          <p>{day(h.pickupUntil)}</p>
          {h.pickupUntil !== null && h.pickupUntil < today && <StatusText tone="bad">{t('holds.overdue_pickup')}</StatusText>}
        </>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (h) => (
        <>
          {branchId !== null && (
            <Button asChild size="sm" variant="ghost">
              <a href={holdSlipHref(branchId, h.id)} target="_blank" rel="noopener" aria-label={t('holds.action.slip_named', { title: h.record.title })}>
                {t('holds.action.slip')}
              </a>
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setCancelling(h)}>
            {t('holds.action.cancel')}
          </Button>
        </>
      ),
    },
  ];
  const clearColumns: DenseColumn<HoldView>[] = [
    { id: 'title', header: t('holds.col.title'), cell: titleCell },
    { id: 'reason', header: t('holds.col.reason'), cell: (h) => (h.closeReason === null ? '—' : t(`vocab.hold_close_reason.${h.closeReason}`)) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (h) => (
        <Button type="button" size="sm" variant="ghost" onClick={() => void clear(h)}>
          {t('holds.action.clear')}
        </Button>
      ),
    },
  ];
  const waitingColumns: DenseColumn<WaitingTitleView>[] = [
    { id: 'title', header: t('holds.col.title'), cell: (w) => <span className="font-semibold">{w.record.title}</span> },
    { id: 'waiting', header: t('holds.col.waiting'), headClassName: 'text-right', className: 'text-right', cell: (w) => w.waiting },
    { id: 'since', header: t('holds.col.since'), className: 'whitespace-nowrap', cell: (w) => day(w.firstPlacedOn) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (w) => (
        <Button type="button" size="sm" variant="ghost" aria-expanded={marking?.record.id === w.record.id} onClick={() => setMarking(w)}>
          {t('holds.action.mark_ready')}
        </Button>
      ),
    },
  ];
  return (
    <div className="grid gap-6">
      <PageHead title={t('nav.circulation.hold_shelf')} intro={t('holds.shelf.intro')} />
      {desk.branches !== undefined && desk.branches.length > 1 && (
        <FilterRow label={t('circulation.desk.branch')}>
          <FilterField id={`${ids}-branch`} label={t('circulation.desk.branch')} className="max-w-xs">
            <select id={`${ids}-branch`} className={SELECT_CLASS} value={branchId ?? ''} onChange={(e) => desk.choose(e.target.value)}>
              {desk.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </FilterField>
        </FilterRow>
      )}
      {desk.branches !== undefined && desk.branches.length === 0 && <Notice kind="error">{t('circulation.desk.no_branch')}</Notice>}
      {notice !== null && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {shelf.isError && data === undefined && <ErrorState error={shelf.error} onRetry={() => void shelf.refetch()} retrying={shelf.isFetching} />}
      {branchId !== null && data === undefined && !shelf.isError && <SkeletonTable label={t('shell.loading')} columns={4} rows={3} />}
      {data !== undefined && (
        <>
          <Section title={t('holds.shelf.ready', { count: data.ready.length })}>
            <DenseTable caption={t('holds.shelf.ready', { count: data.ready.length })} columns={readyColumns} rows={data.ready} rowKey={(h) => h.id} empty={t('holds.shelf.ready_empty')} />
          </Section>
          <Section title={t('holds.shelf.to_clear', { count: data.toClear.length })}>
            <DenseTable caption={t('holds.shelf.to_clear', { count: data.toClear.length })} columns={clearColumns} rows={data.toClear} rowKey={(h) => h.id} empty={t('holds.shelf.to_clear_empty')} />
          </Section>
          <Section title={t('holds.shelf.waiting', { count: data.waitingTitles.length })}>
            {branchId !== null && marking !== null && (
              <MarkReadyPanel
                key={marking.record.id}
                title={marking}
                branchId={branchId}
                onClose={() => setMarking(null)}
                onDone={async (r) => {
                  setNotice({ kind: 'success', text: t('holds.done.ready', { date: day(r.pickupUntil) }) });
                  await refresh();
                }}
              />
            )}
            <DenseTable
              caption={t('holds.shelf.waiting', { count: data.waitingTitles.length })}
              columns={waitingColumns}
              rows={data.waitingTitles}
              rowKey={(w) => w.record.id}
              rowClassName={(w) => (marking?.record.id === w.record.id ? 'bg-accent-soft' : undefined)}
              empty={t('holds.shelf.waiting_empty')}
            />
          </Section>
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

/**
 * "Tandai siap", a panel above the queues: scan a copy of `title` from the shelf; it is kept for the first in its queue.
 */
function MarkReadyPanel({ title, branchId, onClose, onDone }: { title: WaitingTitleView; branchId: string; onClose(): void; onDone(r: HoldActionResponse): Promise<void> }) {
  const t = useT();
  const [barcode, setBarcode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (barcode.trim() === '') return;
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
    <InlinePanel title={t('holds.ready_dialog.title', { title: title.record.title })} onSubmit={(e) => void submit(e)} onCancel={onClose}>
      <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('holds.ready_dialog.description')}</p>
      <Field label={t('holds.ready_dialog.barcode')} className="max-w-sm">
        {(c) => <Input {...c} autoComplete="off" className="tracking-wide" value={barcode} maxLength={200} onChange={(e) => setBarcode(e.target.value)} />}
      </Field>
      {error !== null && <PageError title={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || barcode.trim() === ''}>
          {t('holds.ready_dialog.submit')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
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
    <div className="grid gap-3">
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          {t('holds.action.add')}
        </Button>
      </div>
      <DenseTable
        caption={t('holds.member.caption', { name: member.name })}
        columns={[
          {
            id: 'title',
            header: t('holds.col.title'),
            cell: (h) => (
              <>
                <p className="font-semibold">{h.record.title}</p>
                {h.item !== null && <p className="text-meta tracking-wide text-muted-foreground">{h.item.barcode}</p>}
              </>
            ),
          },
          { id: 'status', header: t('holds.col.status'), cell: (h) => <HoldStatus hold={h} /> },
          { id: 'branch', header: t('holds.col.branch'), className: 'whitespace-nowrap', cell: (h) => h.pickupBranch.code },
          {
            id: 'actions',
            header: <span className="sr-only">{t('table.actions')}</span>,
            className: 'py-1.5 text-right',
            cell: (h) =>
              h.pickupBranch.id === branchId ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setCancelling(h)}>
                  {t('holds.action.cancel')}
                </Button>
              ) : (
                <span className="text-meta text-muted-foreground">{t('holds.member.other_branch', { code: h.pickupBranch.code })}</span>
              ),
          },
        ]}
        rows={member.holds}
        rowKey={(h) => h.id}
        empty={t('holds.member.empty')}
      />
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
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setQ(text.trim());
              }}>
              <Field id={`${ids}-q`} label={t('holds.place.search')} className="min-w-0 flex-1">
                <Input id={`${ids}-q`} autoFocus autoComplete="off" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
              </Field>
              <Button type="submit" variant="outline" disabled={text.trim().length < 2}>
                {t('holds.place.search')}
              </Button>
            </form>
          )}
          {error !== null && <PageError title={error} />}
          {results.isFetching && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('holds.place.searching')}
            </p>
          )}
          {results.isError && <Notice kind="error">{problemText(t, results.error)}</Notice>}
          {q.length >= 2 && results.data !== undefined && items.length === 0 && <p className="text-sm text-muted-foreground">{t('holds.place.no_results')}</p>}
          {items.length > 0 && (
            <ul className="grid max-h-80 overflow-y-auto rounded-lg border">
              {items.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{r.title}</span>
                    <span className="text-meta text-muted-foreground">
                      {[r.mainAgent, r.year, t('holds.place.copies', { count: r.itemCount })].filter((x) => x !== null && x !== '').join(' · ')}
                    </span>
                  </span>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void place(r.id, r.title)}>
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

// ---- the hold shelf slip ------------------------------------------------------------------------------------------

/** The hold shelf slip of the ready hold `holdId` as a roll PDF the browser opens (the session cookie authorises it). */
export function holdSlipHref(branchId: string, holdId: string): string {
  return `/api/v1/branches/${encodeURIComponent(branchId)}/circulation/holds/${encodeURIComponent(holdId)}/slip`;
}
