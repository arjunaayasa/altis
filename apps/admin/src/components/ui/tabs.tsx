import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Adapted from shadcn/ui (new-york-v4, MIT: LICENSE-shadcn-ui.txt; see README.md in this folder). Arrow keys move
// between the triggers (roving focus) and activate them.

function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />;
}

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex h-9 w-full items-stretch justify-start gap-5 border-b text-muted-foreground', className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "-mb-px inline-flex items-center justify-center gap-1.5 border-b-2 border-transparent px-0 pt-1 text-sm font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}

/**
 * The classes of a tab list whose tabs may wrap onto more rows on a narrow screen: the list grows with its rows, and
 * each tab keeps the height of one row. (A tab's default height is a share of the list's, which overflows the list
 * once the tabs wrap and covers the panel below, so its lower tabs can no longer be clicked.)
 */
const WRAPPING_TABS = Object.freeze({ list: 'h-auto flex-wrap', trigger: 'h-7.5' } as const);

export { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS };
