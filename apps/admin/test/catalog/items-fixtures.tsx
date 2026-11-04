import { type Permission } from '@altis/shared';
import type { BranchItem } from '@altis/shared/api/branches';
import type { ItemDetail, ItemEventView, ItemListItem, ItemView } from '@altis/shared/api/catalog/items';
import type { LocationView } from '@altis/shared/api/catalog/locations';
import type { CollectionTypeView, CustomFieldView, SupplierView } from '@altis/shared/api/catalog/masters';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import type { FakeHandler } from '../fake-api';
import { signedIn, type SignedIn } from '../fake-api';

// The fixtures of the Eksemplar tests (Phase 2 Task 25): two live branches and an archived one, their locations, two
// collection types, a supplier, the catalog config with two barcode patterns, and builders for item views, list rows
// and history rows. Every id is a ULID, since the screens check ids read from the URL.

/** A ULID made of `prefix` (Crockford base32) and `n`, zero-padded to 26 characters. */
export const ulid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(26 - prefix.length, '0')}`;

/** The first wait of a test: it covers the lazy screen's first import and the first reads, slow on a busy machine. */
export const FIRST = { timeout: 10_000 };

export const PUSAT = ulid('01JZBR', 1);
export const UTARA = ulid('01JZBR', 2);
export const LAMA = ulid('01JZBR', 3);

export const BRANCHES: BranchItem[] = [
  { id: PUSAT, code: 'PUSAT', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', isDefault: true, archivedAt: null, version: 1 },
  { id: UTARA, code: 'UTARA', name: 'Cabang Utara', address: null, timezone: 'Asia/Jakarta', isDefault: false, archivedAt: null, version: 1 },
  { id: LAMA, code: 'LAMA', name: 'Cabang Lama', address: null, timezone: 'Asia/Jakarta', isDefault: false, archivedAt: 1_700_000_000_000, version: 2 },
];

/**
 * `GET branches` with UTARA marked inactive (L13, the edition seam: `active: false`; the community server marks every
 * live branch active, an edition may not).
 */
export const BRANCHES_UTARA_OUTSIDE = BRANCHES.map((b) => ({ ...b, active: b.id === PUSAT }));

export const RECORD = ulid('01JZREC', 1);

export const TK_UMUM = ulid('01JZTK', 1);
export const TK_REF = ulid('01JZTK', 2);

export const COLLECTION_TYPES: CollectionTypeView[] = [
  { id: TK_UMUM, code: 'UMUM', nameId: 'Umum', nameEn: 'General', loanable: true, selfService: true, sortOrder: 0, usage: 4, archived: false, version: 1 },
  { id: TK_REF, code: 'REF', nameId: 'Referensi', nameEn: 'Reference', loanable: false, selfService: false, sortOrder: 1, usage: 1, archived: false, version: 1 },
];

export const SUPPLIER = ulid('01JZPMS', 1);

export const SUPPLIERS: SupplierView[] = [
  { id: SUPPLIER, code: 'TBS', name: 'Toko Buku Sejahtera', contactName: null, phone: null, email: null, address: null, note: null, usage: 0, archived: false, version: 1 },
];

export const ROOM_PUSAT = ulid('01JZRNG', 1);
export const SHELF_800 = ulid('01JZRAK', 1);
export const SHELF_808 = ulid('01JZRAK', 2);
export const ROOM_UTARA = ulid('01JZRNG', 2);

function location(o: Partial<LocationView> & Pick<LocationView, 'id' | 'branchId' | 'kind' | 'code' | 'name'>): LocationView {
  return {
    parentId: null,
    shelfHint: null,
    classFrom: null,
    classTo: null,
    mapFileId: null,
    box: null,
    isPublic: true,
    sortOrder: 0,
    itemCount: 0,
    archived: false,
    version: 1,
    ...o,
  };
}

export const LOCATIONS: LocationView[] = [
  location({ id: ROOM_PUSAT, branchId: PUSAT, kind: 'room', code: 'RB', name: 'Ruang Baca' }),
  location({ id: SHELF_800, branchId: PUSAT, parentId: ROOM_PUSAT, kind: 'shelf', code: 'R800', name: 'Rak 800', classFrom: '800', classTo: '899', shelfHint: 'Lorong 3' }),
  location({ id: SHELF_808, branchId: PUSAT, parentId: ROOM_PUSAT, kind: 'shelf', code: 'R808', name: 'Rak 808', classFrom: '800', classTo: '809' }),
  location({ id: ROOM_UTARA, branchId: UTARA, kind: 'room', code: 'RU', name: 'Ruang Utara' }),
];

export const CONFIG: CatalogConfigView = {
  barcodePatterns: [
    { id: 'umum', name: 'Umum', prefix: 'B', digits: 7, suffix: '' },
    { id: 'ref', name: 'Referensi', prefix: 'R', digits: 5, suffix: 'X' },
  ],
  symbology: 'code128',
  labelProfiles: [],
  currency: 'IDR',
  dedupeThreshold: 80,
  defaultMaterialTypeId: null,
  defaultCollectionTypeId: TK_UMUM,
  sruServers: [],
  arsyaEnabled: false,
};

/**
 * The item custom fields (`entity: 'items'`, spec §3.7): a required text whose code holds a `.`, an optional yes/no,
 * an optional choice, and an archived one (never shown).
 */
export const ITEM_CUSTOM_FIELDS: CustomFieldView[] = [
  customField({ id: ulid('01JZRT', 1), code: 'dana.sumber', type: 'text', labelId: 'Sumber dana', required: true, sortOrder: 0 }),
  customField({ id: ulid('01JZRT', 2), code: 'hadiah', type: 'boolean', labelId: 'Hadiah', sortOrder: 1 }),
  customField({
    id: ulid('01JZRT', 3),
    code: 'kondisi',
    type: 'select',
    labelId: 'Kondisi',
    sortOrder: 2,
    options: [
      { value: 'baik', labelId: 'Baik', labelEn: 'Good' },
      { value: 'rusak', labelId: 'Rusak', labelEn: 'Damaged' },
    ],
  }),
  customField({ id: ulid('01JZRT', 4), code: 'lama', type: 'text', labelId: 'Ruas lama', sortOrder: 3, archived: true }),
];

function customField(o: Partial<CustomFieldView> & Pick<CustomFieldView, 'id' | 'code' | 'type' | 'labelId'>): CustomFieldView {
  return { entity: 'items', labelEn: null, options: [], required: false, sortOrder: 0, isPublic: false, isSearchable: false, usage: 0, archived: false, version: 1, ...o };
}

export const ITEM = ulid('01JZEKS', 1);

/** An item view: `B0000001` of the record "Laskar Pelangi", available at PUSAT on no location. */
export function itemView(o: Partial<ItemView> = {}): ItemView {
  return {
    id: ITEM,
    record: { id: RECORD, title: 'Laskar Pelangi' },
    branch: { id: PUSAT, code: 'PUSAT', name: 'Perpustakaan Pusat' },
    barcode: 'B0000001',
    inventoryNo: null,
    callNumber: null,
    locationId: null,
    locationPath: null,
    suggestedLocation: null,
    collectionTypeId: TK_UMUM,
    status: 'available',
    statusNote: null,
    partsTotal: 1,
    acqSource: null,
    orderNo: null,
    orderDate: null,
    receivedDate: null,
    invoiceDate: null,
    supplierId: null,
    invoiceNo: null,
    price: null,
    currency: null,
    note: null,
    custom: {},
    loanable: true,
    selfService: true,
    archived: false,
    createdAt: 1_760_000_000_000,
    updatedAt: null,
    version: 3,
    ...o,
  };
}

export function itemDetail(o: Partial<ItemDetail> = {}): ItemDetail {
  return { ...itemView(o), history: o.history ?? [] };
}

/** One history row. */
export function itemEvent(o: Partial<ItemEventView> & Pick<ItemEventView, 'id' | 'type'>): ItemEventView {
  return {
    at: 1_760_000_000_000,
    fromStatus: null,
    toStatus: null,
    fromLocationId: null,
    toLocationId: null,
    actorType: 'staff',
    actorId: 'U1',
    fields: [],
    ...o,
  };
}

/** One list row. */
export function listItem(o: Partial<ItemListItem> & Pick<ItemListItem, 'id' | 'barcode'>): ItemListItem {
  return {
    record: { id: RECORD, title: 'Laskar Pelangi' },
    branch: { id: PUSAT, code: 'PUSAT' },
    locationPath: null,
    callNumber: '899.221 HIR l',
    collectionTypeId: TK_UMUM,
    status: 'available',
    archived: false,
    version: 1,
    ...o,
  };
}

/** The reads every items screen makes (branches, config, masters, locations), plus `extra` (which wins). */
export function catalogReads(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET branches': () => ({ items: BRANCHES }),
    'GET catalog/config': () => CONFIG,
    'GET catalog/collection-types': () => ({ items: COLLECTION_TYPES }),
    'GET catalog/suppliers': () => ({ items: SUPPLIERS }),
    'GET catalog/custom-fields': () => ({ items: [] }),
    'GET catalog/locations': (req) => {
      const branchId = req.query.get('branchId');
      return { items: LOCATIONS.filter((l) => branchId === null || l.branchId === branchId) };
    },
    ...extra,
  };
}

/**
 * A reader of the catalogue (`catalog.records.read`, global) who manages items only at `branches` (a role assigned at
 * those branches: `me.branchPermissions`).
 */
export function itemsManagerAt(branches: readonly string[], extra: readonly Permission[] = []): SignedIn {
  const me = signedIn({ permissions: ['catalog.records.read', ...extra] });
  return { ...me, branchPermissions: Object.fromEntries(branches.map((b) => [b, ['catalog.items.manage']])) };
}
