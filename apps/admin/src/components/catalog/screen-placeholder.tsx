import { useT } from '@/i18n';
import type { CatalogPlaceholderScreen } from '@/i18n/catalog';

/**
 * What a catalogue screen shows until the task that owns it replaces its placeholder file (Phase 2 Task 3, plan
 * decision P2-02): its own `catalog.placeholder.<screen>` text (S22), inside the shell like any section. The route,
 * the screen's export name and the lazy chunk are already the final ones, so the owner only rewrites the screen.
 */
export function ScreenPlaceholder({ screen }: { screen: CatalogPlaceholderScreen }) {
  const t = useT();
  return (
    <div data-screen-placeholder={screen} className="mx-auto flex max-w-lg flex-col items-start gap-3 py-12">
      <h1 className="text-2xl font-semibold">{t(`catalog.placeholder.${screen}`)}</h1>
    </div>
  );
}
