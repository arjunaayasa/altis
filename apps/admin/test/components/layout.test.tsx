import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, FilterField, FilterRow, FormSection, InlinePanel, KeyText, LoadingState, PageError, Section, SelectionBar } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// The layout pieces the screens are put together with: the selection bar and its inline bulk panels (keyboard and
// focus), the labelled filter row, the empty / loading / error blocks, the page-level error and the form sections.

const NETWORK = new TypeError('Failed to fetch');

/** A list with three rows to select, its bar, and one panel per bulk action. */
function List({ withFocusAfter = true }: { withFocusAfter?: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [panel, setPanel] = useState<string | null>(null);
  const all = useRef<HTMLInputElement>(null);
  return (
    <main id="main" tabIndex={-1}>
      <SelectionBar
        count={selected.length}
        label={`${selected.length} anggota dipilih`}
        actions={[
          { id: 'extend', label: 'Perpanjang masa' },
          { id: 'archive', label: 'Arsipkan' },
        ]}
        open={panel}
        onOpenChange={setPanel}
        extra={<Button size="sm">Tambah ke antrean</Button>}
        onClear={() => {
          setPanel(null);
          setSelected([]);
        }}
        focusAfter={withFocusAfter ? all : undefined}>
        {panel === 'extend' && (
          <InlinePanel
            title={`Perpanjang masa: ${selected.length} anggota`}
            onSubmit={(e) => {
              e.preventDefault();
              setPanel(null);
            }}
            onCancel={() => setPanel(null)}>
            <label>
              Lama (hari)
              <input />
            </label>
            <Button type="submit">Terapkan</Button>
            <Button type="button" variant="outline" onClick={() => setPanel(null)}>
              Batal
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPanel(null);
                setSelected([]);
              }}>
              Terapkan dan kosongkan
            </Button>
          </InlinePanel>
        )}
      </SelectionBar>
      <input ref={all} type="checkbox" aria-label="Pilih semua" onChange={() => setSelected(['a', 'b', 'c'])} />
      {['a', 'b', 'c'].map((id) => (
        <input key={id} type="checkbox" aria-label={`Pilih ${id}`} checked={selected.includes(id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, id] : s.filter((x) => x !== id)))} />
      ))}
    </main>
  );
}

