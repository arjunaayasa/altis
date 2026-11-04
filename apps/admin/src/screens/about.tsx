import { COMMUNITY_LICENSE_SPDX, COMMUNITY_SOURCE_URL } from '@altis/shared';
import { ExternalLinkIcon, LibraryIcon } from 'lucide-react';
import { EDITION, editionName } from '@/edition';
import { useT } from '@/i18n';
import { useMe } from '@/lib/me';

/**
 * Tentang (spec §13.3 "Kerangka admin: halaman Tentang"; every signed-in staff user): the build this admin SPA is
 * (`__ALTIS_BUILD__`), the server's own when it already runs another one, the edition ("Edisi Komunitas"), the
 * software licence (AGPL-3.0-only) with the link to the source code (AGPL §13: whoever uses ALTIS over a network is
 * offered its source; ruling R24), and the third-party notices the release ships (`GET /legal/third-party-notices.txt`,
 * the same text as THIRD_PARTY_NOTICES.txt).
 */
export function AboutScreen() {
  const t = useT();
  const me = useMe();
  const server = me?.build;
  const serverDiffers = server !== undefined && server !== __ALTIS_BUILD__;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex items-start gap-3">
        <LibraryIcon className="mt-1 size-8 shrink-0 text-primary" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('about.title')}</h1>
          <p className="text-muted-foreground">{t('about.product')}</p>
        </div>
      </header>
      <dl className="grid gap-x-6 gap-y-2 rounded-lg border bg-card p-5 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t('about.version')}</dt>
        <dd className="font-mono font-medium">{__ALTIS_BUILD__}</dd>
        {serverDiffers && (
          <>
            <dt className="text-muted-foreground">{t('about.server_version')}</dt>
            <dd>
              <span className="font-mono font-medium">{server}</span>
              <span className="block text-xs text-muted-foreground">{t('about.server_differs')}</span>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t('about.edition')}</dt>
        <dd className="font-medium">{editionName(t, EDITION)}</dd>
        <dt className="text-muted-foreground">{t('about.software_license')}</dt>
        <dd className="font-mono font-medium">{COMMUNITY_LICENSE_SPDX}</dd>
        <dt className="text-muted-foreground">{t('about.source')}</dt>
        <dd className="break-words">
          <a
            href={COMMUNITY_SOURCE_URL}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            {COMMUNITY_SOURCE_URL.replace(/^https:\/\//, '')}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        </dd>
        {me !== undefined && (
          <>
            <dt className="text-muted-foreground">{t('about.library')}</dt>
            <dd className="break-words">{me.library.name}</dd>
          </>
        )}
      </dl>
      <section className="flex flex-col gap-1 text-sm">
        <a
          href="/legal/third-party-notices.txt"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('about.notices')}
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </a>
        <p className="text-muted-foreground">{t('about.notices_hint')}</p>
      </section>
    </div>
  );
}
