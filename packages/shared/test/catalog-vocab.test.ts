import { describe, expect, it } from 'vitest';
import {
  ACQ_SOURCES,
  AGENT_TYPES,
  ATTACHMENT_MEDIA,
  BODY_FORMATS,
  EXPORT_FORMATS,
  FACETS,
  FIELD_STATES,
  IDENTIFIER_TYPES,
  IMPORT_FORMATS,
  ITEM_STATUSES,
  ITEM_TRANSITIONS,
  LOCATION_KINDS,
  RDA_CARRIER_CODES,
  RDA_CARRIER_TYPES,
  RDA_CONTENT_CODES,
  RDA_CONTENT_TYPES,
  RDA_MEDIA_CODES,
  RDA_MEDIA_TYPES,
  RECORD_FIELD_NAMES,
  RELATION_TYPES,
  RELATOR_ROLES,
  RUN_KINDS,
  RUN_STATUSES,
  SUBJECT_EXPORT_TAG,
  SUBJECT_TYPES,
  THESAURUS_RECIPROCAL,
  THESAURUS_RELS,
  VOCAB_LISTS,
  canTransition,
  vocabKey,
  type ItemStatus,
} from '../src/catalog-vocab.js';
import { LOCALES, MESSAGES } from '../src/i18n/index.js';
import * as root from '../src/index.js';

// The fixed vocabularies of the catalog (Phase 2 spec §2.5, §3.8, §4.6, §5) and their shared labels.

describe('item statuses and transitions (§2.5)', () => {
  it('has the 8 statuses of the table', () => {
    expect([...ITEM_STATUSES]).toEqual(['on_order', 'processing', 'available', 'not_for_loan', 'repair', 'missing', 'lost', 'withdrawn']);
  });

  it('ITEM_TRANSITIONS is the §2.5 table, plus available → lost (an item its borrower declares lost)', () => {
    expect(ITEM_TRANSITIONS).toEqual({
      on_order: ['processing', 'available', 'withdrawn'],
      processing: ['available', 'not_for_loan', 'withdrawn'],
      available: ['not_for_loan', 'repair', 'missing', 'withdrawn', 'lost'],
      not_for_loan: ['available', 'repair', 'missing', 'withdrawn'],
      repair: ['available', 'not_for_loan', 'withdrawn'],
      missing: ['available', 'not_for_loan', 'lost'],
      lost: ['available', 'withdrawn'],
      withdrawn: ['processing'],
    });
    expect(Object.keys(ITEM_TRANSITIONS)).toEqual([...ITEM_STATUSES]);
  });

  it('canTransition follows the table: repair → lost is refused, available → lost and missing → lost are allowed', () => {
    expect(canTransition('repair', 'lost')).toBe(false);
    expect(canTransition('available', 'lost')).toBe(true);
    expect(canTransition('missing', 'lost')).toBe(true);
    expect(canTransition('withdrawn', 'processing')).toBe(true);
    expect(canTransition('withdrawn', 'available')).toBe(false);
    for (const from of ITEM_STATUSES) {
      for (const to of ITEM_STATUSES) expect(canTransition(from, to), `${from} → ${to}`).toBe(ITEM_TRANSITIONS[from].includes(to));
    }
  });

  it('staying in a status is not a transition, and a status from outside never reads the prototype', () => {
    for (const s of ITEM_STATUSES) expect(canTransition(s, s)).toBe(false);
    expect(canTransition('__proto__' as ItemStatus, 'available')).toBe(false);
    expect(canTransition('toString' as ItemStatus, 'available')).toBe(false);
    expect(canTransition('available', 'constructor' as ItemStatus)).toBe(false);
  });

  it('the table and its rows are frozen', () => {
    expect(Object.isFrozen(ITEM_TRANSITIONS)).toBe(true);
    for (const s of ITEM_STATUSES) expect(Object.isFrozen(ITEM_TRANSITIONS[s])).toBe(true);
    expect(Object.isFrozen(ITEM_STATUSES)).toBe(true);
  });
});

describe('records, authorities and the other lists', () => {
  it('has the 18 template field names of §3.8, title not among them', () => {
    expect(RECORD_FIELD_NAMES).toHaveLength(18);
    expect([...RECORD_FIELD_NAMES]).toEqual([
      'subtitle',
      'responsibility',
      'edition',
      'material_detail',
      'publisher',
      'publication_place',
      'publication_year',
      'physical_desc',
      'series',
      'classification',
      'call_number',
      'language',
      'rda',
      'summary',
      'notes',
      'identifiers',
      'agents',
      'subjects',
    ]);
    expect([...FIELD_STATES]).toEqual(['hidden', 'optional', 'required']);
  });

  it('pins the lists the spec names', () => {
    expect([...RELATOR_ROLES]).toEqual(['aut', 'edt', 'trl', 'ill', 'cmp', 'drt', 'pro', 'cre', 'ctb']);
    expect([...IDENTIFIER_TYPES]).toEqual(['isbn', 'issn', 'doi', 'control', 'other']);
    expect([...RELATION_TYPES]).toEqual(['related', 'other_edition', 'part_of', 'translation_of']);
    expect([...AGENT_TYPES]).toEqual(['person', 'organization', 'meeting']);
    expect([...SUBJECT_TYPES]).toEqual(['topic', 'geographic', 'name', 'temporal', 'genre', 'occupation']);
    expect([...THESAURUS_RELS]).toEqual(['use', 'uf', 'bt', 'nt', 'rt', 'sa']);
    expect([...LOCATION_KINDS]).toEqual(['room', 'area', 'shelf']);
    expect([...ACQ_SOURCES]).toEqual(['purchase', 'gift', 'exchange', 'deposit', 'other']);
    expect([...ATTACHMENT_MEDIA]).toEqual(['pdf', 'audio', 'video', 'image', 'url', 'other']);
    expect([...IMPORT_FORMATS]).toEqual(['marc21', 'marcxml', 'csv-records', 'csv-items', 'csv-slims', 'csv-slims-items']);
    expect([...EXPORT_FORMATS]).toEqual(['marc21', 'marcxml', 'marcjson', 'csv-records', 'csv-items']);
    // The SLiMS usage statistics import of the accreditation workspace is a catalogue run too.
    expect([...RUN_KINDS]).toEqual(['import', 'export', 'migration', 'dedupe_scan', 'slims_usage', 'member_import']);
    expect([...RUN_STATUSES]).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    expect([...BODY_FORMATS]).toEqual(['markdown', 'html']);
  });

  it('M4: the facets include cl, the class digit', () => {
    expect([...FACETS]).toEqual(['mt', 'lg', 'ct', 'br', 'lc', 'av', 'at', 'sb', 'cl']);
  });

  it('exports every subject type under its MARC tag', () => {
    expect(SUBJECT_EXPORT_TAG).toEqual({ name: '600', topic: '650', geographic: '651', temporal: '648', genre: '655', occupation: '656' });
    expect(Object.keys(SUBJECT_EXPORT_TAG).sort()).toEqual([...SUBJECT_TYPES].sort());
  });

  it('the thesaurus reciprocal is the §3.5 table and undoes itself', () => {
    expect(THESAURUS_RECIPROCAL).toEqual({ use: 'uf', uf: 'use', bt: 'nt', nt: 'bt', rt: 'rt', sa: 'sa' });
    for (const rel of THESAURUS_RELS) expect(THESAURUS_RECIPROCAL[THESAURUS_RECIPROCAL[rel]]).toBe(rel);
  });
});

