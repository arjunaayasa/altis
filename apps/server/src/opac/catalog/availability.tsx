import { locationPaths, openLoanDueDates, type LocationPath } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { t, type ItemStatus, type Locale } from '@altis/shared';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { opacText } from './messages.js';
import { ShelfMap, planSize, type ImageSize, type PlanBox } from './shelf-map.js';
import { formatDate } from './views/page.js';

// The availability of a record on the OPAC detail (Phase 2 Task 34; spec §9.3, §2.5, §3.6): one row per item with its
// branch, its place (room › area › shelf, then the shelf hint), its call number (the item's own, else the record's),
// its barcode and its status label; and the shelf maps of the shelves those items stand on.
//
// An item with an open loan keeps its status `available` in the catalogue; this table shows it as on loan, with its due
// date, and does not count it as available. The borrower is never named.
//
// The items come from a public load (`loadRecordData` with `publicOnly`): no `withdrawn`, `lost` or archived item ever
// reaches this file. A location is shown only when every level of its chain is public and live (`isPublic`); otherwise
// the cell says nothing of it, and it gets no map. Prices, suppliers and notes are not part of the load.

type Db = DbHandle['db'];

/** At most this many items are listed (a record with thousands of copies stays a page a phone can show). */
export const AVAILABILITY_MAX = 500;
/** At most this many shelf maps. */
export const SHELF_MAPS_MAX = 10;

/** One row of the table. */
export interface AvailabilityRow {
  id: string;
  branch: string;
  /** `Room › Area › Shelf`, or null when the item has no location or it is not public. */
  place: string | null;
  hint: string | null;
  callNumber: string | null;
  barcode: string;
  status: ItemStatus;
  /** The due date of the item's open loan, or null when it is not on loan. */
  dueOn: string | null;
}

/** A shelf map to draw. */
export interface AvailabilityMap {
  planFileId: string;
  box: PlanBox;
  size: ImageSize | null;
  label: string;
}

export interface Availability {
  rows: AvailabilityRow[];
  /** Every item of the public load (the rows may be fewer). */
  total: number;
  available: number;
  maps: AvailabilityMap[];
}

/** The parts of a location's path, the most specific first (shelf, area, room). */
function placeParts(p: LocationPath): string[] {
  return [p.shelfName, p.areaName, p.roomName].filter((s): s is string => s !== null && s.trim() !== '');
}

/**
 * The availability of `d` (a public load with its items): the branch names and location paths of the first
 * {@link AVAILABILITY_MAX} items, and, with `showShelfMap`, the maps of their shelves whose plan is a public, stored
 * file (at most {@link SHELF_MAPS_MAX}).
 */
