import { describe, expect, it } from 'vitest';
import { TABLE_COLUMNS, TABLE_KEYS, type ColumnSpec } from '../src/columns.js';
import { PERSONAL_COLUMNS, isPersonalColumn, personalLogKeys, type PersonalCategory, type TableName } from '../src/registry.js';
import { K1_TABLES_BY_MIGRATION } from './fixtures/komunitas-k1-tables.js';
import { CIRCULATION_TABLES_BY_MIGRATION } from './fixtures/komunitas-members-circulation-tables.js';
// ---- Komunitas (holds) ----
import { HOLDS_TABLES_BY_MIGRATION } from './fixtures/komunitas-holds-tables.js';
import { CIRC_CORE_TABLES_BY_MIGRATION } from './fixtures/komunitas-circ-core-tables.js';
import { VISITS_TABLES_BY_MIGRATION } from './fixtures/komunitas-visits-tables.js';
// ---- Komunitas (member area) ----
import { MEMBER_AREA_TABLES_BY_MIGRATION } from './fixtures/komunitas-member-area-tables.js';
import { CHARGES_TABLES_BY_MIGRATION } from './fixtures/komunitas-charges-tables.js';
// ---- Komunitas (notices) ----
import { NOTICES_TABLES_BY_MIGRATION } from './fixtures/komunitas-notices-tables.js';
// ---- Komunitas K4 (stocktake) ----
import { STOCKTAKE_TABLES_BY_MIGRATION } from './fixtures/komunitas-stocktake-tables.js';
// ---- Komunitas (OPAC home page) ----
import { OPAC_HOME_TABLES_BY_MIGRATION } from './fixtures/komunitas-opac-home-tables.js';

// The personal-data dictionary (PERSONAL_COLUMNS): which columns hold personal data, so that public output, events,
// logs and exports can leave them out or ask for re-authentication. Every registered column must exist; every column of
// a Komunitas table that could hold text about a person must be either registered or named below with the reason it
// is not personal, so that a new free-text column cannot slip in unclassified.

const K1_TABLES = Object.values(K1_TABLES_BY_MIGRATION).flat() as TableName[];

const CATEGORIES: readonly PersonalCategory[] = ['identity', 'contact', 'credential', 'free_text', 'photo'];

/** Kinds that hold text a person could type (character columns and JSON); every other kind is an id, a date, a time, a number or a flag. */
const TEXT_KINDS: ReadonlySet<ColumnSpec['kind']> = new Set(['char', 'varchar', 'text', 'json', 'key191']);

/** Text columns of the K1 tables holding a status, a code from a fixed list, or a value ALTIS computes. */
const K1_CODE_COLUMNS: Record<string, string> = {
  'report_runs.report_id': 'the id of a report definition in the code',
  'report_runs.format': 'an export format code',
  'report_runs.locale': 'a language code',
  'report_runs.status': 'a run status',
  'report_runs.error_code': 'an error code',
  'accred_periods.kind': 'a period kind',
  'accred_periods.instrument_id': 'the id of an instrument in the code',
  'accred_periods.status': 'a period status',
  'accred_periods.services': 'a JSON list of service codes',
  'accred_answers.answer': 'an answer letter',
  'accred_answers.mode': 'how the answer was given',
  'accred_results.payload': 'values, counts and note codes ALTIS computed',
  'accred_snapshots.instrument_id': 'the id of an instrument in the code',
  'accred_snapshots.result_values': 'the frozen computed values: numbers, letters and codes',
  'accred_snapshots.na': 'a computed score written as a decimal',
  'accred_snapshots.na_low': 'a computed score written as a decimal',
  'accred_snapshots.na_high': 'a computed score written as a decimal',
  'accred_snapshots.grade': 'a grade letter',
  'accred_evidence.indicator_code': 'an indicator code',
  'accred_evidence.evidence_code': 'an evidence item code of an indicator',
  'accred_evidence.entity': 'the register table an evidence file belongs to',
  'usage_group_map.accred_group': 'a population group code',
  'library_activities.kind': 'an activity kind',
  'library_staff.role': 'a staff role code',
  'library_staff.employment': 'an employment status code',
  'library_staff.education_level': 'an education level code',
  'library_partnerships.kind': 'an agreement kind',
  'library_budgets.currency': 'a currency code',
  'library_documents.kind': 'a document kind',
  'library_documents.aspect_codes': 'a JSON list of aspect codes',
};

