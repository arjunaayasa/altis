import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EditorDrawer } from '@/components/layout';

// The editor drawer of the layout guide: a modal dialog named by its title and described by its sentence, whose
// submit does not reach the page's form behind it, closed by Esc and its close button (not by its own submit), with
// the focus back on the button that opened it.

function Page({ onPageSubmit, onApply }: { onPageSubmit(): void; onApply(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onPageSubmit();
      }}>
      <button type="button" onClick={() => setOpen(true)}>
        Ubah butir 1
      </button>
      {open && (
        <EditorDrawer open title="Ubah butir 1" description="Masuk ke draf halaman." closeLabel="Tutup" onSubmit={onApply} onClose={() => setOpen(false)} footer={<button type="submit">Selesai</button>}>
          <label>
            Nama
            <input defaultValue="" />
          </label>
        </EditorDrawer>
      )}
    </form>
  );
}

describe('EditorDrawer', () => {
  it('is a named modal dialog whose submit stays its own, and gives the focus back when it closes', async () => {
    const onPageSubmit = vi.fn();
    const onApply = vi.fn();
    render(<Page onPageSubmit={onPageSubmit} onApply={onApply} />);
    const opener = screen.getByRole('button', { name: 'Ubah butir 1' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = await screen.findByRole('dialog', { name: 'Ubah butir 1' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(drawer.getAttribute('aria-describedby')!)?.textContent).toBe('Masuk ke draf halaman.');
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Selesai' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onPageSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(drawer);
    fireEvent.keyDown(within(drawer).getByLabelText('Nama'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.click(opener);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Tutup' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
