import type { shellRoute } from '@/routes';
import { accreditationRoutes } from './accreditation';
import { circulationRoutes } from './circulation';
import { membersRoutes } from './members';
import { reportsRoutes } from './reports';
import { accreditationSettingsRoutes } from './settings';

// The admin routes of reports and accreditation, members and circulation: one file per area, joined here and spread once into the shell's
// children (routes.tsx), so that no later task edits routes.tsx. Every path is a child of the shell
// (`/admin/reports…`, `/admin/accreditation…`, `/admin/settings/accreditation`).
//
// The area files import `lazyScreen` from routes.tsx, which imports this file: a cycle that is safe because they call
// it only inside these functions, which routes.tsx runs after its own declarations (`lazyScreen` is a function
// declaration, hoisted).

/** Every route of reports and accreditation, members and circulation, children of `shell`. */
export function komunitasRoutes(shell: typeof shellRoute) {
  return [
    ...reportsRoutes(shell),
    ...accreditationRoutes(shell),
    ...accreditationSettingsRoutes(shell),
    ...circulationRoutes(shell),
    ...membersRoutes(shell),
  ];
}
