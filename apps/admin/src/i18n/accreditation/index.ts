// The admin copy of the accreditation workspace frame and the new period form, keys `accreditation.*`, filled by the
// task that builds those screens. `ACCREDITATION_ID` is the source of the keys and `ACCREDITATION_EN` is typed against
// it (a missing English text fails `tsc`); both are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread,
// and held to the shared rules there (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both
// languages, no English left in `id`, no shared family prefix.

export const ACCREDITATION_ID = {} as const;

export const ACCREDITATION_EN: Readonly<Record<keyof typeof ACCREDITATION_ID, string>> = {};
