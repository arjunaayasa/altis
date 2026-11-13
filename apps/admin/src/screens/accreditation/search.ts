// The search params of the accreditation workspace: the open tab of a period. No React here, so the route's
// `validateSearch` does not pull the screen out of its lazy chunk.

/** The tabs of a period, in their order, as the `tab` search param names them. */
export const ACCREDITATION_TABS = Object.freeze([
  'ringkasan',
  'indikator',
  'profil',
  'populasi',
  'register',
  'penggunaan',
  'snp',
  'cetak',
  'riwayat',
] as const);

export type AccreditationTab = (typeof ACCREDITATION_TABS)[number];

/** The search params of `/admin/accreditation/$periodId`. */
export interface AccreditationSearch {
  tab?: AccreditationTab;
}

/** Whether `value` names a tab of a period. */
export function isAccreditationTab(value: unknown): value is AccreditationTab {
  return typeof value === 'string' && (ACCREDITATION_TABS as readonly string[]).includes(value);
}

/** The search params from what the router parsed: a tab it does not know is dropped (the screen opens its first). */
export function validateAccreditationSearch(raw: Record<string, unknown>): AccreditationSearch {
  return isAccreditationTab(raw['tab']) ? { tab: raw['tab'] } : {};
}
