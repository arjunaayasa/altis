import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkMemberCsvHeader, initialMapping, missingFields, readCsvHead, remap, slimsHead } from '@/screens/members/import-head';
import { adminMe, startApp } from '../fake-api';

// Impor Anggota: the browser reads the file's head before anything is sent, so the mapping step can say what the
// server will make of it (the separator, the encoding, the rows, each column's field); the admin can change which
// column feeds which field (a SLiMS member export starts from its fixed order), a required field left out stops the
// dry run, and the dry run and the import send that mapping.

beforeAll(async () => {
  await import('@/screens/members/import');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readCsvHead', () => {
  it('takes the separator seen most in the first line, keeps quoted separators and line breaks, and skips empty rows', () => {
    const head = readCsvHead(bytes('﻿member_no;name;notes\r\nS-1;"Rina; Putri";"two\nlines"\r\n;;\r\nS-2;Doni;\r\n'));
    expect(head.encoding).toBe('utf-8');
    expect(head.separator).toBe(';');
    expect(head.header).toEqual(['member_no', 'name', 'notes']);
    expect(head.rows).toEqual([
      ['S-1', 'Rina; Putri', 'two\nlines'],
      ['S-2', 'Doni', ''],
    ]);
    // The line each row starts on (the header is line 1; a quoted line break moves the next row down).
    expect(head.lines).toEqual([2, 5]);
    expect(head.total).toBe(2);
  });

  it('reads a file that is not UTF-8 as Windows-1252, and a comma file on a tie', () => {
    const head = readCsvHead(new Uint8Array([...bytes('member_no,name\nS-1,Jos'), 0xe9]));
    expect(head.encoding).toBe('windows-1252');
    expect(head.separator).toBe(',');
    expect(head.rows[0]).toEqual(['S-1', 'José']);
  });

  it('refuses an empty file and a quote that is never closed', () => {
    expect(() => readCsvHead(bytes(''))).toThrow();
    expect(() => readCsvHead(bytes('member_no,name\n"S-1,Rina\n'))).toThrow();
  });
});

describe('checkMemberCsvHeader', () => {
  it('matches the columns without regard to case, ignores an empty one, and names the missing, unknown and repeated ones', () => {
    expect(checkMemberCsvHeader(['Member_No', 'NAME', 'member_type', ''])).toEqual({
      columns: ['member_no', 'name', 'member_type', null],
      missing: [],
      unknown: [],
      duplicate: [],
      ok: true,
    });
    const bad = checkMemberCsvHeader(['member_no', 'nama', 'member_no']);
    expect(bad.columns).toEqual(['member_no', 'unknown', 'duplicate']);
    expect(bad.missing).toEqual(['name', 'member_type']);
    expect(bad.unknown).toEqual(['nama']);
    expect(bad.duplicate).toEqual(['member_no']);
    expect(bad.ok).toBe(false);
  });
});

describe('the mapping', () => {
  it('starts from the header names (unknown and repeated ones ignored) or the SLiMS order; a field moves to the column chosen last', () => {
    expect(initialMapping('csv-members', ['member_no', 'nama', 'NAME', 'name', 'member_type'])).toEqual(['member_no', null, 'name', null, 'member_type']);
    const mapping = initialMapping('csv-members', ['nomor', 'nama', 'tipe']);
    expect(missingFields(mapping)).toEqual(['member_no', 'name', 'member_type']);
    const mapped = remap(remap(remap(mapping, 0, 'member_no'), 1, 'name'), 2, 'member_type');
    expect([mapped, missingFields(mapped)]).toEqual([['member_no', 'name', 'member_type'], []]);
    expect(remap(mapped, 2, 'name')).toEqual(['member_no', null, 'name']);
    const bare = slimsHead(readCsvHead(bytes('S-1,Rina,1,Siswa\nS-2,Doni,0,Guru\n')));
    expect([bare.header.slice(0, 4), bare.rows.map((r) => r[0]), bare.lines, bare.total]).toEqual([['member_id', 'member_name', 'gender', 'member_type_name'], ['S-1', 'S-2'], [1, 2], 2]);
    expect(initialMapping('slims-members', bare.header).slice(0, 4)).toEqual(['member_no', 'name', null, 'member_type']);
    const named = slimsHead(readCsvHead(bytes('member_id,member_name\nS-1,Rina\n')));
    expect([named.header, named.total]).toEqual([['member_id', 'member_name'], 1]);
  });
});

