import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentNameKey,
  barcodeProblem,
  marcToDraft,
  normalizeBarcode,
  parseIsbn,
  readMarcXml,
  subjectTermKey,
  type MarcRecord,
} from '../../../../packages/core/src/index.js';
import { createSqlDumpParser } from '../../../../packages/core/src/migration/slims/source/sql-dump.js';
import {
  PERF_PHASE2_SEED,
  PERF_PUBLISHERS,
  WORDS_EN,
  WORDS_ID,
  attachmentOf,
  itemRange,
  perfAgentName,
  perfBarcode,
  perfCounts,
  perfItem,
  perfMarcRecord,
  perfPdf,
  perfPublisherName,
  perfRecord,
  perfSubjectTerm,
  perfSupplier,
  perfUniqueWord,
  writePerfMarcXml,
  writePerfSlimsDump,
} from '../seed.js';

// The generator of the seed `perf-phase2` (K9, K16; plan Task 39): the counts of spec §15 exactly, names, terms and
// barcodes distinct and valid for the columns they go into, the same record for the same number, and the two files
// (MARCXML for the import, a SLiMS dump for the migration) read back by the product's own readers with the counts asked.

const FULL = perfCounts(1);

describe('the counts', () => {
  it('are those of K9: 100 000 records, 150 000 items, 50 000 agents, 20 000 subjects, 2 000 attachments', () => {
    expect(PERF_PHASE2_SEED).toEqual({ name: 'perf-phase2', records: 100_000, items: 150_000, agents: 50_000, subjects: 20_000, attachments: 2_000 });
    expect(FULL).toEqual({ records: 100_000, items: 150_000, agents: 50_000, subjects: 20_000, attachments: 2_000 });
  });

  it('scale down with the same shape, and refuse a scale that is not a positive number', () => {
    expect(perfCounts(0.01)).toEqual({ records: 1_000, items: 1_500, agents: 500, subjects: 200, attachments: 20 });
    expect(perfCounts(0.00001)).toEqual({ records: 1, items: 2, agents: 1, subjects: 1, attachments: 1 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 20]) expect(() => perfCounts(bad)).toThrow(RangeError);
  });

  it('give every record its items so that they add up to the item count exactly (1 or 2 each at 1.5 per record)', () => {
    let total = 0;
    let next = 0;
    for (let n = 0; n < FULL.records; n += 1) {
      const r = itemRange(n, FULL);
      expect(r.first).toBe(next);
      expect([1, 2]).toContain(r.count);
      next += r.count;
      total += r.count;
    }
    expect(total).toBe(150_000);
  });

  it('give exactly `attachments` records an attachment, half of them files and half links', () => {
    const kinds = { file: 0, url: 0 };
    for (let n = 0; n < FULL.records; n += 1) {
      const a = attachmentOf(n, FULL);
      if (a !== null) kinds[a] += 1;
    }
    expect(kinds).toEqual({ file: 1_000, url: 1_000 });
    const small = perfCounts(0.001);
    expect(Array.from({ length: small.records }, (_, n) => attachmentOf(n, small)).filter((a) => a !== null)).toHaveLength(small.attachments);
  });
});

describe('the authorities', () => {
  it('50 000 agent names, distinct by their key (agentNameKey), each fitting the column', () => {
    const keys = new Set<string>();
    for (let k = 0; k < FULL.agents; k += 1) {
      const name = perfAgentName(k);
      expect(name.length).toBeLessThanOrEqual(100); // SLiMS mst_author.author_name
      keys.add(agentNameKey(name));
    }
    expect(keys.size).toBe(FULL.agents);
  });

  it('20 000 subject terms, distinct by their key, each within SLiMS mst_topic.topic (50 characters)', () => {
    const keys = new Set<string>();
    for (let k = 0; k < FULL.subjects; k += 1) {
      const term = perfSubjectTerm(k);
      expect(term.length).toBeLessThanOrEqual(50);
      keys.add(subjectTermKey(term));
    }
    expect(keys.size).toBe(FULL.subjects);
  });

  it('2 000 distinct publishers and 20 suppliers whose contact strings are distinctive', () => {
    expect(new Set(Array.from({ length: PERF_PUBLISHERS }, (_, k) => perfPublisherName(k).toUpperCase())).size).toBe(PERF_PUBLISHERS);
    const s = perfSupplier(4);
    expect(s).toEqual({ code: 'PMS-05', name: expect.any(String), contactName: 'Kontakperf 05', phone: '0812-7700-9005', email: 'pemasok05@perf-kontak.test', address: 'Jl. Kontakperf No. 05' });
  });
});