/** Free-text columns of the K1 tables that are not personal data, each with the reason. */
const K1_NON_PERSONAL: Record<string, string> = {
  'report_runs.params': "a report's parameters: ids, dates, codes and the paper size",
  'report_runs.output_name': 'a file name made from the run id',
  'accred_periods.name': 'a period name chosen by the library',
  'accred_periods.external_website_url': "the address of the library's public website",
  'accred_snapshots.note': 'a label the librarian gives a frozen snapshot',
  'accred_evidence.caption': 'a caption describing an evidence file',
  'usage_group_map.label': 'the name of a member type in the source system',
  'library_activities.title': 'an activity name chosen by the library',
  'library_activities.partner': 'the partner organisation of an activity',
  'library_activities.description': 'what an activity was about',
  'library_staff.position': 'a job title',
  'staff_trainings.title': 'the name of a training course',
  'staff_trainings.organizer': 'the organisation that ran a training',
  'library_partnerships.partner': 'a partner institution',
  'library_partnerships.scope': 'what a partnership agreement covers',
  'library_budgets.note': 'a note on a budget year',
  'library_documents.title': 'the title of a library document',
  'library_documents.reference': 'a document number',
  'library_documents.issued_by': 'the office or role that issued a document',
};

// ---- Komunitas (members and circulation) ----
const CIRCULATION_TABLES = Object.values(CIRCULATION_TABLES_BY_MIGRATION).flat() as TableName[];

/** Text columns of the members and circulation tables holding a status, a code from a fixed list, or a value ALTIS computes. */
const CIRCULATION_CODE_COLUMNS: Record<string, string> = {
  'member_types.accred_group': 'a population group code',
  'members.status': 'a member status',
  'members.locale': 'a language code',
  'members.source': 'where the row came from: manual, an import run id or the key of the source system',
  'member_events.type': 'a member event type',
  'member_events.actor_type': 'the kind of actor',
  'member_events.meta': 'field names and the dates of an extension, never a personal value',
  'policies.currency': 'a currency code',
  'loans.outcome': 'a loan outcome code',
  'loans.currency': 'a currency code',
  'loans.overrides': 'a list of override reason codes',
  'loans.source': 'where the loan came from (desk or migrated)',
  'loans.stat_ddc': 'a classification key for statistics',
  'loans.stat_accred_group': 'a population group code',
};

/** Free-text columns of the members and circulation tables that are not personal data, each with the reason. */
const CIRCULATION_NON_PERSONAL: Record<string, string> = {
  'member_types.code_display': 'a member type code chosen by the library',
  'member_types.name_id': 'the name of a member type',
  'member_types.name_en': 'the name of a member type',
  'members.member_no_display': 'the member number the library assigns, replaced when a member is anonymised',
  'policies.code_display': 'a loan rule code chosen by the library',
  'policies.name': 'the name of a loan rule',
  'loans.stat_class_name': 'the class a loan is counted in for statistics, kept after anonymisation',
};

// ---- Komunitas (holds) ----
const HOLDS_TABLES = Object.values(HOLDS_TABLES_BY_MIGRATION).flat() as TableName[];

/** Text columns of the holds table holding a status or a code from a fixed list; it has no free text. */
const HOLDS_CODE_COLUMNS: Record<string, string> = {
  'holds.status': 'a hold status',
  'holds.source': 'where the hold was placed (desk, OPAC or migrated)',
  'holds.close_reason': 'a hold close reason code',
};

