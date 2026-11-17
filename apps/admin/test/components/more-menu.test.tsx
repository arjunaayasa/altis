import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { InlinePanel, MoreMenu, MoreMenuItem, MoreMenuRule } from '@/components/layout';
import { Button } from '@/components/ui/button';

// The ⋯ menu of a row or a page head and the inline panels it opens: the menu is the shared dropdown menu (the arrow
// keys move through its actions, it stays open when the page scrolls), a chosen action runs with the focus back on the
// ⋯ button, and a panel gives the focus back to what opened it when it closes with the focus inside.

function Row() {
  const [panel, setPanel] = useState<'suspend' | 'note' | null>(null);
  return (
    <main id="main" tabIndex={-1}>
      <Button type="button" onClick={() => setPanel('note')}>
        Catatan…
      </Button>
      <MoreMenu small label="Tindakan untuk Budi">
        <MoreMenuItem onSelect={() => setPanel('suspend')}>Tangguhkan…</MoreMenuItem>
        <MoreMenuItem onSelect={() => undefined}>Layani di Meja Layanan</MoreMenuItem>
        <MoreMenuRule />
        <MoreMenuItem danger onSelect={() => undefined}>
          Arsipkan…
        </MoreMenuItem>
      </MoreMenu>
      {panel !== null && (
        <InlinePanel
          title={panel === 'suspend' ? 'Tangguhkan Budi' : 'Catatan'}
          onSubmit={(e) => {
            e.preventDefault();
            setPanel(null);
          }}
          onCancel={() => setPanel(null)}>
          <label>
            Alasan
            <input />
          </label>
          <Button type="submit">Simpan</Button>
          <Button type="button" variant="outline" onClick={() => setPanel(null)}>
            Batal
          </Button>
        </InlinePanel>
      )}
    </main>
  );
}

describe('MoreMenu', () => {
  it('the arrow keys move through the actions; a scroll does not close it; Esc gives the focus back to ⋯', async () => {
    render(<Row />);
    const trigger = screen.getByRole('button', { name: 'Tindakan untuk Budi' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Tangguhkan…', 'Layani di Meja Layanan', 'Arsipkan…']);
    expect(items[2]!.getAttribute('data-variant')).toBe('destructive');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1]!, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(items[2]));
    fireEvent.scroll(window);
    fireEvent.scroll(document);
    expect(menu.isConnected).toBe(true);
    fireEvent.keyDown(items[2]!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('an action that opens a panel: the focus goes into the panel, and back to ⋯ when it is cancelled', async () => {
    render(<Row />);
    const trigger = screen.getByRole('button', { name: 'Tindakan untuk Budi' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tangguhkan…' }));
    const field = await screen.findByRole('textbox', { name: 'Alasan' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    // The menu's own focus return (a moment after it closes) does not take the focus out of the panel.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Tangguhkan Budi' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('InlinePanel', () => {
  it('gives the focus back to its trigger when it is saved or cancelled with the focus inside', async () => {
    render(<Row />);
    const open = screen.getByRole('button', { name: 'Catatan…' });
    open.focus();
    fireEvent.click(open);
    const field = await screen.findByRole('textbox', { name: 'Alasan' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Alasan' })).toBeNull());
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    const again = await screen.findByRole('textbox', { name: 'Alasan' });
    await waitFor(() => expect(document.activeElement).toBe(again));
    const cancel = screen.getByRole('button', { name: 'Batal' });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Alasan' })).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('gives it back too when the focus fell out of it before it closed (a browser drops it from a button disabled while saving)', async () => {
    render(<Row />);
    const open = screen.getByRole('button', { name: 'Catatan…' });
    open.focus();
    fireEvent.click(open);
    const field = await screen.findByRole('textbox', { name: 'Alasan' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    field.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Alasan' })).toBeNull());
    expect(document.activeElement).toBe(open);
  });
});
