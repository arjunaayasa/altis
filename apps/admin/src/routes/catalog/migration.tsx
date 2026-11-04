import { isUlid } from '@altis/shared';
import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Migrasi SLiMS (Phase 2): `/admin/catalog/migration`. Created by Task 3 with the final paths, each
// on its screen's lazy chunk; Task 30 added `validateSearch` and edits no shared file (routes.tsx spreads catalogRoutes
// once). `?run=<id>` names the migration run the screen shows, so a reload keeps following a run that is still going
// (where no worker runs, the open page is what drives it) and a report keeps its address.

/** The search of `/admin/catalog/migration`. */
export interface MigrationSearch {
  run?: string;
}

/** The route's `validateSearch`: `run` when it is a ULID; anything else in the query is dropped. */
export function validateMigrationSearch(search: Record<string, unknown>): MigrationSearch {
  const { run } = search;
  return typeof run === 'string' && isUlid(run) ? { run } : {};
}

/** The routes of Migrasi SLiMS, children of the shell. */
export function migrationRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/migration',
      validateSearch: validateMigrationSearch,
      component: lazyScreen(() => import('@/screens/catalog/migration/index'), 'SlimsMigrationScreen'),
    }),
  ];
}
