import { siteIconPath, type SiteIdentityPublic } from '@altis/shared/api/site-identity';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The site's identity as every visitor may know it (`GET site/identity/public`, no session needed): the name, the
 * logos, the icon. The sidebar and the sign-in page draw the library's brand from it. It is read once and kept; the
 * identity screen invalidates {@link SITE_IDENTITY_PUBLIC_KEY} after a save. While the request is pending or when it
 * fails the hook answers undefined, and the caller shows the library's name it already has.
 */

export const SITE_IDENTITY_PUBLIC_KEY = ['site', 'identity', 'public'] as const;

export function useSiteIdentity(): SiteIdentityPublic | undefined {
  return useQuery({
    queryKey: SITE_IDENTITY_PUBLIC_KEY,
    queryFn: () => api<SiteIdentityPublic>('GET', 'site/identity/public'),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  }).data;
}

/** The icon the collapsed sidebar shows: the library's own or the built-in one, the server answers either way. */
export const SITE_ICON_URL = siteIconPath(192);