describe('RDA 336/337/338', () => {
  const lists = [
    ['content', RDA_CONTENT_TYPES, RDA_CONTENT_CODES],
    ['media', RDA_MEDIA_TYPES, RDA_MEDIA_CODES],
    ['carrier', RDA_CARRIER_TYPES, RDA_CARRIER_CODES],
  ] as const;

  it('each list has unique codes and a term per code, and its code list follows it', () => {
    for (const [name, terms, codes] of lists) {
      expect(new Set(terms.map((e) => e.code)).size, name).toBe(terms.length);
      for (const e of terms) {
        expect(e.code, name).toMatch(/^[a-z]{1,3}$/);
        expect(e.term.trim(), `${name}:${e.code}`).not.toBe('');
      }
      expect([...codes]).toEqual(terms.map((e) => e.code));
      expect(Object.isFrozen(terms)).toBe(true);
    }
    expect(RDA_CONTENT_TYPES).toHaveLength(25);
    expect(RDA_MEDIA_TYPES).toHaveLength(10);
  });

  it('holds every code the seeded material types use (§2.6)', () => {
    for (const c of ['txt', 'cri', 'spw', 'tdi', 'xxx']) expect(RDA_CONTENT_CODES).toContain(c);
    for (const c of ['n', 'c', 's', 'v']) expect(RDA_MEDIA_CODES).toContain(c);
    for (const c of ['nc', 'cr', 'nb', 'sd', 'vd', 'nz']) expect(RDA_CARRIER_CODES).toContain(c);
    expect(RDA_CONTENT_TYPES.find((e) => e.code === 'txt')?.term).toBe('text');
    expect(RDA_CARRIER_TYPES.find((e) => e.code === 'cr')?.term).toBe('online resource');
  });
});

describe('vocab.* messages', () => {
  const expectedKeys = (): string[] =>
    Object.entries(VOCAB_LISTS)
      .flatMap(([list, values]) => (values as readonly string[]).map((v) => `vocab.${list}.${v}`))
      .sort();

  it('every vocab value has a message in both languages, without placeholders', () => {
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Readonly<Record<string, string>>;
      for (const key of expectedKeys()) {
        expect(table[key], `${locale}:${key}`).toBeTruthy();
        expect(table[key]!.trim(), `${locale}:${key}`).not.toBe('');
        expect(table[key], `${locale}:${key}`).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      }
    }
  });

  it('has no vocab.* key beyond the lists (the RDA lists have none)', () => {
    for (const locale of LOCALES) {
      const found = Object.keys(MESSAGES[locale]).filter((k) => k.startsWith('vocab.'));
      expect(found.sort(), locale).toEqual(expectedKeys());
    }
  });

  it('says each label differently in the two languages', () => {
    const table = (locale: 'id' | 'en') => MESSAGES[locale] as Readonly<Record<string, string>>;
    for (const key of expectedKeys()) expect(table('id')[key], key).not.toBe(table('en')[key]);
  });

  it('labels the statuses as §2.5 does: on_order is "Dalam pemesanan"', () => {
    const id = MESSAGES.id as Readonly<Record<string, string>>;
    expect(id['vocab.item_status.on_order']).toBe('Dalam pemesanan');
    expect(id['vocab.item_status.not_for_loan']).toBe('Baca di tempat');
    expect(id['vocab.item_status.withdrawn']).toBe('Disiangi');
    expect(vocabKey('item_status', 'on_order')).toBe('vocab.item_status.on_order');
    expect(vocabKey('field', 'material_detail')).toBe('vocab.field.material_detail');
  });
});

describe('the package root', () => {
  it('re-exports the vocabularies (no Zod: the root stays free of schemas)', () => {
    expect(root.ITEM_TRANSITIONS).toBe(ITEM_TRANSITIONS);
    expect(root.canTransition).toBe(canTransition);
    expect(root.VOCAB_LISTS).toBe(VOCAB_LISTS);
    expect(root.RDA_CONTENT_TYPES).toBe(RDA_CONTENT_TYPES);
  });
});
