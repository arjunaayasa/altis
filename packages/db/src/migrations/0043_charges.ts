import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0043: charges and payments (Komunitas circulation). All class data, scoped to a branch: a charge to the branch of the
// loan (or of the desk that booked it), a payment to the branch of the desk that took it.
//
// - charges: one sum a member owes: an overdue fine, a lost item's replacement, damage, a member card, a manual charge,
//   or one carried over by a migration (`kind`). Money is BIGINT minor units with its `currency`. `paid_minor` and
//   `waived_minor` only grow by the payments and adjustments the code writes, and `paid_minor + waived_minor` never
//   passes `amount_minor`; `status` is `open` while something is left, `settled` when nothing is, `cancelled` when the
//   whole charge was cancelled (a lost item that came back). `loan_id` and `item_id` link a fine to its loan and item;
//   `description` is the line the member sees (personal data: it may name what was borrowed). `date_unknown` marks a
//   migrated charge whose day was not known.
// - charge_adjustments: a waive (part or all of what is left, with a reason) or a cancellation of a charge; they belong
//   to the charge (CASCADE). The reason is `reason_text` (personal data): a column named `reason` would put that word on
//   the list of field names the server log redacts, and `reason` is the code word every problem carries.
// - payments: one payment at the desk, with its receipt number `<branch code>/<year>/<sequence, 6 digits>`: the next
//   `receipt_seq` of the branch and the library's year, unique per (branch, year), never reused (a voided payment keeps
//   its number). A migrated payment has no number (all three columns null).
// - payment_allocations: how much of a payment went to each charge; they belong to the payment (CASCADE).
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0043_charges';

export const charges: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'charges', 'data', NAME, (t) => {
      t.id();
      t.ulid('member_id');
      t.ulid('branch_id');
      t.ulid('loan_id').nullable();
      t.ulid('item_id').nullable();
      t.varchar('kind', 16);
      t.varchar('description', 191);
      t.bigint('amount_minor');
      t.bigint('paid_minor').default(0);
      t.bigint('waived_minor').default(0);
      t.char('currency', 3);
      t.varchar('status', 16);
      t.date('charged_on');
      t.timestamp('charged_at');
      t.bool('date_unknown').default(0);
      t.varchar('source', 16);
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'charges', 'ix_charges_member_id_status', ['member_id', 'status']);
    await ensureIndex(db, dialect, 'charges', 'ix_charges_loan_id', ['loan_id']);
    await ensureIndex(db, dialect, 'charges', 'ix_charges_charged_on', ['charged_on']);
    await ensureIndex(db, dialect, 'charges', 'ix_charges_status_branch_id', ['status', 'branch_id']);

    await ensureTable(db, dialect, 'charge_adjustments', 'data', NAME, (t) => {
      t.id();
      t.ulid('charge_id');
      t.varchar('kind', 16);
      t.bigint('amount_minor');
      t.varchar('reason_text', 191);
      t.timestamp('at');
      t.ulid('by').nullable();
      t.foreignKey('charge_id', 'charges', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'charge_adjustments', 'ix_charge_adjustments_charge_id', ['charge_id']);

    await ensureTable(db, dialect, 'payments', 'data', NAME, (t) => {
      t.id();
      t.ulid('member_id');
      t.ulid('branch_id');
      t.smallint('receipt_year').nullable();
      t.int('receipt_seq').nullable();
      t.varchar('receipt_no', 64).nullable();
      t.bigint('amount_minor');
      t.char('currency', 3);
      t.varchar('method', 16);
      t.date('paid_on');
      t.timestamp('paid_at');
      t.ulid('received_by').nullable();
      t.varchar('note', 191).nullable();
      t.timestamp('voided_at').nullable();
      t.ulid('voided_by').nullable();
      t.varchar('void_reason', 191).nullable();
      t.bool('date_unknown').default(0);
      t.varchar('source', 16);
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'payments', 'uq_payments_branch_id_receipt_year_receipt_seq', ['branch_id', 'receipt_year', 'receipt_seq'], { unique: true });
    await ensureIndex(db, dialect, 'payments', 'ix_payments_member_id_paid_at', ['member_id', 'paid_at']);
    await ensureIndex(db, dialect, 'payments', 'ix_payments_paid_on_branch_id', ['paid_on', 'branch_id']);

    await ensureTable(db, dialect, 'payment_allocations', 'data', NAME, (t) => {
      t.ulid('payment_id');
      t.ulid('charge_id');
      t.bigint('amount_minor');
      t.primaryKey(['payment_id', 'charge_id']);
      t.foreignKey('payment_id', 'payments', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'payment_allocations', 'ix_payment_allocations_charge_id', ['charge_id']);
  },
};
