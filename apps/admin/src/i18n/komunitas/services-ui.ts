// The admin copy of the remaining Layanan and Anggota screens' layout (calendar, loan rules, holds, notices, charges,
// visits, stocktake, member cards, clearance letters and the member page's extras): short words and button labels the
// shared layout pieces need. Keys start with `circulation.`, `holds.`, `notices.`, `charges.`, `visits.`,
// `stocktake.` or `members.`.

export const SERVICES_UI_ID = {
  'circulation.calendar.closed_short': 'Tutup',
  'circulation.policies.col.rule': 'Aturan',
  'circulation.policies.more_named': 'Tindakan untuk aturan {code}',
} as const;

export const SERVICES_UI_EN: Record<keyof typeof SERVICES_UI_ID, string> = {
  'circulation.calendar.closed_short': 'Closed',
  'circulation.policies.col.rule': 'Rule',
  'circulation.policies.more_named': 'Actions for rule {code}',
};
