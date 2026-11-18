import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DataTable } from '@/components/data-table';
import { BackLink, FormSection, LinkTabs, SideSection } from '@/components/layout';
import { buttonVariants } from '@/components/ui/button';

// The layout pieces that several screens had drawn beside themselves: the back link that brings back a list's view,
// the side-by-side page part, the two-column and list form sections, the link tabs, the right-aligned columns of a
// TanStack table and the classes of a link drawn as a button.

/** Renders `ui` at `path` of a router whose every address shows it. */
async function atPath(path: string, ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />);
  await router.load();
  return router;
}

describe('BackLink', () => {
  it('goes back to the list with its view in the search params', async () => {
    await atPath('/admin/catalog/authorities/x', <BackLink to="/admin/catalog/authorities" search={{ kind: 'subjects' }}>Daftar otoritas</BackLink>);
    const link = await screen.findByRole('link', { name: 'Daftar otoritas' });
    expect(link.getAttribute('href')).toBe('/admin/catalog/authorities?kind=subjects');
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('without search, the list as it opens', async () => {
    await atPath('/admin/jobs/x', <BackLink to="/admin/jobs">Tugas</BackLink>);
    expect((await screen.findByRole('link', { name: 'Tugas' })).getAttribute('href')).toBe('/admin/jobs');
  });
});

describe('LinkTabs', () => {
  it('a named navigation of links; the page shown is the current one', async () => {
    const items = [
      { to: '/admin/jobs', label: 'Tugas' },
      { to: '/admin/jobs/schedules', label: 'Jadwal' },
    ];
    await atPath('/admin/jobs/schedules', <LinkTabs label="Bagian tugas" items={items} />);
    const nav = await screen.findByRole('navigation', { name: 'Bagian tugas' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Tugas', 'Jadwal']);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page']);
  });
});

describe('SideSection and the FormSection options', () => {
  it('a side section is a region named by its h2, its sentence and content beside it, no fieldset', () => {
    render(
      <SideSection title="Data pribadi" intro="Unduh atau anonimkan.">
        <button type="button">Unduh data</button>
      </SideSection>,
    );
    const region = screen.getByRole('region', { name: 'Data pribadi' });
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('Data pribadi');
    expect(region.textContent).toContain('Unduh atau anonimkan.');
    expect(within(region).queryByRole('group')).toBeNull();
    // It draws its own card when it does not stand in one (the rule of src/index.css on this slot).
    expect(region.getAttribute('data-slot')).toBe('side-section');
  });

  it('columns={2} keeps two columns of fields on a wide screen', () => {
    render(
      <FormSection title="Judul" columns={2}>
        <input aria-label="Judul utama" />
      </FormSection>,
    );
    const group = screen.getByRole('group', { name: 'Judul' });
    expect(group.className).toContain('sm:grid-cols-2');
    expect(group.className).not.toContain('xl:grid-cols-3');
  });

  it('a list part has no second fieldset; introId lets the sentence describe the list', () => {
    render(
      <FormSection list title="Pengarang" intro="Urutan menentukan pengarang utama." introId="agents-hint">
        <fieldset aria-describedby="agents-hint">
          <legend>Pengarang</legend>
        </fieldset>
      </FormSection>,
    );
    const groups = screen.getAllByRole('group', { name: 'Pengarang' });
    expect(groups).toHaveLength(1);
    expect(document.getElementById('agents-hint')?.textContent).toBe('Urutan menentukan pengarang utama.');
  });
});

interface Run {
  id: string;
  name: string;
  rows: number;
}
const features = tableFeatures({});
const column = createColumnHelper<typeof features, Run>();
const COLUMNS = column.columns([column.accessor('name', { header: 'Nama' }), column.accessor('rows', { header: 'Baris' })]);
const RUNS: Run[] = [{ id: '1', name: 'Ekspor', rows: 1200 }];

function Runs() {
  const table = useTable({ features, columns: COLUMNS, data: RUNS, getRowId: (r) => r.id });
  return <DataTable table={table} caption="Riwayat" empty="Belum ada" alignRight={['rows']} />;
}

describe('DataTable alignRight', () => {
  it('aligns the named columns right, header and cells, and only those', () => {
    render(<Runs />);
    const table = screen.getByRole('table', { name: 'Riwayat' });
    const [name, rows] = within(table).getAllByRole('columnheader');
    expect(rows!.className).toContain('text-right');
    expect(rows!.className).not.toContain('text-left');
    expect(name!.className).toContain('text-left');
    const cells = within(table).getAllByRole('cell');
    expect(cells[1]!.className).toContain('text-right');
    expect(cells[0]!.className).not.toContain('text-right');
  });
});

describe('buttonVariants', () => {
  it('merges its classes: an outline keeps its border colour on a link drawn by hand', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'sm' }).split(' ');
    expect(classes).toContain('border-input');
    expect(classes).not.toContain('border-transparent');
    expect(buttonVariants({ className: 'self-start' }).split(' ')).toContain('self-start');
  });
});
