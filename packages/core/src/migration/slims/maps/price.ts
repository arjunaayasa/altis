// SLiMS item prices (Phase 2 spec §11.4 row `item` and `priceMode`; D2-28; plan Task 38). Pure.
//
// `priceMode`: `major` = SLiMS holds whole currency units (rupiah), stored ×100 in minor units; `minor` = SLiMS holds
// minor units already (whole numbers only); `skip` = prices are not migrated. A price that is not a non-negative
// number (at most 2 decimals in `major`) is not migrated (`invalidPrice`, reported). No price, no currency; a price
// with an empty or invalid currency (not three letters, e.g. `Rp`) takes `IDR` (`currencyFallback`, reported).

/** The largest price kept, in minor units (15 digits, the API's 13 + 2 decimals). */
const PRICE_MAX = 999_999_999_999_999;
const MAJOR = /^(\d{1,15})(?:\.(\d{1,2}))?$/;
const MINOR = /^\d{1,15}$/;

export type SlimsPriceMode = 'major' | 'minor' | 'skip';

export interface SlimsPrice {
  /** In the currency's minor unit, or null. */
  price: number | null;
  currency: string | null;
  invalidPrice: boolean;
  currencyFallback: boolean;
}

const NONE: SlimsPrice = Object.freeze({ price: null, currency: null, invalidPrice: false, currencyFallback: false });

/** The price SLiMS `price` and `price_currency` (numbers or cleaned text) become under `mode`. */
export function slimsPrice(price: unknown, currency: unknown, mode: SlimsPriceMode): SlimsPrice {
  if (mode === 'skip') return { ...NONE };
  const text = typeof price === 'number' ? (Number.isFinite(price) ? String(price) : 'x') : typeof price === 'string' ? price.trim() : '';
  if (price === null || price === undefined || text === '') return { ...NONE };
  let minor: number | null = null;
  if (mode === 'major') {
    const m = MAJOR.exec(text);
    if (m !== null) minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  } else if (MINOR.test(text)) {
    minor = Number(text);
  }
  if (minor === null || !Number.isSafeInteger(minor) || minor > PRICE_MAX) return { ...NONE, invalidPrice: true };
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code)
    ? { price: minor, currency: code, invalidPrice: false, currencyFallback: false }
    : { price: minor, currency: 'IDR', invalidPrice: false, currencyFallback: true };
}