describe('SelectionBar', () => {
  it('shows only while rows are selected: a region named by the count, its actions, then Batal pilih', () => {
    render(<List />);
    expect(screen.queryByRole('region', { name: /dipilih/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Pilih a'));
    fireEvent.click(screen.getByLabelText('Pilih b'));
    const bar = screen.getByRole('region', { name: '2 anggota dipilih' });
    expect(within(bar).getByRole('status').textContent).toBe('2 anggota dipilih');
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Perpanjang masa', 'Arsipkan', 'Tambah ke antrean', 'Batal pilih']);
    expect(within(bar).getByRole('button', { name: 'Perpanjang masa' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('says "{count} dipilih" without a label of its own', () => {
    render(<SelectionBar count={4} onClear={() => undefined} />);
    expect(screen.getByRole('region', { name: '4 dipilih' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Batal pilih' })).toBeTruthy();
  });

  it("an action opens its panel under the bar with the focus inside; Esc closes it and gives the focus back to the action's button", async () => {
    render(<List />);
    fireEvent.click(screen.getByLabelText('Pilih a'));
    const extend = screen.getByRole('button', { name: 'Perpanjang masa' });
    extend.focus();
    fireEvent.click(extend);
    expect(extend.getAttribute('aria-pressed')).toBe('true');
    const panel = screen.getByRole('form', { name: 'Perpanjang masa: 1 anggota' });
    const field = within(panel).getByRole('textbox', { name: 'Lama (hari)' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: /Perpanjang masa/ })).toBeNull();
    expect(extend.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(extend);
  });

  it('pressing the open action again closes its panel; applying it gives the focus back to the button too', async () => {
    render(<List />);
    fireEvent.click(screen.getByLabelText('Pilih a'));
    const extend = screen.getByRole('button', { name: 'Perpanjang masa' });
    extend.focus();
    fireEvent.click(extend);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Lama (hari)' })));
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    expect(screen.queryByRole('form', { name: /Perpanjang masa/ })).toBeNull();
    expect(document.activeElement).toBe(extend);

    fireEvent.click(extend);
    expect(screen.getByRole('form', { name: /Perpanjang masa/ })).toBeTruthy();
    extend.focus();
    fireEvent.click(extend);
    expect(screen.queryByRole('form', { name: /Perpanjang masa/ })).toBeNull();
    expect(document.activeElement).toBe(extend);
  });

  it('Batal pilih empties the selection; the focus goes to the list (focusAfter), not to nowhere', () => {
    render(<List />);
    fireEvent.click(screen.getByLabelText('Pilih a'));
    const clear = screen.getByRole('button', { name: 'Batal pilih' });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole('region', { name: /dipilih/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Pilih semua'));
  });

  it('without focusAfter the focus goes to the main region', () => {
    render(<List withFocusAfter={false} />);
    fireEvent.click(screen.getByLabelText('Pilih a'));
    const clear = screen.getByRole('button', { name: 'Batal pilih' });
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('a panel that empties the selection as it closes: the focus lands on focusAfter, not on a button that went away', async () => {
    render(<List />);
    fireEvent.click(screen.getByLabelText('Pilih a'));
    const extend = screen.getByRole('button', { name: 'Perpanjang masa' });
    extend.focus();
    fireEvent.click(extend);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Lama (hari)' })));
    const done = screen.getByRole('button', { name: 'Terapkan dan kosongkan' });
    done.focus();
    fireEvent.click(done);
    expect(screen.queryByRole('region', { name: /dipilih/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Pilih semua'));
  });

  it('unticking the last row keeps the focus on that row', () => {
    render(<List />);
    const a = screen.getByLabelText('Pilih a');
    fireEvent.click(a);
    a.focus();
    fireEvent.click(a);
    expect(screen.queryByRole('region', { name: /dipilih/ })).toBeNull();
    expect(document.activeElement).toBe(a);
  });
});

describe('FilterRow', () => {
  function Filters({ onSubmit }: { onSubmit?: () => void }) {
    return (
      <FilterRow
        label="Saringan anggota"
        onSubmit={
          onSubmit === undefined
            ? undefined
            : (e) => {
                e.preventDefault();
                onSubmit();
              }
        }
        actions={<Button variant="link">Hapus saringan</Button>}>
        <FilterField wide label="Cari" hint="Nomor, nama, atau e-mail">
          {(c) => <Input {...c} type="search" />}
        </FilterField>
        <FilterField id="f-type" label="Tipe">
          <select id="f-type">
            <option value="">Semua tipe</option>
          </select>
        </FilterField>
        <FilterField label="Kelas" error="form.error.too_big">
          {(c) => <Input {...c} />}
        </FilterField>
      </FilterRow>
    );
  }

  it('is a named form; every filter is named by its visible label, its hint and error linked to it', () => {
    render(<Filters />);
    const form = screen.getByRole('form', { name: 'Saringan anggota' });
    const search = within(form).getByRole('searchbox', { name: 'Cari' });
    expect(document.getElementById(search.getAttribute('aria-describedby')!)!.textContent).toBe('Nomor, nama, atau e-mail');
    expect(within(form).getByRole('combobox', { name: 'Tipe' })).toBeTruthy();
    const kelas = within(form).getByRole('textbox', { name: 'Kelas' });
    expect(kelas.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(kelas.getAttribute('aria-describedby')!)!.textContent).toBe('Terlalu panjang.');
    // Every visible label belongs to a control.
    for (const label of form.querySelectorAll('label')) expect(label.htmlFor === '' || document.getElementById(label.htmlFor) !== null).toBe(true);
    expect(within(form).getByRole('button', { name: 'Hapus saringan' })).toBeTruthy();
  });

  it('Enter in a typed filter submits it (a hidden submit button makes it work with several fields)', () => {
    const submit = vi.fn();
    render(<Filters onSubmit={submit} />);
    const hidden = screen.getByRole('button', { name: 'Terapkan saringan' });
    expect(hidden.getAttribute('type')).toBe('submit');
    expect(hidden.tabIndex).toBe(-1);
    fireEvent.submit(screen.getByRole('searchbox', { name: 'Cari' }).closest('form')!);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('without onSubmit, submitting does not leave the page', () => {
    render(<Filters />);
    const form = screen.getByRole('form', { name: 'Saringan anggota' });
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('the state blocks', () => {
  it('EmptyState: a region named by its heading, the sentence and the actions', () => {
    render(
      <EmptyState title="Belum ada anggota" actions={<Button>Tambah anggota</Button>}>
        <p>Tambahkan anggota satu per satu.</p>
      </EmptyState>,
    );
    const region = screen.getByRole('region', { name: 'Belum ada anggota' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Belum ada anggota' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Tambah anggota' })).toBeTruthy();
  });

  it('LoadingState: busy, and "Memuat…" said once to screen readers', () => {
    const { container } = render(<LoadingState lines={3} />);
    expect(screen.getByRole('status').textContent).toBe('Memuat…');
    expect(container.firstElementChild!.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(3);
  });

  it('ErrorState: what failed, why, and Coba lagi', () => {
    const retry = vi.fn();
    render(<ErrorState title="Daftar anggota gagal dimuat" error={NETWORK} onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Daftar anggota gagal dimuat');
    expect(alert.textContent).toContain('Server tidak dapat dihubungi.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Coba lagi' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('ErrorState says "Data gagal dimuat" without a title, and waits while retrying', () => {
    render(<ErrorState error={NETWORK} onRetry={() => undefined} retrying />);
    expect(screen.getByRole('alert').textContent).toContain('Data gagal dimuat');
    expect((screen.getByRole('button', { name: 'Coba lagi' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PageError', () => {
  it('nothing without a title or an error; the reason is the title when there is no title', () => {
    const { container, rerender } = render(<PageError error={null} />);
    expect(container.textContent).toBe('');
    rerender(<PageError error={NETWORK} />);
    expect(screen.getByRole('alert').firstElementChild!.textContent).toBe('Server tidak dapat dihubungi. Periksa koneksi Anda, lalu coba lagi.');
  });

  it('a title, the reason under it, more words and an action', () => {
    render(
      <PageError title="Data ini sudah diubah oleh orang lain." error={NETWORK} action={<Button>Muat ulang data</Button>}>
        <p>Isian Anda masih ada.</p>
      </PageError>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.firstElementChild!.textContent).toBe('Data ini sudah diubah oleh orang lain.');
    expect(alert.textContent).toContain('Periksa koneksi');
    expect(alert.textContent).toContain('Isian Anda masih ada.');
    expect(within(alert).getByRole('button', { name: 'Muat ulang data' })).toBeTruthy();
  });
});

describe('Section and FormSection', () => {
  it('a section is a region named by its h2', () => {
    render(
      <Section title="Peminjaman per subjek" aside="30 hari terakhir">
        <p>…</p>
      </Section>,
    );
    const region = screen.getByRole('region', { name: 'Peminjaman per subjek' });
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('Peminjaman per subjek');
    expect(region.textContent).toContain('30 hari terakhir');
  });

  it('a form section names its fieldset and turns it off when disabled', () => {
    render(
      <FormSection title="Kontak" intro="Dipakai untuk menghubungi anggota." disabled>
        <label>
          Telepon
          <input />
        </label>
      </FormSection>,
    );
    const group = screen.getByRole('group', { name: 'Kontak' });
    expect((group as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.getByRole('region', { name: 'Kontak' })).toBeTruthy();
  });
});

describe('KeyText', () => {
  it('draws the function keys and Esc of a sentence as keys, and keeps the rest as text', () => {
    const { container } = render(
      <p>
        <KeyText text="Tekan F6 untuk mencari per nama; F12 dan Esc juga. Fakta F2x bukan tombol." />
      </p>,
    );
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['F6', 'F12', 'Esc']);
    expect(container.textContent).toBe('Tekan F6 untuk mencari per nama; F12 dan Esc juga. Fakta F2x bukan tombol.');
  });
});
