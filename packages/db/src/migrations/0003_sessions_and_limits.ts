import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0003: sessions, remember-me tokens, password resets and rate limits (spec §6.5, §7.1). Class volatile: emptied
// by a restore. Tokens are stored as SHA-256 hex only (CHAR(64)); subjects are `subject_type` + `subject_id`
// (staff now, members from Phase 3), without foreign keys.

const NAME = '0003_sessions_and_limits';

export const sessionsAndLimits: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'sessions', 'volatile', NAME, (t) => {
      t.char('id', 64);
      t.varchar('subject_type', 32);
      t.ulid('subject_id');
      t.timestamp('created_at');
      t.timestamp('last_seen_at');
      t.timestamp('expires_at');
      t.varchar('ip', 45).nullable();
      t.varchar('user_agent', 191).nullable();
      t.bool('mfa_passed').default(0);
      t.timestamp('reauth_at').nullable();
      t.char('remember_selector', 24).nullable();
      t.int('authz_version').default(1);
      t.primaryKey(['id']);
    });
    await ensureIndex(db, dialect, 'sessions', 'ix_sessions_subject_type_subject_id', ['subject_type', 'subject_id']);
    await ensureIndex(db, dialect, 'sessions', 'ix_sessions_expires_at', ['expires_at']);
    // Revoking a remember-me token revokes the sessions it created (spec §7.1).
    await ensureIndex(db, dialect, 'sessions', 'ix_sessions_remember_selector', ['remember_selector']);

    await ensureTable(db, dialect, 'remember_tokens', 'volatile', NAME, (t) => {
      t.char('selector', 24);
      t.char('validator_hash', 64);
      t.char('prev_validator_hash', 64).nullable();
      t.timestamp('rotated_at').nullable();
      t.varchar('subject_type', 32);
      t.ulid('subject_id');
      t.timestamp('expires_at');
      t.bool('mfa_bound').default(0);
      t.timestamp('last_used_at').nullable();
      t.primaryKey(['selector']);
    });
    await ensureIndex(db, dialect, 'remember_tokens', 'ix_remember_tokens_subject_type_subject_id', [
      'subject_type',
      'subject_id',
    ]);

    await ensureTable(db, dialect, 'password_resets', 'volatile', NAME, (t) => {
      t.char('token_hash', 64);
      t.varchar('subject_type', 32);
      t.ulid('subject_id');
      t.timestamp('expires_at');
      t.timestamp('used_at').nullable();
      t.primaryKey(['token_hash']);
    });
    await ensureIndex(db, dialect, 'password_resets', 'ix_password_resets_subject_type_subject_id', [
      'subject_type',
      'subject_id',
    ]);

    // One row per bucket and window; `bucket` is the SHA-256 hex of `bucket_name` (spec §6.1). bucket_name is TEXT
    // (ruling R43): never indexed, and names built from a username_key and an IP can exceed 191 characters.
    await ensureTable(db, dialect, 'rate_limits', 'volatile', NAME, (t) => {
      t.char('bucket', 64);
      t.timestamp('window_start');
      t.text('bucket_name');
      t.int('count').default(0);
      t.primaryKey(['bucket', 'window_start']);
    });
    await ensureIndex(db, dialect, 'rate_limits', 'ix_rate_limits_window_start', ['window_start']);
  },
};
