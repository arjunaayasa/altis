import { ACCREDITATION_EN, ACCREDITATION_ID } from '../accreditation';
import { ACCREDITATION_PRINT_EN, ACCREDITATION_PRINT_ID } from '../accreditation/print';
import { ACCREDITATION_REGISTERS_EN, ACCREDITATION_REGISTERS_ID } from '../accreditation/registers';
import { ACCREDITATION_USAGE_EN, ACCREDITATION_USAGE_ID } from '../accreditation/usage';
import { ACCREDITATION_WORKSPACE_EN, ACCREDITATION_WORKSPACE_ID } from '../accreditation/workspace';
import { REPORTS_EN, REPORTS_ID } from '../reports';
import { CIRC_CORE_EN, CIRC_CORE_ID } from './circ-core';
import { CIRCULATION_EN, CIRCULATION_ID } from './circulation';
// ---- Komunitas (holds) ----
import { HOLDS_EN, HOLDS_ID } from './holds';
// ---- Komunitas (member area) ----
import { MEMBER_AREA_EN, MEMBER_AREA_ID } from './member-area';
// ---- Komunitas (charges and payments) ----
import { CHARGES_ADMIN_EN, CHARGES_ADMIN_ID } from './charges';
// ---- Komunitas (member, visit and circulation reports) ----
import { CIRC_REPORTS_ADMIN_EN, CIRC_REPORTS_ADMIN_ID } from './circ-reports';
// ---- Komunitas (notices) ----
import { NOTICES_ADMIN_EN, NOTICES_ADMIN_ID } from './notices';
// ---- Komunitas K4 (stocktake) ----
import { STOCKTAKE_ADMIN_EN, STOCKTAKE_ADMIN_ID } from './stocktake';
// ---- Komunitas K5 (reports) ----
import { REPORTS_K5_ADMIN_EN, REPORTS_K5_ADMIN_ID } from './reports-k5';
// ---- Komunitas (OPAC home page) ----
import { OPAC_HOME_ADMIN_EN, OPAC_HOME_ADMIN_ID } from './opac-home';
import { MEMBERS_EN, MEMBERS_ID } from './members';
import { MEMBERS_TOOLS_EN, MEMBERS_TOOLS_ID } from './members-tools';
import { KOMUNITAS_SETTINGS_EN, KOMUNITAS_SETTINGS_ID } from './settings';
// ---- Komunitas (desk and member screens' layout) ----
import { DESK_MEMBERS_UI_EN, DESK_MEMBERS_UI_ID } from './desk-members-ui';

// The admin copy of reports and accreditation, members and circulation: one file per area, each owned by the task that builds its screens,
// joined here and spread once into ADMIN_ID/ADMIN_EN (i18n/id.ts, i18n/en.ts), so that no later task edits those
// shared files. Keys start with `reports.` or `accreditation.` (admin-only families), never with a shared family such
// as `report.` or `accred.`, which come from @altis/shared through the same useT().

/**
 * The text each placeholder screen and tab shows until its task replaces it (components/komunitas/
 * screen-placeholder.tsx). One key per screen or tab.
 */
const PLACEHOLDER_ID = {
  'komunitas.placeholder.reports_catalog': 'Katalog laporan belum tersedia.',
  'komunitas.placeholder.report_detail': 'Halaman laporan belum tersedia.',
  'komunitas.placeholder.accreditation': 'Ruang akreditasi belum tersedia.',
  'komunitas.placeholder.period_create': 'Formulir periode akreditasi baru belum tersedia.',
  'komunitas.placeholder.accreditation_settings': 'Pengaturan akreditasi belum tersedia.',
  'komunitas.placeholder.tab_summary': 'Ringkasan akreditasi belum tersedia.',
  'komunitas.placeholder.tab_indicators': 'Daftar indikator belum tersedia.',
  'komunitas.placeholder.tab_profile': 'Profil perpustakaan untuk akreditasi belum tersedia.',
  'komunitas.placeholder.tab_population': 'Populasi dan sarana belum tersedia.',
  'komunitas.placeholder.tab_registers': 'Register akreditasi belum tersedia.',
  'komunitas.placeholder.tab_usage': 'Penggunaan bulanan belum tersedia.',
  'komunitas.placeholder.tab_snp': 'Kepatuhan SNP belum tersedia.',
  'komunitas.placeholder.tab_print': 'Cetak berkas akreditasi belum tersedia.',
  'komunitas.placeholder.tab_history': 'Riwayat periode belum tersedia.',
} as const;

