import { describe, expect, it } from 'vitest';
import { MARCXML_COLLECTION_CLOSE, MARCXML_COLLECTION_OPEN, readMarcXml, writeMarcXmlRecord } from '../../src/marc/index.js';
import type { MarcReadResult, MarcRecord } from '../../src/marc/index.js';
import { XmlError, createXmlReader, xmlAttr, xmlEscape } from '../../src/xml/index.js';
import { CORPUS, cf, df } from '../support/marc-corpus.js';

// Spec §5.1, plan Task 6 and S21: MARCXML (http://www.loc.gov/MARC21/slim, with or without a prefix) through our own
// streaming XML reader. The reader takes bytes and reports each record's absolute byte offsets, so an import can
// checkpoint the end of its last committed record and resume from there with the namespace prefixes in scope.

const NS = 'http://www.loc.gov/MARC21/slim';

type Result = MarcReadResult & { startByte: number; endByte: number };
type Options = Parameters<typeof readMarcXml>[0];

function readAll(bytes: Uint8Array, size = bytes.length || 1, o?: Options): Result[] {
  const reader = readMarcXml(o);
  const out: Result[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(...reader.push(bytes.subarray(i, i + size)));
  out.push(...reader.end());
  return out;
}

const utf8 = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'));

/** The corpus records with leader/09 `a` (a MARCXML record is Unicode) and a distinct 001 each, cycled to `n`. */
function records(n: number): MarcRecord[] {
  const out: MarcRecord[] = [];
  for (let i = 0; i < n; i++) {
    const { record } = CORPUS[i % CORPUS.length]!;
    const fields = record.fields.filter((f) => f.tag !== '001');
    out.push({ leader: `${record.leader.slice(0, 9)}a${record.leader.slice(10)}`, fields: [cf('001', `R${String(i).padStart(5, '0')}`), ...fields] });
  }
  return out;
}

/** The same record with every element written `marc:`-prefixed, the prefix declared on the root only. */
function prefixedRecord(rec: MarcRecord): string {
  let s = `<marc:record>\n  <marc:leader>${xmlEscape(rec.leader)}</marc:leader>\n`;
  for (const f of rec.fields) {
    if ('value' in f) s += `  <marc:controlfield tag="${f.tag}">${xmlEscape(f.value)}</marc:controlfield>\n`;
    else {
      s += `  <marc:datafield tag="${f.tag}" ind1="${xmlAttr(f.ind1)}" ind2="${xmlAttr(f.ind2)}">\n`;
      for (const [code, value] of f.subfields) s += `    <marc:subfield code="${xmlAttr(code)}">${xmlEscape(value)}</marc:subfield>\n`;
      s += '  </marc:datafield>\n';
    }
  }
  return `${s}</marc:record>`;
}

function okRecord(r: Result | undefined): MarcRecord {
  if (!r?.ok) throw new Error(`expected an ok result, got ${JSON.stringify(r)}`);
  return r.record;
}

describe('writeMarcXmlRecord and readMarcXml', () => {
  it('reads a 1 000-record collection fed in 7-byte chunks exactly as in one chunk; offsets slice each record', () => {
    const recs = records(1000);
    const xmls = recs.map((r) => writeMarcXmlRecord(r));
    const doc = `${MARCXML_COLLECTION_OPEN}${xmls.join('\n')}\n${MARCXML_COLLECTION_CLOSE}`;
    const bytes = utf8(doc);
    const whole = readAll(bytes);
    expect(whole).toHaveLength(1000);
    expect(readAll(bytes, 7)).toEqual(whole);
    whole.forEach((r, i) => {
      expect(r).toMatchObject({ ok: true, index: i, warnings: [] });
      expect(okRecord(r)).toEqual(recs[i]);
      expect(Buffer.from(bytes.subarray(r.startByte, r.endByte)).toString('utf8')).toBe(xmls[i]);
    });
  });

  it('refuses a DOCTYPE with XmlError(doctype)', () => {
    const doc = utf8(`<?xml version="1.0"?>\n<!DOCTYPE collection [<!ENTITY x "y">]>\n<collection xmlns="${NS}"/>`);
    for (const size of [doc.length, 5]) {
      let error: unknown = null;
      try {
        readAll(doc, size);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(XmlError);
      expect((error as XmlError).reason).toBe('doctype');
    }
  });

  it('escapes what XML needs, drops what XML 1.0 forbids, writes leader/09 a, and reads it back', () => {
    const rec: MarcRecord = {
      leader: '00000nam  2200000 a 4500',
      fields: [cf('001', 'A&B<1>'), df('245', '1"', 'aTom & Jerry <"kartun"> \u{1}x', "b'kutip'\r\nbaris")],
    };
    const xml = writeMarcXmlRecord(rec);
    expect(xml).toContain(`<record xmlns="${NS}">`);
    expect(xml).toContain('<leader>00000nam a2200000 a 4500</leader>');
    expect(xml).not.toContain('\u{1}');
    const back = okRecord(readAll(utf8(xml))[0]);
    expect(back).toEqual({
      leader: '00000nam a2200000 a 4500',
      fields: [cf('001', 'A&B<1>'), df('245', '1"', 'aTom & Jerry <"kartun"> x', "b'kutip'\r\nbaris")],
    });
  });

  it('opens and closes a collection', () => {
    expect(MARCXML_COLLECTION_OPEN.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(MARCXML_COLLECTION_OPEN).toContain(`<collection xmlns="${NS}">`);
    expect(MARCXML_COLLECTION_CLOSE.trim()).toBe('</collection>');
    const results = readAll(utf8(MARCXML_COLLECTION_OPEN + MARCXML_COLLECTION_CLOSE));
    expect(results).toEqual([]);
  });
});

describe('readMarcXml: namespaces and layouts', () => {
  const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [cf('001', 'X1'), df('245', '00', 'aJudul.')] };

  it('reads a record as the root element, and a prefix other than marc:', () => {
    expect(okRecord(readAll(utf8(writeMarcXmlRecord(rec)))[0])).toEqual(rec);
    const other = prefixedRecord(rec).replaceAll('marc:', 'm21:').replace('<m21:record>', `<m21:record xmlns:m21="${NS}">`);
    expect(okRecord(readAll(utf8(other))[0])).toEqual(rec);
  });

  it('finds MARC records inside another vocabulary (an SRU answer) and ignores elements of other namespaces', () => {
    const doc = [
      '<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">',
      '<zs:numberOfRecords>2</zs:numberOfRecords><zs:records>',
      `<zs:record><zs:recordSchema>marcxml</zs:recordSchema><zs:recordData>${writeMarcXmlRecord(rec)}</zs:recordData></zs:record>`,
      '<zs:record><zs:recordData><record><leader>not marc</leader></record></zs:recordData></zs:record>',
      `<zs:record><zs:recordData><r:record xmlns:r="${NS}"><r:leader>${rec.leader}</r:leader><x:note xmlns:x="urn:x"><r:controlfield tag="001">Z</r:controlfield></x:note>`,
      '<r:controlfield tag="001">X2</r:controlfield></r:record></zs:recordData></zs:record>',
      '</zs:records></zs:searchRetrieveResponse>',
    ].join('');
    const results = readAll(Uint8Array.from(Buffer.from(doc, 'utf8')));
    expect(results.map((r) => okRecord(r).fields)).toEqual([rec.fields, [cf('001', 'X2')]]);
  });

  it('refuses a flood of namespace declarations (bounded scope)', () => {
    const many = Array.from({ length: 65 }, (_, i) => ` xmlns:p${i}="urn:x${i}"`).join('');
    let error: unknown = null;
    try {
      readAll(utf8(`<collection xmlns="${NS}"${many}/>`));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(XmlError);
    expect((error as XmlError).reason).toBe('limit');
  });

  it('counts a leading BOM in the byte offsets', () => {
    const body = `${MARCXML_COLLECTION_OPEN}${writeMarcXmlRecord(rec)}${MARCXML_COLLECTION_CLOSE}`;
    const bytes = utf8(`\u{FEFF}${body}`);
    const [r] = readAll(bytes, 3);
    expect(r!.startByte).toBe(3 + Buffer.byteLength(MARCXML_COLLECTION_OPEN));
    expect(Buffer.from(bytes.subarray(r!.startByte, r!.endByte)).toString('utf8')).toBe(writeMarcXmlRecord(rec));
  });
});

describe('readMarcXml: bad records are skipped, not fatal', () => {
  const wrap = (...recs: string[]) => utf8(`<collection xmlns="${NS}">${recs.join('')}</collection>`);
  const good = '<record><leader>00000nam a2200000 i 4500</leader><controlfield tag="001">OK</controlfield></record>';

  it('skips a record with bytes that are not UTF-8 (encoding)', () => {
    const bad = Buffer.from('<record><leader>00000nam a2200000 i 4500</leader><controlfield tag="001">Caf_</controlfield></record>', 'latin1');
    bad[bad.indexOf('_')] = 0xe9;
    const doc = Uint8Array.from(Buffer.concat([Buffer.from(`<collection xmlns="${NS}">`), bad, Buffer.from(good), Buffer.from('</collection>')]));
    for (const size of [doc.length, 1, 7]) expect(readAll(doc, size).map((r) => (r.ok ? r.record.fields : r.error))).toEqual(['encoding', [cf('001', 'OK')]]);
  });

  it('skips a record with a bad tag, indicator or subfield code (directory)', () => {
    const results = readAll(
      wrap(
        '<record><controlfield tag="1">x</controlfield></record>',
        '<record><controlfield tag="245">x</controlfield></record>',
        '<record><datafield tag="001" ind1=" " ind2=" "/></record>',
        '<record><datafield tag="245" ind1="10" ind2=" "><subfield code="a">x</subfield></datafield></record>',
        '<record><datafield tag="245" ind1="1" ind2="0"><subfield code="ab">x</subfield></datafield></record>',
        '<record><datafield tag="245" ind1="1" ind2="0"><subfield>x</subfield></datafield></record>',
        '<record/>',
        good,
      ),
    );
    expect(results.map((r) => (r.ok ? 'ok' : r.error))).toEqual(['directory', 'directory', 'directory', 'directory', 'directory', 'directory', 'directory', 'ok']);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('repairs a leader that is not 24 characters (leader_length) and missing indicators', () => {
    const results = readAll(
      wrap(
        '<record><leader>00000nam a22</leader><datafield tag="245"><subfield code="a">x</subfield></datafield></record>',
        '<record><datafield tag="245" ind1="" ind2="1"><subfield code="a">y</subfield></datafield></record>',
      ),
    );
    expect(results.map((r) => (r.ok ? [r.record.leader, r.record.fields, r.warnings] : r.error))).toEqual([
      ['00000nam a22            ', [df('245', '  ', 'ax')], ['leader_length']],
      [' '.repeat(24), [df('245', ' 1', 'ay')], ['leader_length']],
    ]);
  });

  it('skips a record past 100 000 subfields (truncated): empty subfields add no text, but each is kept (S9)', () => {
    const flood = '<subfield code="a"/>'.repeat(150_000);
    const doc = wrap(`<record><leader>00000nam a2200000 i 4500</leader><datafield tag="500" ind1=" " ind2=" ">${flood}</datafield></record>`, good);
    const results = readAll(doc, 65_536);
    expect(results.map((r) => (r.ok ? r.record.fields : r.error))).toEqual(['truncated', [cf('001', 'OK')]]);
    const many = `<datafield tag="500" ind1=" " ind2=" ">${'<subfield code="a">x</subfield>'.repeat(1000)}</datafield>`.repeat(100);
    expect(readAll(wrap(`<record>${many}</record>`)).map((r) => (r.ok ? r.record.fields.length : r.error))).toEqual([100]);
  });

  it('skips a record holding a text above 1 MiB (truncated) and reads on, as long as one text stays within 4 MiB', () => {
    const big = (chars: number, ch = 'x') => `<record><datafield tag="520" ind1=" " ind2=" "><subfield code="a">${ch.repeat(chars)}</subfield></datafield></record>`;
    const results = readAll(wrap(big(1_200_000), big(1_100_000, '\u00e9'), good), 65_536);
    expect(results.map((r) => (r.ok ? r.record.fields : r.error))).toEqual(['truncated', 'truncated', [cf('001', 'OK')]]);
    // One text of more than 4 MiB is beyond what the XML reader buffers (S9): the document is refused.
    expect(() => readAll(wrap(big(4 * 1024 * 1024 + 1), good), 65_536)).toThrow(XmlError);
  });

  it('repairs a leader holding a long run of blanks in linear time (a regex `[…]+$` retries the run from each start)', () => {
    const blanks = ' \n\t\r'.repeat(120_000); // two runs: 960 000 characters, under the 1 MiB of a record
    const doc = wrap(`<record><leader>${blanks}00000nam a${blanks}b</leader><controlfield tag="001">x</controlfield></record>`, good);
    const started = performance.now();
    const results = readAll(doc, 65_536);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(results.map((r) => (r.ok ? [r.record.leader, r.warnings] : r.error))).toEqual([
      ['00000nam a' + ' '.repeat(14), ['leader_length']],
      ['00000nam a2200000 i 4500', []],
    ]);
  });
});

describe('readMarcXml: resuming from a checkpoint (S21)', () => {
  /** A `marc:`-prefixed collection whose titles hold 2-, 3- and 4-byte characters. */
  function prefixedCollection(n: number): { bytes: Uint8Array; recs: MarcRecord[] } {
    const recs = records(n).map((r, i) => ({ ...r, fields: [...r.fields, df('246', '3 ', `aJudul ${i} — édition 日本 😀`)] }));
    const doc = [
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      `<marc:collection xmlns:marc="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`,
      ...recs.map((r) => `${prefixedRecord(r)}\n`),
      '</marc:collection>\n',
    ].join('');
    return { bytes: utf8(doc), recs };
  }

  it('resumed from record 400 endByte with prefixes(), reads records 401…n exactly as an uninterrupted parse', () => {
    const { bytes, recs } = prefixedCollection(1000);
    const uninterrupted = readAll(bytes, 4096);
    expect(uninterrupted.map((r) => okRecord(r))).toEqual(recs);

    // The first slice reads until it has 400 records, then stops.
    const first = readMarcXml();
    const seen: Result[] = [];
    for (let i = 0; seen.length < 400; i += 4096) seen.push(...first.push(bytes.subarray(i, i + 4096)));
    const checkpoint = { byteOffset: seen[399]!.endByte, prefixes: first.prefixes() };
    expect(JSON.parse(JSON.stringify(checkpoint.prefixes))).toEqual(checkpoint.prefixes);
    expect(checkpoint.prefixes.marc).toBe(NS);
    expect(Buffer.byteLength(JSON.stringify(checkpoint.prefixes))).toBeLessThan(1000);
    // The cut lies after multibyte titles, so a character count would be off.
    expect(Buffer.from(bytes.subarray(0, checkpoint.byteOffset)).toString('utf8').length).toBeLessThan(checkpoint.byteOffset);

    for (const size of [7, 4096]) {
      const resumed = readAll(bytes.subarray(checkpoint.byteOffset), size, { resume: { prefixes: checkpoint.prefixes }, baseOffset: checkpoint.byteOffset });
      const strip = (r: Result) => ({ ...r, index: 0 });
      expect(resumed.map(strip)).toEqual(uninterrupted.slice(400).map(strip));
      expect(resumed[0]!.index).toBe(0);
      expect(okRecord(resumed[0])).toEqual(recs[400]);
    }
  });

  it('keeps prefixes() bounded and refuses a resume map that prefixes() did not produce', () => {
    const reader = readMarcXml();
    expect(reader.prefixes()).toEqual(readMarcXml().prefixes());
    expect(() => readMarcXml({ resume: { prefixes: { marc: NS } }, baseOffset: 10 })).toThrow(RangeError);
    expect(() => readMarcXml({ resume: { prefixes: { ...readMarcXml().prefixes(), 'bad prefix': NS } } })).toThrow(RangeError);
  });

  it('resumes after a record that is the root element: the rest is read as after the root, no record and no error', () => {
    const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [cf('001', 'ROOT'), df('245', '00', 'aJudul.')] };
    const head = `<?xml version="1.0" encoding="UTF-8"?>\n${writeMarcXmlRecord(rec)}`;
    for (const [tail, outcome] of [
      ['\n<!-- akhir -->\n', 'ok'],
      ['', 'ok'],
      [`\n${writeMarcXmlRecord(rec)}\n`, 'syntax'],
      ['\nteks\n', 'syntax'],
    ] as const) {
      const bytes = utf8(head + tail);
      // Uninterrupted: the outcome the resumed parse must match.
      let whole: unknown = 'ok';
      try {
        readAll(bytes);
      } catch (e) {
        whole = (e as XmlError).reason;
      }
      expect(whole, JSON.stringify(tail)).toBe(outcome);
      const first = readMarcXml();
      const [r] = first.push(bytes.subarray(0, Buffer.byteLength(head)));
      expect(okRecord(r)).toEqual(rec);
      let resumed: unknown = 'ok';
      try {
        expect(readAll(bytes.subarray(r!.endByte), 3, { resume: { prefixes: first.prefixes() }, baseOffset: r!.endByte })).toEqual([]);
      } catch (e) {
        resumed = e instanceof XmlError ? e.reason : e;
      }
      expect(resumed, JSON.stringify(tail)).toBe(outcome);
    }
  });

  it('keeps its own copy of an incomplete character: a Buffer the caller reuses after push() does not change the text', () => {
    const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [df('245', '00', 'aKisah 日本.')] };
    const bytes = Buffer.from(writeMarcXmlRecord(rec), 'utf8');
    const cut = bytes.indexOf(Buffer.from('日', 'utf8')) + 1; // inside the three bytes of 日
    const reader = readMarcXml();
    const buffer = Buffer.alloc(bytes.length);
    bytes.copy(buffer, 0, 0, cut);
    expect(reader.push(buffer.subarray(0, cut))).toEqual([]);
    buffer.fill(0x20);
    bytes.copy(buffer, 0, cut);
    const results = [...reader.push(buffer.subarray(0, bytes.length - cut)), ...reader.end()];
    expect(results.map((r) => okRecord(r))).toEqual([rec]);
  });

  it('feeds a string source as UTF-8 bytes (an SRU answer)', () => {
    const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [df('245', '00', 'aKisah 日本.')] };
    const reader = readMarcXml();
    const results = [...reader.push(Buffer.from(writeMarcXmlRecord(rec), 'utf8')), ...reader.end()];
    expect(results.map((r) => okRecord(r))).toEqual([rec]);
  });

  it('the XML reader of Task 5 still sees one well-formed document in what the writer produces', () => {
    const doc = `${MARCXML_COLLECTION_OPEN}${records(3).map((r) => writeMarcXmlRecord(r)).join('\n')}\n${MARCXML_COLLECTION_CLOSE}`;
    const reader = createXmlReader();
    expect(() => {
      reader.write(doc);
      reader.end();
    }).not.toThrow();
  });
});
