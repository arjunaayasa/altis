// The admin copy of Pengaturan Akreditasi, keys `accreditation.settings.*`, filled by the task that builds those
// screens. `KOMUNITAS_SETTINGS_ID` is the source of the keys and `KOMUNITAS_SETTINGS_EN` is typed against it (a
// missing English text fails `tsc`); both are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and
// held to the shared rules there (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages,
// no English left in `id`, no shared family prefix.

export const KOMUNITAS_SETTINGS_ID = {} as const;

export const KOMUNITAS_SETTINGS_EN: Readonly<Record<keyof typeof KOMUNITAS_SETTINGS_ID, string>> = {};