const PLACEHOLDER_EN: Record<keyof typeof PLACEHOLDER_ID, string> = {
  'komunitas.placeholder.reports_catalog': 'The report catalogue is not available yet.',
  'komunitas.placeholder.report_detail': 'The report page is not available yet.',
  'komunitas.placeholder.accreditation': 'The accreditation workspace is not available yet.',
  'komunitas.placeholder.period_create': 'The new accreditation period form is not available yet.',
  'komunitas.placeholder.accreditation_settings': 'The accreditation settings are not available yet.',
  'komunitas.placeholder.tab_summary': 'The accreditation summary is not available yet.',
  'komunitas.placeholder.tab_indicators': 'The indicator list is not available yet.',
  'komunitas.placeholder.tab_profile': 'The library profile for accreditation is not available yet.',
  'komunitas.placeholder.tab_population': 'Population and facilities are not available yet.',
  'komunitas.placeholder.tab_registers': 'The accreditation registers are not available yet.',
  'komunitas.placeholder.tab_usage': 'Monthly usage is not available yet.',
  'komunitas.placeholder.tab_snp': 'SNP compliance is not available yet.',
  'komunitas.placeholder.tab_print': 'Printing the accreditation files is not available yet.',
  'komunitas.placeholder.tab_history': 'The period history is not available yet.',
};

/** The screens and tabs a placeholder stands for: `komunitas.placeholder.<screen>`. */
export type KomunitasPlaceholderScreen = keyof typeof PLACEHOLDER_ID extends `komunitas.placeholder.${infer S}` ? S : never;

/** Every area's Indonesian copy (the source of the keys), in a fixed order. */
export const KOMUNITAS_AREAS_ID = Object.freeze({
  reports: REPORTS_ID,
  accreditation: ACCREDITATION_ID,
  workspace: ACCREDITATION_WORKSPACE_ID,
  registers: ACCREDITATION_REGISTERS_ID,
  usage: ACCREDITATION_USAGE_ID,
  print: ACCREDITATION_PRINT_ID,
  settings: KOMUNITAS_SETTINGS_ID,
  members: MEMBERS_ID,
  circulation: CIRCULATION_ID,
  // ---- Komunitas (holds) ----
  holds: HOLDS_ID,
  // ---- Komunitas (circulation core) ----
  circCore: CIRC_CORE_ID,
  // ---- Komunitas K2 (members extended and visits) ----
  membersTools: MEMBERS_TOOLS_ID,
  // ---- Komunitas (member area) ----
  'member-area': MEMBER_AREA_ID,
  // ---- Komunitas (charges and payments) ----
  charges: CHARGES_ADMIN_ID,
  // ---- Komunitas (member, visit and circulation reports) ----
  circReports: CIRC_REPORTS_ADMIN_ID,
  // ---- Komunitas (notices) ----
  notices: NOTICES_ADMIN_ID,
  // ---- Komunitas K4 (stocktake) ----
  stocktake: STOCKTAKE_ADMIN_ID,
  // ---- Komunitas K5 (reports) ----
  reportsK5: REPORTS_K5_ADMIN_ID,
  // ---- Komunitas (OPAC home page) ----
  opacHome: OPAC_HOME_ADMIN_ID,
  placeholder: PLACEHOLDER_ID,
  // ---- Komunitas (desk and member screens' layout) ----
  deskMembersUi: DESK_MEMBERS_UI_ID,
});

