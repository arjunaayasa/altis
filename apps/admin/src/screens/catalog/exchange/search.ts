// The search params of Impor/Ekspor (Phase 2 Task 29): the open tab, and `export=selection` when Bibliografi's
// "Ekspor terpilih" (M2) left record ids in `sessionStorage` for the export form. No React here, so the route's
// `validateSearch` does not pull the screen out of its lazy chunk.

/** The tabs of Impor/Ekspor, in their order. */
export const EXCHANGE_TABS = Object.freeze(['import', 'export', 'runs'] as const);

export type ExchangeTab = (typeof EXCHANGE_TABS)[number];

/** The search params of `/admin/catalog/exchange`. */
export interface ExchangeSearch {
  tab?: ExchangeTab;
  /** Read the selection Bibliografi stored (once; the screen then replaces this with `tab=export`). */
  export?: 'selection';
}

/** Whether `value` names a tab of Impor/Ekspor. */
export function isExchangeTab(value: unknown): value is ExchangeTab {
  return typeof value === 'string' && (EXCHANGE_TABS as readonly string[]).includes(value);
}

/** The search params from what the router parsed: anything unknown or malformed is dropped. */
export function validateExchangeSearch(raw: Record<string, unknown>): ExchangeSearch {
  const out: ExchangeSearch = {};
  if (isExchangeTab(raw['tab'])) out.tab = raw['tab'];
  if (raw['export'] === 'selection') out.export = 'selection';
  return out;
}
