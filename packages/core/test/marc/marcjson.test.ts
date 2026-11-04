import { describe, expect, it } from 'vitest';
import { marcJsonRecord, marcToDraft, recordToMarc, writeMarcJsonLine } from '../../src/marc/index.js';
import type { MarcRecord } from '../../src/marc/index.js';
import { CORPUS, asData, cf, df, materialTypeCodeFor } from '../support/marc-corpus.js';

// Spec §5.1 and M9: MARC-in-JSON, one record per line (JSON Lines) for the `marcjson` export, and one object for the
// `format=json` answer of GET catalog/records/:id/marc.

const EXPORT = { audience: 'staff', orgCode: null, baseUrl: 'https://perpus.example', includeItems: true } as const;

describe('marcJsonRecord and writeMarcJsonLine', () => {
  it('writes control fields as {tag: value} and data fields as {tag: {ind1, ind2, subfields}} in record order', () => {
    const rec: MarcRecord = {
      leader: '00000nam  2200000 a 4500',
      fields: [cf('001', 'X1'), df('245', '10', 'aJudul :', 'bsub.'), df('650', ' 7', 'aTopik.', '2local')],
    };
    expect(marcJsonRecord(rec)).toEqual({
      leader: '00000nam a2200000 a 4500',
      fields: [
        { '001': 'X1' },
        { '245': { ind1: '1', ind2: '0', subfields: [{ a: 'Judul :' }, { b: 'sub.' }] } },
        { '650': { ind1: ' ', ind2: '7', subfields: [{ a: 'Topik.' }, { 2: 'local' }] } },
      ],
    });
  });

  it('writes one line per record that JSON.parse reads, the first field being {"001": id}', () => {
    const lines = CORPUS.map(({ record }, i) => {
      const { draft } = marcToDraft(record, { materialTypeCodeFor });
      return writeMarcJsonLine(recordToMarc(asData(draft, { id: `01JTESTRECORD${String(i).padStart(13, '0')}` }), EXPORT));
    });
    const file = lines.join('');
    expect(file.split('\n')).toHaveLength(CORPUS.length + 1);
    lines.forEach((line, i) => {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.indexOf('\n')).toBe(line.length - 1);
      const parsed = JSON.parse(line) as { leader: string; fields: Record<string, unknown>[] };
      expect(parsed.fields[0]).toEqual({ '001': `01JTESTRECORD${String(i).padStart(13, '0')}` });
      expect(parsed.leader).toHaveLength(24);
    });
  });

  it('keeps line separators and control characters inside the JSON string', () => {
    const line = writeMarcJsonLine({ leader: '00000nam a2200000 i 4500', fields: [df('500', '  ', 'abaris\nkedua\u{2028}\u{1}')] });
    expect(line.split('\n')).toHaveLength(2);
    expect((JSON.parse(line) as { fields: unknown[] }).fields[0]).toEqual({ '500': { ind1: ' ', ind2: ' ', subfields: [{ a: 'baris\nkedua\u{2028}\u{1}' }] } });
  });
});
