import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Adapted from shadcn/ui (new-york-v4, MIT: LICENSE-shadcn-ui.txt; see README.md in this folder).

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-8.5 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-base transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-bad-bg md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
