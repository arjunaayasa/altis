import { cn } from '@/lib/utils';

/** The first letters of the first two words of a name (`Siti Aminah` → `SA`). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join('');
}

/**
 * A member's photo at 3:4 (60 × 80, or 96 × 128 for `lg`), or the initials on the neutral layer when there is none.
 * The photo is decorative next to the name, so it has no text of its own unless `alt` is given.
 */
export function MemberPhoto({ name, fileId, size = 'sm', alt }: { name: string; fileId: string | null; size?: 'sm' | 'lg'; alt?: string }) {
  const box = size === 'lg' ? 'h-32 w-24 text-2xl' : 'h-20 w-15 text-base';
  if (fileId !== null) {
    return <img src={`/files/${encodeURIComponent(fileId)}`} alt={alt ?? ''} className={cn('shrink-0 rounded border object-cover', box)} />;
  }
  return (
    <span aria-hidden={alt === undefined ? true : undefined} role={alt === undefined ? undefined : 'img'} aria-label={alt} className={cn('grid shrink-0 place-items-center rounded border bg-layer-2 font-bold text-muted-foreground', box)}>
      {initials(name)}
    </span>
  );
}
