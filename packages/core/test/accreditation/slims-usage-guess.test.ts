import { describe, expect, it } from 'vitest';
import { guessGroup } from '../../src/accreditation/slims-usage/guess.js';

// The first guess of a SLiMS member type's population group, from its name: the wizard shows it for editing and the
// usage import stores it for a type met for the first time.

describe('guessGroup', () => {
  it.each([
    ['Siswa', 'student'],
    ['siswa kelas X', 'student'],
    ['Murid', 'student'],
    ['PELAJAR', 'student'],
    ['Mahasiswa Pascasarjana', 'student'],
    ['Guru', 'teacher'],
    ['Dosen Tetap', 'teacher'],
    ['Pendidik', 'teacher'],
    ['Staf TU', 'edu_staff'],
    ['Karyawan', 'edu_staff'],
    ['Tendik', 'edu_staff'],
    ['Pegawai Honorer', 'edu_staff'],
    ['Umum', 'public'],
    ['Alumni', 'public'],
    ['', 'public'],
  ] as const)('%j → %s', (name, group) => {
    expect(guessGroup(name)).toBe(group);
  });

  it('matches the words anywhere in the name, the student words before the teacher and staff words', () => {
    expect(guessGroup('Anggota Siswa Teladan')).toBe('student');
    expect(guessGroup('Guru dan Staf')).toBe('teacher');
    expect(guessGroup('Mahasiswa Pegawai')).toBe('student');
  });
});
