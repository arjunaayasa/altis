/**
 * The shared texts of the register annexes of accreditation: the staff ratio rows and any other fixed row label of
 * those annexes; keys `report.row.registers.*`. This file belongs to the task that writes those reports and is the one
 * shared message file it may edit. `ANNEX_REGISTERS_ID` is the source of the keys and `ANNEX_REGISTERS_EN` is typed
 * against it, so a key without its English text fails `tsc`; both are spread once into the shared catalogs
 * (`i18n/id.ts`, `i18n/en.ts`) and held to their rules: the same {placeholders} in both languages, no English left in
 * the Indonesian text.
 *
 * - `yes`, `no`: the cells of the staff list's yes/no columns (librarian, library training, certificate, association).
 * - `education_library`: added to a staff member's education when it is in library science.
 * - `ratio.*`: the rows of the staff ratios, in the order the annex lists them.
 * - `budget_mean`: the last row of the budget annex, the library's mean share over the three budget years.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const ANNEX_REGISTERS_ID = {
  'report.row.registers.yes': 'Ya',
  'report.row.registers.no': 'Tidak',
  'report.row.registers.education_library': 'ilmu perpustakaan',
  'report.row.registers.ratio.active_staff': 'Tenaga yang aktif pada akhir periode',
  'report.row.registers.ratio.librarians': 'Pustakawan di antara tenaga aktif',
  'report.row.registers.ratio.population': 'Warga sekolah (siswa, guru, dan tenaga kependidikan)',
  'report.row.registers.ratio.population_per_staff': 'Warga sekolah per tenaga aktif (dipotong ke bilangan bulat)',
  'report.row.registers.ratio.staff_pcs': 'Komputer untuk tenaga perpustakaan',
  'report.row.registers.ratio.staff_pcs_pct': 'Komputer untuk tenaga per tenaga aktif (%, dipotong)',
  'report.row.registers.ratio.trainings_3p': 'Pelatihan tenaga aktif dalam tiga periode',
  'report.row.registers.ratio.training_avg_3p': 'Rerata pelatihan per tenaga aktif dalam tiga periode (dipotong ke bilangan bulat)',
  'report.row.registers.budget_mean': 'Rerata tiga tahun anggaran',
} as const;

export const ANNEX_REGISTERS_EN: Readonly<Record<keyof typeof ANNEX_REGISTERS_ID, string>> = {
  'report.row.registers.yes': 'Yes',
  'report.row.registers.no': 'No',
  'report.row.registers.education_library': 'library science',
  'report.row.registers.ratio.active_staff': 'Staff active at the end of the period',
  'report.row.registers.ratio.librarians': 'Librarians among the active staff',
  'report.row.registers.ratio.population': 'School community (students, teachers and education staff)',
  'report.row.registers.ratio.population_per_staff': 'School community per active staff member (cut to a whole number)',
  'report.row.registers.ratio.staff_pcs': 'Computers for the library staff',
  'report.row.registers.ratio.staff_pcs_pct': 'Computers for the staff per active staff member (%, cut)',
  'report.row.registers.ratio.trainings_3p': 'Trainings of the active staff in the three periods',
  'report.row.registers.ratio.training_avg_3p': 'Average trainings per active staff member in the three periods (cut to a whole number)',
  'report.row.registers.budget_mean': 'Mean of the three budget years',
};
