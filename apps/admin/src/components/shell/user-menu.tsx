import { LOCALES, type Locale } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDownIcon } from 'lucide-react';
import { useSetLanguage } from '@/components/command-palette';
import { initials } from '@/components/layout/member-photo';
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
 * The user menu of the top bar, under the user's initials (in a small circle) and name; on a narrow screen the
 * initials alone, the button still named by the user. It holds the profile, the colour theme of this browser (Terang /
 * Gelap / Ikuti sistem), the language and signing out; the radio dot marks the choices in use.
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
        <button
          type="button"
          aria-label={t('shell.user_menu', { name: me.user.name })}
          className="flex h-8 max-w-52 shrink-0 items-center gap-2 rounded-md px-1.5 text-ui font-medium transition-colors duration-150 ease-out hover:bg-layer-2"
        >
          <span aria-hidden="true" className="grid size-6.5 shrink-0 place-items-center rounded-full border border-border-strong bg-layer-2 text-[0.6875rem] font-semibold text-muted-foreground">
            {initials(me.user.name)}
          </span>
          <span className="truncate max-lg:hidden">{me.user.name}</span>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground max-lg:hidden" />
        </button>
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