// ---- Komunitas (circulation core) ----
const CIRC_CORE_TABLES = Object.values(CIRC_CORE_TABLES_BY_MIGRATION).flat() as TableName[];

/** Text columns of the circulation core tables holding a code from a fixed list, a date part or a value ALTIS computes. */
const CIRC_CORE_CODE_COLUMNS: Record<string, string> = {
  'calendars.kind': 'a calendar rule kind',
  'calendars.month_day_from': 'a day of the year (MM-DD)',
  'calendars.month_day_to': 'a day of the year (MM-DD)',
  'item_uses.stat_ddc': 'a classification key for statistics',
  'item_uses.source': 'where the use came from (desk or migrated)',
  'member_clearances.purpose': 'a clearance purpose code',
};

/** Free-text columns of the circulation core tables that are not personal data, each with the reason. */
const CIRC_CORE_NON_PERSONAL: Record<string, string> = {
  'calendars.name': 'the name of closed days (a holiday)',
  'member_clearances.number_display': 'the letter number the library assigns',
};

// ---- Komunitas K2 (visits) ----
const VISITS_TABLES = Object.values(VISITS_TABLES_BY_MIGRATION).flat() as TableName[];

/** Text columns of the visits tables holding a code, a hash or a value ALTIS computes. */
const VISITS_CODE_COLUMNS: Record<string, string> = {
  'visit_stations.activation_hash': 'the SHA-256 of a one-time activation code',
  'visits.source': 'where the visit was recorded',
  'visits.accred_group': 'a population group code',
  'visits.purpose': 'a visit purpose code',
};

/** Free-text columns of the visits tables that are not personal data, each with the reason. */
const VISITS_NON_PERSONAL: Record<string, string> = {
  'visit_stations.name': 'the name of a guestbook device chosen by the library',
  'visits.class_name': 'the class a visit is counted in for statistics, kept after anonymisation',
};

// ---- Komunitas (charges and payments) ----
const CHARGES_TABLES = Object.values(CHARGES_TABLES_BY_MIGRATION).flat() as TableName[];

/** Text columns of the charges and payments tables holding a code from a fixed list or a value ALTIS computes. */
const CHARGES_CODE_COLUMNS: Record<string, string> = {
  'charges.kind': 'a charge kind',
  'charges.currency': 'a currency code',
  'charges.status': 'a charge status',
  'charges.source': 'where the charge came from (desk, system or migrated)',
  'charge_adjustments.kind': 'an adjustment kind (waive or cancel)',
  'payments.currency': 'a currency code',
  'payments.method': 'a payment method code',
  'payments.source': 'where the payment came from (desk or migrated)',
};

/** Free-text columns of the charges and payments tables that are not personal data, each with the reason. */
const CHARGES_NON_PERSONAL: Record<string, string> = {
  'payments.receipt_no': 'the receipt number the library assigns',
};

// ---- Komunitas (notices) ----
/** Text columns of the notices table: codes from fixed lists and a list of ids; the mail's text is never kept. */
const NOTICES_CODE_COLUMNS: Record<string, string> = {
  'notices.kind': 'a notice kind (due soon, overdue, hold ready)',
  'notices.channel': 'the channel code (email)',
  'notices.status': 'a notice status',
  'notices.reason': 'a skip or failure reason code',
  'notices.loan_ids': 'a JSON list of loan ids',
};

/** The columns of `table` in a primary key, a unique index or a foreign key. */
function keyColumns(table: TableName): Set<string> {
  const keys = TABLE_KEYS[table];
  return new Set([...keys.pk, ...keys.unique.flat(), ...keys.fks.map((f) => f.column)]);
}

/** The text columns of `tables` that are not keys, as `table.column`. */
function textColumnsOf(tables: readonly TableName[]): string[] {
  return tables.flatMap((table) => {
    const keys = keyColumns(table);
    return TABLE_COLUMNS[table].filter((c) => TEXT_KINDS.has(c.kind) && !keys.has(c.name)).map((c) => `${table}.${c.name}`);
  });
}

