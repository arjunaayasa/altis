// The admin copy of the Cetak tab, keys `accreditation.print.*`, filled by the task that builds those screens.
// `ACCREDITATION_PRINT_ID` is the source of the keys and `ACCREDITATION_PRINT_EN` is typed against it (a missing
// English text fails `tsc`); both are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and held to
// the shared rules there (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages, no
// English left in `id`, no shared family prefix.

export const ACCREDITATION_PRINT_ID = {} as const;

export const ACCREDITATION_PRINT_EN: Readonly<Record<keyof typeof ACCREDITATION_PRINT_ID, string>> = {};
