import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Filter chips for a `TableToolbar`: compact buttons in the toolbar's row, each one filter. A chip at rest shows the
 * filter's name; one in use shows the name and the value ("Jenis bahan: Buku") in the accent, so the filters in use
 * are read at a glance. Every chip is a native control underneath (a `<select>`, a checkbox) or a real button, so the
 * keyboard, a screen reader and a phone's own pickers work as they do for any form control.
 */

/** The box of a chip (34 px, like the toolbar's other controls), and its look while its filter is in use. */
export const CHIP =
  'relative inline-flex h-8.5 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-ui leading-none font-semibold whitespace-nowrap transition-colors duration-150 ease-out hover:bg-accent [&_svg]:size-4 [&_svg]:shrink-0';
export const CHIP_ON = 'border-primary bg-primary-soft text-accent-text hover:bg-primary-soft';
/** The focus ring of a chip whose control is a native one laid over it (or hidden inside it). */
const CHIP_FOCUS_WITHIN = 'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring';

/** One choice of a {@link ChipSelect}. */
export interface ChipOption {
  value: string;
  label: string;
}

/**
 * A chip that chooses one of several values: a native `<select>` named `label`, laid invisibly over the chip's own
 * text, so the chip is as wide as what it says and not as its longest option. `on` (by default: a value other than
 * the first option's) draws it in the accent with its value after the name; at rest it shows the name alone, or the
 * value too with `showValue` (an order always has one).
 */
export function ChipSelect({
  label,
  value,
  options,
  onChange,
  on,
  showValue = false,
  className,
}: {
  label: string;
  value: string;
  options: readonly ChipOption[];
  onChange(value: string): void;
  on?: boolean;
  showValue?: boolean;
  className?: string;
}) {
  const id = useId();
  const active = on ?? value !== (options[0]?.value ?? '');
  const current = options.find((o) => o.value === value);
  return (
    <span data-chip="" data-on={active ? '' : undefined} className={cn(CHIP, CHIP_FOCUS_WITHIN, active && CHIP_ON, className)}>
      <span data-chip-text="" className="min-w-0 truncate">
        <label htmlFor={id}>{label}</label>
        {/* The select says its own value; this is for the eye. */}
        {(active || showValue) && current !== undefined && <span aria-hidden="true">: {current.label}</span>}
      </span>
      <ChevronDownIcon aria-hidden="true" className={active ? undefined : 'text-muted-foreground'} />
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A chip that is on or off: a checkbox named by the chip's text, with a check mark while it is on. */
export function ChipToggle({ checked, onChange, className, children }: { checked: boolean; onChange(checked: boolean): void; className?: string; children: ReactNode }) {
  return (
    <label data-chip="" data-on={checked ? '' : undefined} className={cn(CHIP, CHIP_FOCUS_WITHIN, 'cursor-pointer', checked && CHIP_ON, className)}>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {checked && <CheckIcon aria-hidden="true" />}
      <span data-chip-text="" className="min-w-0 truncate">{children}</span>
    </label>
  );
}

/** A chip that is a button (the trigger of a popover holding a filter with more than one control). */
export function ChipButton({ on = false, className, children, ...props }: ComponentProps<'button'> & { on?: boolean }) {
  return (
    <button
      type="button"
      data-chip=""
      data-on={on ? '' : undefined}
      className={cn(CHIP, 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', on && CHIP_ON, className)}
      {...props}>
      <span data-chip-text="" className="min-w-0 truncate">{children}</span>
      <ChevronDownIcon aria-hidden="true" className={on ? undefined : 'text-muted-foreground'} />
    </button>
  );
}
