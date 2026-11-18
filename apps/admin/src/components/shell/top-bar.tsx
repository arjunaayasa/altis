import type { MeResponse } from '@altis/shared/api/auth';
import { ChevronRightIcon, MenuIcon, SearchIcon } from 'lucide-react';
import type { Ref } from 'react';
import { NotificationBell } from '@/components/notifications/bell';
import { SIDEBAR_ID } from '@/components/shell/sidebar';
import { UserMenu } from '@/components/shell/user-menu';
import { useLocale, useT } from '@/i18n';

type SignedIn = Extract<MeResponse, { authenticated: true }>;

/** "Ctrl+K", or "⌘K" on Apple systems. */
export function paletteShortcut(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /Mac|iPhone|iPad/.test(platform) ? '⌘K' : 'Ctrl+K';
}

/** Today as the top bar shows it ("Selasa, 17 Nov 2026") and as a `<time>` value. */
function today(locale: string): { text: string; iso: string } {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const text = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).format(now);
  return { text, iso };
}

/** A button of the top bar that shows only an icon. */
const ICON_BUTTON =
  'inline-grid size-7.5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-layer-2 hover:text-foreground [&>svg]:size-4';

export interface TopBarProps {
  me: SignedIn;
  /** Where the user is: the module (Beranda or a group) and, under it, the page; `page` null on a page of no item. */
  crumbs: { module: string; page: string | null };
  /** Whether the sidebar is open as a drawer (a narrow screen). */
  drawerOpen: boolean;
  onDrawerToggle(): void;
  /** The menu button, which gets the focus back when the drawer closes. */
  menuButtonRef: Ref<HTMLButtonElement>;
  onPalette(): void;
  onLogout(): void;
}

/**
 * The top bar (52 px): on a narrow screen the menu button that opens the sidebar as a drawer; where the user is (the
 * module, then the page); the command search with its shortcut (its icon alone on a narrow screen); today's date (wide
 * screens); the notifications; the user menu.
 */
export function TopBar({ me, crumbs, drawerOpen, onDrawerToggle, menuButtonRef, onPalette, onLogout }: TopBarProps) {
  const t = useT();
  const locale = useLocale();
  const date = today(locale);
  return (
    <>
      <button ref={menuButtonRef} type="button" aria-label={t('shell.menu_open')} aria-controls={SIDEBAR_ID} aria-expanded={drawerOpen} onClick={onDrawerToggle} className={`${ICON_BUTTON} lg:hidden`}>
        <MenuIcon aria-hidden="true" />
      </button>
      <nav aria-label={t('shell.breadcrumb_label')} className="mr-auto min-w-0">
        <ol className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground">
          <li className={crumbs.page === null ? 'truncate font-semibold text-foreground' : 'shrink-0 max-sm:hidden'} aria-current={crumbs.page === null ? 'page' : undefined}>
            {crumbs.module}
          </li>
          {crumbs.page !== null && (
            <li className="flex min-w-0 items-center gap-1.5" aria-current="page">
              <ChevronRightIcon aria-hidden="true" className="size-3.25 shrink-0 max-sm:hidden" />
              <span className="truncate font-semibold text-foreground">{crumbs.page}</span>
            </li>
          )}
        </ol>
      </nav>
      <button
        type="button"
        aria-label={t('shell.open_palette')}
        aria-keyshortcuts="Control+K Meta+K"
        onClick={onPalette}
        className="flex h-8 shrink-0 items-center gap-2 rounded-md text-ui text-muted-foreground transition-colors duration-150 ease-out max-lg:w-7.5 max-lg:justify-center max-lg:hover:bg-layer-2 max-lg:hover:text-foreground lg:w-[280px] lg:border lg:border-border-strong lg:bg-background lg:pr-2 lg:pl-2.5 lg:hover:border-muted-foreground"
      >
        <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate max-lg:hidden">{t('shell.open_palette')}</span>
        <kbd className="ml-auto max-lg:hidden">{paletteShortcut().replace('+', ' ')}</kbd>
      </button>
      <time dateTime={date.iso} className="text-ui whitespace-nowrap text-muted-foreground max-[1179px]:hidden">
        {date.text}
      </time>
      <div data-slot="notifications" className="flex shrink-0">
        <NotificationBell />
      </div>
      <UserMenu me={me} onLogout={onLogout} />
    </>
  );
}
