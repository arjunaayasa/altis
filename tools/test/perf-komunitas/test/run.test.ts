import { describe, expect, it } from 'vitest';
import {
  KOMUNITAS_BUDGETS,
  KOMUNITAS_MODES,
  STOCKTAKE_COPIES,
  judgeKomunitas,
  parseRunArgs,
  stocktakeCopies,
  stocktakeScanPlan,
  type Measurement,
  type ScanCopy,
} from '../run.js';

// The community runner's stocktake mode, the parts that need no engine: its budgets, its command line, the copies a
// session takes in at a scale, and the scan lists of the four officers. The measurement itself seeds a database and
// runs the domain code (pnpm perf:komunitas --mode stocktake).

const shelf = (n: number): ScanCopy[] => Array.from({ length: n }, (_, i) => ({ barcode: `P2${String(i + 1).padStart(7, '0')}`, locationId: `SHELF-${i % 3}` }));
const outside: ScanCopy[] = [
  { barcode: 'OUT-1', locationId: 'OTHER' },
  { barcode: 'OUT-2', locationId: 'OTHER' },
];

describe('the stocktake mode', () => {
  it('has its budgets: preparation ≤ 5 minutes, scan p95 < 150 ms, finish ≤ 10 minutes, every slice ≤ 20 s', () => {
    expect(KOMUNITAS_MODES).toContain('stocktake');
    expect(KOMUNITAS_BUDGETS).toMatchObject({ stocktakePrepareMs: 300_000, stocktakeScanP95Ms: 150, stocktakeFinishMs: 600_000, sliceMs: 20_000 });
    const row = (value: number): Measurement => ({ mode: 'stocktake', name: 'scan p95', value, unit: 'ms', budget: KOMUNITAS_BUDGETS.stocktakeScanP95Ms, op: '<' });
    expect(judgeKomunitas([row(149.9)])).toEqual([]);
    expect(judgeKomunitas([row(150)])).toHaveLength(1);
  });

  it('is picked on the command line, and runs by default with the others', () => {
    expect(parseRunArgs(['--mode', 'stocktake', '--scale', '0.0134', '--assert'])).toMatchObject({ modes: ['stocktake'], scale: 0.0134, assert: true, db: 'sqlite' });
    expect(parseRunArgs([]).modes).toEqual(['reports', 'accred', 'migrate', 'stocktake']);
    expect(() => parseRunArgs(['--mode', 'stocktakes'])).toThrow(/^USAGE: --mode/);
  });

  it('takes in 150 000 copies at scale 1, as many as the scale says below it', () => {
    expect(STOCKTAKE_COPIES).toBe(150_000);
    expect(stocktakeCopies(1)).toBe(150_000);
    expect(stocktakeCopies(0.0134)).toBe(2_010);
    expect(stocktakeCopies(0.000001)).toBe(1);
  });

  it('gives each officer every fourth copy of the shelf with its shelf named, mixed with the cases officers meet', () => {
    const copies = shelf(1_000);
    const lists = stocktakeScanPlan(copies, { officers: 4, perOfficer: 1_000, outside, otherShelf: 'SHELF-X' });
    expect(lists).toHaveLength(4);
    const all = lists.flat();
    const own = new Set(copies.map((c) => c.barcode));
    // 90 % of the shelf, each copy once as an officer's own.
    const scannedCopies = new Set(all.filter((s) => own.has(s.barcode)).map((s) => s.barcode));
    expect(scannedCopies.size).toBe(900);
    lists.forEach((list, k) => {
      for (const s of list.filter((x) => own.has(x.barcode) && x.locationId !== 'SHELF-X')) {
        const i = Number(s.barcode.slice(2)) - 1;
        expect(s.locationId).toBe(copies[i]!.locationId);
        expect([k, (k + 1) % 4]).toContain(i % 4);
      }
    });
    // Misplaced copies, a copy shared with the next officer, unknown codes (some the same for every officer), another
    // branch's copies (the same for every officer) and copies scanned again.
    expect(all.filter((s) => s.locationId === 'SHELF-X').length).toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const list of lists) for (const code of new Set(list.map((s) => s.barcode))) counts.set(code, (counts.get(code) ?? 0) + 1);
    expect([...counts].filter(([code, n]) => own.has(code) && n === 2).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.barcode.startsWith('ZZ-PERF-')).length).toBeGreaterThan(0);
    expect([...counts].filter(([code, n]) => code.startsWith('ZZ-PERF-X-') && n === 4).length).toBeGreaterThan(0);
    expect(counts.get('OUT-2')).toBe(4);
    expect(lists.some((list) => list.some((s, i) => i > 0 && list[i - 1]!.barcode === s.barcode))).toBe(true);
  });

  it('stops at the scans per officer, and plans nothing for an empty shelf', () => {
    const lists = stocktakeScanPlan(shelf(10_000), { officers: 4, perOfficer: 100, outside: [], otherShelf: null });
    expect(lists.map((l) => l.length)).toEqual([100, 100, 100, 100]);
    expect(lists.flat().some((s) => s.barcode.startsWith('OUT'))).toBe(false);
    expect(stocktakeScanPlan([], { officers: 4, perOfficer: 100, outside, otherShelf: null })).toEqual([[], [], [], []]);
  });
});
