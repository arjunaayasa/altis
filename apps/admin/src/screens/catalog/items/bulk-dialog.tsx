import { ITEM_STATUSES, type ItemStatus } from '@altis/shared';
import { ITEM_BULK_MAX, type ItemBulkBody, type ItemBulkResponse, type ItemListItem } from '@altis/shared/api/catalog/items';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Field, Notice, NoticeAlert, SELECT_CLASS } from '@/components/form-field';
import { Callout, InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holdsAt } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { LocationOptions, useBranchLocations, useCollectionTypeName, useCollectionTypes, useInactiveBranches } from './item-form';

/**
 * "Ubah massal" of the item list (Phase 2 spec §3.4, §13; plan Task 25): move the selected items to a location, change
 * their status or their collection type (`POST branches/:branchId/items/bulk`, at most {@link ITEM_BULK_MAX} ids).
 *
 * - The route is branch-scoped, so the items go in one request per branch, and only the branches where the user may
 *   manage items (`holdsAt`) and that are writable (L13, `isWritableBranch`); the others are left out and the panel says how
 *   many. A branch whose request is refused (or fails) does not stop the next ones: it is listed with its reason.
 * - A location belongs to one branch: the move is offered only when the items are all of one branch.
 * - Each status change is checked per item by the server (§2.5); the refused items come back with their reason
 *   (`invalid_transition`, `not_found`, `invalid_location`; `record_archived`, `archived_reference` for an item leaving
 *   `withdrawn`) and are listed by barcode, the rest is changed.
 * - Nothing is sent before one change is chosen.
 * - **Tanggal terima** (`set.receivedDate`): "Isi yang kosong" (the default, `receivedDateMode: 'fill_empty'`) fills only
 *   the copies without one, and the server refuses the others `received_date_set`; "Timpa semua" (`overwrite`) sets it
 *   on every copy. A date filled here is an edit made in ALTIS, so a SLiMS re-sync skips such a copy from then on: the
 *   panel says so above its buttons as soon as a date is entered, before the change is confirmed. It opens as an inline
 *   panel under the list's selection bar.
 */

/** The location choice "no location" (the select's `''` is "unchanged"). */
const NO_LOCATION = 'none';

type ReceivedDateMode = NonNullable<ItemBulkBody['receivedDateMode']>;

const RECEIVED_DATE_MODES: readonly ReceivedDateMode[] = ['fill_empty', 'overwrite'];

type Refusal = ItemBulkResponse['refused'][number];

interface Outcome {
  updated: number;
  refused: Refusal[];
}

/** A branch whose request was refused or failed: its code and the problem's sentence. */
interface BranchFailure {
  branchId: string;
  code: string;
  reason: string;
}

