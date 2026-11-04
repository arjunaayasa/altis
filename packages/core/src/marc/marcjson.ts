// MARC-in-JSON (Phase 2 spec §5.1, M9): the `marcjson` export (JSON Lines, one record per line) and the `format=json`
// answer of GET catalog/records/:id/marc (one object). Leader/09 is `a` (the text is Unicode). Pure; no I/O.

import type { MarcJsonDataField, MarcJsonRecord } from '@altis/shared/api/catalog/exchange';
import { isControlField, marcIndicator, unicodeLeader, type MarcRecord } from './record.js';

/** `rec` as one MARC-in-JSON object: `{<tag>: value}` for a control field, `{<tag>: {ind1, ind2, subfields}}` else. */
export function marcJsonRecord(rec: MarcRecord): MarcJsonRecord {
  return {
    leader: unicodeLeader(rec.leader),
    fields: rec.fields.map((f) => {
      if (isControlField(f)) return { [f.tag]: f.value };
      const field: MarcJsonDataField = {
        ind1: marcIndicator(f.ind1),
        ind2: marcIndicator(f.ind2),
        subfields: f.subfields.map(([code, value]) => ({ [code]: value })),
      };
      return { [f.tag]: field };
    }),
  };
}

/** One JSON Lines line: `JSON.stringify` escapes line breaks and control characters, so the only `\n` ends it. */
export function writeMarcJsonLine(rec: MarcRecord): string {
  return `${JSON.stringify(marcJsonRecord(rec))}\n`;
}
