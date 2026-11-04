// The `oai_dc` metadata of a record (spec §10): one `<oai_dc:dc>` element with its namespaces and the DC elements of
// dublin-core.ts in §10's order, written with Task 5's XmlWriter (text escaped, characters XML 1.0 forbids dropped).
// OAI-PMH (Task 35) appends it to a `<metadata>` element with `XmlWriter.raw()`. Pure.

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { XmlWriter } from '../../xml/writer.js';
import { DC_ELEMENTS, dcValues } from './dublin-core.js';
import type { RecordRenderOptions } from './names.js';

const OAI_DC_NS = 'http://www.openarchives.org/OAI/2.0/oai_dc/';
const OAI_DC_XSD = 'http://www.openarchives.org/OAI/2.0/oai_dc.xsd';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/** The `<oai_dc:dc>` element of `d` (no XML declaration). */
export function toOaiDc(d: RecordData, o: RecordRenderOptions): string {
  const values = dcValues(d, o);
  const w = new XmlWriter().open('oai_dc:dc', {
    'xmlns:oai_dc': OAI_DC_NS,
    'xmlns:dc': DC_NS,
    'xmlns:xsi': XSI_NS,
    'xsi:schemaLocation': `${OAI_DC_NS} ${OAI_DC_XSD}`,
  });
  for (const e of DC_ELEMENTS) for (const value of values[e]) w.leaf(`dc:${e}`, value);
  return w.close().toString();
}
