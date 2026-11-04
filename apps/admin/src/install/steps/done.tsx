import { Button } from '@/components/ui/button';
import { useInstallT } from '../i18n';
import { StepHeading } from '../ui';

// Step 6, done (spec §9.5 step 7): the server wrote installState `complete`, install.lock and the marker, removed the
// code and session files and cleared `altis_install`; every /install request now answers 404. The admin signs in.

/** Where `finish` sends the browser: a same-origin path only (anything else → the sign-in page). */
function safePath(next: string): string {
  return /^\/admin(?:\/[A-Za-z0-9/_-]*)?$/.test(next) ? next : '/admin/login';
}

export function DoneStep({ next }: { next: string }) {
  const t = useInstallT();
  return (
    <div className="space-y-6">
      <StepHeading title={t('done.title')} intro={t('done.body')} />
      <p className="rounded-md bg-muted p-3 text-sm">{t('done.two_factor')}</p>
      <Button asChild>
        <a href={safePath(next)}>{t('done.login')}</a>
      </Button>
    </div>
  );
}