/** Every area's English copy, in the same order. */
export const KOMUNITAS_AREAS_EN: { readonly [A in keyof typeof KOMUNITAS_AREAS_ID]: Readonly<Record<string, string>> } = Object.freeze({
  reports: REPORTS_EN,
  accreditation: ACCREDITATION_EN,
  workspace: ACCREDITATION_WORKSPACE_EN,
  registers: ACCREDITATION_REGISTERS_EN,
  usage: ACCREDITATION_USAGE_EN,
  print: ACCREDITATION_PRINT_EN,
  settings: KOMUNITAS_SETTINGS_EN,
  members: MEMBERS_EN,
  circulation: CIRCULATION_EN,
  holds: HOLDS_EN,
  // ---- Komunitas (circulation core) ----
  circCore: CIRC_CORE_EN,
  // ---- Komunitas K2 (members extended and visits) ----
  membersTools: MEMBERS_TOOLS_EN,
  'member-area': MEMBER_AREA_EN,
  // ---- Komunitas (charges and payments) ----
  charges: CHARGES_ADMIN_EN,
  // ---- Komunitas (member, visit and circulation reports) ----
  circReports: CIRC_REPORTS_ADMIN_EN,
  // ---- Komunitas (notices) ----
  notices: NOTICES_ADMIN_EN,
  // ---- Komunitas K4 (stocktake) ----
  stocktake: STOCKTAKE_ADMIN_EN,
  // ---- Komunitas K5 (reports) ----
  reportsK5: REPORTS_K5_ADMIN_EN,
  // ---- Komunitas (OPAC home page) ----
  opacHome: OPAC_HOME_ADMIN_EN,
  placeholder: PLACEHOLDER_EN,
  // ---- Komunitas (desk and member screens' layout) ----
  deskMembersUi: DESK_MEMBERS_UI_EN,
});

/** The Indonesian copy of reports and accreditation, spread into ADMIN_ID. */
export const KOMUNITAS_ID = {
  ...REPORTS_ID,
  ...ACCREDITATION_ID,
  ...ACCREDITATION_WORKSPACE_ID,
  ...ACCREDITATION_REGISTERS_ID,
  ...ACCREDITATION_USAGE_ID,
  ...ACCREDITATION_PRINT_ID,
  ...KOMUNITAS_SETTINGS_ID,
  ...MEMBERS_ID,
  ...CIRCULATION_ID,
  ...HOLDS_ID,
  ...CIRC_CORE_ID,
  ...MEMBERS_TOOLS_ID,
  ...MEMBER_AREA_ID,
  ...CHARGES_ADMIN_ID,
  ...CIRC_REPORTS_ADMIN_ID,
  ...NOTICES_ADMIN_ID,
  ...STOCKTAKE_ADMIN_ID,
  ...REPORTS_K5_ADMIN_ID,
  ...OPAC_HOME_ADMIN_ID,
  ...PLACEHOLDER_ID,
  ...DESK_MEMBERS_UI_ID,
} as const;

/** The English copy of reports and accreditation, spread into ADMIN_EN (typed against {@link KOMUNITAS_ID}). */
export const KOMUNITAS_EN: Record<keyof typeof KOMUNITAS_ID, string> = {
  ...REPORTS_EN,
  ...ACCREDITATION_EN,
  ...ACCREDITATION_WORKSPACE_EN,
  ...ACCREDITATION_REGISTERS_EN,
  ...ACCREDITATION_USAGE_EN,
  ...ACCREDITATION_PRINT_EN,
  ...KOMUNITAS_SETTINGS_EN,
  ...MEMBERS_EN,
  ...CIRCULATION_EN,
  ...HOLDS_EN,
  ...CIRC_CORE_EN,
  ...MEMBERS_TOOLS_EN,
  ...MEMBER_AREA_EN,
  ...CHARGES_ADMIN_EN,
  ...CIRC_REPORTS_ADMIN_EN,
  ...NOTICES_ADMIN_EN,
  ...STOCKTAKE_ADMIN_EN,
  ...REPORTS_K5_ADMIN_EN,
  ...OPAC_HOME_ADMIN_EN,
  ...PLACEHOLDER_EN,
  ...DESK_MEMBERS_UI_EN,
};
