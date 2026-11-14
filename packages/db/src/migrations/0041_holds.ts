import type { AltisMigration } from '../migrator.js';
import { ensureIndex, ensureTable } from '../ddl.js';

// 0041: holds (Komunitas circulation). Class data, scoped to the branch where the member picks the copy up.
//
// - holds: a member's hold on a title (a record), queued per record and pickup branch in the order (`placed_at`, `id`).
//   `item_id` is the copy the hold is pinned to (`pinned = 1`) or, once a returned copy is kept for the member, that
//   copy. `status` is `waiting`, `ready`, `fulfilled`, `cancelled` or `expired`.
// - `active_key` is `<member_id>:<record_id>` while the hold is `waiting` or `ready` and null once it is closed: its
//   unique index allows one active hold per member per title on every engine (NULLs are distinct).
// - `trap_item_id` is the kept copy's id while the hold is `ready`, null otherwise: its unique index keeps one copy on
//   the hold shelf for one hold only.
// - `member_id` becomes null when the history is anonymised; `placed_by` is null when the member placed it themselves.
// - `shelf_cleared_at` is set when staff put a copy that is no longer kept (an expired or cancelled hold) back on the
//   shelf.
//
// The two key columns are binary (key191() and ulid()); the code enforces the narrower width of `active_key` (64).
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0041_holds';

export const holds: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'holds', 'data', NAME, (t) => {
      t.id();
      t.ulid('record_id');
      t.ulid('item_id').nullable();
      t.bool('pinned').default(0);
      t.ulid('member_id').nullable();
      t.ulid('pickup_branch_id');
      t.varchar('status', 16);
      t.key191('active_key').nullable();
      t.ulid('trap_item_id').nullable();
      t.date('placed_on');
      t.timestamp('placed_at');
      t.ulid('placed_by').nullable();
      t.varchar('source', 16);
      t.date('expires_on').nullable();
      t.timestamp('ready_at').nullable();
      t.date('pickup_until').nullable();
      t.timestamp('closed_at').nullable();
      t.varchar('close_reason', 24).nullable();
      t.timestamp('shelf_cleared_at').nullable();
      t.ulid('loan_id').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'holds', 'uq_holds_active_key', ['active_key'], { unique: true });
    await ensureIndex(db, dialect, 'holds', 'uq_holds_trap_item_id', ['trap_item_id'], { unique: true });
    await ensureIndex(db, dialect, 'holds', 'ix_holds_record_id_status_placed_at', ['record_id', 'status', 'placed_at']);
    await ensureIndex(db, dialect, 'holds', 'ix_holds_member_id_status', ['member_id', 'status']);
    await ensureIndex(db, dialect, 'holds', 'ix_holds_status_pickup_until', ['status', 'pickup_until']);
  },
};
