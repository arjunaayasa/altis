import type { MeResponse } from '@altis/shared/api/auth';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { holds, holdsAt } from '@/lib/access';
import { signedIn, superMe } from '../fake-api';

// The admin primitives of Phase 2 (plan Task 4): the radix-ui components in the shadcn style of components/ui, the
// combobox built from Popover + Command, and the branch-scoped permission check of lib/access.ts.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tabs', () => {
  it('shows the panel of the selected tab; a click and the arrow keys switch it', async () => {
    const onValueChange = vi.fn();
    render(
      <Tabs defaultValue="nama" onValueChange={onValueChange}>
        <TabsList aria-label="Otoritas">
          <TabsTrigger value="nama">Nama</TabsTrigger>
          <TabsTrigger value="subjek">Subjek</TabsTrigger>
        </TabsList>
        <TabsContent value="nama">Daftar nama</TabsContent>
        <TabsContent value="subjek">Daftar subjek</TabsContent>
      </Tabs>,
    );
    const [nama, subjek] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement];
    expect(nama.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Daftar nama');
    expect(nama.getAttribute('data-slot')).toBe('tabs-trigger');

    fireEvent.mouseDown(subjek, { button: 0 });
    expect(onValueChange).toHaveBeenLastCalledWith('subjek');
    expect(subjek.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Daftar subjek');

    act(() => subjek.focus());
    fireEvent.keyDown(subjek, { key: 'ArrowLeft' });
    // Radix moves the focus on the next tick; a focused trigger becomes the selected one (automatic activation).
    await waitFor(() => expect(document.activeElement).toBe(nama));
    expect(nama.getAttribute('aria-selected')).toBe('true');
    expect(onValueChange).toHaveBeenLastCalledWith('nama');
  });
});

