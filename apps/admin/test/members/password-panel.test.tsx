import type { MemberView } from '@altis/shared/api/members';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberPasswordPanel } from '@/screens/members/password';
import { json, problem } from '../fake-api';

// The OPAC password form as a panel in the member page: the same requests and refusals as its dialog, opened in the
// page (no dialog), closed by Esc or Batal.

const MEMBER = {
  id: '01JZ0000000000000000000N01',
  memberNo: 'B 001',
  name: 'Siti Aminah',
  version: 1,
} as MemberView;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MemberPasswordPanel', () => {
  it('says why a weak password is refused, then saves one and closes', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? problem(422, 'PASSWORD_TOO_WEAK', { reason: 'common' }) : json({ id: MEMBER.id, version: 2 });
      }),
    );
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<MemberPasswordPanel member={MEMBER} onClose={onClose} onDone={onDone} />);
    const panel = screen.getByRole('form', { name: 'Kata sandi OPAC' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The panel takes the focus on its first field.
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByLabelText('Kata sandi baru')));

    fireEvent.change(within(panel).getByLabelText('Kata sandi baru'), { target: { value: 'password123' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await within(panel).findByText('Kata sandi ini terlalu umum dan mudah ditebak. Pilih yang lain.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.change(within(panel).getByLabelText('Kata sandi baru'), { target: { value: 'buku-pelajaran-9' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Simpan kata sandi' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Kata sandi OPAC anggota disimpan.'));
    expect(onClose).toHaveBeenCalled();
    expect(bodies).toEqual([
      { password: 'password123', mustReset: true },
      { password: 'buku-pelajaran-9', mustReset: true },
    ]);
  });

  it('asks for a password before sending, and Esc closes it without a request', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<MemberPasswordPanel member={MEMBER} onClose={onClose} onDone={vi.fn()} />);
    const panel = screen.getByRole('form', { name: 'Kata sandi OPAC' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Simpan kata sandi' }));
    expect(within(panel).getByLabelText('Kata sandi baru').getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(within(panel).getByLabelText('Kata sandi baru'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
