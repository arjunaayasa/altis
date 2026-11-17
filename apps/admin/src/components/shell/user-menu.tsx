import { LOCALES, type Locale } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { useNavigate } from '@tanstack/react-router';
import { useSetLanguage } from '@/components/command-palette';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLocale, useT } from '@/i18n';
import { THEME_CHOICES, useThemeChoice, type ThemeChoice } from '@/lib/theme';

type SignedIn = Extract<MeResponse, { authenticated: true }>;

const GROUP_LABEL = 'px-2 pt-1.5 pb-1 text-xs font-semibold text-faint';

/**
 * The user menu of the top bar, under the user's name: the profile, the colour theme of this browser (Terang / Gelap /
 * Ikuti sistem), the language and signing out. No icons; the radio dot marks the choices in use.
 */
export function UserMenu({ me, onLogout }: { me: SignedIn; onLogout(): void }) {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const setLanguage = useSetLanguage();
  const [theme, setTheme] = useThemeChoice();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-40 font-normal text-muted-foreground hover:text-foreground" aria-label={t('shell.user_menu', { name: me.user.name })}>
          <span className="truncate">{me.user.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="grid gap-0.5 font-normal">
          <span className="truncate font-semibold">{me.user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{me.user.username}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void navigate({ to: '/admin/profile' })}>{t('palette.profile')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={GROUP_LABEL}>{t('shell.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeChoice)}>
          {THEME_CHOICES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {t(`shell.theme.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={GROUP_LABEL}>{t('palette.group.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={(value) => void setLanguage(value as Locale)}>
          {LOCALES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} lang={option}>
              {t(`palette.language.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout}>{t('palette.logout')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
