import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Adapted from shadcn/ui (new-york-v4, MIT: LICENSE-shadcn-ui.txt; see README.md in this folder).

function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn('flex items-center gap-2 text-sm leading-none font-semibold select-none peer-disabled:opacity-50', className)}
      {...props}
    />
  );
}

export { Label };
