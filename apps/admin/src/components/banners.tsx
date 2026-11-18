import type { Banner } from '@altis/shared/api/auth';
import { Link } from '@tanstack/react-router';
import { TONE_SURFACE, TONE_TEXT } from '@/components/layout/status';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { isServerPage, safeNext } from '@/lib/api';
import { useBuildMismatch } from '@/lib/build-sync';
import { page } from '@/lib/page';
import { cn } from '@/lib/utils';

/** A banner's box: the message left, its button right (under it on a narrow screen). */
const BANNER = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border px-3.5 py-2.5 text-sm';

/**
 * The status banner slot of the shell (spec §13.3; decision D32): the banners `GET auth/me` names (maintenance and
 * clock in the community edition; an edition may add its own providers) and, first, the version-sync banner
 * "ALTIS telah diperbarui — muat ulang" while a dirty form keeps the page from reloading itself (§4.8).
 *
 * Each is a one-line callout above the page (the message in words, its button at the end): neutral for information,
 * amber for a warning, red for an error.
 */
export function Banners({ banners }: { banners: readonly Banner[] }) {
  const t = useT();
  const mismatch = useBuildMismatch();
  if (banners.length === 0 && !mismatch) return null;
  return (
    <section aria-label={t('shell.banners_label')} className="flex w-full max-w-[1400px] flex-col gap-2 px-4 pt-4 lg:px-6 lg:pt-6">
      {mismatch && (
        <div role="alert" data-banner="build" className={cn(BANNER, 'border-border bg-background')}>
          <p className="font-semibold">{t('shell.build_mismatch')}</p>
          <Button size="sm" variant="outline" onClick={() => page.reload()}>
            {t('shell.reload')}
          </Button>
        </div>
      )}
      {banners.map((banner) => (
        <div
          key={banner.kind}
          role="alert"
          data-banner={banner.kind}
          className={cn(BANNER, banner.severity === 'info' ? 'border-border bg-background' : TONE_SURFACE[banner.severity === 'error' ? 'bad' : 'warn'])}>
          <p className={cn('font-semibold', banner.severity !== 'info' && TONE_TEXT[banner.severity === 'error' ? 'bad' : 'warn'])}>{t(banner.messageKey, banner.params)}</p>
          {banner.link !== undefined && safeNext(banner.link) === banner.link && (
            <Button asChild size="sm" variant="outline" className="bg-background">
              {/* 1c Task 19: the operations page is the server's (`/admin/_update`): loaded, not routed. */}
              {isServerPage(banner.link) ? (
                <a href={banner.link}>{t('shell.banner_link')}</a>
              ) : (
                <Link to={banner.link}>{t('shell.banner_link')}</Link>
              )}
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
