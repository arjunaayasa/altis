// The admin copy of the workspace tabs Ringkasan, Indikator, Profil, Populasi & Sarana and Riwayat, keys
// `accreditation.workspace.*`, filled by the task that builds those screens. `ACCREDITATION_WORKSPACE_ID` is the
// source of the keys and `ACCREDITATION_WORKSPACE_EN` is typed against it (a missing English text fails `tsc`); both
// are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and held to the shared rules there
// (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages, no English left in `id`, no
// shared family prefix.

export const ACCREDITATION_WORKSPACE_ID = {} as const;

export const ACCREDITATION_WORKSPACE_EN: Readonly<Record<keyof typeof ACCREDITATION_WORKSPACE_ID, string>> = {};
