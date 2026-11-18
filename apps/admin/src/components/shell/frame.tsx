import type { MeResponse } from '@altis/shared/api/auth';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBrand } from '@/components/shell/brand';
import { Sidebar, moduleLabel } from '@/components/shell/sidebar';
import { useSidebarCollapsed } from '@/components/shell/sidebar-state';
import { TopBar } from '@/components/shell/top-bar';
import { useT } from '@/i18n';
import { activeModule, activeNavPath, visibleModules } from '@/lib/nav';
import { cn } from '@/lib/utils';

export { paletteShortcut } from '@/components/shell/top-bar';

type SignedIn = Extract<MeResponse, { authenticated: true }>;

/**
 * The look of the admin frame around a screen: the sidebar on the left at the full height of the window (the library's
 * brand, the whole navigation, the button that collapses it), and beside it the top bar (where the user is, the
 * command search, the date, the notifications, the user menu) over `children` (the banners and the screen), on the
 * page's grey.
 *
 * Wide screens: the sidebar is 240 px, or 56 px (icons only) once the user collapsed it; the choice is this browser's
 * (sidebar-state.ts).
 *
 * Narrow screens (under 1024 px): the sidebar is a drawer opened by the top bar's menu button. While it is open it is a
 * modal dialog: the rest of the frame is inert (the focus stays in the drawer, and a screen reader reads only it).
 * Escape (wherever the focus is), the scrim or the drawer's close button closes it and gives the focus back to the menu
 * button; any change of page closes it, and so does a window grown to the wide layout.
 */
export function ShellFrame({ me, pathname, onPalette, onLogout, children }: { me: SignedIn; pathname: string; onPalette(): void; onLogout(): void; children: ReactNode }) {
  const t = useT();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  // The page the drawer was opened on: open only while the page stays the same, so any change of page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const navOpen = openOn === pathname;
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  // Closed by Escape, the scrim or the close button: the focus goes back to the menu button once the frame is no longer inert.
  const returnFocus = useRef(false);

  // Beranda is there for a fully signed-in session (it needs no permission). A session that now owes the second factor
  // (signed in again in another tab) sees no module at all, and an empty sidebar while the shell sends it to sign in.
  const modules = visibleModules(me);
  const active = activeModule(modules, pathname);
  const current = activeNavPath(
    modules.flatMap((m) => m.items),
    pathname,
  );
  const view = modules.find((m) => m.module === active);
  const page = view?.items.find((item) => item.to === current);
  // Beranda is one page: its crumb is the module alone.
  const crumbs = { module: moduleLabel(t, active), page: page === undefined || active === 'home' ? null : t(page.labelKey) };
  // The library's own logo and icon come with the site's identity; until it is read its name stands as text.
  const brand = useBrand(me.library.name);

  // The drawer just opened: the focus goes into it, on the marked page if there is one. Just closed by Escape, the
  // scrim or its close button: back to the menu button.
  useEffect(() => {
    if (!navOpen) {
      if (returnFocus.current) menuButton.current?.focus();
      returnFocus.current = false;
      return;
    }
    const target = drawer.current?.querySelector<HTMLElement>('a[aria-current="page"]') ?? drawer.current?.querySelector<HTMLElement>('nav a, nav button');
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
    <div data-slot="shell" className={cn('min-h-dvh bg-page lg:grid', collapsed ? 'lg:grid-cols-[56px_minmax(0,1fr)]' : 'lg:grid-cols-[240px_minmax(0,1fr)]')}>
      <a
        href="#main"
        inert={navOpen}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2"
      >
        {t('shell.skip_to_content')}
      </a>
      <Sidebar
        ref={drawer}
        brand={brand}
        modules={modules}
        active={active}
        current={current}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        drawer={navOpen}
        onClose={closeDrawer}
        onNavigate={() => setOpenOn(null)}
      />
      {navOpen && <div aria-hidden="true" data-slot="scrim" className="fixed inset-0 z-40 bg-(--scrim) lg:hidden" onClick={closeDrawer} />}
      <div className="flex min-h-dvh min-w-0 flex-col">
        <header inert={navOpen} className="sticky top-0 z-30 flex h-13 shrink-0 items-center gap-1.5 border-b bg-background px-3 lg:gap-3 lg:px-6">
          <TopBar
            me={me}
            crumbs={crumbs}
            drawerOpen={navOpen}
            onDrawerToggle={() => setOpenOn((open) => (open === pathname ? null : pathname))}
            menuButtonRef={menuButton}
            onPalette={onPalette}
            onLogout={onLogout}
          />
        </header>
        <div inert={navOpen} className="flex min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
