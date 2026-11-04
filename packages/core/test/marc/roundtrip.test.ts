import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import { describe, expect, it } from 'vitest';
import { marcToDraft, readIso2709, readMarcXml, recordToMarc, writeIso2709, writeMarcXmlRecord } from '../../src/marc/index.js';
import type { MarcRecord } from '../../src/marc/index.js';
import { NON_REPEATABLE } from '../../src/marc/map-export.js';
import { CORPUS, asData, maskLeader, marc8Iso2709, materialTypeCodeFor } from '../support/marc-corpus.js';

// K5 under B3: the mapping normalises by design (260 → 264, 440/830 → 490, 050 → 090, 300 $b/$c into $a, 952 → 852,
// ISBD punctuation), so the corpus is not compared with its export. Instead, for every corpus record r:
// - d = marcToDraft(r), r2 = recordToMarc(asData(d)), d2 = marcToDraft(r2): normalize(d2) equals normalize(d);
// - fixpoint: recordToMarc(asData(marcToDraft(r2))) equals r2 except 005;
// - no tag MARC allows once appears twice in r2.

const STAFF = { audience: 'staff', orgCode: null, baseUrl: 'https://perpus.example', includeItems: true } as const;

/** The corpus as an import reads it: MARC-8 records through their MARC-8 bytes. */
function corpusRecords(): { name: string; record: MarcRecord }[] {
  return CORPUS.map(({ name, record, marc8 }) => {
    if (!marc8) return { name, record };
    const reader = readIso2709();
    const [r] = [...reader.push(marc8Iso2709(record)), ...reader.end()];
    if (!r?.ok) throw new Error(`${name}: the MARC-8 bytes did not read`);
    return { name, record: r.record };
  });
}

const toDraft = (r: MarcRecord): RecordDraft => marcToDraft(r, { materialTypeCodeFor }).draft;

/**
 * The comparable part of a draft: no `control` identifier, the leader's recomputed positions masked, no 005/008 in
 * marcExtra, items as {barcode, locationCode, callNumber} (an export writes 852, so 952 $y and the like do not survive).
 */
function normalize(d: RecordDraft) {
  return {
    ...d,
    identifiers: d.identifiers.filter((i) => i.type !== 'control'),
    marcExtra: d.marcExtra.filter((f) => f.tag !== '005' && f.tag !== '008').map((f) => (f.tag === 'LDR' ? { ...f, data: maskLeader(f.data) } : f)),
    items: d.items.map((i) => ({ barcode: i.barcode, locationCode: i.locationCode, callNumber: i.callNumber })),
  };
}

const without005 = (r: MarcRecord): MarcRecord => ({ ...r, fields: r.fields.filter((f) => f.tag !== '005') });

describe('K5: the MARC round trip (B3)', () => {
  const records = corpusRecords();

  it('covers the corpus the plan asks for', () => {
    expect(records.length).toBeGreaterThanOrEqual(50);
    const tags = new Set(records.flatMap((r) => r.record.fields.map((f) => f.tag + ('ind2' in f && f.tag === '264' ? f.ind2 : ''))));
    for (const tag of ['260', '2641', '600', '610', '611', '648', '650', '651', '655', '656', '852', '952', '856', '024', '504', '730', '990']) expect(tags, tag).toContain(tag);
    expect(CORPUS.filter((e) => e.marc8).length).toBeGreaterThanOrEqual(5);
    expect(records.some((r) => r.record.fields.some((f) => f.tag === '020' && 'subfields' in f && f.subfields.some(([c]) => c === 'q')))).toBe(true);
  });

  it('normalize(marcToDraft(r2)) equals normalize(marcToDraft(r)) for every corpus record', () => {
    for (const { name, record } of records) {
      const d = toDraft(record);
      const r2 = recordToMarc(asData(d), STAFF);
      const d2 = toDraft(r2);
      expect(normalize(d2), name).toEqual(normalize(d));
    }
  });

  it('is a fixpoint after one export: recordToMarc(asData(marcToDraft(r2))) equals r2 except 005', () => {
    for (const options of [STAFF, { ...STAFF, orgCode: 'ID-ALTIS' }]) {
      for (const { name, record } of records) {
        const r2 = recordToMarc(asData(toDraft(record)), options);
        const r3 = recordToMarc(asData(toDraft(r2), { updatedAt: Date.UTC(2027, 0, 1) }), options);
        expect(without005(r3), name).toEqual(without005(r2));
        expect(r3.fields.find((f) => f.tag === '005'), name).not.toEqual(r2.fields.find((f) => f.tag === '005'));
      }
    }
  });

  it('never writes a non-repeatable tag twice, and writes fields in tag order', () => {
    expect(NON_REPEATABLE.has('245') && NON_REPEATABLE.has('008') && NON_REPEATABLE.has('100') && NON_REPEATABLE.has('040')).toBe(true);
    for (const audience of ['staff', 'public'] as const) {
      for (const { name, record } of records) {
        const r2 = recordToMarc(asData(toDraft(record)), { ...STAFF, audience, orgCode: 'ID-ALTIS' });
        const tags = r2.fields.map((f) => f.tag);
        for (const tag of NON_REPEATABLE) expect(tags.filter((t) => t === tag).length, `${name} ${tag}`).toBeLessThanOrEqual(1);
        expect(tags, name).toEqual([...tags].sort());
        expect(tags.slice(0, 2), name).toEqual(['001', '003']);
      }
    }
  });

  it('keeps every exported record readable: ISO 2709 and MARCXML read back to the same record', () => {
    for (const { name, record } of records) {
      const r2 = recordToMarc(asData(toDraft(record)), STAFF);
      const iso = readIso2709();
      expect([...iso.push(writeIso2709(r2)), ...iso.end()], name).toMatchObject([{ ok: true, record: r2, warnings: [] }]);
      const xml = readMarcXml();
      expect([...xml.push(Buffer.from(writeMarcXmlRecord(r2), 'utf8')), ...xml.end()], name).toMatchObject([{ ok: true, record: r2, warnings: [] }]);
    }
  });
});
