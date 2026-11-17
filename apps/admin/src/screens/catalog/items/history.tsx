import type { ItemEventView } from '@altis/shared/api/catalog/items';
import type { LocationView } from '@altis/shared/api/catalog/locations';
import { useId } from 'react';
import { useDateTime } from '@/components/data-table';
import { SectionHead } from '@/components/layout';
import { useT, type TKey, type Translate } from '@/i18n';
import { locationNames } from './item-form';

/**
 * The history of an item (Phase 2 spec §2.2 `item_events`, §13 "riwayat"; plan Task 25): the rows of
 * `GET catalog/items/:id`, newest first as the server sends them (at most 500). Each row says what happened (the shared
 * `vocab.item_event.*` label), when and by whom (staff, system, command line: an event names no person), and the
 * status change (`Dari Tersedia ke Perbaikan`), the move (location names from the branch's locations, archived ones
 * included) or the names of the changed fields. An event never carries values (§12.4), so neither does this list.
 */

/** The label of each API field an `updated` event may name; any other name is shown as it is. */
const FIELD_LABELS: Readonly<Record<string, TKey>> = Object.freeze({
  barcode: 'catalog.items.field.barcode',
  collectionTypeId: 'catalog.items.field.collection_type',
  status: 'catalog.items.field.status',
  locationId: 'catalog.items.field.location',
  callNumber: 'catalog.items.field.call_number',
  inventoryNo: 'catalog.items.field.inventory_no',
  partsTotal: 'catalog.items.field.parts_total',
  statusNote: 'catalog.items.field.status_note',
  acqSource: 'catalog.items.field.acq_source',
  orderNo: 'catalog.items.field.order_no',
  orderDate: 'catalog.items.field.order_date',
  receivedDate: 'catalog.items.field.received_date',
  invoiceDate: 'catalog.items.field.invoice_date',
  supplierId: 'catalog.items.field.supplier',
  invoiceNo: 'catalog.items.field.invoice_no',
  price: 'catalog.items.field.price',
  currency: 'catalog.items.field.currency',
  note: 'catalog.items.field.note',
  custom: 'catalog.items.field.custom',
});

const ACTORS: Readonly<Record<string, TKey>> = Object.freeze({
  staff: 'catalog.items.history.actor.staff',
  system: 'catalog.items.history.actor.system',
  cli: 'catalog.items.history.actor.cli',
});

const own = <T,>(o: Readonly<Record<string, T>>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);

function fieldLabel(t: Translate, field: string): string {
  const key = own(FIELD_LABELS, field);
  return key === undefined ? field : t(key);
}

function actorLabel(t: Translate, actorType: string): string {
  const key = own(ACTORS, actorType);
  return key === undefined ? actorType : t(key);
}

/** What the event changed, in one sentence; null when it says nothing more than its kind. */
function detailOf(t: Translate, e: ItemEventView, place: (id: string | null) => string): string | null {
  const status = (s: NonNullable<ItemEventView['toStatus']>): string => t(`vocab.item_status.${s}`);
  switch (e.type) {
    case 'status':
    case 'archived':
      return e.fromStatus !== null && e.toStatus !== null && e.fromStatus !== e.toStatus
        ? t('catalog.items.history.change', { from: status(e.fromStatus), to: status(e.toStatus) })
        : null;
    case 'moved':
      return t('catalog.items.history.change', { from: place(e.fromLocationId), to: place(e.toLocationId) });
    case 'created':
    case 'imported':
    case 'migrated':
      return e.toStatus === null ? null : t('catalog.items.history.initial', { status: status(e.toStatus) });
    case 'updated':
      return e.fields.length === 0 ? null : t('catalog.items.history.fields', { fields: e.fields.map((f) => fieldLabel(t, f)).join(', ') });
    default:
      return null;
  }
}

export function ItemHistory({ events, locations }: { events: readonly ItemEventView[]; locations: readonly LocationView[] }) {
  const t = useT();
  const dateTime = useDateTime();
  const titleId = useId();
  const names = locationNames(locations);
  const place = (id: string | null): string => (id === null ? t('catalog.items.no_location') : (names.get(id) ?? t('catalog.items.history.location_unknown')));
  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <SectionHead id={titleId} title={t('catalog.items.history.title')} />
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('catalog.items.history.empty')}</p>
      ) : (
        <ol aria-labelledby={titleId} className="divide-y rounded-lg border">
          {events.map((e) => {
            const detail = detailOf(t, e, place);
            return (
              <li key={e.id} className="grid gap-0.5 px-3 py-2.5">
                <h3 className="text-sm font-semibold">{t(`vocab.item_event.${e.type}`)}</h3>
                <p className="text-xs text-muted-foreground">
                  {t('catalog.items.history.when', { at: dateTime(e.at), actor: actorLabel(t, e.actorType) })}
                </p>
                {detail !== null && <p className="text-sm">{detail}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
