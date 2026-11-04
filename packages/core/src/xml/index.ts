// The bounded streaming XML reader and the XML writer (Phase 2 Task 5; spec §5.1, §10, S9). Only the names of the
// task's interface are exported (M14).

export { XmlError, createXmlReader } from './reader.js';
export type { XmlEvent } from './reader.js';
export { XmlWriter, stripInvalidXmlChars, xmlAttr, xmlEscape } from './writer.js';
