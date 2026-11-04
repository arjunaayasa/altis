// The catalog's `locations` barrel (Phase 2): created empty by Task 3, filled by Task 14 (rooms, areas and shelves of a
// branch, their class ranges and the shelf map). It exports only the names of Task 14's interface, generic ones with a
// prefix (M14; packages/core/test/barrels.test.ts); the row helpers stay internal.
export { archiveLocation, createLocation, listLocations, setLocationMap, updateLocation } from './service.js';
export type { LocationSaveResult } from './service.js';
export { enqueueLocationReindex } from './reindex.js';
