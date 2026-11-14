/**
 * The shared texts of the member area (the OPAC `/akun` pages and what staff set for it): the audit actions, the
 * attachment access for members and the password-reset mail of a member. `MEMBER_AREA_ID` is the source of the keys
 * and `MEMBER_AREA_EN` is typed against it, so a key without its English text fails `tsc`; both are spread once into the
 * shared catalogs (`i18n/id.ts`, `i18n/en.ts`). The OPAC pages keep their own strings beside them in apps/server.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const MEMBER_AREA_ID = {
  // ---- audit.<action> ----
  'audit.members.member.password_set': 'Mengatur kata sandi OPAC anggota',
  'audit.members.self.password_change': 'Anggota mengganti kata sandinya',
  'audit.members.self.password_reset': 'Anggota mengatur ulang kata sandinya lewat e-mail',
  'audit.members.self.data_export': 'Anggota mengunduh data dirinya',
  'audit.members.self.login_locked': 'Masuk OPAC anggota ditahan karena terlalu banyak percobaan',
  // ---- vocab.<list>.<value> ----
  'vocab.attachment_access.members': 'Anggota yang masuk',
  // ---- mail: plain text only ----
  'mail.member_password_reset.subject': 'Atur ulang kata sandi anggota Anda di {library}',
  'mail.member_password_reset.body': [
    'Halo {name},',
    '',
    'Kami menerima permintaan untuk mengatur ulang kata sandi OPAC anggota nomor {memberNo} di {library}.',
    '',
    'Buka tautan berikut untuk membuat kata sandi yang baru. Tautan ini berlaku {minutes} menit dan hanya dapat dipakai satu kali:',
    '',
    '{link}',
    '',
    'Jika Anda tidak meminta ini, abaikan saja email ini. Kata sandi Anda tidak berubah.',
    '',
    'Salam,',
    '{library}',
  ].join('\n'),
};

export const MEMBER_AREA_EN: Record<keyof typeof MEMBER_AREA_ID, string> = {
  'audit.members.member.password_set': "Set a member's OPAC password",
  'audit.members.self.password_change': 'A member changed their password',
  'audit.members.self.password_reset': 'A member reset their password by e-mail',
  'audit.members.self.data_export': 'A member downloaded their own data',
  'audit.members.self.login_locked': 'Member sign-in held back after too many attempts',
  'vocab.attachment_access.members': 'Signed-in members',
  'mail.member_password_reset.subject': 'Reset your member password at {library}',
  'mail.member_password_reset.body': [
    'Hello {name},',
    '',
    'We received a request to reset the OPAC password of member number {memberNo} at {library}.',
    '',
    'Open the link below to choose a new password. The link works for {minutes} minutes and only once:',
    '',
    '{link}',
    '',
    'If you did not ask for this, ignore this email. Your password has not changed.',
    '',
    'Regards,',
    '{library}',
  ].join('\n'),
};
