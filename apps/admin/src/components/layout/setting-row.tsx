import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** What a {@link SettingRow} hands its control: the ids that link it to the row's title and description. */
export interface SettingControl {
  id: string;
  'aria-describedby': string | undefined;
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
      className={cn('grid items-center gap-x-6 gap-y-2 border-t px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)] [[data-slot=card-head]+&]:border-t-0', className)}>
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
