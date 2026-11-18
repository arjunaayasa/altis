import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BulkBar, Card, CardBody, DenseTable, EmptyState, FilterTabs, FormSection, PageHead, PageHeader, SaveBar, SelectionBar, SettingRow, StatRow, TABLE, TableToolbar } from '@/components/layout';
import { buttonVariants } from '@/components/ui/button';

// The layout pieces of the admin's page patterns: the page header, the summary row, the filter tabs, a card with its
// toolbar, bulk bar and table, the setting rows, the sticky save bar; and the tokens they stand on (src/index.css).

/** Renders `ui` at `path` of a router whose every address shows it. */
async function atPath(at: string, ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: [at] }) });
  render(<RouterProvider router={router} />);
  await router.load();
  return router;
}

const classes = (el: Element): string[] => el.className.split(/\s+/);

describe('PageHeader', () => {
  it('the title is the h1 of the page (21 px), one sentence under it, the actions beside it', () => {
    render(<PageHeader title="Cantuman" description="Semua judul di koleksi." titleId="judul" actions={<button type="button">Tambah cantuman</button>} />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Cantuman' });
    expect(h1.id).toBe('judul');
    expect(classes(h1)).toEqual(expect.arrayContaining(['text-title', 'font-bold']));
    expect(screen.getByText('Semua judul di koleksi.').tagName).toBe('P');
    expect(screen.getByRole('button', { name: 'Tambah cantuman' })).toBeTruthy();
    // Nothing above the title, and no icon in it.
    expect(h1.parentElement!.firstElementChild).toBe(h1);
    expect(h1.querySelector('svg')).toBeNull();
  });

  it('PageHead is the same piece and `intro` the older name of the sentence, so the screens need no change', () => {
    expect(PageHead).toBe(PageHeader);
    render(<PageHead title="Anggota" intro="Daftar anggota perpustakaan." />);
    expect(screen.getByRole('heading', { level: 1, name: 'Anggota' })).toBeTruthy();
    expect(screen.getByText('Daftar anggota perpustakaan.')).toBeTruthy();
  });
});

describe('StatRow', () => {
  const items = [
    { key: 'a', label: 'Dipinjam hari ini', value: '14', note: '9 anggota' },
    { key: 'b', label: 'Dikembalikan hari ini', value: '6' },
    { key: 'c', label: 'Pinjaman terlambat', value: '7', note: <a href="/admin/layanan/terlambat">lihat daftar</a> },
    { key: 'd', label: 'Kunjungan hari ini', value: '42', note: 'dari buku tamu' },
    { key: 'e', label: 'Kelima', value: '1' },
  ];

  it('one card of at most four cells: a label, a figure and a factual note each', () => {
    render(<StatRow label="Ringkasan hari ini" items={items} />);
    const row = screen.getByLabelText('Ringkasan hari ini');
    expect(row.tagName).toBe('DL');
    expect(classes(row)).toEqual(expect.arrayContaining(['rounded-lg', 'border', 'bg-background']));
    expect(within(row).getAllByRole('term').map((dt) => dt.textContent)).toEqual(['Dipinjam hari ini', 'Dikembalikan hari ini', 'Pinjaman terlambat', 'Kunjungan hari ini']);
    const first = within(row).getAllByRole('term')[0]!.parentElement!;
    expect([...first.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['14', '9 anggota']);
    expect(classes(first.querySelector('dd')!)).toEqual(expect.arrayContaining(['text-2xl', 'tabular-nums']));
    expect(within(row).getByRole('link', { name: 'lihat daftar' })).toBeTruthy();
  });

  it('a figure is plain: no icon, no tile, no trend chip', () => {
    render(<StatRow label="Ringkasan" items={items} />);
    const row = screen.getByLabelText('Ringkasan');
    expect(row.querySelector('svg')).toBeNull();
    for (const dd of row.querySelectorAll('dd')) expect(dd.className).not.toMatch(/\b(bg-|text-ok|text-bad|text-warn)/);
  });
});

describe('FilterTabs', () => {
  const items = [
    { id: 'all', label: 'Semua', count: 28 },
    { id: 'no-cover', label: 'Tanpa sampul', count: 3 },
    { id: 'draft', label: 'Draf' },
  ];

  it('buttons: the filter in use is pressed and underlined; a press reports the tab', () => {
    const onChange = vi.fn();
    render(<FilterTabs label="Saringan cantuman" items={items} value="all" onChange={onChange} />);
    const nav = screen.getByRole('navigation', { name: 'Saringan cantuman' });
    const tabs = within(nav).getAllByRole('button');
    expect(tabs.map((b) => b.textContent)).toEqual(['Semua28', 'Tanpa sampul3', 'Draf']);
    expect(tabs.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(classes(tabs[0]!)).toContain('border-primary');
    expect(classes(tabs[1]!)).not.toContain('border-primary');
    fireEvent.click(tabs[1]!);
    expect(onChange).toHaveBeenCalledWith('no-cover');
  });

  it('links: a tab with an address is a link, the one in use the current page', async () => {
    const linked = [
      { id: 'all', label: 'Semua', count: 28, to: '/admin/catalog/records' },
      { id: 'draft', label: 'Draf', count: 1, to: '/admin/catalog/records', search: { status: 'draft' } },
    ];
    await atPath('/admin/catalog/records?status=draft', <FilterTabs label="Saringan" items={linked} value="draft" />);
    const links = within(await screen.findByRole('navigation', { name: 'Saringan' })).getAllByRole('link');
    expect(links.map((a) => [a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['/admin/catalog/records', null],
      ['/admin/catalog/records?status=draft', 'page'],
    ]);
  });
});

describe('Card, TableToolbar, BulkBar and a table', () => {
  it('a titled card is a region named by its h2 (15 px), with its line and its aside in the head', () => {
    render(
      <Card title="Perlu perhatian" description="Diperbarui 16.42" aside={<a href="/admin/reports">Laporan</a>}>
        <CardBody>Isi</CardBody>
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Perlu perhatian' });
    expect(card.getAttribute('data-slot')).toBe('card');
    expect(classes(card)).toEqual(expect.arrayContaining(['rounded-lg', 'border', 'bg-background']));
    expect(card.className).not.toMatch(/shadow/);
    const h2 = within(card).getByRole('heading', { level: 2 });
    expect(classes(h2)).toEqual(expect.arrayContaining(['text-heading', 'font-semibold']));
    expect(within(card).getByText('Diperbarui 16.42')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Laporan' })).toBeTruthy();
  });

  it('a card without a title is a plain box, or a region named by `label`', () => {
    const { container } = render(<Card>Isi</Card>);
    expect(container.firstElementChild!.tagName).toBe('DIV');
    render(<Card label="Daftar cantuman">Isi</Card>);
    expect(screen.getByRole('region', { name: 'Daftar cantuman' })).toBeTruthy();
  });

  it('a table sits in a card under its toolbar and bulk bar: a named group of controls, the count, then the rows', () => {
    const onClear = vi.fn();
    render(
      <Card label="Daftar cantuman">
        <TableToolbar label="Alat daftar" actions={<button type="button">Ekspor</button>}>
          <input type="search" aria-label="Cari judul" />
        </TableToolbar>
        <BulkBar count={2} onClear={onClear} extra={<button type="button">Cetak label</button>} />
        <DenseTable caption="Cantuman" columns={[{ id: 'title', header: 'Judul', cell: (r: { id: string; title: string }) => r.title }]} rows={[{ id: '1', title: 'Surat untuk Nenek' }]} rowKey={(r) => r.id} empty="Kosong" />
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Daftar cantuman' });
    const tools = within(card).getByRole('group', { name: 'Alat daftar' });
    expect(within(tools).getByRole('searchbox', { name: 'Cari judul' })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: 'Ekspor' })).toBeTruthy();
    const bulk = within(card).getByRole('region', { name: '2 dipilih' });
    expect(classes(bulk)).toContain('bg-primary-soft');
    fireEvent.click(within(bulk).getByRole('button', { name: 'Batal pilih' }));
    expect(onClear).toHaveBeenCalled();
    // Order: toolbar, bulk bar, table.
    expect([...card.children].map((el) => el.getAttribute('data-slot') ?? el.tagName)).toEqual(['table-toolbar', 'bulk-bar', 'DIV']);
    expect(within(card).getByRole('table', { name: 'Cantuman' })).toBeTruthy();
  });

  it('BulkBar shows only while rows are selected, and SelectionBar is the same piece', () => {
    expect(SelectionBar).toBe(BulkBar);
    const { container } = render(<BulkBar count={0} onClear={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('table heads are 34 px on the neutral layer, rows 40 px', () => {
    expect(TABLE.th.split(' ')).toEqual(expect.arrayContaining(['h-8.5', 'bg-layer-2']));
    expect(TABLE.td.split(' ')).toContain('h-10');
  });

  it('an empty state is a region named by its heading, with no picture', () => {
    render(
      <EmptyState title="Belum ada cantuman" actions={<button type="button">Tambah cantuman</button>}>
        <p>Tambahkan judul pertama.</p>
      </EmptyState>,
    );
    const region = screen.getByRole('region', { name: 'Belum ada cantuman' });
    expect(classes(within(region).getByRole('heading', { level: 2 }))).toContain('text-heading');
    expect(region.querySelector('svg, img')).toBeNull();
  });
});

describe('FormSection', () => {
  it('the title and its sentence on the left (220 px on a wide screen), the fields on the right as a named group', () => {
    render(
      <FormSection title="Identitas" intro="Nama dan nomor anggota.">
        <input aria-label="Nama" />
      </FormSection>,
    );
    const region = screen.getByRole('region', { name: 'Identitas' });
    expect(region.className).toContain('lg:grid-cols-[220px_minmax(0,1fr)]');
    expect(classes(within(region).getByRole('heading', { level: 2 }))).toEqual(expect.arrayContaining(['text-heading', 'font-semibold']));
    expect(within(within(region).getByRole('group', { name: 'Identitas' })).getByLabelText('Nama')).toBeTruthy();
  });
});

describe('SettingRow', () => {
  it('names its control by the title and describes it by the sentence', () => {
    render(
      <Card title="Identitas perpustakaan">
        <SettingRow title="Nama perpustakaan" description="Tampil di kepala situs.">
          {(control) => <input {...control} />}
        </SettingRow>
        <SettingRow title="Logo">
          <a href="/admin/opac/identitas">Atur di Identitas situs</a>
        </SettingRow>
      </Card>,
    );
    const input = screen.getByLabelText('Nama perpustakaan');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('Tampil di kepala situs.');
    // A row whose control is not a field (a link, a group of buttons) keeps its title as text.
    expect(screen.getByText('Logo').tagName).toBe('P');
    const rows = document.querySelectorAll('[data-slot="setting-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.previousElementSibling!.getAttribute('data-slot')).toBe('card-head');
  });
});

describe('SaveBar', () => {
  it('sticks to the bottom: the state of the form in words, then the buttons', () => {
    render(
      <SaveBar message="Ada perubahan yang belum disimpan">
        <button type="button">Batal</button>
        <button type="submit">Simpan</button>
      </SaveBar>,
    );
    const bar = document.querySelector('[data-slot="save-bar"]')!;
    expect(classes(bar)).toEqual(expect.arrayContaining(['sticky', 'bottom-0']));
    expect(screen.getByRole('status').textContent).toBe('Ada perubahan yang belum disimpan');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Batal', 'Simpan']);
  });

  it('what keeps the form from being saved is an alert, its icon hidden beside its words', () => {
    render(
      <SaveBar tone="bad" message="2 isian perlu diperbaiki">
        <button type="submit">Simpan</button>
      </SaveBar>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('2 isian perlu diperbaiki');
    expect(alert.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps its status line while there is nothing to say, so a later message is announced', () => {
    render(
      <SaveBar>
        <button type="submit">Simpan</button>
      </SaveBar>,
    );
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('the design tokens (src/index.css)', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'index.css'), 'utf8');
  /** The declarations of the first block that opens with `open`. */
  const block = (open: string): string => {
    const at = css.indexOf(open);
    expect(at, open).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('\n}', at));
  };
  const value = (text: string, name: string): string | undefined => new RegExp(`${name}:\\s*([^;]+);`).exec(text)?.[1];

  it('light: the page, the cards, the sidebar and the chart series', () => {
    const light = block(':root {');
    expect(value(light, '--page')).toBe('#f5f6f7');
    expect(value(light, '--background')).toBe('#fff');
    expect(value(light, '--primary-soft')).toBe('#e9eff9');
    expect(value(light, '--accent-soft')).toBe('var(--primary-soft)');
    expect(value(light, '--side')).toBe('#202327');
    expect([value(light, '--series-1'), value(light, '--series-2')]).toEqual(['#2f5fc4', '#c2691c']);
    expect(value(light, '--font-ui')).toMatch(/^'Plus Jakarta Sans Variable', ui-sans-serif, system-ui/);
  });

  it('dark: the same tokens under the system preference and under data-theme="dark"', () => {
    const bySystem = block("  :root:not([data-theme='light']) {");
    const byChoice = block(":root[data-theme='dark'] {");
    const names = (text: string): string[] => [...text.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]!);
    expect(names(byChoice)).toEqual(names(bySystem));
    for (const name of names(bySystem)) expect(value(byChoice, name), name).toBe(value(bySystem, name));
    expect(value(byChoice, '--page')).toBe('#15171a');
    expect(value(byChoice, '--side')).toBe('#111315');
    expect([value(byChoice, '--series-1'), value(byChoice, '--series-2')]).toEqual(['#4f82dc', '#cf7a3a']);
  });

  it('radius 4 px for controls and 6 px for cards; no gradient, no wide letter spacing', () => {
    expect(value(block(':root {'), '--radius')).toBe('0.375rem');
    const theme = block('@theme inline {');
    expect(value(theme, '--radius-md')).toBe('calc(var(--radius) - 2px)');
    expect(value(theme, '--radius-lg')).toBe('var(--radius)');
    for (const step of ['wide', 'wider', 'widest']) expect(value(theme, `--tracking-${step}`)).toBe('0em');
    expect(css).not.toMatch(/gradient\(/);
    expect(css).toMatch(/letter-spacing: 0;/);
  });

  it('controls are 34 px high, small ones 28 px', () => {
    expect(buttonVariants().split(' ')).toContain('h-8.5');
    expect(buttonVariants({ size: 'sm' }).split(' ')).toContain('h-7');
  });
});
