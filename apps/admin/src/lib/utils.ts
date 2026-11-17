import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge told about the theme values index.css adds: the type size `text-meta` (13 px) and the shadow
 * `shadow-pop`. Unknown, it would take `text-meta` for a colour and drop the colour beside it (`text-primary-foreground`).
 */
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['meta'], shadow: ['pop'] } } });

/** Joins class names, later Tailwind utilities winning over earlier ones of the same property (`p-2` then `p-4`). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