export async function loadAvailability(db: Db, d: RecordData, o: { showShelfMap: boolean; dataDir: () => string }): Promise<Availability> {
  const shown = d.items.slice(0, AVAILABILITY_MAX);
  const onLoan = d.items.length === 0 ? new Map<string, string>() : await openLoanDueDates(db, d.items.map((i) => i.id));
  const branchIds = [...new Set(shown.map((i) => i.branchId))];
  const branches = new Map(
    branchIds.length === 0 ? [] : (await db.selectFrom('branches').select(['id', 'name']).where('id', 'in', branchIds).execute()).map((b) => [b.id, b.name]),
  );
  const locationIds = [...new Set(shown.flatMap((i) => (i.locationId === null ? [] : [i.locationId])))];
  const paths = locationIds.length === 0 ? new Map<string, LocationPath>() : await locationPaths(db, locationIds);
  const publicPath = (id: string | null): LocationPath | null => {
    const p = id === null ? undefined : paths.get(id);
    return p !== undefined && p.isPublic ? p : null;
  };

  const rows = shown.map((i): AvailabilityRow => {
    const p = publicPath(i.locationId);
    const parts = p === null ? [] : placeParts(p);
    const hint = p?.shelfHint ?? null;
    return {
      id: i.id,
      branch: branches.get(i.branchId) ?? i.branchCode,
      place: parts.length === 0 ? null : [...parts].reverse().join(' › '),
      // A hint made from a name (locationPaths falls back to the name cut to 40 characters) says nothing more.
      hint: hint === null || hint.trim() === '' || parts.some((part) => part.startsWith(hint.trim())) ? null : hint,
      callNumber: i.callNumber ?? d.callNumber ?? null,
      barcode: i.barcode,
      status: i.status,
      dueOn: onLoan.get(i.id) ?? null,
    };
  });

  const maps: AvailabilityMap[] = [];
  if (o.showShelfMap) {
    const candidates: { path: LocationPath; box: PlanBox; planFileId: string }[] = [];
    for (const id of locationIds) {
      const p = publicPath(id);
      if (p === null || p.mapFileId === null || p.box === null) continue;
      candidates.push({ path: p, box: p.box, planFileId: p.mapFileId });
      if (candidates.length === SHELF_MAPS_MAX) break;
    }
    const planIds = [...new Set(candidates.map((c) => c.planFileId))];
    const stored = new Set(
      planIds.length === 0
        ? []
        : (
            await db.selectFrom('files').select('id').where('id', 'in', planIds).where('status', '=', 'ok').where('access', '=', 'public').execute()
          ).map((f) => f.id),
    );
    const sizes = new Map<string, ImageSize | null>();
    for (const id of planIds) if (stored.has(id)) sizes.set(id, await planSize(o.dataDir, id));
    for (const c of candidates) {
      if (!stored.has(c.planFileId)) continue;
      maps.push({ planFileId: c.planFileId, box: c.box, size: sizes.get(c.planFileId) ?? null, label: placeParts(c.path).join(', ') });
    }
  }

  return { rows, total: d.items.length, available: d.items.filter((i) => i.status === 'available' && !onLoan.has(i.id)).length, maps };
}

/** The colour of a status label (with its text, never the colour alone). */
function statusClass(status: ItemStatus): string {
  switch (status) {
    case 'available':
    case 'not_for_loan':
      return 'status status-ok';
    case 'missing':
    case 'lost':
    case 'withdrawn':
      return 'status status-danger';
    default:
      return 'status status-warn';
  }
}

/** The availability section: the summary, the table, the shelf maps; a line when there is no item to show. */
export function AvailabilitySection(props: { availability: Availability; locale: Locale }) {
  const { availability: a, locale } = props;
  const none = '—';
  return (
    <section class="record-section" aria-labelledby="ketersediaan">
      <h2 id="ketersediaan">{opacText(locale, 'detail.availability')}</h2>
      {a.total === 0 ? (
        <p>{opacText(locale, 'detail.availability_none')}</p>
      ) : (
        <>
          <p class="availability-summary">{opacText(locale, 'detail.availability_summary', { count: a.total, available: a.available })}</p>
          <div class="table-scroll">
            <table class="availability">
              <thead>
                <tr>
                  <th scope="col">{opacText(locale, 'detail.col.branch')}</th>
                  <th scope="col">{opacText(locale, 'detail.col.location')}</th>
                  <th scope="col">{t(locale, 'vocab.field.call_number')}</th>
                  <th scope="col">{opacText(locale, 'detail.col.barcode')}</th>
                  <th scope="col">{opacText(locale, 'detail.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr>
                    <td>{r.branch}</td>
                    <td>
                      {r.place ?? none}
                      {r.hint === null ? null : <span class="shelf-hint">{r.hint}</span>}
                    </td>
                    <td>{r.callNumber ?? none}</td>
                    <td>{r.barcode}</td>
                    <td>
                      {r.dueOn === null ? (
                        <span class={statusClass(r.status)}>{t(locale, `vocab.item_status.${r.status}`)}</span>
                      ) : (
                        <span class="status status-warn">{opacText(locale, 'detail.on_loan', { date: formatDate(locale, Date.parse(`${r.dueOn}T00:00:00Z`), 'UTC') })}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {a.rows.length < a.total ? <p class="availability-more">{opacText(locale, 'detail.availability_more', { shown: a.rows.length, count: a.total })}</p> : null}
          {a.maps.map((m) => (
            <ShelfMap planFileId={m.planFileId} box={m.box} size={m.size} label={m.label} summary={opacText(locale, 'detail.shelf_map.summary', { place: m.label })} />
          ))}
        </>
      )}
    </section>
  );
}
