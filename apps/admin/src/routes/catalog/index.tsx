import type { shellRoute } from '@/routes';
import { authoritiesRoutes } from './authorities';
import { duplicatesRoutes } from './duplicates';
import { exchangeRoutes } from './exchange';
import { itemsRoutes } from './items';
import { labelsRoutes } from './labels';
import { locationsRoutes } from './locations';
import { mastersRoutes } from './masters';
import { migrationRoutes } from './migration';
import { pagesRoutes } from './pages';
import { recordsRoutes } from './records';
import { catalogSettingsRoutes } from './settings';

// The admin routes of the catalogue (Phase 2 Task 3, plan decision P2-02): one file per area, each owned by the task
// that builds its screens, joined here and spread once into the shell's children (routes.tsx), so that no later task
// edits routes.tsx. Every path is a child of the shell (`/admin/catalog/…`, `/admin/opac/pages…`,
// `/admin/settings/catalog`); a static segment (`new`) outranks a parameter (`$recordId`) as everywhere else.
//
// The area files import `lazyScreen` from routes.tsx, which imports this file: a cycle that is safe because they call
// it only inside these functions, which routes.tsx runs after its own declarations (`lazyScreen` is a function
// declaration, hoisted).

/** Every catalogue route, children of `shell`. */
export function catalogRoutes(shell: typeof shellRoute) {
  return [
    ...recordsRoutes(shell),
    ...itemsRoutes(shell),
    ...authoritiesRoutes(shell),
    ...locationsRoutes(shell),
    ...mastersRoutes(shell),
    ...exchangeRoutes(shell),
    ...labelsRoutes(shell),
    ...duplicatesRoutes(shell),
    ...migrationRoutes(shell),
    ...pagesRoutes(shell),
    ...catalogSettingsRoutes(shell),
  ];
}
