import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkMemberCsvHeader, readCsvHead } from '@/screens/members/import-head';
import { adminMe, startApp } from '../fake-api';

// Impor Anggota: the browser reads the file's head before anything is sent, so the mapping step can say what the
// server will make of it (the separator, the encoding, the rows, each column's field) and stop a file the server would
// refuse whole (a required column missing, an unknown one).

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

describe('Impor Anggota: four numbered steps', () => {
  const TYPES = { items: [{ id: '01JZ0000000000000000000T01', code: 'SISWA', nameId: 'Siswa', nameEn: null, accredGroup: 'student', membershipDays: 365, loanLimit: 3, holdsAllowed: true, holdsLimit: 2, onlineRenewal: true, sortOrder: 0, memberCount: 0, archived: false, version: 1 }] };

  it('reads the chosen file into the mapping step: the fields, the flagged cells, and no dry run while a required column is missing', async () => {
    const app = startApp({ me: adminMe(), path: '/admin/anggota/impor', routes: { 'GET members/types': () => TYPES } });
    const steps = await screen.findByRole('list', { name: 'Langkah impor' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Unggah berkas', '2Pemetaan & pratinjau', '3Uji kering', '4Hasil']);
    expect(within(steps).getByText('Unggah berkas').closest('li')?.getAttribute('aria-current')).toBe('step');

    const good = new File(['member_no;name;member_type;expires_on\nS-1;Rina;SISWA;2027-07-01\nS-2;Doni;GURU;kemarin\n'], 'anggota.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText(/Pilih berkas CSV/), { target: { files: [good] } });
    expect(await screen.findByRole('heading', { name: 'Pemetaan & pratinjau' })).toBeTruthy();
    expect(screen.getByText('anggota.csv: pemisah titik koma, UTF-8, 2 baris, 4 kolom')).toBeTruthy();
    const mapping = screen.getByRole('table', { name: 'Pemetaan kolom' });
    expect(within(mapping).getByText('Tipe anggota')).toBeTruthy();
    // An unknown type code and an unreadable date are marked in the preview (in words and colour).
    const preview = screen.getByRole('table', { name: 'Pratinjau 2 baris pertama' });
    expect(within(preview).getByText('GURU').className).toContain('text-destructive');
    expect(within(preview).getByText('kemarin').className).toContain('text-destructive');
    expect(within(preview).getByText('2027-07-01').className).not.toContain('text-destructive');
    expect(within(preview).getByText('SISWA').className).not.toContain('text-destructive');
    expect((screen.getByRole('button', { name: 'Uji kering' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Kembali' }));
    const missing = new File(['member_no,nama\nS-1,Rina\n'], 'salah.csv', { type: 'text/csv' });
    fireEvent.change(await screen.findByLabelText(/Pilih berkas CSV/), { target: { files: [missing] } });
    expect(await screen.findByText('Kolom wajib belum ada: name, member_type')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Uji kering' }) as HTMLButtonElement).disabled).toBe(true));
    expect(app.writes()).toEqual([]);
  });
});
