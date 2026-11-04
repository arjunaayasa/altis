import { ITEM_STATUSES, type ItemStatus } from '@altis/shared';
import { ITEM_BULK_MAX, type ItemBulkBody, type ItemBulkResponse, type ItemListItem } from '@altis/shared/api/catalog/items';
import { useId, useMemo, useState } from 'react';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
 *   manage items (`holdsAt`) and that are writable (L13, `isWritableBranch`); the others are left out and the dialog says how
 *   many. A branch whose request is refused (or fails) does not stop the next ones: it is listed with its reason.
 * - A location belongs to one branch: the move is offered only when the items are all of one branch.
 * - Each status change is checked per item by the server (§2.5); the refused items come back with their reason
 *   (`invalid_transition`, `not_found`, `invalid_location`; `record_archived`, `archived_reference` for an item leaving
 *   `withdrawn`) and are listed by barcode, the rest is changed.
 * - Nothing is sent before one change is chosen.
 */

/** The location choice "no location" (the select's `''` is "unchanged"). */
const NO_LOCATION = 'none';

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

export function BulkDialog({
  open,
  items,
  onApplied,
  onClose,
}: {
  open: boolean;
  /** The selected rows. */
  items: readonly ItemListItem[];
  /** After a request changed something (the list reads again). */
  onApplied(): void;
  onClose(): void;
}) {
  const t = useT();
  const focus = useReturnFocus();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent closeLabel={t('catalog.items.bulk.close')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        {open && <BulkBody items={items} onApplied={onApplied} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function BulkBody({ items, onApplied, onClose }: { items: readonly ItemListItem[]; onApplied(): void; onClose(): void }) {
  const t = useT();
  const me = useMe();
  const typeName = useCollectionTypeName();
  const ids = { location: useId(), status: useId(), type: useId(), refused: useId() };
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
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<BranchFailure[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const barcodes = useMemo(() => new Map(items.map((i) => [i.id, i.barcode])), [items]);
  const tooMany = managed.length > ITEM_BULK_MAX;

  const apply = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    const set: ItemBulkBody['set'] = {};
    if (location !== '') set.locationId = location === NO_LOCATION ? null : location;
    if (status !== '') set.status = status;
    if (collectionTypeId !== '') set.collectionTypeId = collectionTypeId;
    if (Object.keys(set).length === 0) {
      setError(t('catalog.items.bulk.nothing'));
      return;
    }
    setBusy(true);
    setFailures([]);
    const done: Outcome = { updated: 0, refused: [] };
    const failed: BranchFailure[] = [];
    for (const [branchId, branchIds] of byBranch) {
      const body: ItemBulkBody = { ids: branchIds, set };
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
    <>
      <DialogHeader>
        <DialogTitle>{t('catalog.items.bulk.title')}</DialogTitle>
        <DialogDescription>{t('catalog.items.bulk.description', { count: managed.length })}</DialogDescription>
      </DialogHeader>
      {items.length > held.length && (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {held.length === 0 ? t('catalog.items.bulk.none_managed') : t('catalog.items.bulk.not_managed', { count: items.length - held.length })}
        </p>
      )}
      {held.length > managed.length && (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('catalog.items.bulk.outside_limit', { count: held.length - managed.length })}</p>
      )}
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
        <div className="flex flex-col gap-3">
          <Notice kind="success">{t('catalog.items.bulk.updated', { count: outcome.updated })}</Notice>
          {outcome.refused.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 id={ids.refused} className="text-sm font-semibold">
                {t('catalog.items.bulk.refused', { count: outcome.refused.length })}
              </h3>
              <ul aria-labelledby={ids.refused} className="max-h-60 overflow-y-auto text-sm">
                {outcome.refused.map((r) => (
                  <li key={r.id} className="py-0.5">
                    <span className="font-mono">{barcodes.get(r.id) ?? r.id}</span>
                    {' — '}
                    {t(`catalog.items.bulk.refused.${r.code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              {t('catalog.items.bulk.done')}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        managed.length > 0 &&
        !tooMany && (
          <div className="flex flex-col gap-4">
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
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                {t('form.cancel')}
              </Button>
              <Button type="button" disabled={busy} onClick={() => void apply()}>
                {t(busy ? 'catalog.items.bulk.applying' : 'catalog.items.bulk.apply')}
              </Button>
            </DialogFooter>
          </div>
        )
      )}
    </>
  );
}
