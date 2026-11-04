// The catalog's `items` barrel (Phase 2, plan Task 17): the names of the task's Interfaces only (M14); the helpers the
// modules share (checks, lock rows, events, the lifecycle) stay inside the folder.
export { createItem, updateItem, archiveItem } from './service.js';
export type { ItemSaveOptions } from './service.js';
export { batchCreateItems } from './batch.js';
export { bulkUpdateItems } from './bulk.js';
export { ensureBarcodeLockRow, nextBarcodes } from './patterns.js';
export { suggestShelf } from './suggest.js';
export { getItem, itemByBarcode, listItems } from './list.js';
export { itemHistory } from './events.js';
