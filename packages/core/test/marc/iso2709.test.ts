import { describe, expect, it } from 'vitest';
import { MarcTooLongError, readIso2709, writeIso2709 } from '../../src/marc/index.js';
import type { MarcDataField, MarcReadResult, MarcRecord } from '../../src/marc/index.js';
import { CORPUS, cf, df, marc8Iso2709, maskLeader } from '../support/marc-corpus.js';

// Spec §5.1, plan Task 6, Review Focus 5 and S9: ISO 2709 in (UTF-8 and MARC-8) and out (UTF-8, leader/09 `a`). The
// reader splits on the record terminator 0x1D, never on the leader length alone, flags what it repaired, skips what
// it cannot read and holds at most about 100 000 bytes.

type Result = MarcReadResult & { startByte: number; endByte: number };

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Reads `bytes` fed in chunks of `size`, end() included. */
function readAll(bytes: Uint8Array, size = bytes.length || 1): Result[] {
  const reader = readIso2709();
  const out: Result[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(...(reader.push(bytes.subarray(i, i + size)) as Result[]));
  out.push(...(reader.end() as Result[]));
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(parts));
}

const okRecord = (r: MarcReadResult | undefined): MarcRecord => {
  if (!r?.ok) throw new Error(`expected an ok result, got ${JSON.stringify(r)}`);
  return r.record;
};

const simple = (id: string, note = 'Catatan.'): MarcRecord => ({
  leader: '00000nam a2200000 i 4500',
  fields: [cf('001', id), df('245', '00', `aJudul ${id}.`), df('500', '  ', `a${note}`)],
});

describe('writeIso2709 and readIso2709: the corpus', () => {
  it('reads back every corpus record it wrote (leader length, coding and base address recomputed)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(50);
    for (const { name, record } of CORPUS) {
      const bytes = writeIso2709(record);
      const leader = latin1(bytes.subarray(0, 24));
      expect(leader.slice(0, 5), name).toBe(String(bytes.length).padStart(5, '0'));
      expect(leader[9], name).toBe('a');
      expect(bytes[Number(leader.slice(12, 17)) - 1], name).toBe(0x1e);
      expect(bytes[bytes.length - 1], name).toBe(0x1d);
      expect(maskLeader(leader), name).toBe(maskLeader(record.leader));
      const results = readAll(bytes);
      expect(results, name).toEqual([{ ok: true, record: { ...record, leader }, index: 0, warnings: [], startByte: 0, endByte: bytes.length }]);
    }
  });

  it('gives the same results whether the file arrives in 1-, 7- or 4096-byte chunks, with exact byte offsets', () => {
    const records = CORPUS.map((e) => e.record);
    const parts = records.map((r) => writeIso2709(r));
    const file = concat(...parts);
    const whole = readAll(file);
    expect(whole).toHaveLength(records.length);
    for (const size of [1, 7, 4096]) expect(readAll(file, size)).toEqual(whole);
    let offset = 0;
    whole.forEach((r, i) => {
      expect(r.index).toBe(i);
      expect([r.startByte, r.endByte]).toEqual([offset, offset + parts[i]!.length]);
      offset += parts[i]!.length;
    });
  });

  it('writes UTF-8 and removes the delimiters 0x1D, 0x1E and 0x1F from values', () => {
    const rec: MarcRecord = {
      leader: '00000nam  2200000 a 4500',
      fields: [cf('001', 'X\u{1E}1'), df('245', '10', 'aCafé\u{1F}b \u{1D}x', 'cPramoedya.')],
    };
    const bytes = writeIso2709(rec);
    expect(Buffer.from(bytes).includes(Buffer.from('Café', 'utf8'))).toBe(true);
    expect(okRecord(readAll(bytes)[0]).fields).toEqual([cf('001', 'X1'), df('245', '10', 'aCaféb x', 'cPramoedya.')]);
  });

  it('turns a bad indicator into a space and skips a subfield without a usable code', () => {
    const bytes = writeIso2709({ leader: '00000nam a2200000 i 4500', fields: [{ tag: '245', ind1: 'é', ind2: '', subfields: [['a', 'Judul'], ['', 'x'], ['ab', 'y']] }] });
    expect(okRecord(readAll(bytes)[0]).fields).toEqual([df('245', '  ', 'aJudul')]);
  });

  it('refuses a tag that is not three ASCII letters or digits', () => {
    expect(() => writeIso2709({ leader: '00000nam a2200000 i 4500', fields: [cf('0\u{1D}1', 'x')] })).toThrow(RangeError);
  });

  it('writes the structure positions of the leader it uses itself: 10-11 `22` and 20-23 `4500`', () => {
    const bytes = writeIso2709({ leader: '', fields: [cf('001', 'X'), df('245', '00', 'aJudul.')] });
    const leader = latin1(bytes.subarray(0, 24));
    expect([leader.slice(10, 12), leader.slice(20, 24), leader[9]]).toEqual(['22', '4500', 'a']);
    const odd = writeIso2709({ leader: '00000nam 1xy00000 i 9999', fields: [cf('001', 'X')] });
    expect(latin1(odd.subarray(0, 24)).slice(5)).toBe('nam a2200037 i 4500');
  });

  it('keeps its own copy of what it holds: a Buffer the caller reuses after push() does not change the record', () => {
    const bytes = Buffer.from(writeIso2709(simple('COPY', 'Catatan panjang.')));
    const reader = readIso2709();
    const buffer = Buffer.alloc(bytes.length);
    const half = Math.floor(bytes.length / 2);
    bytes.copy(buffer, 0, 0, half);
    expect(reader.push(buffer.subarray(0, half))).toEqual([]);
    buffer.fill(0x5a);
    bytes.copy(buffer, 0, half);
    const results = [...reader.push(buffer.subarray(0, bytes.length - half)), ...reader.end()];
    expect(results.map((r) => (r.ok ? r.record.fields : r.error))).toEqual([simple('COPY', 'Catatan panjang.').fields]);
  });
});

