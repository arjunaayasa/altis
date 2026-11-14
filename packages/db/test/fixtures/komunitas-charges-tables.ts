import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, charges and payments: what tables.test.ts expects of the tables of migration 0043 (charges, their
// adjustments, payments with numbered receipts, allocations), written out by hand, independently of TABLE_CLASSES/
// TABLE_COLUMNS/TABLE_KEYS, in the notations of tables.test.ts. Kept in its own module so that tables.test.ts only
// spreads it in.

/** The tables of 0043. */
export type ChargesTable = 'charges' | 'charge_adjustments' | 'payments' | 'payment_allocations';

/** Every table of 0043 is class data. */
export const CHARGES_CLASSES: Record<ChargesTable, 'data'> = {
  charges: 'data',
  charge_adjustments: 'data',
  payments: 'data',
  payment_allocations: 'data',
};

/** Which migration creates which tables, in creation order. */
export const CHARGES_TABLES_BY_MIGRATION: Record<string, ChargesTable[]> = {
  '0043_charges': ['charges', 'charge_adjustments', 'payments', 'payment_allocations'],
};

export const CHARGES_PRIMARY_KEYS: Record<ChargesTable, string[]> = {
  charges: ['id'],
  charge_adjustments: ['id'],
  payments: ['id'],
  payment_allocations: ['payment_id', 'charge_id'],
};

export interface ChargesIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0043. */
export const CHARGES_INDEXES: ChargesIndexFacts[] = [
  { table: 'charge_adjustments', name: 'ix_charge_adjustments_charge_id', unique: false, columns: ['charge_id'] },
  { table: 'charges', name: 'ix_charges_charged_on', unique: false, columns: ['charged_on'] },
  { table: 'charges', name: 'ix_charges_loan_id', unique: false, columns: ['loan_id'] },
  { table: 'charges', name: 'ix_charges_member_id_status', unique: false, columns: ['member_id', 'status'] },
  { table: 'charges', name: 'ix_charges_status_branch_id', unique: false, columns: ['status', 'branch_id'] },
  { table: 'payment_allocations', name: 'ix_payment_allocations_charge_id', unique: false, columns: ['charge_id'] },
  { table: 'payments', name: 'ix_payments_member_id_paid_at', unique: false, columns: ['member_id', 'paid_at'] },
  { table: 'payments', name: 'ix_payments_paid_on_branch_id', unique: false, columns: ['paid_on', 'branch_id'] },
  { table: 'payments', name: 'uq_payments_branch_id_receipt_year_receipt_seq', unique: true, columns: ['branch_id', 'receipt_year', 'receipt_seq'] },
];

/** The unique indexes above as `table(columns)`. */
export const CHARGES_UNIQUE = CHARGES_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

export interface ChargesForeignKeyFacts {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

/** A charge owns its adjustments, a payment its allocations. */
export const CHARGES_FOREIGN_KEYS: ChargesForeignKeyFacts[] = [
  { table: 'charge_adjustments', column: 'charge_id', refTable: 'charges', refColumn: 'id', onDelete: 'cascade' },
  { table: 'payment_allocations', column: 'payment_id', refTable: 'payments', refColumn: 'id', onDelete: 'cascade' },
];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const CHARGES_COLUMNS: Record<ChargesTable, Record<string, string>> = {
  charges: {
    id: 'char(26)',
    member_id: 'char(26)',
    branch_id: 'char(26)',
    loan_id: 'char(26) null',
    item_id: 'char(26) null',
    kind: 'varchar(16)',
    description: 'varchar(191)',
    amount_minor: 'bigint',
    paid_minor: 'bigint default',
    waived_minor: 'bigint default',
    currency: 'char(3)',
    status: 'varchar(16)',
    charged_on: 'char(10)',
    charged_at: 'bigint',
    date_unknown: 'smallint default',
    source: 'varchar(16)',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  charge_adjustments: {
    id: 'char(26)',
    charge_id: 'char(26)',
    kind: 'varchar(16)',
    amount_minor: 'bigint',
    reason: 'varchar(191)',
    at: 'bigint',
    by: 'char(26) null',
  },
  payments: {
    id: 'char(26)',
    member_id: 'char(26)',
    branch_id: 'char(26)',
    receipt_year: 'smallint null',
    receipt_seq: 'integer null',
    receipt_no: 'varchar(64) null',
    amount_minor: 'bigint',
    currency: 'char(3)',
    method: 'varchar(16)',
    paid_on: 'char(10)',
    paid_at: 'bigint',
    received_by: 'char(26) null',
    note: 'varchar(191) null',
    voided_at: 'bigint null',
    voided_by: 'char(26) null',
    void_reason: 'varchar(191) null',
    date_unknown: 'smallint default',
    source: 'varchar(16)',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  payment_allocations: {
    payment_id: 'char(26)',
    charge_id: 'char(26)',
    amount_minor: 'bigint',
  },
};

/** The database default of every column the `DB` type marks `Generated`, per table. */
export const CHARGES_DEFAULTS = {
  charges: { paid_minor: 0, waived_minor: 0, date_unknown: 0, version: 0 },
  charge_adjustments: {},
  payments: { date_unknown: 0, version: 0 },
  payment_allocations: {},
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of every table of 0043, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B of a table sets every nullable column to null. `branchId` and `staffId` are rows of the Phase 1
 * sample. The ids are new ULIDs unless `newId` gives them; the times are fixed. An adjustment and an allocation point at
 * the charge and the payment of row A (their foreign keys).
 */
export function chargesSampleRows(o: { branchId: string; staffId: string; newId?: () => string }): {
  [T in ChargesTable]: Selectable<DB[T]>[];
} {
  const nextId = o.newId ?? newId;
  const chargeA = nextId();
  const chargeB = nextId();
  const paymentA = nextId();
  const paymentB = nextId();
  return {
    charges: [
      {
        id: chargeA,
        member_id: nextId(),
        branch_id: o.branchId,
        loan_id: nextId(),
        item_id: nextId(),
        kind: 'overdue',
        description: 'Terlambat 5 hari: B0001 Laskar Pelangi',
        amount_minor: 9_007_199_254_740_991,
        paid_minor: 250_000,
        waived_minor: 100_000,
        currency: 'IDR',
        status: 'open',
        charged_on: '2026-01-02',
        charged_at: EPOCH_MS,
        date_unknown: 1,
        source: 'system',
        version: 4,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: chargeB,
        member_id: nextId(),
        branch_id: o.branchId,
        loan_id: null,
        item_id: null,
        kind: 'manual',
        description: 'Kartu anggota baru',
        amount_minor: 1,
        paid_minor: 0,
        waived_minor: 0,
        currency: 'USD',
        status: 'cancelled',
        charged_on: '2020-02-29',
        charged_at: LATER_MS,
        date_unknown: 0,
        source: 'desk',
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
    charge_adjustments: [
      { id: nextId(), charge_id: chargeA, kind: 'waive', amount_minor: 100_000, reason: 'Siswa kurang mampu', at: LATER_MS, by: o.staffId },
      { id: nextId(), charge_id: chargeB, kind: 'cancel', amount_minor: 1, reason: 'Eksemplar kembali', at: EPOCH_MS, by: null },
    ],
    payments: [
      {
        id: paymentA,
        member_id: nextId(),
        branch_id: o.branchId,
        receipt_year: 2026,
        receipt_seq: 999_999,
        receipt_no: 'PST/2026/999999',
        amount_minor: 250_000,
        currency: 'IDR',
        method: 'transfer',
        paid_on: '2026-01-02',
        paid_at: EPOCH_MS,
        received_by: o.staffId,
        note: 'Dibayar oleh orang tua',
        voided_at: LATER_MS,
        voided_by: o.staffId,
        void_reason: 'Salah nominal',
        date_unknown: 1,
        source: 'desk',
        version: 2,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: paymentB,
        member_id: nextId(),
        branch_id: o.branchId,
        receipt_year: null,
        receipt_seq: null,
        receipt_no: null,
        amount_minor: 1,
        currency: 'IDR',
        method: 'other',
        paid_on: '2019-07-01',
        paid_at: LATER_MS,
        received_by: null,
        note: null,
        voided_at: null,
        voided_by: null,
        void_reason: null,
        date_unknown: 0,
        source: 'migrated',
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
    payment_allocations: [
      { payment_id: paymentA, charge_id: chargeA, amount_minor: 250_000 },
      { payment_id: paymentB, charge_id: chargeB, amount_minor: 1 },
    ],
  };
}
