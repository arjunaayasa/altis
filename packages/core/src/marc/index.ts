// The `marc` barrel (Phase 2 Task 6): the MARC 21 codec (ISO 2709 with MARC-8 Latin, MARCXML, MARC-in-JSON) and the
// mapping between MARC and the catalog's records. Only the names of the task's interface are exported (M14); helpers
// (NON_REPEATABLE, the leader and indicator helpers, the MARC-8 decoder object) stay in their modules.

export { MarcTooLongError } from './record.js';
export type { MarcControlField, MarcDataField, MarcReadResult, MarcRecord } from './record.js';
export { readIso2709, writeIso2709 } from './iso2709.js';
export { decodeMarc8 } from './marc8.js';
export { MARCXML_COLLECTION_CLOSE, MARCXML_COLLECTION_OPEN, readMarcXml, writeMarcXmlRecord } from './marcxml.js';
export { marcJsonRecord, writeMarcJsonLine } from './marcjson.js';
export { marcToDraft } from './map-import.js';
export { recordToMarc } from './map-export.js';