describe('writeIso2709: the 99 999-byte limit (Review Focus 5)', () => {
  it('throws MarcTooLongError for 25 × 5 000-byte 520 fields', () => {
    const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [cf('001', 'LONG')] };
    for (let i = 0; i < 25; i++) rec.fields.push(df('520', '  ', `a${'x'.repeat(5000)}`));
    expect(() => writeIso2709(rec)).toThrow(MarcTooLongError);
    try {
      writeIso2709(rec);
    } catch (e) {
      expect((e as MarcTooLongError).length).toBeGreaterThan(99_999);
    }
  });

  it('throws MarcTooLongError for one field above 9 999 bytes, and writes a record of exactly 99 999 bytes', () => {
    expect(() => writeIso2709({ leader: '00000nam a2200000 i 4500', fields: [df('520', '  ', `a${'é'.repeat(5000)}`)] })).toThrow(MarcTooLongError);
    const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [] };
    for (let i = 0; i < 11; i++) rec.fields.push(df('520', '  ', `a${'x'.repeat(9000)}`));
    const base = writeIso2709(rec).length;
    expect(99_999 - base).toBeGreaterThan(0);
    expect(99_999 - base).toBeLessThan(999);
    (rec.fields[0] as MarcDataField).subfields[0]![1] += 'x'.repeat(99_999 - base);
    expect(writeIso2709(rec)).toHaveLength(99_999);
    (rec.fields[1] as MarcDataField).subfields[0]![1] += 'x';
    expect(() => writeIso2709(rec)).toThrow(MarcTooLongError);
  });
});

