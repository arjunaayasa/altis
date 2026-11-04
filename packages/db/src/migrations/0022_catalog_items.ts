import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0022: locations, items and their masters (Phase 2 spec §2.2, §2.4, §3.4, §3.6). All class data.
//
// - locations: room › area › shelf of a branch (`branch_id` RESTRICT: a branch with locations cannot be deleted);
//   `parent_id` has no foreign key (§2.1, no self-reference). `code_key` is UNIQUE per branch. A room may have a
//   floor plan (`map_file_id`); an area or shelf a box on its parent's plan (`map_*`, per mille 0–1000).
// - items: `record_id` RESTRICT (a record with items cannot be deleted), `barcode_key` (the normalised barcode, spec
//   §3.4) UNIQUE across branches. Dates are CHAR(10) `YYYY-MM-DD`; `price` is money() in the currency's minor unit.
// - item_events belong to their item (CASCADE); `meta` names changed fields only.
// - suppliers' contact columns are personal data (main spec §6.9): never sent by a public API.
// Every text column of a unique key is key191() (R39b, P2-09).

const NAME = '0022_catalog_items';

export const catalogItems: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'locations', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id');
      t.ulid('parent_id').nullable();
      t.varchar('kind', 8);
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name', 191);
      t.varchar('shelf_hint', 40).nullable();
      t.varchar('class_from', 32).nullable();
      t.varchar('class_to', 32).nullable();
      t.ulid('map_file_id').nullable();
      t.smallint('map_x').nullable();
      t.smallint('map_y').nullable();
      t.smallint('map_w').nullable();
      t.smallint('map_h').nullable();
      t.bool('is_public').default(1);
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.foreignKey('branch_id', 'branches', 'id', { onDelete: 'restrict' });
    });
    await ensureIndex(db, dialect, 'locations', 'uq_locations_branch_id_code_key', ['branch_id', 'code_key'], { unique: true });
    await ensureIndex(db, dialect, 'locations', 'ix_locations_branch_id_parent_id', ['branch_id', 'parent_id']);

    await ensureTable(db, dialect, 'collection_types', 'data', NAME, (t) => {
      t.id();
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name_id', 191);
      t.varchar('name_en', 191);
      t.bool('loanable').default(1);
      t.bool('self_service').default(1);
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'collection_types', 'uq_collection_types_code_key', ['code_key'], { unique: true });

    await ensureTable(db, dialect, 'suppliers', 'data', NAME, (t) => {
      t.id();
      t.varchar('code_display', 191);
      t.key191('code_key');
      t.varchar('name', 191);
      t.varchar('contact_name', 191).nullable();
      t.varchar('phone', 64).nullable();
      t.varchar('email', 191).nullable();
      t.text('address').nullable();
      t.text('note').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'suppliers', 'uq_suppliers_code_key', ['code_key'], { unique: true });

    await ensureTable(db, dialect, 'items', 'data', NAME, (t) => {
      t.id();
      t.ulid('record_id');
      t.ulid('branch_id');
      t.varchar('barcode_display', 64);
      t.key191('barcode_key');
      t.varchar('inventory_no', 64).nullable();
      t.varchar('call_number', 64).nullable();
      t.ulid('location_id').nullable();
      t.ulid('collection_type_id');
      t.varchar('status', 16);
      t.varchar('status_note', 191).nullable();
      t.smallint('parts_total').default(1);
      t.varchar('acq_source', 16).nullable();
      t.varchar('order_no', 64).nullable();
      t.date('order_date').nullable();
      t.date('received_date').nullable();
      t.date('invoice_date').nullable();
      t.ulid('supplier_id').nullable();
      t.varchar('invoice_no', 64).nullable();
      t.money('price').nullable();
      t.char('currency', 3).nullable();
      t.text('note').nullable();
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.foreignKey('record_id', 'records', 'id', { onDelete: 'restrict' });
    });
    await ensureIndex(db, dialect, 'items', 'uq_items_barcode_key', ['barcode_key'], { unique: true });
    await ensureIndex(db, dialect, 'items', 'ix_items_record_id', ['record_id']);
    await ensureIndex(db, dialect, 'items', 'ix_items_branch_id_location_id', ['branch_id', 'location_id']);
    await ensureIndex(db, dialect, 'items', 'ix_items_inventory_no', ['inventory_no']);

    await ensureTable(db, dialect, 'item_events', 'data', NAME, (t) => {
      t.id();
      t.ulid('item_id');
      t.timestamp('at');
      t.varchar('type', 16);
      t.varchar('from_status', 16).nullable();
      t.varchar('to_status', 16).nullable();
      t.ulid('from_location_id').nullable();
      t.ulid('to_location_id').nullable();
      t.varchar('actor_type', 32);
      t.ulid('actor_id').nullable();
      t.json('meta');
      t.foreignKey('item_id', 'items', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'item_events', 'ix_item_events_item_id_at', ['item_id', 'at']);
  },
};
