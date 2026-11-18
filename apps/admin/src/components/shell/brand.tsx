import type { SiteIdentityPublic } from '@altis/shared/api/site-identity';
import { SITE_ICON_URL, useSiteIdentity } from '@/lib/site-identity';
import { cn } from '@/lib/utils';

/** What a brand area shows: the site's name, and the library's own logos and square icon once it uploaded them. */
export interface BrandProps {
  /** The site's name: the text shown when there is no logo, and the logo's alternative text when it has none. */
  name: string;
  /** The main logo, drawn for a light background. */
  logoUrl?: string;
  /** The logo drawn for a dark background; without one the main logo stands on a small white plate there. */
  logoDarkUrl?: string;
  /** The main logo's alternative text. */
  logoAlt?: string;
  /** The square site icon, shown where there is no room for the logo. */
  iconUrl?: string;
  /** Whether the name is written beside the logo (a logo that is only a mark). */
  showName?: boolean;
}

/** The brand of `identity`; before it is known (or when it could not be read), `fallbackName` as text. */
export function brandOf(identity: SiteIdentityPublic | undefined, fallbackName: string): BrandProps {
  if (identity === undefined) return { name: fallbackName };
  return {
    name: identity.name,
    ...(identity.logo === null ? {} : { logoUrl: identity.logo.url, logoAlt: identity.logo.alt }),
    ...(identity.logoDark === null ? {} : { logoDarkUrl: identity.logoDark.url }),
    // The server answers the icon's address with or without an icon of the library's own (then a built-in one).
    iconUrl: SITE_ICON_URL,
    showName: identity.showNameBesideLogo,
  };
}

/** The brand from the site's identity (lib/site-identity.ts), with `fallbackName` until it is there. */
export function useBrand(fallbackName: string): BrandProps {
  return brandOf(useSiteIdentity(), fallbackName);
}

/** The white plate a logo made for a light background stands on where the background is dark. */
const PLATE = 'inline-flex shrink-0 items-center rounded-md bg-white';

/** The logo's alternative text: nothing when the name is written beside it, else its own text or the name. */
function altOf({ name, logoAlt, showName }: BrandProps): string {
  if (showName === true) return '';
  return logoAlt === undefined || logoAlt.trim() === '' ? name : logoAlt;
}

/**
 * The library's brand in the sidebar, which is dark in both themes: the logo for dark backgrounds (30 px high), else
 * the main logo on a small white plate, else the name as plain text; the name also stands beside a logo that asks for
 * it. `compact` (the collapsed sidebar) shows the square icon instead. Nothing is made up: no monogram, no badge. The
 * name is always there for a screen reader.
 */
export function SidebarBrand({ compact = false, ...brand }: BrandProps & { compact?: boolean }) {
  const { name, logoUrl, logoDarkUrl, iconUrl, showName } = brand;
  if (compact) {
    return iconUrl === undefined ? <span className="sr-only">{name}</span> : <img src={iconUrl} alt={name} className="size-7 rounded-[5px]" />;
  }
  const text = <span className="min-w-0 truncate text-[0.90625rem] font-semibold text-side-strong">{name}</span>;
  if (logoUrl === undefined && logoDarkUrl === undefined) return text;
  return (
    <>
      {logoDarkUrl !== undefined ? (
        <img src={logoDarkUrl} alt={altOf(brand)} className="h-7.5 w-auto max-w-full min-w-0 shrink-0 object-contain" />
      ) : (
        <span data-slot="logo-plate" className={cn(PLATE, 'h-7.5 px-1')}>
          <img src={logoUrl} alt={altOf(brand)} className="h-6.5 w-auto max-w-40 object-contain" />
        </span>
      )}
      {showName === true && text}
    </>
  );
}

/**
 * The library's brand on a page of its own (the sign-in card): the main logo (44 px high), or the name as text
 * (17 px). In the dark theme the logo for dark backgrounds takes its place; without one the main logo stands on a
 * white plate there.
 */
export function PageBrand({ className, ...brand }: BrandProps & { className?: string }) {
  const { name, logoUrl, logoDarkUrl, showName } = brand;
  const text = <p className={cn('text-[1.0625rem] leading-tight font-bold', logoUrl === undefined && className)}>{name}</p>;
  if (logoUrl === undefined) return text;
  const alt = altOf(brand);
  return (
    <div data-slot="page-brand" className={cn('flex min-w-0 items-center gap-3', className)}>
      {logoDarkUrl === undefined ? (
        <span data-slot="logo-plate" className="inline-flex shrink-0 items-center rounded-md dark:bg-white dark:px-1.5">
          <img src={logoUrl} alt={alt} className="h-11 w-auto max-w-full object-contain" />
        </span>
      ) : (
        <>
          <img src={logoUrl} alt={alt} className="h-11 w-auto max-w-full object-contain dark:hidden" />
          <img src={logoDarkUrl} alt={alt} className="hidden h-11 w-auto max-w-full object-contain dark:block" />
        </>
      )}
      {showName === true && text}
    </div>
  );
}
