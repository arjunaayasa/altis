import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** What a {@link SettingRow} hands its control: the ids that link it to the row's title and description. */
export interface SettingControl {
  id: string;
  'aria-describedby': string | undefined;
}

/** Whether the form fields drawn here are the rows of a settings card (see {@link SettingRowsScope}). */
const SettingRows = createContext(false);

/** True inside a {@link SettingRowsScope}. */
export function useSettingRows(): boolean {
  return useContext(SettingRows);
}

/**
 * Marks its children as the content of a settings card: a `Field` or a `CheckField` (components/form-field.tsx) drawn
 * inside is laid out as a setting row (its label and hint on the left, its control on the right) instead of a label
 * above its control, so a settings form keeps its fields, ids and messages and only changes its layout.
 */
export function SettingRowsScope({ children }: { children: ReactNode }) {
  return <SettingRows.Provider value={true}>{children}</SettingRows.Provider>;
}

/** The box of a setting row: two columns on a wide screen, a thin rule above, the card's 16 px at the sides. */
export const SETTING_ROW = 'grid items-center gap-x-6 gap-y-2 border-t px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]';

/** A part of a settings card that is not a row (a note, a list, a group of rows with its own title): the same rule and sides. */
export const SETTING_BLOCK = 'grid min-w-0 gap-3 border-t px-4 py-3';

/**
 * A part of a settings card that is not a row: an editor of a list, a note, a group of fields with a layout of their
 * own. It takes the row's rule and sides ({@link SETTING_BLOCK}), and the fields inside it are laid out as fields
 * (a label above its control) again.
 */
export function SettingBlock({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-slot="setting-block" className={cn(SETTING_BLOCK, className)}>
      <SettingRows.Provider value={false}>{children}</SettingRows.Provider>
    </div>
  );
}

/**
 * One setting inside a titled card: its name and a sentence on the left, its control on the right (under them on a
 * narrow screen), a thin rule above every row but the first after the card's head. Pass the control as a function to
 * link it: the name becomes its `<label>` and the sentence its description.
 *
 * ```tsx
 * <SettingRow title="Nama perpustakaan" description="Tampil di kepala situs.">{(c) => <Input {...c} />}</SettingRow>
 * ```
 */
export function SettingRow({
  title,
  description,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode | ((control: SettingControl) => ReactNode);
}) {
  const id = useId();
  const descriptionId = `${id}-d`;
  const linked = typeof children === 'function';
  return (
    <div
      data-slot="setting-row"
      className={cn(SETTING_ROW, '[[data-slot=card-head]+&]:border-t-0', className)}>
      <div className="min-w-0">
        {linked ? (
          <label htmlFor={id} className="block font-semibold">
            {title}
          </label>
        ) : (
          <p className="font-semibold">{title}</p>
        )}
        {description !== undefined && (
          <p id={descriptionId} className="text-meta text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 lg:justify-end">{linked ? children({ id, 'aria-describedby': description === undefined ? undefined : descriptionId }) : children}</div>
    </div>
  );
}
