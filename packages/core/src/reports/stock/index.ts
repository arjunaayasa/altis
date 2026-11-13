// The collection stock at a date and the acquisition date of a copy: what the collection reports and the accreditation
// collection metrics count from. Core-internal (not part of the package barrel).
export { acqDateOf } from './acq-date.js';
export type { AcqBasis, AcqInput } from './acq-date.js';
export { firstAcq, inStockAt, liveAt, lostAt, statusAt } from './stock.js';
export type { ItemStockFacts, RecordStockFacts } from './stock.js';
export { STOCK_SCAN_MAX_LIMIT, scanRecordStock } from './scan.js';