/** The panel under the item list's selection bar (Esc or "Batal" closes it; "Selesai" once applied). */
export function BulkPanel({
  items,
  onApplied,
  onClose,
}: {
  /** The selected rows. */
  items: readonly ItemListItem[];
  /** After a request changed something (the list reads again). */
  onApplied(): void;
  onClose(): void;
}) {
  const t = useT();
  const me = useMe();
  const typeName = useCollectionTypeName();
  const ids = { location: useId(), status: useId(), type: useId(), refused: useId(), received: useId(), mode: useId() };
  const outside = useInactiveBranches();
  const held = useMemo(() => items.filter((i) => holdsAt(me, 'catalog.items.manage', i.branch.id)), [items, me]);
  const managed = useMemo(() => held.filter((i) => !outside.has(i.branch.id)), [held, outside]);
  /** The managed items by branch, in the order of the selection. */
  const byBranch = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const i of managed) groups.set(i.branch.id, [...(groups.get(i.branch.id) ?? []), i.id]);
    return groups;
  }, [managed]);
  const oneBranch = byBranch.size === 1 ? [...byBranch.keys()][0]! : null;
  const locations = useBranchLocations(oneBranch);
  const types = useCollectionTypes();
  const [location, setLocation] = useState('');
  const [status, setStatus] = useState<ItemStatus | ''>('');
  const [collectionTypeId, setCollectionTypeId] = useState('');
  const [receivedDate, setReceivedDate] = useState('');
  const [receivedDateMode, setReceivedDateMode] = useState<ReceivedDateMode>('fill_empty');
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<BranchFailure[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const barcodes = useMemo(() => new Map(items.map((i) => [i.id, i.barcode])), [items]);
  const tooMany = managed.length > ITEM_BULK_MAX;
  const doneButton = useRef<HTMLButtonElement>(null);
  // Once applied, the form's buttons are gone: the focus goes to "Selesai".
  useEffect(() => {
    if (outcome !== null) doneButton.current?.focus();
  }, [outcome]);

  const apply = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    const set: ItemBulkBody['set'] = {};
    if (location !== '') set.locationId = location === NO_LOCATION ? null : location;
    if (status !== '') set.status = status;
    if (collectionTypeId !== '') set.collectionTypeId = collectionTypeId;
    if (receivedDate !== '') set.receivedDate = receivedDate;
    if (Object.keys(set).length === 0) {
      setError(t('catalog.items.bulk.nothing'));
      return;
    }
    setBusy(true);
    setFailures([]);
    const done: Outcome = { updated: 0, refused: [] };
    const failed: BranchFailure[] = [];
    for (const [branchId, branchIds] of byBranch) {
      const body: ItemBulkBody = { ids: branchIds, set, ...(set.receivedDate === undefined ? {} : { receivedDateMode }) };
      try {
        const answer = await api<ItemBulkResponse>('POST', `branches/${encodeURIComponent(branchId)}/items/bulk`, body);
        done.updated += answer.updated;
        done.refused.push(...answer.refused);
        onApplied();
      } catch (e) {
        // One branch refused (an inactive branch, a grant gone, a lost connection): the next branches are still sent.
        failed.push({ branchId, code: managed.find((i) => i.branch.id === branchId)?.branch.code ?? branchId, reason: problemText(t, e) });
      }
    }
    setBusy(false);
    setFailures(failed);
    // What the other branches answered is shown too.
    if (done.updated > 0 || done.refused.length > 0) setOutcome(done);
  };

  return (
    <InlinePanel
      title={t('catalog.items.bulk.title')}
      onCancel={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}>
      <p className="text-sm text-muted-foreground">{t('catalog.items.bulk.description', { count: managed.length })}</p>
      {items.length > held.length && (
        <Callout
          className="bg-background"
          title={held.length === 0 ? t('catalog.items.bulk.none_managed') : t('catalog.items.bulk.not_managed', { count: items.length - held.length })}
        />
      )}
      {held.length > managed.length && <Callout className="bg-background" title={t('catalog.items.bulk.outside_limit', { count: held.length - managed.length })} />}
      {tooMany && <Notice kind="error">{t('catalog.items.bulk.too_many', { max: ITEM_BULK_MAX })}</Notice>}
      {error !== null && <Notice kind="error">{error}</Notice>}
      {failures.length > 0 && (
        <Notice kind="error">
          {failures.map((f) => (
            <span key={f.branchId} className="block">
              {t('catalog.items.bulk.branch_failed', { branch: f.code, reason: f.reason })}
            </span>
          ))}
        </Notice>
      )}
      {outcome !== null ? (
        <div className="grid gap-3">
          <Notice kind="success">{t('catalog.items.bulk.updated', { count: outcome.updated })}</Notice>
          {outcome.refused.length > 0 && (
            <div className="grid gap-1">
              <h3 id={ids.refused} className="text-sm font-semibold">
                {t('catalog.items.bulk.refused', { count: outcome.refused.length })}
              </h3>
              <ul aria-labelledby={ids.refused} className="max-h-60 overflow-y-auto text-sm">
                {outcome.refused.map((r) => (
                  <li key={r.id} className="py-0.5">
                    <span className="font-semibold">{barcodes.get(r.id) ?? r.id}</span>
                    {' — '}
                    {t(`catalog.items.bulk.refused.${r.code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button ref={doneButton} type="button" size="sm" onClick={onClose}>
              {t('catalog.items.bulk.done')}
            </Button>
          </div>
        </div>
      ) : (
        managed.length > 0 &&
        !tooMany && (
          <>
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field id={ids.location} label={t('catalog.items.bulk.location')} hint={oneBranch === null ? t('catalog.items.bulk.location_one_branch') : undefined}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} disabled={oneBranch === null || busy} value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">{t('catalog.items.bulk.keep')}</option>
                    <option value={NO_LOCATION}>{t('catalog.items.no_location')}</option>
                    <LocationOptions locations={locations.data?.items ?? []} />
                  </select>
                )}
              </Field>
              <Field id={ids.status} label={t('catalog.items.bulk.status')}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} disabled={busy} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus | '')}>
                    <option value="">{t('catalog.items.bulk.keep')}</option>
                    {ITEM_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`vocab.item_status.${s}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field id={ids.type} label={t('catalog.items.bulk.collection_type')}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} disabled={busy} value={collectionTypeId} onChange={(e) => setCollectionTypeId(e.target.value)}>
                    <option value="">{t('catalog.items.bulk.keep')}</option>
                    {(types.data?.items ?? [])
                      .filter((ct) => !ct.archived)
                      .map((ct) => (
                        <option key={ct.id} value={ct.id}>
                          {typeName(ct)}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
              <Field id={ids.received} label={t('catalog.items.bulk.received_date')} hint={t('catalog.items.bulk.received_date_hint')}>
                {(c) => <Input {...c} type="date" disabled={busy} value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />}
              </Field>
            </div>
            <fieldset className="grid gap-2" disabled={busy || receivedDate === ''}>
              <legend className="mb-1.5 text-meta leading-snug font-semibold">{t('catalog.items.bulk.received_mode')}</legend>
              {RECEIVED_DATE_MODES.map((mode) => (
                <div key={mode} className="flex items-center gap-2">
                  <input
                    id={`${ids.mode}-${mode}`}
                    type="radio"
                    name={ids.mode}
                    value={mode}
                    checked={receivedDateMode === mode}
                    onChange={() => setReceivedDateMode(mode)}
                    className="size-4 accent-primary"
                  />
                  <label htmlFor={`${ids.mode}-${mode}`} className="text-sm">
                    {t(`catalog.items.bulk.received_mode.${mode}`)}
                  </label>
                </div>
              ))}
            </fieldset>
            {receivedDate !== '' && <NoticeAlert>{t('catalog.items.bulk.received_sync_note')}</NoticeAlert>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {t(busy ? 'catalog.items.bulk.applying' : 'catalog.items.bulk.apply')}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                {t('form.cancel')}
              </Button>
            </div>
          </>
        )
      )}
      {outcome === null && (managed.length === 0 || tooMany) && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            {t('catalog.items.bulk.close')}
          </Button>
        </div>
      )}
    </InlinePanel>
  );
}