describe('a record', () => {
  it('is the same for the same number and counts', () => {
    expect(perfRecord(4_321, FULL)).toEqual(perfRecord(4_321, FULL));
    expect(perfRecord(4_321, FULL)).not.toEqual(perfRecord(4_322, FULL));
  });

  it('has a valid ISBN-13 (three in four), distinct per record, a four-digit year, distinct agents and subjects', () => {
    const isbns = new Set<string>();
    for (let n = 0; n < 20_000; n += 1) {
      const r = perfRecord(n, FULL);
      expect(r.year).toMatch(/^(19[6-9]\d|20[0-2]\d)$/);
      expect(Number(r.year)).toBeLessThanOrEqual(2026);
      expect(new Set(r.agents.map((a) => a.k)).size).toBe(r.agents.length);
      expect(r.agents.filter((a) => a.isMain)).toHaveLength(1);
      expect(new Set(r.subjects.map((s) => s.k)).size).toBe(r.subjects.length);
      expect(r.subjects.filter((s) => s.isPrimary)).toHaveLength(1);
      if (n % 4 === 3) expect(r.isbn).toBeNull();
      else {
        expect(parseIsbn(r.isbn!)).toMatchObject({ valid: true, key: r.isbn });
        isbns.add(r.isbn!);
      }
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.callNumber.length).toBeLessThanOrEqual(50);
    }
    expect(isbns.size).toBe(15_000);
  });

  it('every even record carries a made-up word of its own: no vocabulary word, no other record', () => {
    const words = new Set([...WORDS_ID, ...WORDS_EN]);
    const unique = new Set<string>();
    for (let n = 0; n < FULL.records; n += 1) unique.add(perfUniqueWord(n));
    expect(unique.size).toBe(FULL.records);
    for (const w of unique) expect(words.has(w)).toBe(false);
    for (const n of [0, 2, 998, 50_000, 99_998]) expect(perfRecord(n, FULL).title.toLowerCase().split(' ')).toContain(perfUniqueWord(n));
    expect(perfRecord(1, FULL).title.toLowerCase()).not.toContain(perfUniqueWord(1));
  });

  it('spreads its promoted, hidden and archived records thinly, as a real catalogue', () => {
    const flags = { promoted: 0, hidden: 0, archived: 0 };
    for (let n = 0; n < FULL.records; n += 1) {
      const r = perfRecord(n, FULL);
      if (r.promoted) flags.promoted += 1;
      if (r.hidden) flags.hidden += 1;
      if (r.archived) flags.archived += 1;
    }
    expect(flags).toEqual({ promoted: 50, hidden: 1030, archived: 473 });
  });
});

