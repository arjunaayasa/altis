import type { Banner } from '@altis/shared/api/auth';
import { Link } from '@tanstack/react-router';
import { InfoIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { isServerPage, safeNext } from '@/lib/api';
import { useBuildMismatch } from '@/lib/build-sync';
import { page } from '@/lib/page';
import { cn } from '@/lib/utils';

/**
 * The status banner slot of the shell (spec §13.3; decision D32): the banners `GET auth/me` names (maintenance and
 * clock in the community edition; an edition may add its own providers) and, first, the version-sync banner
 * "ALTIS telah diperbarui — muat ulang" while a dirty form keeps the page from reloading itself (§4.8).
 */
export function Banners({ banners }: { banners: readonly Banner[] }) {
  const t = useT();
  const mismatch = useBuildMismatch();
  if (banners.length === 0 && !mismatch) return null;
  return (
    <section aria-label={t('shell.banners_label')} className="flex flex-col gap-2 px-4 pt-4 md:px-6">
      {mismatch && (
        <Alert className="border-primary/30" data-banner="build">
          <RefreshCwIcon aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-foreground">
            <span>{t('shell.build_mismatch')}</span>
            <Button size="sm" variant="outline" onClick={() => page.reload()}>
              {t('shell.reload')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {banners.map((banner) => (
        <Alert
          key={banner.kind}
          data-banner={banner.kind}
          variant={banner.severity === 'error' ? 'destructive' : 'default'}
          className={cn(banner.severity === 'warning' && 'border-warning-foreground/30 bg-warning text-warning-foreground')}
        >
          {banner.severity === 'info' ? <InfoIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-current">
            <span>{t(banner.messageKey, banner.params)}</span>
            {banner.link !== undefined && safeNext(banner.link) === banner.link && (
              <Button asChild size="sm" variant="outline">
                {/* 1c Task 19: the operations page is the server's (`/admin/_update`): loaded, not routed. */}
                {isServerPage(banner.link) ? (
                  <a href={banner.link}>{t('shell.banner_link')}</a>
                ) : (
                  <Link to={banner.link}>{t('shell.banner_link')}</Link>
                )}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </section>
  );
}
