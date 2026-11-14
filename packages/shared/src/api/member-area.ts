/**
 * The admin side of the OPAC member area (community edition): staff setting a member's OPAC password.
 *
 * `PUT members/:id/password` (`members.records.manage`, re-authenticated) → `StoreResponse`: `password` sets a new
 * password (checked against the member password policy: `members.password.minLength`, at most 256 characters, not a
 * common password → 422 PASSWORD_TOO_WEAK `{reason}`), null removes it (the member cannot sign in until one is set
 * again); `mustReset` asks the member for a new one at the next sign-in. Every session of the member ends. Audited
 * `members.member.password_set {cleared, mustReset}`, never the password.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/member-area`.
 */
import { z } from 'zod';

export const MemberPasswordBody = z.strictObject({
  password: z.string().min(1).max(1024).nullable(),
  mustReset: z.boolean(),
});

export type MemberPasswordBody = z.infer<typeof MemberPasswordBody>;
