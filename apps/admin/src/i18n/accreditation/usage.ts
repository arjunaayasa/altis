// The admin copy of the Penggunaan Bulanan tab, its SLiMS import wizard and the SNP tab, keys `accreditation.usage.*`
// and `accreditation.snp.*`, filled by the task that builds those screens. `ACCREDITATION_USAGE_ID` is the source of
// the keys and `ACCREDITATION_USAGE_EN` is typed against it (a missing English text fails `tsc`); both are joined in
// i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and held to the shared rules there
// (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages, no English left in `id`, no
// shared family prefix.

export const ACCREDITATION_USAGE_ID = {} as const;

export const ACCREDITATION_USAGE_EN: Readonly<Record<keyof typeof ACCREDITATION_USAGE_ID, string>> = {};
