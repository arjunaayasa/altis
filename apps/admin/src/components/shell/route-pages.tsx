import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { ApiError } from '@/lib/api';
import { page } from '@/lib/page';

/** What the router shows for a path no route serves (inside the shell for `/admin/…`, else on its own). */
export function NotFound() {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-3 py-12">
      <h1 className="text-2xl font-semibold">{t('page.not_found.title')}</h1>
      <p className="text-muted-foreground">{t('page.not_found.body')}</p>
      <Button asChild variant="outline">
        <Link to="/admin">{t('page.not_found.back')}</Link>
      </Button>
    </div>
  );
}

/**
 * What the router shows when a route fails: a lazy chunk that still fails after its one reload (lib/lazy-reload.ts),
 * or an error thrown while rendering. An API problem shows its localized message and its reference code; nothing
 * else of the error reaches the page.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const t = useT();
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-start gap-3 py-12">
      <h1 className="text-2xl font-semibold">{t('page.error.title')}</h1>
      <p className="text-muted-foreground">{error instanceof ApiError ? t(`error.${error.code}`) : t('page.error.body')}</p>
      {error instanceof ApiError && error.traceId !== undefined && (
        <p className="text-xs text-muted-foreground">{t('page.error.trace', { code: error.traceId.slice(-8) })}</p>
      )}
      <Button variant="outline" onClick={() => page.reload()}>
        {t('shell.reload')}
      </Button>
    </div>
  );
}

/** Shown while a route's data or chunk loads. */
export function Pending() {
  const t = useT();
  return (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      {t('shell.loading')}
    </p>
  );
}
