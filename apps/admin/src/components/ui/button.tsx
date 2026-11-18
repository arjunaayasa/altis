import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Adapted from shadcn/ui (new-york-v4, MIT: LICENSE-shadcn-ui.txt; see README.md in this folder).

const variants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent text-ui leading-none font-semibold whitespace-nowrap transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-accent-text underline-offset-4 hover:underline',
      },
      // The admin's controls are 34 px high; a small one 28 px.
      size: {
        default: 'h-8.5 px-3',
        sm: 'h-7 px-2 text-meta [&_svg]:size-3.5',
        lg: 'h-9.5 px-4 text-sm',
        icon: 'size-8.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/**
 * The classes of a button of `variant` and `size`, merged so that the variant's border and colours win over the base's
 * (`border-input` over `border-transparent`): also right on a link drawn as a button by hand (`<a className={…}>`).
 */
function buttonVariants(props?: Parameters<typeof variants>[0]): string {
  return cn(variants(props));
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={buttonVariants({ variant, size, className })} {...props} />;
}

export { Button, buttonVariants };
