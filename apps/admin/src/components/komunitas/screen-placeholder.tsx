import { useT } from '@/i18n';
import type { KomunitasPlaceholderScreen } from '@/i18n/komunitas';

/**
 * What a reports or accreditation screen (or a workspace tab) shows until the task that owns it replaces its
 * placeholder file: its own `komunitas.placeholder.<screen>` text, inside the shell like any section. The route, the
 * screen's export name and the lazy chunk are already the final ones, so the owner only rewrites the screen. A tab's
 * placeholder is a level-2 heading, under the workspace's own.
 */
export function KomunitasPlaceholder({ screen, level = 1 }: { screen: KomunitasPlaceholderScreen; level?: 1 | 2 }) {
  const t = useT();
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div data-screen-placeholder={screen} className="mx-auto flex max-w-lg flex-col items-start gap-3 py-12">
      <Heading className={level === 1 ? 'text-2xl font-semibold' : 'text-lg font-semibold'}>{t(`komunitas.placeholder.${screen}`)}</Heading>
    </div>
  );
}