describe('Impor Anggota: four numbered steps', () => {
  const TYPES = { items: [{ id: '01JZ0000000000000000000T01', code: 'SISWA', nameId: 'Siswa', nameEn: null, accredGroup: 'student', membershipDays: 365, loanLimit: 3, holdsAllowed: true, holdsLimit: 2, onlineRenewal: true, sortOrder: 0, memberCount: 0, archived: false, version: 1 }] };

  it('reads the chosen file into the mapping step: the fields, the flagged cells, and no dry run while a required column is missing', async () => {
    const app = startApp({ me: adminMe(), path: '/admin/anggota/impor', routes: { 'GET members/types': () => TYPES } });
    const steps = await screen.findByRole('list', { name: 'Langkah impor' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Unggah berkas', '2Pemetaan & pratinjau', '3Uji kering', '4Hasil']);
    expect(within(steps).getByText('Unggah berkas').closest('li')?.getAttribute('aria-current')).toBe('step');

    const good = new File(['member_no;name;member_type;expires_on;gender\nS-1;Rina;SISWA;2027-07-01;P\nS-2;Doni;GURU;kemarin;X\n'], 'anggota.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/Pilih berkas CSV/), { target: { files: [good] } });
    expect(await screen.findByRole('heading', { name: 'Pemetaan & pratinjau' })).toBeTruthy();
    expect(screen.getByText('anggota.csv: pemisah titik koma, UTF-8, 2 baris, 5 kolom')).toBeTruthy();
    const mapping = screen.getByRole('table', { name: 'Pemetaan kolom' });
    expect((within(mapping).getByRole('combobox', { name: 'Ruas untuk kolom member_type' }) as HTMLSelectElement).value).toBe('member_type');
    // An unknown type code and an unreadable date (the row refused) and an unreadable gender (only warned of) are
    // marked in the preview in colour and in words, with a count of each under the table.
    const preview = screen.getByRole('table', { name: 'Pratinjau 2 baris pertama' });
    expect(within(preview).getByText('GURU').className).toContain('text-bad');
    expect(within(preview).getByText('kemarin').className).toContain('text-bad');
    expect(within(preview).getByText('X').className).toContain('text-warn');
    expect(within(preview).getByText('GURU').closest('td')?.textContent).toBe('GURUtipe tidak dikenal');
    expect(within(preview).getByText('kemarin').closest('td')?.textContent).toBe('kemarintanggal tidak terbaca');
    expect(within(preview).getByText('X').closest('td')?.textContent).toBe('Xakan dikosongkan');
    expect(within(preview).getByText('2027-07-01').className).not.toContain('text-bad');
    expect(within(preview).getByText('SISWA').className).not.toContain('text-bad');
    expect(within(preview).getByText('P').closest('td')?.textContent).toBe('P');
    expect(screen.getByText('Sel bertanda di pratinjau: 2 membuat barisnya ditolak, 1 hanya diperingatkan. Uji kering memeriksa semua baris.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Uji kering' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Kembali' }));
    const missing = new File(['member_no,nama\nS-1,Rina\n'], 'salah.csv', { type: 'text/csv' });
    fireEvent.change(await screen.findByLabelText(/Pilih berkas CSV/), { target: { files: [missing] } });
    expect(await screen.findByText('Ruas wajib belum dipetakan: Nama, Tipe anggota')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Uji kering' }) as HTMLButtonElement).disabled).toBe(true));
    // The admin maps the column "nama" to the name: only the type is missing now.
    fireEvent.change(screen.getByRole('combobox', { name: 'Ruas untuk kolom nama' }), { target: { value: 'name' } });
    expect(await screen.findByText('Ruas wajib belum dipetakan: Tipe anggota')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Uji kering' }) as HTMLButtonElement).disabled).toBe(true);
    expect(app.writes()).toEqual([]);
  });
});
