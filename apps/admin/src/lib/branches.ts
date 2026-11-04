import type { BranchView } from '@altis/shared/api/branches';

/**
 * Whether staff may write to `branch`: it is live (not archived) and the server does not mark it inactive. `GET
 * branches` answers `active` for each branch; the community edition marks every live branch active, so this is
 * `archivedAt === null` there. The screens that pick a branch to write to (items, locations, imports, the SLiMS
 * migration) offer only writable ones and show an inactive branch's data read-only.
 */
export const isWritableBranch = (branch: BranchView): boolean => branch.archivedAt === null && branch.active !== false;
