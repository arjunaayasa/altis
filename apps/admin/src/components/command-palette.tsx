import { LOCALES, type Locale } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { ME_KEY } from '@/lib/me';
import { visibleNavSections } from '@/lib/nav';
import { THEME_CHOICES, useThemeChoice } from '@/lib/theme';

type SignedIn = Extract<MeResponse, { authenticated: true }>;

/** Signs out (`POST auth/logout`) and opens the sign-in page, also when the session was already gone. */
export async function logout(o: { clearMe(): void; navigate(href: string): void }): Promise<void> {
  try {
    await api('POST', 'auth/logout');
  } catch {
    // An expired session is signed out already; the sign-in page is the right place either way.
  }
  o.clearMe();
  o.navigate('/admin/login');
}

/**
 * Sets the user's language (their own setting, `PATCH auth/me`): the shell switches at once and follows the server's
 * answer. Used by the palette and the user menu.
 */
export function useSetLanguage(): (next: Locale) => Promise<void> {
  const queryClient = useQueryClient();
  return async (next) => {
    queryClient.setQueryData<MeResponse>(ME_KEY, (current) =>
      current?.authenticated === true ? { ...current, user: { ...current.user, locale: next } } : current,
    );
    try {
      await api('PATCH', 'auth/me', { locale: next });
    } catch {
      // Not saved: the answer of auth/me below brings the language the server keeps back.
    } finally {
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
    }
  };
}

/**
 * The command palette (Ctrl/⌘+K): the sections the user may open (the same filter as the navigation),
 * under the navigation's groups (Phase 2: Katalog, OPAC, Sistem), then the account (profile, sign out), the language
 * and the colour theme (as in the user menu). No icons; a check marks the language and the theme in use.
 */
export function CommandPalette({ me, open, onOpenChange }: { me: SignedIn; open: boolean; onOpenChange(open: boolean): void }) {
  const t = useT();
  const locale = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setLanguage = useSetLanguage();
  const [theme, setTheme] = useThemeChoice();

  const run = (action: () => void | Promise<void>): void => {
    onOpenChange(false);
    void action();
  };

  const inUse = (
    <>
      <CheckIcon aria-hidden="true" className="ml-auto" />
      <span className="sr-only">{t('palette.current')}</span>
    </>
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('palette.title')} description={t('palette.description')}>
      <CommandInput placeholder={t('palette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('palette.empty')}</CommandEmpty>
        {/* Phase 2 (Task 2): the sections by nav group, Beranda under Navigasi (lib/nav.ts). */}
        {visibleNavSections(me).map((section) => (
          <CommandGroup
            key={section.group ?? 'top'}
            heading={section.group === null ? t('palette.group.navigation') : t(`nav.group.${section.group}`)}
          >
            {section.items.map((item) => (
              <CommandItem key={item.to} value={`${t(item.labelKey)} ${item.to}`} onSelect={() => run(() => navigate({ to: item.to }))}>
                {t(item.labelKey)}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading={t('palette.group.account')}>
          <CommandItem value={t('palette.profile')} onSelect={() => run(() => navigate({ to: '/admin/profile' }))}>
            {t('palette.profile')}
          </CommandItem>
          <CommandItem
            value={t('palette.logout')}
            onSelect={() =>
              run(() =>
                logout({
                  clearMe: () => queryClient.removeQueries({ queryKey: ME_KEY }),
                  navigate: (href) => void navigate({ href }),
                }),
              )
            }
          >
            {t('palette.logout')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('palette.group.language')}>
          {LOCALES.map((option) => (
            <CommandItem key={option} value={t(`palette.language.${option}`)} onSelect={() => run(() => setLanguage(option))}>
              <span lang={option}>{t(`palette.language.${option}`)}</span>
              {option === locale && inUse}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('shell.theme')}>
          {THEME_CHOICES.map((option) => (
            <CommandItem key={option} value={`${t('shell.theme')} ${t(`shell.theme.${option}`)}`} onSelect={() => run(() => setTheme(option))}>
              {t(`shell.theme.${option}`)}
              {option === theme && inUse}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
