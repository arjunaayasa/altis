// The admin copy of the member area: the member type's OPAC options (holds and online renewal), setting a member's
// OPAC password, the member types of an attachment for signed-in members, and the member as an audit actor. Keys keep
// the families of the screens they sit in (`members.`, `catalog.attachments.`, `auditlog.`).

export const MEMBER_AREA_ID = {
  'members.types.field.opac': 'Layanan OPAC anggota',
  'members.types.field.holds_allowed': 'Boleh memesan judul (reservasi)',
  'members.types.field.holds_limit': 'Batas reservasi aktif',
  'members.types.field.online_renewal': 'Boleh memperpanjang pinjaman sendiri lewat OPAC',
  'members.types.opac.summary': 'Pesan: {holds}, perpanjang daring: {renew}',
  'members.types.opac.yes': 'ya',
  'members.types.opac.no': 'tidak',
  'members.password.open': 'Atur kata sandi OPAC…',
  'members.password.title': 'Kata sandi OPAC',
  'members.password.intro':
    'Atur kata sandi agar anggota bisa masuk ke Akun Anggota di OPAC dengan nomor anggotanya. Semua sesi anggota ini akan dikeluarkan.',
  'members.password.field': 'Kata sandi baru',
  'members.password.hint': 'Minimal 8 karakter (sesuai pengaturan). Berikan kepada anggota secara langsung.',
  'members.password.must_reset': 'Minta anggota mengganti kata sandi saat masuk berikutnya',
  'members.password.save': 'Simpan kata sandi',
  'members.password.clear': 'Hapus kata sandi',
  'members.password.saved': 'Kata sandi OPAC anggota disimpan.',
  'members.password.cleared': 'Kata sandi OPAC anggota dihapus. Anggota tidak bisa masuk sampai kata sandi diatur lagi.',
  'members.password.reauth': 'Konfirmasi kata sandi Anda sendiri dahulu, lalu simpan lagi.',
  'catalog.attachments.field.member_types': 'Tipe anggota yang boleh membuka',
  'catalog.attachments.member_types_hint': 'Tidak ada yang dipilih: semua anggota yang masuk boleh membuka.',
  'catalog.attachments.member_types_unreadable': 'Daftar tipe anggota tidak dapat dibaca; lampiran ini terbuka untuk semua anggota yang masuk.',
  'auditlog.actor.member': 'Anggota (OPAC)',
  'jobs.type.mail.member_password_reset': 'Mengirim e-mail atur ulang sandi anggota',
} as const;

export const MEMBER_AREA_EN: Record<keyof typeof MEMBER_AREA_ID, string> = {
  'members.types.field.opac': 'Member services in the OPAC',
  'members.types.field.holds_allowed': 'May place holds',
  'members.types.field.holds_limit': 'Most active holds',
  'members.types.field.online_renewal': 'May renew own loans in the OPAC',
  'members.types.opac.summary': 'Holds: {holds}, online renewal: {renew}',
  'members.types.opac.yes': 'yes',
  'members.types.opac.no': 'no',
  'members.password.open': 'Set the OPAC password…',
  'members.password.title': 'OPAC password',
  'members.password.intro':
    "Set a password so that the member can sign in to the OPAC member account with the member number. All of this member's sessions end.",
  'members.password.field': 'New password',
  'members.password.hint': 'At least 8 characters (as the settings say). Hand it to the member in person.',
  'members.password.must_reset': 'Ask the member to change the password at the next sign-in',
  'members.password.save': 'Save the password',
  'members.password.clear': 'Remove the password',
  'members.password.saved': "The member's OPAC password is saved.",
  'members.password.cleared': "The member's OPAC password is removed. The member cannot sign in until a password is set again.",
  'members.password.reauth': 'Confirm your own password first, then save again.',
  'catalog.attachments.field.member_types': 'Member types that may open it',
  'catalog.attachments.member_types_hint': 'None selected: every signed-in member may open it.',
  'catalog.attachments.member_types_unreadable': 'The member types cannot be read; this attachment opens to every signed-in member.',
  'auditlog.actor.member': 'Member (OPAC)',
  'jobs.type.mail.member_password_reset': "Send a member's password reset e-mail",
};
