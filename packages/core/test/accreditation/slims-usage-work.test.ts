import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countLoan, emptyCounts, type MemberInfo, type RowContext } from '../../src/accreditation/slims-usage/count.js';
import { APPEND_FLUSH_BYTES, UsageWork, initialState } from '../../src/accreditation/slims-usage/work.js';

// The work files of the SLiMS usage import: what a slice appends waits in memory only until the flush bound, so a
// slice that reads a million rows holds no more than one that reads a thousand; bytes written before the slice saved
// its state are cut off by the next slice, as a kill leaves them; and the loan ids remembered across slices are those
// of `loan` only.

const SPANS = [
  { from: '2023-07-01', to: '2024-06-30' },
  { from: '2024-07-01', to: '2025-06-30' },
  { from: '2025-07-01', to: '2026-06-30' },
];
/** Rows the job reads in one page. */
const PAGE = 500;

const hashOf = (n: number): string => n.toString(16).padStart(32, '0');

describe('the usage import work files', () => {
  let dataDir: string;
  let runId: string;

  beforeEach(async () => {
    dataDir = path.join(await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-usage-work-'))), 'data');
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    runId = newId(Date.now());
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(dataDir), { recursive: true, force: true });
  });

  const open = () => UsageWork.open(dataDir, runId, () => initialState('members', SPANS));
  const fileSize = async (name: string): Promise<number | null> => (await fsp.stat(path.join(dataDir, 'tmp', runId, name)).catch(() => null))?.size ?? null;

  it('keeps no more than the flush bound and one page waiting, however many rows a slice reads', async () => {
    const w = await open();
    await w.save();
    // About three times the bound in check-ins and member lines, flushed after each page as the job does.
    const rows = Math.ceil((3 * APPEND_FLUSH_BYTES) / 60);
    let most = 0;
    for (let n = 0; n < rows; n += 1) {
      w.appendEntry('visits', '2026-03', { hash: hashOf(n), second: n % 2_678_400 });
      w.appendLine('usage-members.bin', [hashOf(n), '1', '2030-12-31']);
      if ((n + 1) % PAGE === 0) {
        await w.flushOver();
        most = Math.max(most, w.waitingBytes);
      }
    }
    expect(most).toBeLessThan(APPEND_FLUSH_BYTES + PAGE * 80);
    // The bytes are on disk before the slice saves its state.
    expect(await fileSize('usage-visits-2026-03.bin')).toBeGreaterThanOrEqual(2 * APPEND_FLUSH_BYTES * (20 / 80));
    expect(await fileSize('usage-members.bin')).toBeGreaterThan(APPEND_FLUSH_BYTES);
  });

  it('a slice killed after it wrote appends but before it saved leaves its work as the last saved state had it', async () => {
    const w = await open();
    for (let n = 0; n < 10; n += 1) w.appendEntry('visits', '2026-03', { hash: hashOf(n), second: n });
    await w.save();
    for (let n = 10; n < 60_000; n += 1) {
      w.appendEntry('visits', '2026-03', { hash: hashOf(n), second: n });
      w.appendLine('usage-loans.bin', String(n));
      if ((n + 1) % PAGE === 0) await w.flushOver();
    }
    expect(await fileSize('usage-visits-2026-03.bin')).toBeGreaterThan(10 * 20);
    // No save: the process is gone. The next slice opens the work the saved state describes.
    const next = await open();
    expect(await next.entries('visits', '2026-03')).toEqual(Array.from({ length: 10 }, (_, n) => ({ hash: hashOf(n), second: n })));
    expect(await next.loans()).toEqual(new Set());
    expect(await fileSize('usage-visits-2026-03.bin')).toBe(10 * 20);
    expect(await fileSize('usage-loans.bin')).toBeNull();
  });

  it('reads back every append in order, across chunks, a line longer than a chunk included', async () => {
    const w = await open();
    const long = 'x'.repeat(40_000);
    const lines: [string, string][] = [];
    for (let n = 0; n < 5_000; n += 1) {
      const line: [string, string] = [`t${n}`, n === 2_500 ? long : `ddc:${n % 10}`];
      lines.push(line);
      w.appendLine('usage-titles.bin', line);
      w.appendEntry('borrows', '2026-04', { hash: hashOf(n), second: 3 * n });
      if ((n + 1) % PAGE === 0) await w.flushOver(64 * 1024);
    }
    await w.save();
    const again = await open();
    expect([...(await again.titles())]).toEqual(lines);
    expect(await again.entries('borrows', '2026-04')).toEqual(Array.from({ length: 5_000 }, (_, n) => ({ hash: hashOf(n), second: 3 * n })));
    expect(again.state.months).toEqual(['2026-04']);
  });
});

describe('the loan ids the usage import remembers', () => {
  function context(): { c: RowContext; added: string[] } {
    const added: string[] = [];
    const seen = new Set<string>();
    const c: RowContext = {
      counts: emptyCounts(),
      cutoverOn: null,
      spans: SPANS,
      members: new Map<string, MemberInfo>(),
      items: new Map(),
      titles: new Map(),
      seenLoans: seen,
      types: {},
      addMember: () => undefined,
      addItem: () => undefined,
      addTitle: () => undefined,
      addLoanId: (id) => {
        seen.add(id);
        added.push(id);
      },
      entry: () => undefined,
      used: () => undefined,
    };
    return { c, added };
  }

  const loan = (id: number, date: string) => ({ loan_id: id, item_code: 'B001', member_id: '', loan_date: date });

  it('remembers the ids of loan rows only: a history row repeating one is skipped, a history id is not kept', () => {
    const { c, added } = context();
    countLoan(c, 'loan', loan(7, '2026-03-02'));
    countLoan(c, 'loan_history', loan(7, '2026-03-02'));
    countLoan(c, 'loan_history', loan(8, '2026-03-05'));
    countLoan(c, 'loan_history', loan(9, '2026-03-06'));
    expect(added).toEqual(['7']);
    expect(c.counts.loanSeenBefore).toBe(1);
    expect(c.counts.monthly['2026-03']!['loans']!['']).toBe(3);
  });
});