describe('readIso2709: dirty files (Review Focus 5)', () => {
  /** A record of exactly `size` bytes whose leader says `claimed`. */
  function sized(size: number, claimed: string): Uint8Array {
    const base = writeIso2709(simple('LEN', '')).length;
    const bytes = writeIso2709(simple('LEN', 'n'.repeat(size - base)));
    expect(bytes).toHaveLength(size);
    bytes.set(Buffer.from(claimed, 'latin1'), 0);
    return bytes;
  }

  it('reads a record whose leader says 00500 for 480 bytes with leader_length, and the good record after it', () => {
    const good = writeIso2709(simple('GOOD'));
    const results = readAll(concat(sized(480, '00500'), good));
    expect(results.map((r) => [r.ok, r.ok ? r.warnings : r.error])).toEqual([
      [true, ['leader_length']],
      [true, []],
    ]);
    expect(okRecord(results[0]).fields[0]).toEqual(cf('001', 'LEN'));
    expect(okRecord(results[1]).fields[0]).toEqual(cf('001', 'GOOD'));
    expect(results[1]!.startByte).toBe(480);
  });

  it('skips a record with a broken directory and still reads the next one', () => {
    const broken = writeIso2709(simple('BAD'));
    broken[24 + 3] = 'X'.charCodeAt(0); // the first entry's length is no longer digits
    const results = readAll(concat(writeIso2709(simple('A')), broken, writeIso2709(simple('B'))));
    expect(results.map((r) => (r.ok ? r.record.fields[0] : r.error))).toEqual([cf('001', 'A'), 'directory', cf('001', 'B')]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('skips a record whose directory points past its end or whose directory is not a multiple of 12', () => {
    const past = writeIso2709(simple('PAST'));
    past.set(Buffer.from('9999', 'latin1'), 24 + 12 + 3); // the 245's length
    const ragged = concat(Buffer.from('00030nam a2200030 i 4500001', 'latin1'), Uint8Array.of(0x1e, 0x1d));
    const tiny = Uint8Array.of(0x31, 0x32, 0x1d);
    expect(readAll(concat(past, ragged, tiny, writeIso2709(simple('OK')))).map((r) => (r.ok ? 'ok' : r.error))).toEqual(['directory', 'directory', 'directory', 'ok']);
  });

  it('reads a last field without its field terminator, and a final record without its record terminator', () => {
    const bytes = writeIso2709(simple('NOFT'));
    const noFieldTerminator = concat(bytes.subarray(0, bytes.length - 2), Uint8Array.of(0x1d));
    const noRecordTerminator = writeIso2709(simple('NORT')).subarray(0, -1);
    const results = readAll(concat(noFieldTerminator, noRecordTerminator));
    expect(results.map((r) => (r.ok ? [r.record.fields.at(-1), r.warnings] : r.error))).toEqual([
      [df('500', '  ', 'aCatatan.'), ['leader_length', 'missing_terminator']],
      [df('500', '  ', 'aCatatan.'), ['missing_terminator']],
    ]);
  });

  it('separates two records whose record terminator between them is missing', () => {
    const a = writeIso2709(simple('A'));
    const b = writeIso2709(simple('B'));
    const results = readAll(concat(a.subarray(0, -1), b, writeIso2709(simple('C'))));
    expect(results.map((r) => (r.ok ? [r.record.fields[0], r.warnings, r.startByte, r.endByte] : r.error))).toEqual([
      [cf('001', 'A'), ['missing_terminator'], 0, a.length - 1],
      [cf('001', 'B'), [], a.length - 1, a.length - 1 + b.length],
      [cf('001', 'C'), [], a.length - 1 + b.length, a.length - 1 + b.length * 2],
    ]);
  });

  it('a broken record that lost its terminator is reported, and the good record right after it is still read', () => {
    const broken = writeIso2709(simple('BAD'));
    broken[24 + 3] = 'X'.charCodeAt(0);
    const good = writeIso2709(simple('GOOD'));
    const file = concat(broken.subarray(0, -1), good, writeIso2709(simple('NEXT')));
    for (const size of [file.length, 7]) {
      const results = readAll(file, size);
      expect(results.map((r) => (r.ok ? r.record.fields[0] : r.error))).toEqual(['directory', cf('001', 'GOOD'), cf('001', 'NEXT')]);
      expect(results.map((r) => [r.startByte, r.endByte])).toEqual([
        [0, broken.length - 1],
        [broken.length - 1, broken.length - 1 + good.length],
        [broken.length - 1 + good.length, file.length],
      ]);
    }
  });

  it('separates two records whose terminator is lost even when the first leader length is wrong', () => {
    const a = writeIso2709(simple('A'));
    a.set(Buffer.from('00999', 'latin1'), 0);
    const b = writeIso2709(simple('B'));
    const results = readAll(concat(a.subarray(0, -1), b));
    expect(results.map((r) => (r.ok ? [r.record.fields[0], r.warnings] : r.error))).toEqual([
      [cf('001', 'A'), ['leader_length', 'missing_terminator']],
      [cf('001', 'B'), []],
    ]);
  });

  it('ignores line breaks between records and an empty record', () => {
    const results = readAll(concat(writeIso2709(simple('A')), Buffer.from('\r\n'), Uint8Array.of(0x1d), Buffer.from('\n'), writeIso2709(simple('B')), Buffer.from('\r\n')));
    expect(results.map((r) => (r.ok ? r.record.fields[0] : r.error))).toEqual([cf('001', 'A'), cf('001', 'B')]);
  });

  it('refuses a UTF-8 record with bytes that are not UTF-8 (encoding) and reads the next', () => {
    const bad = writeIso2709(simple('ENC', 'Caf_'));
    bad[bad.indexOf('_'.charCodeAt(0))] = 0xe9; // Latin-1 é in a record whose leader says UTF-8
    expect(readAll(concat(bad, writeIso2709(simple('OK')))).map((r) => (r.ok ? 'ok' : r.error))).toEqual(['encoding', 'ok']);
  });

  it('reads a record with leader/09 blank but valid multibyte UTF-8 as UTF-8 (no mojibake)', () => {
    const bytes = writeIso2709(simple('MIS', 'Café Ñandú'));
    bytes[9] = 0x20;
    const rec = okRecord(readAll(bytes)[0]);
    expect(rec.leader[9]).toBe(' ');
    expect(rec.fields[2]).toEqual(df('500', '  ', 'aCafé Ñandú'));
  });

  it('reads a record with an escape sequence as MARC-8 even when its bytes happen to be valid UTF-8', () => {
    // ESC ) 4 puts Extended Arabic in G1: C7 A1 would also be valid UTF-8 (U+01E1), but it is MARC-8.
    const rec = { ...simple('ARB', 'Teks QQ'), leader: '00000nam  2200000 a 4500' };
    const bytes = Buffer.from(marc8Iso2709(rec));
    const at = bytes.indexOf('QQ');
    const patched = Buffer.concat([bytes.subarray(0, at), Buffer.from([0x1b, 0x29, 0x34, 0xc7, 0xa1, 0x1b, 0x29, 0x21, 0x45]), bytes.subarray(at + 2)]);
    patched.write(String(patched.length).padStart(5, '0'), 0, 'latin1');
    const entry = 24 + 12 * 2;
    patched.write(String(Number(patched.toString('latin1', entry + 3, entry + 7)) + 7).padStart(4, '0'), entry + 3, 'latin1');
    const [r] = readAll(Uint8Array.from(patched));
    expect(r?.ok && [r.record.fields[2], r.warnings]).toEqual([df('500', '  ', 'aTeks ??'), ['marc8_replaced']]);
  });

  it('throws when push() is called after end()', () => {
    const reader = readIso2709();
    reader.end();
    expect(() => reader.push(Uint8Array.of(0x1d))).toThrow();
  });
});

describe('readIso2709: bounded (S9)', () => {
  it('reports one truncated record for 150 000 bytes without 0x1D, then reads the good record; it never holds more than ~100 000 bytes', () => {
    const garbage = new Uint8Array(150_000).fill(0x41);
    const good = writeIso2709(simple('AFTER'));
    const file = concat(garbage, Uint8Array.of(0x1d), good);
    const reader = readIso2709();
    const results: Result[] = [];
    let pushed = 0;
    for (let i = 0; i < file.length; i += 1000) {
      const chunk = file.subarray(i, i + 1000);
      results.push(...(reader.push(chunk) as Result[]));
      pushed += chunk.length;
      expect(pushed - reader.consumedBytes()).toBeLessThanOrEqual(100_000);
    }
    results.push(...(reader.end() as Result[]));
    expect(results.map((r) => (r.ok ? r.record.fields[0] : [r.error, r.index]))).toEqual([['truncated', 0], cf('001', 'AFTER')]);
    expect(results[1]!.index).toBe(1);
    expect(results.map((r) => [r.startByte, r.endByte])).toEqual([
      [0, 150_001],
      [150_001, file.length],
    ]);
    expect(reader.consumedBytes()).toBe(file.length);
  });

  it('reads a good record that follows 150 000 bytes without 0x1D directly (no terminator in between)', () => {
    const garbage = new Uint8Array(150_000).fill(0x41);
    const good = writeIso2709(simple('AFTER'));
    const file = concat(garbage, good, writeIso2709(simple('NEXT')));
    for (const size of [file.length, 4096, 1000, 7]) {
      const reader = readIso2709();
      const results: Result[] = [];
      let pushed = 0;
      for (let i = 0; i < file.length; i += size) {
        const chunk = file.subarray(i, i + size);
        results.push(...(reader.push(chunk) as Result[]));
        pushed += chunk.length;
        expect(pushed - reader.consumedBytes()).toBeLessThanOrEqual(100_000);
      }
      results.push(...(reader.end() as Result[]));
      expect(results.map((r) => (r.ok ? r.record.fields[0] : r.error)), `chunks of ${size}`).toEqual(['truncated', cf('001', 'AFTER'), cf('001', 'NEXT')]);
      // The offsets tile the input: a checkpoint after the truncated record is the good record's first byte.
      expect(results.map((r) => [r.startByte, r.endByte]), `chunks of ${size}`).toEqual([
        [0, 150_000],
        [150_000, 150_000 + good.length],
        [150_000 + good.length, file.length],
      ]);
    }
  });

  it('reports a truncated record at the end of the input, and a final record after it without its terminator', () => {
    const garbage = new Uint8Array(120_000).fill(0x43);
    expect(readAll(garbage, 4096).map((r) => (r.ok ? 'ok' : [r.error, r.startByte, r.endByte]))).toEqual([['truncated', 0, 120_000]]);
    const last = writeIso2709(simple('LAST')).subarray(0, -1);
    const results = readAll(concat(garbage, last), 4096);
    expect(results.map((r) => (r.ok ? [r.record.fields[0], r.warnings] : r.error))).toEqual(['truncated', [cf('001', 'LAST'), ['missing_terminator']]]);
  });

  it('stays fast when a truncated record is full of fake leaders whose length and base address agree', () => {
    // 37-byte blocks: a leader whose length reaches the 0x1D below, one directory entry, a field terminator.
    const blocks = 2600;
    const garbageLength = 60_000 + 37 * blocks;
    const parts: Uint8Array[] = [new Uint8Array(60_000).fill(0x41)];
    for (let b = 0; b < blocks; b++) {
      const at = 60_000 + 37 * b;
      parts.push(Buffer.from(`${String(garbageLength - at + 1).padStart(5, '0')}nam a2200037 i 4500245999900000`, 'latin1'), Uint8Array.of(0x1e));
    }
    const file = concat(...parts, Uint8Array.of(0x1d), writeIso2709(simple('NEXT')));
    const started = performance.now();
    const results = readAll(file, 4096);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(results.map((r) => (r.ok ? r.record.fields[0] : r.error))).toEqual(['truncated', cf('001', 'NEXT')]);
  });

  it('reports the truncated record once, even fed in one chunk', () => {
    const file = concat(new Uint8Array(250_000).fill(0x42), Uint8Array.of(0x1d), writeIso2709(simple('AFTER')));
    expect(readAll(file).map((r) => (r.ok ? 'ok' : r.error))).toEqual(['truncated', 'ok']);
  });

  it('reads a record of the largest size after line breaks, without calling it truncated', () => {
    const rec: MarcRecord = { leader: '00000nam a2200000 i 4500', fields: [] };
    for (let i = 0; i < 11; i++) rec.fields.push(df('520', '  ', `a${'x'.repeat(9000)}`));
    const base = writeIso2709(rec).length;
    (rec.fields[0] as MarcDataField).subfields[0]![1] += 'x'.repeat(99_999 - base);
    const max = writeIso2709(rec);
    expect(max).toHaveLength(99_999);
    expect(readAll(concat(Buffer.from('\r\n\r\n'), max, Buffer.from('\r\n'), max), 4096).map((r) => (r.ok ? 'ok' : r.error))).toEqual(['ok', 'ok']);
  });
});

describe('readIso2709: MARC-8', () => {
  it('reads the MARC-8 records of the corpus into Unicode (NFC), leader as stored', () => {
    const marc8 = CORPUS.filter((e) => e.marc8);
    expect(marc8.length).toBeGreaterThanOrEqual(5);
    for (const { name, record } of marc8) {
      const bytes = marc8Iso2709(record);
      expect(bytes[9], name).toBe(0x20);
      const [r] = readAll(bytes);
      expect(r, name).toEqual({ ok: true, record: { ...record, leader: latin1(bytes.subarray(0, 24)) }, index: 0, warnings: [], startByte: 0, endByte: bytes.length });
    }
  });

  it('flags marc8_replaced when a field switches to a character set other than ASCII and ANSEL', () => {
    const rec = { ...simple('ESC', 'Judul ZZZ'), leader: '00000nam  2200000 a 4500' };
    const bytes = Buffer.from(marc8Iso2709(rec));
    const at = bytes.indexOf('ZZZ');
    const withEscape = Buffer.concat([bytes.subarray(0, at), Buffer.from([0x1b, 0x28, 0x33, 0x41, 0x42, 0x1b, 0x28, 0x42]), bytes.subarray(at + 3)]);
    withEscape.write(String(withEscape.length).padStart(5, '0'), 0, 'latin1');
    // The 500's directory length grows by the 5 extra bytes.
    const entry = 24 + 12 * 2;
    withEscape.write(String(Number(withEscape.toString('latin1', entry + 3, entry + 7)) + 5).padStart(4, '0'), entry + 3, 'latin1');
    const [r] = readAll(Uint8Array.from(withEscape));
    expect(r?.ok && r.warnings).toEqual(['marc8_replaced']);
    expect(okRecord(r).fields[2]).toEqual(df('500', '  ', 'aJudul ??'));
  });
});
