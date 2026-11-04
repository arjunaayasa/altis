import type { Grants, SessionView, StaffAuthView } from '@altis/core';
import type { SessionStage } from '@altis/shared/api/auth';

/**
 * What step 7 of the middleware chain (session resolution, spec §4.7, http/auth.ts) knows about the request's
 * subject: the session, the staff user, the user's grants at its current `authz_version`, and how far the session got.
 */
export interface AuthState {
  /** The staff user's ULID (`user.id`). */
  subjectId: string;
  /**
   * The session the request runs in: the new one when step 7 rotated the request's token, otherwise the one the
   * cookie named, as it was read (before step 7's touch of `last_seen_at`).
   */
  session: SessionView;
  /** The staff user, `active`. */
  user: StaffAuthView;
  /** The grants at `user.authzVersion`, shared through the per-process cache: never mutate them. */
  grants: Grants;
  stage: SessionStage;
}
