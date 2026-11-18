import { cn } from '@/lib/utils';

/** What a brand area shows: the library's name, and its own logo and square icon once it uploaded them. */
export interface BrandProps {
  /** The library's name: the text shown when there is no logo, and the logo's alternative text. */
  name: string;
  /** The logo (for the background it stands on). */
  logoUrl?: string;
  /** The square site icon, shown where there is no room for the logo. */
  iconUrl?: string;
}

/**
 * The library's brand in the sidebar: its logo (30 px high), or its name as plain text; `compact` (the collapsed
 * sidebar) shows the square icon instead. Without a logo or an icon nothing is made up: no monogram, no badge. The
 * name is always there for a screen reader.
 */
export function SidebarBrand({ name, logoUrl, iconUrl, compact = false }: BrandProps & { compact?: boolean }) {
  if (compact) {
    return iconUrl === undefined ? <span className="sr-only">{name}</span> : <img src={iconUrl} alt={name} className="size-7 rounded-[5px]" />;
  }
  return logoUrl === undefined ? (
    <span className="min-w-0 truncate text-[0.90625rem] font-semibold text-side-strong">{name}</span>
  ) : (
    <img src={logoUrl} alt={name} className="h-7.5 w-auto max-w-full" />
  );
}

/** The library's brand on a page of its own (the sign-in card): its logo (44 px high), or its name as text (17 px). */
export function PageBrand({ name, logoUrl, className }: BrandProps & { className?: string }) {
  return logoUrl === undefined ? (
    <p className={cn('text-[1.0625rem] leading-tight font-bold', className)}>{name}</p>
  ) : (
    <img src={logoUrl} alt={name} className={cn('h-11 w-auto max-w-full', className)} />
  );
}
