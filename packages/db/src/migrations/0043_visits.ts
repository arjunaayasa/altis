import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0043: visits and guestbook stations (Komunitas). Both class data and branch-scoped.
//
// - visit_stations: a guestbook device of a branch (and optionally a room, `location_id`). Staff create one and get a
//   one-time activation code (8 characters, 10 minutes), stored only as its SHA-256 (`activation_hash`, with its
//   expiry); typing it on the device stores the SHA-256 of a 256-bit device token (`token_hash`, unique while set; NULLs
//   are distinct on every engine, so many unpaired stations coexist). Revoking sets `revoked_at` and clears the token;
//   a new code clears it too, so the device must be activated again.
// - visits: one visit (or a group's head count) at a branch on a calendar date of the branch's time zone. `source` is
//   `station`, `desk`, `online`, `manual` or `migrated`. A member's visit keeps the member type, population group and
//   class of that day (`member_type_id`, `accred_group`, `class_name`), so the counts per type and class stay right
//   after the member changes or is anonymised; a guest has `accred_group = 'guest'` and a name and institution, which
//   are personal data. `day_key` = `<source>:<member id>:<branch id>:<date>` for the desk and online sources only, so
//   at most one such visit per member, branch and day exists (unique while set); it is cleared when the visit is
//   anonymised. A wrong entry is voided (`voided_at`), never deleted.
//
// Every text column of a unique key is binary on MySQL/MariaDB and byte-ordered on PostgreSQL (key191; the code keeps
// `day_key` within 96 characters). Table names and classes are literals: a shipped migration never reads the live
// registry.

const NAME = '0043_visits';

export const visits: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'visit_stations', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id');
      t.ulid('location_id').nullable();
      t.varchar('name', 191);
      t.char('token_hash', 64).nullable();
      t.char('activation_hash', 64).nullable();
      t.timestamp('activation_expires_at').nullable();
      t.timestamp('activated_at').nullable();
      t.timestamp('last_seen_at').nullable();
      t.timestamp('revoked_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'visit_stations', 'uq_visit_stations_token_hash', ['token_hash'], { unique: true });
    await ensureIndex(db, dialect, 'visit_stations', 'ix_visit_stations_branch_id', ['branch_id']);

    await ensureTable(db, dialect, 'visits', 'data', NAME, (t) => {
      t.id();
      t.ulid('branch_id');
      t.ulid('location_id').nullable();
      t.date('visited_on');
      t.timestamp('visited_at');
      t.varchar('source', 16);
      t.ulid('member_id').nullable();
      t.ulid('member_type_id').nullable();
      t.varchar('accred_group', 16).nullable();
      t.varchar('class_name', 64).nullable();
      t.varchar('guest_name', 191).nullable();
      t.varchar('guest_institution', 191).nullable();
      t.varchar('purpose', 16).nullable();
      t.smallint('headcount').default(1);
      t.bool('is_repeat').default(0);
      t.ulid('station_id').nullable();
      t.key191('day_key').nullable();
      t.varchar('note', 191).nullable();
      t.timestamp('voided_at').nullable();
      t.ulid('voided_by').nullable();
      t.ulid('created_by').nullable();
    });
    await ensureIndex(db, dialect, 'visits', 'uq_visits_day_key', ['day_key'], { unique: true });
    await ensureIndex(db, dialect, 'visits', 'ix_visits_branch_id_visited_on', ['branch_id', 'visited_on']);
    await ensureIndex(db, dialect, 'visits', 'ix_visits_visited_on', ['visited_on']);
    await ensureIndex(db, dialect, 'visits', 'ix_visits_member_id_visited_at', ['member_id', 'visited_at']);
    await ensureIndex(db, dialect, 'visits', 'ix_visits_visited_on_class_name', ['visited_on', 'class_name']);
  },
};
