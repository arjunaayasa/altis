import { libraryCollectionStatistics, libraryLoanStatistics, libraryMemberStatistics, libraryVisitStatistics } from '@altis/core';
import type { Permission } from '@altis/shared';
import type { CollectionStatistics, LoanStatistics, MemberStatistics, VisitStatistics } from '@altis/shared/api/library-statistics';
import { route, type RouteDecl } from '../http/route.js';

// The library's figures at a glance on the dashboard (the shapes: @altis/shared/api/library-statistics), one read per
// module, each behind that module's read permission, so a staff member sees the figures of the modules they work in:
//
//   GET catalog/statistics       catalog.records.read      → CollectionStatistics
//   GET members/statistics       members.records.read      → MemberStatistics
//   GET visits/statistics        visits.records.read       → VisitStatistics
//   GET circulation/statistics   circulation.records.read  → LoanStatistics
//
// Literal paths: they are mounted before the members routes, whose `members/:id` would take `members/statistics`.

type Reader<T> = (db: Parameters<typeof libraryCollectionStatistics>[0], now: number) => Promise<T>;

/** The route of one module's figures. */
function statistics<T>(id: string, path: string, permission: Permission, read: Reader<T>): RouteDecl {
  return route({
    id,
    method: 'GET',
    path,
    permission,
    idempotency: 'none',
    audit: null,
    handler: async (rc) => {
      const body: T = await read(rc.db.db, rc.now);
      return { body };
    },
  });
}

export const LIBRARY_STATISTICS_ROUTES: RouteDecl[] = [
  statistics<CollectionStatistics>('catalog.statistics', '/api/v1/catalog/statistics', 'catalog.records.read', libraryCollectionStatistics),
  statistics<MemberStatistics>('members.statistics', '/api/v1/members/statistics', 'members.records.read', libraryMemberStatistics),
  statistics<VisitStatistics>('visits.statistics', '/api/v1/visits/statistics', 'visits.records.read', libraryVisitStatistics),
  statistics<LoanStatistics>('circulation.statistics', '/api/v1/circulation/statistics', 'circulation.records.read', libraryLoanStatistics),
];
