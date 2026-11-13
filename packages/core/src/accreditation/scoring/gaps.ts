import type { ScoreView } from '@altis/shared/api/accreditation';

// The gap list: how much each indicator's answer stands below an a, (4 − score) · W_k / (4 · n_k) of the estimate,
// with an unanswered indicator counted as a d. Gaps are compared exactly in whole numbers over the scale of the
// estimate; the largest ten are listed (an indicator at a has no gap), ties in component order K, SP, L, T, F, G and
// then by item number (L10 after L9), each with four decimals, cut.

/** How many gaps the list shows. */
export const GAP_LIST_SIZE = 10;

const COMPONENT_ORDER: readonly string[] = ['K', 'SP', 'L', 'T', 'F', 'G'];

/** One indicator's gap: `scaled` is (4 − score) · W_k · (L / (4 · n_k)), the gap times `lcm`. */
export interface GapInput {
  code: string;
  officialNo: string;
  component: string;
  actionKey: string;
  scaled: number;
}

/** The number of an item (`L10` → 10). */
const itemNumber = (officialNo: string): number => Number(/\d+$/.exec(officialNo)?.[0] ?? 0);

const componentRank = (code: string): number => {
  const k = COMPONENT_ORDER.indexOf(code);
  return k === -1 ? COMPONENT_ORDER.length : k;
};

/** `scaled / lcm` with four decimals, cut. */
export function formatGap(scaled: number, lcm: number): string {
  const tenThousandths = (scaled * 10_000 - ((scaled * 10_000) % lcm)) / lcm;
  return `${(tenThousandths - (tenThousandths % 10_000)) / 10_000}.${String(tenThousandths % 10_000).padStart(4, '0')}`;
}

/** The largest gaps of `gaps`, in list order. */
export function largestGaps(gaps: readonly GapInput[], lcm: number): ScoreView['gaps'] {
  return gaps
    .filter((g) => g.scaled > 0)
    .sort(
      (x, y) =>
        y.scaled - x.scaled ||
        componentRank(x.component) - componentRank(y.component) ||
        itemNumber(x.officialNo) - itemNumber(y.officialNo) ||
        (x.officialNo < y.officialNo ? -1 : x.officialNo > y.officialNo ? 1 : 0),
    )
    .slice(0, GAP_LIST_SIZE)
    .map((g) => ({ code: g.code, officialNo: g.officialNo, component: g.component, gap: formatGap(g.scaled, lcm), actionKey: g.actionKey }));
}
