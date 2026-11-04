import { paletteShortcut } from '@/components/shell/app-shell';
import { useT } from '@/i18n';
import { useMe } from '@/lib/me';
import { Dashboard } from '@/screens/dashboard';

/** Beranda: the first screen after signing in, a welcome above the system dashboard (§13.3 "Dasbor sistem", 1c Task 31). */
export function HomeScreen() {
  const t = useT();
  const me = useMe();
  const name = me?.authenticated === true ? me.user.name : '';
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('nav.home')}</h1>
        <p>{t('home.welcome', { name })}</p>
        <p className="text-muted-foreground">{t('home.intro', { shortcut: paletteShortcut() })}</p>
      </div>
      <Dashboard />
    </div>
  );
}