describe('items and files', () => {
  it('150 000 barcodes, distinct, normalised already and valid (§3.4: 3-64 printable characters, not an ISBN)', () => {
    const seen = new Set<string>();
    for (let j = 0; j < FULL.items; j += 1) {
      const b = perfBarcode(j);
      seen.add(b);
      if (j % 997 === 0) {
        expect(normalizeBarcode(b)).toBe(b);
        expect(barcodeProblem(b)).toBeNull();
      }
    }
    expect(seen.size).toBe(FULL.items);
  });

  it('an item has a lifecycle status of §2.5 and a branch of the two', () => {
    const rec = perfRecord(9, FULL);
    for (const j of rec.items) {
      const it = perfItem(j, rec);
      expect(['available', 'not_for_loan', 'repair', 'missing', 'processing']).toContain(it.status);
      expect(it.branch).toBe(1); // records n % 5 === 4 live in the second branch
    }
  });

  it('an attachment file is a PDF (the magic the upload check reads), distinct per number', () => {
    expect(perfPdf(1).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(perfPdf(1).toString('latin1')).toMatch(/%%EOF\n$/);
    expect(perfPdf(1).equals(perfPdf(2))).toBe(false);
  });
});

describe('the import file and the migration dump', () => {
  let dir: string;
  const small = perfCounts(0.003); // 300 records, 450 items

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-perf-phase2-'));
  });
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('a record maps (marcToDraft, the importer\'s mapping) to its title, ISBN, agents, subjects, items and link', () => {
    const rec = perfRecord(100, FULL);
    expect(rec.attachment).toBe('file');
    const { draft } = marcToDraft(perfMarcRecord(rec, ['PUSAT', 'UTARA']), { materialTypeCodeFor: () => 'BUKU' });
    expect(draft.title).toBe(rec.title);
    expect(draft.identifiers).toEqual([{ type: 'control', value: 'perf-100' }, { type: 'isbn', value: rec.isbn }]);
    expect(draft.agents?.map((a) => a.name)).toEqual(rec.agents.map((a) => perfAgentName(a.k)));
    expect(draft.subjects).toHaveLength(rec.subjects.length);
    expect(draft.items?.map((i) => i.barcode)).toEqual(rec.items.map(perfBarcode));
    expect(draft.items?.[0]).toMatchObject({ branchCode: 'PUSAT', collectionTypeCode: expect.any(String), callNumber: rec.callNumber });
    expect(draft.links).toEqual([{ url: 'https://repositori.perf.test/dokumen/100', title: 'Tautan repositori 100' }]);
    expect(draft.publicationYear).toBe(rec.year);
  });

  it('writePerfMarcXml: one collection the MARCXML reader reads back as `records` records without a warning', async () => {
    const file = path.join(dir, 'perf.xml');
    const bytes = await writePerfMarcXml(file, small, ['PUSAT', 'PUSAT']);
    const buf = await fsp.readFile(file);
    expect(buf.length).toBe(bytes);
    const reader = readMarcXml();
    const records: MarcRecord[] = [];
    for (let at = 0; at < buf.length; at += 65_536) {
      for (const r of reader.push(buf.subarray(at, at + 65_536))) {
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.warnings).toEqual([]);
          records.push(r.record);
        }
      }
    }
    reader.end();
    expect(records).toHaveLength(small.records);
    const barcodes = records.flatMap((r) => r.fields.filter((f) => f.tag === '952').map((f) => ('subfields' in f ? f.subfields.find(([c]) => c === 'p')?.[1] : undefined)));
    expect(new Set(barcodes).size).toBe(small.items);
  });

  it('writePerfSlimsDump: a dump the SLiMS dump parser reads with the counts of biblio, item, authors and topics', async () => {
    const file = path.join(dir, 'perf.sql');
    await writePerfSlimsDump(file, small, { now: Date.UTC(2026, 10, 1) });
    const text = await fsp.readFile(file, 'latin1');
    const parser = createSqlDumpParser();
    const rows = new Map<string, number>();
    const created = new Set<string>();
    const take = (events: ReturnType<typeof parser.push>) => {
      for (const e of events) {
        if (e.type === 'create') created.add(e.table);
        if (e.type === 'insert') rows.set(e.table, (rows.get(e.table) ?? 0) + e.rows.length);
      }
    };
    for (let at = 0; at < text.length; at += 100_000) take(parser.push(text.slice(at, at + 100_000)));
    take(parser.end());
    expect(created.has('biblio') && created.has('item') && created.has('loan') && created.has('mst_custom_field')).toBe(true);
    expect(rows.get('biblio')).toBe(small.records);
    expect(rows.get('item')).toBe(small.items);
    expect(rows.get('mst_author')).toBe(small.agents);
    expect(rows.get('mst_topic')).toBe(small.subjects);
    expect(rows.get('mst_publisher')).toBe(PERF_PUBLISHERS);
    const links = Array.from({ length: small.records }, (_, n) => perfRecord(n, small));
    expect(rows.get('biblio_author')).toBe(links.reduce((s, r) => s + r.agents.length, 0));
    expect(rows.get('biblio_topic')).toBe(links.reduce((s, r) => s + r.subjects.length, 0));
  });
});