describe('Checkbox', () => {
  it('toggles and reports the change, and is labelled by its label', () => {
    function Box() {
      const [checked, setChecked] = useState(false);
      return (
        <label>
          <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
          Tampil di OPAC
        </label>
      );
    }
    render(<Box />);
    const box = screen.getByRole('checkbox', { name: 'Tampil di OPAC' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('false');
  });
});

describe('the focus of a form control stays visible', () => {
  // Tailwind writes the `aria-invalid:` rules after the `focus-visible:` ones at the same specificity: a property both
  // set is the invalid one's on a focused invalid field, unless an `aria-invalid:focus-visible:` rule sets it again.
  // And `outline-none` sets the outline style to none for the outline width utilities too: a focus outline after it
  // must set its style again.
  const property = (utility: string): string => utility.split('-', 1)[0]!;
  function focusShadowedWhenInvalid(className: string): string[] {
    const classes = className.split(/\s+/);
    const set = (prefix: string): Set<string> => new Set(classes.filter((c) => c.startsWith(prefix) && !c.slice(prefix.length).includes(':')).map((c) => property(c.slice(prefix.length))));
    const onFocus = set('focus-visible:');
    const restated = set('aria-invalid:focus-visible:');
    return [...set('aria-invalid:')].filter((p) => onFocus.has(p) && !restated.has(p));
  }

  it('an invalid input, select, textarea or select trigger shows the focus look when it has the focus', () => {
    render(
      <>
        <Input aria-label="Nama" aria-invalid />
        <select aria-label="Tipe" aria-invalid className={SELECT_CLASS} />
        <textarea aria-label="Catatan" aria-invalid className={TEXTAREA_CLASS} />
        <Select>
          <SelectTrigger aria-label="Cabang" aria-invalid>
            <SelectValue />
          </SelectTrigger>
        </Select>
      </>,
    );
    for (const name of ['Nama', 'Tipe', 'Catatan', 'Cabang']) {
      const control = screen.getByLabelText(name);
      expect(control.getAttribute('aria-invalid')).toBe('true');
      expect(focusShadowedWhenInvalid(control.className), name).toEqual([]);
      expect(control.className).toMatch(/(^|\s)focus-visible:border-ring(\s|$)/);
    }
  });

  it('the checkbox draws its focus outline after outline-none', () => {
    render(<Checkbox aria-label="Tampil di OPAC" />);
    const classes = screen.getByRole('checkbox', { name: 'Tampil di OPAC' }).className.split(/\s+/);
    expect(classes).toContain('outline-none');
    expect(classes).toEqual(expect.arrayContaining(['focus-visible:outline-2', 'focus-visible:outline-solid']));
  });
});

describe('Select', () => {
  it('opens from the keyboard, picks an option and shows it', async () => {
    const onValueChange = vi.fn();
    render(
      <Select defaultValue="available" onValueChange={onValueChange}>
        <SelectTrigger aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="available">Tersedia</SelectItem>
          <SelectItem value="repair">Perbaikan</SelectItem>
          <SelectItem value="missing">Tidak ditemukan di rak</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(trigger.textContent).toContain('Tersedia');
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const listbox = await screen.findByRole('listbox');
    const option = within(listbox).getByRole('option', { name: 'Perbaikan' });
    act(() => option.focus());
    fireEvent.keyDown(option, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('repair');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(trigger.textContent).toContain('Perbaikan');
  });
});

describe('Popover', () => {
  it('opens on its trigger and closes on Escape, giving the focus back', async () => {
    render(
      <Popover>
        <PopoverTrigger>Filter</PopoverTrigger>
        <PopoverContent aria-label="Filter lanjutan">
          <input aria-label="Tahun" />
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Filter' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Filter lanjutan' });
    expect(dialog.getAttribute('data-slot')).toBe('popover-content');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('DropdownMenu', () => {
  it('opens from the keyboard and runs the chosen item', async () => {
    const onArchive = vi.fn();
    const onToggle = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Tindakan</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Cantuman</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={false} onCheckedChange={onToggle}>
            Tampil di OPAC
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onArchive}>
            Arsipkan
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Tindakan' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Tampil di OPAC' }).getAttribute('aria-checked')).toBe('false');
    const archive = within(menu).getByRole('menuitem', { name: 'Arsipkan' });
    expect(archive.getAttribute('data-variant')).toBe('destructive');
    fireEvent.click(archive);
    expect(onArchive).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('Tooltip', () => {
  it('shows its text when the trigger gets the focus', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>?</TooltipTrigger>
          <TooltipContent>Kode MARC 336</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => screen.getByRole('button', { name: '?' }).focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe('Kode MARC 336');
  });
});

describe('Combobox', () => {
  const OPTIONS: ComboboxOption[] = [
    { value: 'A1', label: 'Hirata, Andrea' },
    { value: 'A2', label: 'Toer, Pramoedya Ananta', keywords: ['pram'] },
    { value: 'A3', label: 'Tere Liye' },
  ];

  function Picker(props: { onChange?(v: string): void; onCreate?(search: string): void }) {
    const [value, setValue] = useState<string | null>(null);
    return (
      <Combobox
        aria-label="Pengarang"
        options={OPTIONS}
        value={value}
        onValueChange={(v) => {
          setValue(v);
          props.onChange?.(v);
        }}
        placeholder="Pilih pengarang"
        searchPlaceholder="Cari nama"
        emptyText="Tidak ada yang cocok"
        {...(props.onCreate === undefined ? {} : { action: { label: 'Buat baru', onSelect: props.onCreate } })}
      />
    );
  }

  it('filters the options by the typed text and picks one', async () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Pengarang' });
    expect(trigger.textContent).toContain('Pilih pengarang');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const search = await screen.findByPlaceholderText('Cari nama');
    fireEvent.change(search, { target: { value: 'pram' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Toer, Pramoedya Ananta']));
    fireEvent.click(screen.getByRole('option', { name: 'Toer, Pramoedya Ananta' }));
    expect(onChange).toHaveBeenCalledWith('A2');
    await waitFor(() => expect(screen.queryByPlaceholderText('Cari nama')).toBeNull());
    expect(trigger.textContent).toContain('Toer, Pramoedya Ananta');
  });

  it('says when nothing matches, and keeps the action listed with the typed text', async () => {
    const onCreate = vi.fn();
    render(<Picker onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Pengarang' }));
    const search = await screen.findByPlaceholderText('Cari nama');
    fireEvent.change(search, { target: { value: 'Ayu Utami' } });
    expect(await screen.findByText('Tidak ada yang cocok')).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Buat baru']);
    fireEvent.click(screen.getByRole('option', { name: 'Buat baru' }));
    expect(onCreate).toHaveBeenCalledWith('Ayu Utami');
    await waitFor(() => expect(screen.queryByPlaceholderText('Cari nama')).toBeNull());
  });

  it('with onSearchChange, leaves the filtering to the caller', async () => {
    const onSearchChange = vi.fn();
    render(
      <Combobox
        aria-label="Penerbit"
        options={OPTIONS}
        value="A3"
        onValueChange={() => {}}
        search=""
        onSearchChange={onSearchChange}
        placeholder="Pilih"
        searchPlaceholder="Cari penerbit"
        emptyText="Kosong"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Penerbit' });
    expect(trigger.textContent).toContain('Tere Liye');
    fireEvent.click(trigger);
    fireEvent.change(await screen.findByPlaceholderText('Cari penerbit'), { target: { value: 'xyz' } });
    expect(onSearchChange).toHaveBeenLastCalledWith('xyz');
    // The caller had not filtered yet: every option stays listed.
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});

describe('holdsAt (lib/access.ts)', () => {
  type SignedIn = Extract<MeResponse, { authenticated: true }>;
  const branchOnly = (): SignedIn => ({ ...signedIn({ permissions: ['system.users.read'] }), branchPermissions: { B1: ['test.branch.manage'] } });

  it('a branch-only grant holds at that branch and nowhere else', () => {
    const me = branchOnly();
    expect(holdsAt(me, 'test.branch.manage', 'B1')).toBe(true);
    expect(holdsAt(me, 'test.branch.manage', 'B2')).toBe(false);
    expect(holds(me, 'test.branch.manage')).toBe(false);
  });

  it('a global grant holds at every branch, a super admin holds everything', () => {
    expect(holdsAt(branchOnly(), 'system.users.read', 'B2')).toBe(true);
    expect(holdsAt(superMe(), 'test.branch.manage', 'B2')).toBe(true);
  });

  it('nothing for a caller not fully signed in, and no branch id reads the prototype', () => {
    const me = branchOnly();
    expect(holdsAt(undefined, 'test.branch.manage', 'B1')).toBe(false);
    expect(holdsAt({ ...me, stage: 'mfa' }, 'test.branch.manage', 'B1')).toBe(false);
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(holdsAt(me, 'test.branch.manage', key), key).toBe(false);
  });
});
