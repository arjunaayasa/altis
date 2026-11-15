import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0046: notices (Komunitas circulation), class data. One row per e-mail the library owes a member: a loan due soon, an
// overdue loan, a hold ready on the hold shelf, built by the daily notices job, a desk's manual send or the hold that
// became ready, and sent by one sender job at a time.
//
// - ref_key: what the mail is about, unique, so that building the same day's notices again (a job run again after a
//   crash, two runs at once) adds nothing: `due_soon:<memberId>:<due_on>`, `overdue:<memberId>:<run date>`,
//   `hold_ready:<holdId>:<ready_at>`, `manual:<kind>:<memberId>:<date>`.
// - status: queued → sending (claimed by one sender, `job_id` and `claimed_at` set) → sent | failed | skipped (with a
//   `reason`). A failed row goes back to queued while `attempts` allows; a sending row whose sender died returns to
//   queued once its claim is older than a job lease.
// - Only ids and states: the mail's text is never kept (`loan_ids` is a JSON list of loan ids, `hold_id` the hold).
//
// Table names and classes are literals: a shipped migration never reads the live registry.

const NAME = '0046_notices';

export const notices: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'notices', 'data', NAME, (t) => {
      t.id();
      t.ulid('member_id');
      t.varchar('kind', 16);
      t.key191('ref_key');
      t.varchar('channel', 16);
      t.varchar('status', 16);
      t.varchar('reason', 32).nullable();
      t.text('loan_ids').nullable();
      t.ulid('hold_id').nullable();
      t.smallint('attempts').default(0);
      t.ulid('job_id').nullable();
      t.timestamp('claimed_at').nullable();
      t.timestamp('created_at');
      t.timestamp('sent_at').nullable();
    });
    await ensureIndex(db, dialect, 'notices', 'uq_notices_ref_key', ['ref_key'], { unique: true });
    await ensureIndex(db, dialect, 'notices', 'ix_notices_status_created_at', ['status', 'created_at']);
    await ensureIndex(db, dialect, 'notices', 'ix_notices_member_id_created_at', ['member_id', 'created_at']);
  },
};
