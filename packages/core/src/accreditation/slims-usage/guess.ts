import type { AccredGroup } from '@altis/shared';

// The first guess of the population group a SLiMS member type counts in, from its name: the wizard shows it as an
// editable step, and the import stores it for a member type the mapping does not name yet. The words are Indonesian
// school and campus words, matched anywhere in the name, in this order.

const STUDENT = /siswa|murid|pelajar|mahasiswa/i;
const TEACHER = /guru|dosen|pendidik/i;
const EDU_STAFF = /staf|karyawan|tendik|pegawai/i;

/**
 * The group a member type named `typeName` most likely counts in: students (`siswa`, `murid`, `pelajar`, `mahasiswa`),
 * teachers (`guru`, `dosen`, `pendidik`), education staff (`staf`, `karyawan`, `tendik`, `pegawai`), or the public.
 */
export function guessGroup(typeName: string): AccredGroup {
  if (STUDENT.test(typeName)) return 'student';
  if (TEACHER.test(typeName)) return 'teacher';
  if (EDU_STAFF.test(typeName)) return 'edu_staff';
  return 'public';
}
