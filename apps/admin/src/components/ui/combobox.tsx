import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// The combobox pattern of shadcn/ui (new-york-v4, MIT: LICENSE-shadcn-ui.txt; see README.md in this folder): a button
// with role="combobox" opening a Popover that holds a Command list (cmdk) with its search box. shadcn/ui ships it as
// an example, not a component; ALTIS makes it one, for the pickers of the catalog (agents, subjects, publishers,
// records) and the long master lists.
//
// - Local filtering (default): cmdk filters `options` by their label and keywords as the user types.
// - Server search: pass `search` and `onSearchChange`; the caller fetches and passes the matching `options` (cmdk's own
//   filter is off) and may show `loading`.
// - `action` adds one item that is always listed ("Buat baru"): it receives the text typed so far.

export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra words the local filter matches (a code, an inverted name). */
  keywords?: readonly string[];
  disabled?: boolean;
}

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  /** The chosen option's value, or null. */
  value: string | null;
  onValueChange(value: string): void;
  /** The trigger's text while nothing is chosen. */
  placeholder: string;
  searchPlaceholder: string;
  /** Shown when no option matches. */
  emptyText: string;
  /** Server search: the text typed (controlled) and its change. */
  search?: string;
  onSearchChange?(search: string): void;
  loading?: boolean;
  /** The text of the loading state (with `loading`). */
  loadingText?: string;
  /** An item listed whatever is typed, e.g. "Buat baru"; `onSelect` receives the typed text. */
  action?: { label: string; onSelect(search: string): void };
  id?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** The value cmdk gives the action item: it starts with an invisible separator, which no id or code holds. */
const ACTION_VALUE = '\u2063combobox-action';

function Combobox({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  search,
  onSearchChange,
  loading = false,
  loadingText,
  action,
  id,
  disabled,
  className,
  ...aria
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState('');
  const listId = useId();
  const remote = onSearchChange !== undefined;
  const typed = remote ? (search ?? '') : localSearch;
  const selected = value === null ? undefined : options.find((o) => o.value === value);

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) setLocalSearch('');
  };
  const choose = (next: string): void => {
    onValueChange(next);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          data-slot="combobox-trigger"
          className={cn('w-full justify-between font-normal aria-invalid:border-destructive', className)}
          {...aria}
        >
          <span className={cn('truncate', selected === undefined && 'text-muted-foreground')}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDownIcon className="opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent data-slot="combobox-content" className="w-(--radix-popover-trigger-width) min-w-[12rem] p-0" align="start" aria-label={aria['aria-label'] ?? placeholder}>
        <Command shouldFilter={!remote}>
          <CommandInput placeholder={searchPlaceholder} value={typed} onValueChange={remote ? onSearchChange : setLocalSearch} />
          <CommandList id={listId}>
            {loading ? (
              <p role="status" className="py-6 text-center text-sm text-muted-foreground">
                {loadingText}
              </p>
            ) : remote ? (
              options.length === 0 && <p className="py-6 text-center text-sm">{emptyText}</p>
            ) : (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {!loading && options.length > 0 && (
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    keywords={[o.label, ...(o.keywords ?? [])]}
                    disabled={o.disabled}
                    onSelect={() => choose(o.value)}
                  >
                    <span className="truncate">{o.label}</span>
                    <CheckIcon aria-hidden="true" className={cn('ml-auto', o.value === value ? 'opacity-100' : 'opacity-0')} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {action !== undefined && (
              <CommandGroup forceMount>
                <CommandItem
                  forceMount
                  value={ACTION_VALUE}
                  onSelect={() => {
                    action.onSelect(typed);
                    onOpenChange(false);
                  }}
                >
                  <PlusIcon aria-hidden="true" />
                  {action.label}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox };
