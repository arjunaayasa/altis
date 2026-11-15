import { describe, expect, it } from 'vitest';
import { buildReceiptPdf, chargeStatusOf, overdueFineMinor, receiptLockName, receiptNumber, type ReceiptData } from '../src/index.js';
import { checkPdf } from './support/pdf-check.js';

// The arithmetic of charges without a database: the overdue fine (grace days, every day late, the cap, minor units
// only), a charge's status from its sums, the receipt number and lock name, and the receipt PDF on both rolls.

describe('the overdue fine', () => {
  const terms = { finePerDayMinor: 50_000, fineCapMinor: 500_000, graceDays: 2 };

  it('is 0 within the grace days, then the rate times every day late, at most the cap', () => {
    const table: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 150_000],
      [4, 200_000],
      [10, 500_000],
      [11, 500_000],
      [365, 500_000],
    ];
    for (const [days, fine] of table) expect({ days, fine: overdueFineMinor(days, terms) }).toEqual({ days, fine });
  });

  it('without a cap or grace days it grows by the rate each day; without a rate it is 0', () => {
    expect(overdueFineMinor(1, { finePerDayMinor: 25_050, fineCapMinor: null, graceDays: 0 })).toBe(25_050);
    expect(overdueFineMinor(100, { finePerDayMinor: 25_050, fineCapMinor: null, graceDays: 0 })).toBe(2_505_000);
    expect(overdueFineMinor(100, { finePerDayMinor: 0, fineCapMinor: null, graceDays: 0 })).toBe(0);
    expect(overdueFineMinor(-3, { finePerDayMinor: 100, fineCapMinor: null, graceDays: 0 })).toBe(0);
    // Never past the largest safe integer.
    expect(overdueFineMinor(1000, { finePerDayMinor: Number.MAX_SAFE_INTEGER, fineCapMinor: null, graceDays: 0 })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('is an integer for every combination (minor units, no rounding)', () => {
    for (let days = 0; days < 40; days++) {
      for (const perDay of [1, 99, 50_000, 123_457]) {
        for (const grace of [0, 1, 3, 7]) {
          for (const cap of [null, 0, 1, 1_000_000]) {
            const fine = overdueFineMinor(days, { finePerDayMinor: perDay, fineCapMinor: cap, graceDays: grace });
            expect(Number.isSafeInteger(fine)).toBe(true);
            expect(fine).toBe(days <= grace ? 0 : Math.min(perDay * days, cap ?? Number.MAX_SAFE_INTEGER));
          }
        }
      }
    }
  });
});

describe('a charge status', () => {
  it('is open while something is left, settled when nothing is, cancelled only when cancelled before any payment', () => {
    expect(chargeStatusOf(1000, 0, 0)).toBe('open');
    expect(chargeStatusOf(1000, 999, 0)).toBe('open');
    expect(chargeStatusOf(1000, 600, 400)).toBe('settled');
    expect(chargeStatusOf(1000, 0, 1000)).toBe('settled');
    expect(chargeStatusOf(1000, 0, 1000, true)).toBe('cancelled');
    expect(chargeStatusOf(1000, 1, 999, true)).toBe('settled');
  });
});

describe('receipts', () => {
  it('number `<branch code>/<year>/<6 digits>` and lock per branch and year', () => {
    expect(receiptNumber('PST', 2026, 1)).toBe('PST/2026/000001');
    expect(receiptNumber('PST', 2026, 123_456)).toBe('PST/2026/123456');
    expect(receiptNumber('PST', 2026, 1_234_567)).toBe('PST/2026/1234567');
    const branch = '01JZ0000000000000000000000';
    expect(receiptLockName(branch, 2026)).toBe(`circulation.receipt:${branch}:2026`);
    expect(() => receiptLockName(branch, 26)).toThrow(TypeError);
    expect(() => receiptLockName('not-a-branch', 2026)).toThrow(TypeError);
  });

  it('print on a 58 and an 80 mm roll, voided or not', () => {
    const data: ReceiptData = {
      library: { name: 'Perpustakaan SMA Contoh', address: 'Jl. Merdeka 1' },
      branchName: 'Pusat (PST)',
      member: { memberNo: 'S-001', name: 'Siti' },
      payment: {
        id: '01JZ0000000000000000000001',
        version: 0,
        memberId: '01JZ0000000000000000000002',
        branchId: '01JZ0000000000000000000003',
        receiptNo: 'PST/2026/000001',
        amount: '1500.00',
        currency: 'IDR',
        method: 'cash',
        paidOn: '2026-09-02',
        paidAt: Date.UTC(2026, 8, 2, 9),
        receivedBy: 'Petugas',
        note: null,
        voided: false,
        voidedAt: null,
        voidReason: null,
        allocations: [{ chargeId: '01JZ0000000000000000000004', amount: '1500.00', kind: 'overdue', description: 'Terlambat 3 hari: B001 Laskar Pelangi' }],
      },
      locale: 'id',
      paper: '58',
      footer: 'Terima kasih',
      time: '16:00',
    };
    for (const paper of ['58', '80'] as const) {
      for (const voided of [false, true]) {
        const pdf = Buffer.from(buildReceiptPdf({ ...data, paper, payment: { ...data.payment, voided } }));
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      }
    }

    // The roll page is as long as the receipt (a receipt printer feeds no blank paper): a short receipt is far under
    // the 210 mm of a sheet, and one with many lines grows past it, still on one page, with every line on the paper.
    const MM = 72 / 25.4;
    const many = Array.from({ length: 60 }, (_, k) => ({ ...data.payment.allocations[0]!, chargeId: `01JZ00000000000000000001${String(k).padStart(2, '0')}` }));
    for (const paper of ['58', '80'] as const) {
      const short = checkPdf(buildReceiptPdf({ ...data, paper })).pages;
      const long = checkPdf(buildReceiptPdf({ ...data, paper, payment: { ...data.payment, allocations: many } })).pages;
      expect([short.length, long.length]).toEqual([1, 1]);
      expect(short[0]!.width).toBeCloseTo(Number(paper) * MM, 2);
      expect(short[0]!.height).toBeLessThan(120 * MM);
      expect(long[0]!.height).toBeGreaterThan(210 * MM);
      for (const page of [short[0]!, long[0]!]) {
        const ys = page.texts.map((x) => x.y);
        expect(Math.min(...ys)).toBeGreaterThan(4 * MM);
        expect(Math.max(...ys)).toBeLessThan(page.height - 4 * MM);
        expect(page.texts.map((x) => x.text)).toContain('Terima kasih');
      }
      // Under the last line come only the empty footer band and the bottom margin.
      expect(Math.min(...short[0]!.texts.map((x) => x.y))).toBeLessThan(20 * MM);
    }
  });
});
