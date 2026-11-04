import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0002: branches, staff users and their roles (spec §6.5, §7.1, §7.2). Class data throughout.
//
// - Human codes are stored twice (spec §6.1): `*_display` as typed, `*_key` normalized by the code (NFKC, trimmed,
//   spaces collapsed, upper case) and UNIQUE. Key columns are key191(): binary collation on MySQL/MariaDB.
// - Foreign keys only for ownership (spec §6.1): recovery codes and role assignments belong to their user
//   (CASCADE), permissions to their role (CASCADE). An assigned role cannot be deleted (RESTRICT): revoking the
//   assignments first is what revokes the holders' sessions (spec §7.1).
// - Trails `created_*` / `updated_*` hold the acting staff user's id, without a foreign key; null when the system
//   or the CLI acted. `version` is the optimistic-concurrency counter (spec §6.1).

const NAME = '0002_org_and_identity';

export const orgAndIdentity: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'branches', 'data', NAME, (t) => {
      t.id();
      t.key191('code_key');
      t.varchar('code_display', 191);
      t.varchar('name', 191);
      t.text('address').nullable();
      t.varchar('timezone', 64);
      t.bool('is_default').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'branches', 'uq_branches_code_key', ['code_key'], { unique: true });

    await ensureTable(db, dialect, 'staff_users', 'data', NAME, (t) => {
      t.id();
      t.key191('username_key');
      t.varchar('username_display', 191);
      t.varchar('name', 191);
      t.key191('email_key').nullable();
      t.varchar('email_display', 191).nullable();
      t.varchar('password_hash', 191);
      t.varchar('status', 32);
      t.varchar('locale', 8).nullable();
      t.text('totp_secret_enc').nullable();
      t.bool('totp_enabled').default(0);
      // Never NULL: the replay guard is `UPDATE ... WHERE totp_last_step < ?` (spec §7.1).
      t.bigint('totp_last_step').default(0);
      t.bool('totp_reenroll').default(0);
      t.bool('mfa_required').default(0);
      t.bool('must_change_password').default(0);
      t.int('authz_version').default(1);
      t.timestamp('last_login_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'staff_users', 'uq_staff_users_username_key', ['username_key'], { unique: true });
    // UNIQUE over a nullable column: any number of users without an e-mail address, on every dialect.
    await ensureIndex(db, dialect, 'staff_users', 'uq_staff_users_email_key', ['email_key'], { unique: true });

    await ensureTable(db, dialect, 'staff_recovery_codes', 'data', NAME, (t) => {
      t.id();
      t.ulid('user_id');
      t.char('code_hash', 64);
      t.timestamp('used_at').nullable();
      t.timestamp('created_at');
      t.foreignKey('user_id', 'staff_users', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'staff_recovery_codes', 'ix_staff_recovery_codes_user_id', ['user_id']);

    await ensureTable(db, dialect, 'roles', 'data', NAME, (t) => {
      t.id();
      t.key191('key');
      t.varchar('name', 191);
      t.text('description').nullable();
      t.bool('is_system').default(0);
      t.bool('mfa_required').default(0);
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'roles', 'uq_roles_key', ['key'], { unique: true });

    // Custom roles only: the permissions of the system roles are computed from the catalog (spec §7.2).
    await ensureTable(db, dialect, 'role_permissions', 'data', NAME, (t) => {
      t.ulid('role_id');
      t.key191('permission');
      t.primaryKey(['role_id', 'permission']);
      t.foreignKey('role_id', 'roles', 'id', { onDelete: 'cascade' });
    });

    // scope_key is '' for a global assignment, otherwise the branch_id. No default: a forgotten scope_key must fail
    // rather than make a branch assignment global. key191() (ruling R39): a column of a unique key compares exactly
    // on every dialect (utf8mb4_bin on MySQL/MariaDB); CHAR cannot hold '' portably (PostgreSQL pads it).
    await ensureTable(db, dialect, 'user_roles', 'data', NAME, (t) => {
      t.id();
      t.ulid('user_id');
      t.ulid('role_id');
      t.ulid('branch_id').nullable();
      t.key191('scope_key');
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.foreignKey('user_id', 'staff_users', 'id', { onDelete: 'cascade' });
      t.foreignKey('role_id', 'roles', 'id', { onDelete: 'restrict' });
    });
    await ensureIndex(db, dialect, 'user_roles', 'uq_user_roles_user_id_role_id_scope_key', ['user_id', 'role_id', 'scope_key'], {
      unique: true,
    });
    await ensureIndex(db, dialect, 'user_roles', 'ix_user_roles_role_id', ['role_id']);
  },
};