/** The text columns of the K1 tables that are not keys, as `table.column`. */
function k1TextColumns(): string[] {
  return textColumnsOf(K1_TABLES);
}

/** `table.column` of every registered personal column. */
function registered(): string[] {
  return Object.entries(PERSONAL_COLUMNS).flatMap(([table, list]) => (list ?? []).map((p) => `${table}.${p.column}`));
}

describe('PERSONAL_COLUMNS', () => {
  it('names columns of TABLE_COLUMNS only, once each, with a known category; frozen', () => {
    expect(Object.isFrozen(PERSONAL_COLUMNS)).toBe(true);
    for (const [table, list] of Object.entries(PERSONAL_COLUMNS)) {
      const columns = (TABLE_COLUMNS[table as TableName] ?? []).map((c) => c.name);
      expect({ table, known: columns.length > 0 }).toEqual({ table, known: true });
      expect(Object.isFrozen(list)).toBe(true);
      const names = (list ?? []).map((p) => p.column);
      expect({ table, names: new Set(names).size }).toEqual({ table, names: names.length });
      for (const p of list ?? []) {
        expect({ table, column: p.column, exists: columns.includes(p.column) }).toEqual({ table, column: p.column, exists: true });
        expect(CATEGORIES).toContain(p.category);
        expect(Object.isFrozen(p)).toBe(true);
      }
    }
  });

  it('puts JSON paths only on JSON or TEXT columns, each a plain field name, none repeated', () => {
    const withPaths = Object.entries(PERSONAL_COLUMNS).flatMap(([table, list]) =>
      (list ?? []).filter((p) => p.jsonPaths !== undefined).map((p) => ({ table: table as TableName, p })),
    );
    expect(withPaths.length).toBeGreaterThan(0);
    for (const { table, p } of withPaths) {
      const kind = TABLE_COLUMNS[table].find((c) => c.name === p.column)?.kind;
      expect({ column: `${table}.${p.column}`, kind }).toEqual({ column: `${table}.${p.column}`, kind: expect.stringMatching(/^(json|text)$/) });
      const paths = p.jsonPaths ?? [];
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(path).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });

  it('holds the Komunitas entries: supplier contacts, staff accounts, accreditation staff, answer notes, the period profile, members, loan notes and the stocktake officer name', () => {
    expect(PERSONAL_COLUMNS).toEqual({
      suppliers: [
        { column: 'contact_name', category: 'identity' },
        { column: 'phone', category: 'contact' },
        { column: 'email', category: 'contact' },
        { column: 'address', category: 'contact' },
      ],
      staff_users: [
        { column: 'name', category: 'identity' },
        { column: 'username_display', category: 'identity' },
        { column: 'email_key', category: 'contact' },
        { column: 'email_display', category: 'contact' },
      ],
      library_staff: [
        { column: 'name', category: 'identity' },
        { column: 'appointment_ref', category: 'identity' },
      ],
      accred_answers: [{ column: 'note', category: 'free_text' }],
      accred_periods: [{ column: 'profile', category: 'identity', jsonPaths: ['schoolHead', 'libraryHead', 'libraryHeadId', 'phone', 'email'] }],
      members: [
        { column: 'status_note', category: 'free_text' },
        { column: 'name', category: 'identity' },
        { column: 'name_key', category: 'identity' },
        { column: 'gender', category: 'identity' },
        { column: 'birth_date', category: 'identity' },
        { column: 'identity_no', category: 'identity' },
        { column: 'institution', category: 'identity' },
        { column: 'class_name', category: 'identity' },
        { column: 'email', category: 'contact' },
        { column: 'phone', category: 'contact' },
        { column: 'address', category: 'contact' },
        { column: 'postal_code', category: 'contact' },
        { column: 'mailing_address', category: 'contact' },
        { column: 'notes', category: 'free_text' },
        { column: 'photo_file_id', category: 'photo' },
        { column: 'password_hash', category: 'credential' },
      ],
      loans: [{ column: 'override_note', category: 'free_text' }],
      member_clearances: [{ column: 'void_reason', category: 'free_text' }],
      visits: [
        { column: 'guest_name', category: 'identity' },
        { column: 'guest_institution', category: 'identity' },
        { column: 'note', category: 'free_text' },
      ],
      charges: [{ column: 'description', category: 'free_text' }],
      charge_adjustments: [{ column: 'reason_text', category: 'free_text' }],
      payments: [
        { column: 'note', category: 'free_text' },
        { column: 'void_reason', category: 'free_text' },
      ],
      stocktake_items: [{ column: 'scanned_by_name', category: 'identity' }],
    });
  });

  // ---- Komunitas K2 (visits) ----
  it('classifies every text column of the 2 visits tables that is not a key; no stale exception', () => {
    expect(VISITS_TABLES).toEqual(['visit_stations', 'visits']);
    const personal = new Set(registered());
    const text = textColumnsOf(VISITS_TABLES);
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const column of text) {
      const places = [personal.has(column), Object.hasOwn(VISITS_CODE_COLUMNS, column), Object.hasOwn(VISITS_NON_PERSONAL, column)].filter(Boolean);
      if (places.length === 0) unclassified.push(column);
      if (places.length > 1) twice.push(column);
    }
    expect(unclassified).toEqual([]);
    expect(twice).toEqual([]);
    for (const column of [...Object.keys(VISITS_CODE_COLUMNS), ...Object.keys(VISITS_NON_PERSONAL)]) {
      expect({ column, isText: text.includes(column) }).toEqual({ column, isText: true });
    }
  });

  // ---- Komunitas (members and circulation) ----
  it('classifies every text column of the 5 members and circulation tables that is not a key; no stale exception', () => {
    expect(CIRCULATION_TABLES).toEqual(['member_types', 'members', 'member_events', 'policies', 'loans']);
    const personal = new Set(registered());
    const text = textColumnsOf(CIRCULATION_TABLES);
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const column of text) {
      const places = [personal.has(column), Object.hasOwn(CIRCULATION_CODE_COLUMNS, column), Object.hasOwn(CIRCULATION_NON_PERSONAL, column)].filter(Boolean);
      if (places.length === 0) unclassified.push(column);
      if (places.length > 1) twice.push(column);
    }
    expect(unclassified).toEqual([]);
    expect(twice).toEqual([]);
    for (const [column, reason] of [...Object.entries(CIRCULATION_CODE_COLUMNS), ...Object.entries(CIRCULATION_NON_PERSONAL)]) {
      expect({ column, isText: text.includes(column) }).toEqual({ column, isText: true });
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  // ---- Komunitas (holds) ----
  it('the holds table has no personal column: every text column that is not a key is a code', () => {
    expect(HOLDS_TABLES).toEqual(['holds']);
    const personal = new Set(registered());
    const text = textColumnsOf(HOLDS_TABLES);
    expect(text.filter((c) => personal.has(c))).toEqual([]);
    expect([...text].sort()).toEqual(Object.keys(HOLDS_CODE_COLUMNS).sort());
  });

  // ---- Komunitas (circulation core) ----
  it('classifies every text column of the 3 circulation core tables that is not a key; no stale exception', () => {
    expect(CIRC_CORE_TABLES).toEqual(['calendars', 'item_uses', 'member_clearances']);
    const personal = new Set(registered());
    const text = textColumnsOf(CIRC_CORE_TABLES);
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const column of text) {
      const places = [personal.has(column), Object.hasOwn(CIRC_CORE_CODE_COLUMNS, column), Object.hasOwn(CIRC_CORE_NON_PERSONAL, column)].filter(Boolean);
      if (places.length === 0) unclassified.push(column);
      if (places.length > 1) twice.push(column);
    }
    expect(unclassified).toEqual([]);
    expect(twice).toEqual([]);
    for (const [column, reason] of [...Object.entries(CIRC_CORE_CODE_COLUMNS), ...Object.entries(CIRC_CORE_NON_PERSONAL)]) {
      expect({ column, isText: text.includes(column) }).toEqual({ column, isText: true });
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  // ---- Komunitas (member area) ----
  it('the member area tables (bookmarks, attachment member types) hold keys and dates only', () => {
    const tables = Object.values(MEMBER_AREA_TABLES_BY_MIGRATION).flat() as TableName[];
    expect(tables).toEqual(['member_bookmarks', 'attachment_member_types']);
    expect(textColumnsOf(tables)).toEqual([]);
  });

  // ---- Komunitas (charges and payments) ----
  it('classifies every text column of the 4 charges and payments tables that is not a key; no stale exception', () => {
    expect(CHARGES_TABLES).toEqual(['charges', 'charge_adjustments', 'payments', 'payment_allocations']);
    const personal = new Set(registered());
    const text = textColumnsOf(CHARGES_TABLES);
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const column of text) {
      const places = [personal.has(column), Object.hasOwn(CHARGES_CODE_COLUMNS, column), Object.hasOwn(CHARGES_NON_PERSONAL, column)].filter(Boolean);
      if (places.length === 0) unclassified.push(column);
      if (places.length > 1) twice.push(column);
    }
    expect(unclassified).toEqual([]);
    expect(twice).toEqual([]);
    for (const [column, reason] of [...Object.entries(CHARGES_CODE_COLUMNS), ...Object.entries(CHARGES_NON_PERSONAL)]) {
      expect({ column, isText: text.includes(column) }).toEqual({ column, isText: true });
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  // ---- Komunitas (notices) ----
  it('the notices table has no personal column: its text columns that are not keys are codes and ids', () => {
    const tables = Object.values(NOTICES_TABLES_BY_MIGRATION).flat() as TableName[];
    expect(tables).toEqual(['notices']);
    const personal = new Set(registered());
    const text = textColumnsOf(tables);
    expect(text.filter((c) => personal.has(c))).toEqual([]);
    expect([...text].sort()).toEqual(Object.keys(NOTICES_CODE_COLUMNS).sort());
  });

  // ---- Komunitas K4 (stocktake) ----
  it('stocktake: only the officer name a migrated session carries is personal; the other text columns are codes, names of the library and JSON of ids', () => {
    const tables = Object.values(STOCKTAKE_TABLES_BY_MIGRATION).flat() as TableName[];
    expect(tables).toEqual(['stocktakes', 'stocktake_items', 'stocktake_unknown_codes']);
    const personal = new Set(registered());
    const text = textColumnsOf(tables);
    expect(text.filter((c) => personal.has(c))).toEqual(['stocktake_items.scanned_by_name']);
    expect(text.filter((c) => !personal.has(c)).sort()).toEqual(
      [
        'stocktakes.name',
        'stocktakes.scope',
        'stocktakes.status',
        'stocktakes.options',
        'stocktakes.source',
        'stocktake_items.state',
        'stocktake_items.expected_status',
        'stocktake_items.stat_ddc',
        'stocktake_items.result',
        'stocktake_unknown_codes.code_display',
      ].sort(),
    );
  });

  it('a member: every column a person could be recognised by is registered; the number, type and dates are not', () => {
    for (const column of ['name', 'name_key', 'identity_no', 'class_name', 'email', 'phone', 'address', 'photo_file_id', 'password_hash', 'birth_date']) {
      expect({ column, personal: isPersonalColumn('members', column) }).toEqual({ column, personal: true });
    }
    for (const column of ['member_no_display', 'member_no_key', 'member_type_id', 'status', 'expires_on']) {
      expect({ column, personal: isPersonalColumn('members', column) }).toEqual({ column, personal: false });
    }
    expect(isPersonalColumn('loans', 'override_note')).toBe(true);
    expect(isPersonalColumn('loans', 'stat_class_name')).toBe(false);
  });

  it('classifies every text column of the 14 K1 tables that is not a key: personal, a code, or named as not personal', () => {
    expect(K1_TABLES).toHaveLength(14);
    const personal = new Set(registered());
    const unclassified: string[] = [];
    const twice: string[] = [];
    for (const column of k1TextColumns()) {
      const places = [personal.has(column), Object.hasOwn(K1_CODE_COLUMNS, column), Object.hasOwn(K1_NON_PERSONAL, column)].filter(Boolean);
      if (places.length === 0) unclassified.push(column);
      if (places.length > 1) twice.push(column);
    }
    expect(unclassified).toEqual([]);
    expect(twice).toEqual([]);
  });

  it('names no stale column in its exception lists: each is a text column of a K1 table, not a key, with a reason', () => {
    const text = new Set(k1TextColumns());
    for (const [column, reason] of [...Object.entries(K1_CODE_COLUMNS), ...Object.entries(K1_NON_PERSONAL)]) {
      expect({ column, isText: text.has(column) }).toEqual({ column, isText: true });
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  it('a free-text column added to a K1 table without a classification is caught', () => {
    const columns = [...k1TextColumns(), 'library_activities.speaker_name'];
    const personal = new Set(registered());
    const unclassified = columns.filter(
      (c) => !personal.has(c) && !Object.hasOwn(K1_CODE_COLUMNS, c) && !Object.hasOwn(K1_NON_PERSONAL, c),
    );
    expect(unclassified).toEqual(['library_activities.speaker_name']);
  });

  // ---- Komunitas (OPAC home page) ----
  it('the OPAC home aggregates hold no personal column: their one text column is a class shared by several borrowers', () => {
    const tables = Object.values(OPAC_HOME_TABLES_BY_MIGRATION).flat() as TableName[];
    expect(tables).toEqual(['opac_popular_titles', 'opac_class_activity']);
    const personal = new Set(registered());
    const text = textColumnsOf(tables);
    expect(text.filter((c) => personal.has(c))).toEqual([]);
    // A class name, as `loans.stat_class_name` (not personal either), kept only when five or more members borrowed in it.
    expect(text).toEqual(['opac_class_activity.class_name']);
  });

  it('isPersonalColumn answers for a registered column only', () => {
    expect(isPersonalColumn('library_staff', 'name')).toBe(true);
    expect(isPersonalColumn('library_staff', 'appointment_ref')).toBe(true);
    expect(isPersonalColumn('accred_periods', 'profile')).toBe(true);
    expect(isPersonalColumn('suppliers', 'email')).toBe(true);
    expect(isPersonalColumn('library_staff', 'role')).toBe(false);
    expect(isPersonalColumn('suppliers', 'name')).toBe(false);
    expect(isPersonalColumn('library_activities', 'title')).toBe(false);
    expect(isPersonalColumn('library_staff', 'toString')).toBe(false);
    expect(isPersonalColumn('nope' as TableName, 'name')).toBe(false);
  });

  it('personalLogKeys: every registered column name and JSON path, lower case without underscores', () => {
    const keys = personalLogKeys();
    const expected = new Set(
      Object.values(PERSONAL_COLUMNS).flatMap((list) =>
        (list ?? []).flatMap((p) => [p.column, ...(p.jsonPaths ?? [])].map((k) => k.toLowerCase().replace(/_/g, ''))),
      ),
    );
    expect([...keys].sort()).toEqual([...expected].sort());
    for (const key of ['appointmentref', 'schoolhead', 'libraryhead', 'libraryheadid', 'contactname', 'usernamedisplay', 'emailkey', 'name', 'note', 'profile', 'phone', 'email', 'address']) {
      expect({ key, has: keys.has(key) }).toEqual({ key, has: true });
    }
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]+$/);
    expect(keys.has('appointment_ref')).toBe(false);
    expect(personalLogKeys()).toBe(keys);
  });
});
