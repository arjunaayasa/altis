// The admin copy of Laporan (the report catalogue and a report's page), keys `reports.*`, filled by the task that
// builds those screens. `REPORTS_ID` is the source of the keys and `REPORTS_EN` is typed against it (a missing English
// text fails `tsc`); both are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and held to the
// shared rules there (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages, no English
// left in `id`, no shared family prefix.

export const REPORTS_ID = {} as const;

export const REPORTS_EN: Readonly<Record<keyof typeof REPORTS_ID, string>> = {};
