import type { MeResponse } from '@altis/shared/api/auth';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NotificationBell } from '@/components/notifications/bell';
import { ModuleBar, ModuleMenu, RouterAnchor, itemLabel, moduleLabel } from '@/components/shell/module-nav';
import { UserMenu } from '@/components/shell/user-menu';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { activeModule, activeNavPath, visibleModules, visibleShortcuts, type ModuleView } from '@/lib/nav';
import { cn } from '@/lib/utils';

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

/**
 * The look of the admin frame around a screen: the top bar (the library, where the user is, the command search, the
 * date, the notifications, the user menu and signing out), the module bar under it, the sidebar with the pages of the
 * active module, and `children` (the banners and the screen) beside the sidebar.
 *
 * Narrow screens (under 1024 px): the module bar scrolls sideways and the sidebar is a drawer opened by "Menu". While
 * it is open it is a modal dialog: the rest of the frame is inert (the focus stays in the drawer, and a screen reader
 * reads only it). Escape (wherever the focus is) or the scrim closes it and gives the focus back to "Menu"; any change of
 * page closes it, and so does a window grown to the wide layout.
 */
export function ShellFrame({ me, pathname, onPalette, onLogout, children }: { me: SignedIn; pathname: string; onPalette(): void; onLogout(): void; children: ReactNode }) {
  const t = useT();
  const locale = useLocale();
  // The page the drawer was opened on: open only while the page stays the same, so any change of page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const navOpen = openOn === pathname;
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  // Closed by Escape or the scrim: the focus goes back to "Menu" once the frame is no longer inert.
  const returnFocus = useRef(false);

  const modules = visibleModules(me);
  const active = activeModule(modules, pathname);
  // Beranda is there for a fully signed-in session (it needs no permission). A session that now owes the second factor
  // (signed in again in another tab) sees no module at all, and an empty Beranda while the shell sends it to sign in.
  const view: ModuleView = modules.find((m) => m.module === active) ?? modules[0] ?? { module: 'home', items: [] };
  const current = activeNavPath(view.items, pathname);
  const page = view.items.find((item) => item.to === current);
  const date = today(locale);

  // The drawer just opened: the focus goes into it, on the marked page if there is one. Just closed by Escape or the
  // scrim: back to "Menu".
  useEffect(() => {
    if (!navOpen) {
      if (returnFocus.current) menuButton.current?.focus();
      returnFocus.current = false;
      return;
    }
    const target = drawer.current?.querySelector<HTMLElement>('a[aria-current="page"]') ?? drawer.current?.querySelector<HTMLElement>('a');
    target?.focus();
    // Escape closes it wherever the focus is; the wide layout has no drawer.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      returnFocus.current = true;
      setOpenOn(null);
    };
    document.addEventListener('keydown', onKey);
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1024px)') : null;
    const onWide = (): void => {
      if (wide?.matches === true) setOpenOn(null);
    };
    wide?.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      wide?.removeEventListener('change', onWide);
    };
  }, [navOpen]);

  const closeDrawer = (): void => {
    returnFocus.current = true;
    setOpenOn(null);
  };

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        inert={navOpen}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2"
      >
        {t('shell.skip_to_content')}
      </a>
      <header inert={navOpen} className="sticky top-0 z-30 border-b bg-background">
        <div className="flex h-12 items-center gap-2 border-b px-3 lg:px-5">
          <Button
            ref={menuButton}
            variant="outline"
            size="sm"
            className="lg:hidden"
            aria-controls="altis-sidebar"
            aria-expanded={navOpen}
            onClick={() => setOpenOn((open) => (open === pathname ? null : pathname))}
          >
            {t('shell.menu')}
          </Button>
          <RouterAnchor to="/admin" className="flex min-w-0 shrink items-baseline gap-2.5 rounded-sm text-foreground no-underline" onClick={() => setOpenOn(null)}>
            <span className="text-base font-bold tracking-[0.06em]">ALTIS</span>
            <span className="truncate text-meta text-muted-foreground">{me.library.name}</span>
          </RouterAnchor>
          <nav aria-label={t('shell.breadcrumb_label')} className="hidden min-w-0 shrink items-center md:flex">
            <span aria-hidden="true" className="mx-3 h-5 w-px shrink-0 bg-border" />
            <ol className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
              <li className="shrink-0" aria-current={page === undefined ? 'page' : undefined}>
                {moduleLabel(t, view.module)}
              </li>
              {page !== undefined && (
                <li className="flex min-w-0 items-center gap-1.5" aria-current="page">
                  <span aria-hidden="true">›</span>
                  <span className="truncate font-semibold text-foreground">{itemLabel(t, page)}</span>
                </li>
              )}
            </ol>
          </nav>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:inline-flex"
            aria-label={t('shell.open_palette')}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={onPalette}
          >
            {t('shell.open_palette')}
            <kbd>{paletteShortcut()}</kbd>
          </Button>
          <time dateTime={date.iso} className="hidden px-2 text-meta whitespace-nowrap text-muted-foreground xl:inline">
            {date.text}
          </time>
          <div data-slot="notifications">
            <NotificationBell />
          </div>
          <UserMenu me={me} onLogout={onLogout} />
          <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={onLogout}>
            {t('palette.logout')}
          </Button>
        </div>
        <ModuleBar modules={modules} active={view.module} />
      </header>
      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <div
          id="altis-sidebar"
          ref={drawer}
          role={navOpen ? 'dialog' : undefined}
          aria-modal={navOpen ? true : undefined}
          aria-label={navOpen ? t('shell.menu') : undefined}
          className={cn(
            'flex flex-col gap-4 overflow-y-auto border-r bg-layer px-2.5 py-4',
            'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-[260px] max-lg:transition-[translate,visibility] max-lg:duration-200 max-lg:ease-out',
            navOpen ? 'max-lg:visible max-lg:translate-x-0 max-lg:shadow-pop' : 'max-lg:invisible max-lg:-translate-x-full',
            'lg:sticky lg:top-[91px] lg:h-[calc(100dvh-91px)]',
          )}
        >
          <ModuleMenu view={view} current={current} shortcuts={visibleShortcuts(me)} onNavigate={() => setOpenOn(null)} />
        </div>
        {navOpen && <div aria-hidden="true" className="fixed inset-0 z-40 bg-(--scrim) lg:hidden" onClick={closeDrawer} />}
        <div inert={navOpen} className="flex min-w-0 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
