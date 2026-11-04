import type { MeResponse } from '@altis/shared/api/auth';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouter } from '@tanstack/react-router';
import { LibraryIcon, LogOutIcon, MenuIcon, SearchIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Banners } from '@/components/banners';
import { CommandPalette, logout } from '@/components/command-palette';
import { NotificationBell } from '@/components/notifications/bell';
import { Pending } from '@/components/shell/route-pages';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { inBackground, isSignInPath, sessionEndedHref } from '@/lib/api';
import { dirtyForms } from '@/lib/dirty-forms';
import { ME_KEY, ShellMeContext, gateTarget, useMe } from '@/lib/me';
import { visibleNavSections, type NavItem } from '@/lib/nav';
import { REALTIME_RESYNC_KEYS, RealtimeContext, createRealtimeHub, invalidateRealtimeKeys, realtimeQueryKeys } from '@/lib/realtime';
import { useShortcuts } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

/** "Ctrl+K", or "⌘K" on Apple systems. */
export function paletteShortcut(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /Mac|iPhone|iPad/.test(platform) ? '⌘K' : 'Ctrl+K';
}

type SignedIn = Extract<MeResponse, { authenticated: true }>;

/**
 * The channels the shell reads for every screen (§10.7): the user's own (`user.<id>`: their notifications), every
 * staff member's (`system.status`), and the system channels the user's permissions open (`system.backup`,
 * `system.update`). A screen adds its own (`jobs.<id>`) with useRealtime.
 */
export function shellChannels(me: SignedIn): string[] {
  const channels = [`user.${me.user.id}`, 'system.status'];
  if (holds(me, 'system.backup.read')) channels.push('system.backup');
  if (holds(me, 'system.update.read')) channels.push('system.update');
  return channels;
}

/**
 * The admin frame (spec §13.3 "Kerangka admin"): the library's name, the navigation the user's permissions allow
 * (lib/nav.ts), the command palette (Ctrl/⌘+K), the status banners, the notification bell (1c) and the screen of the
 * route. The route gate (routes.tsx) only renders it for a fully signed-in session; the language comes from the root
 * (`me.user.locale ?? me.library.locale`).
 *
 * The session can end while the frame is open (idle expiry, a sign-out in another tab, an administrator's action):
 * `auth/me` read again answers signed out. The frame never goes blank: it keeps showing the last signed-in answer,
 * and sends the user to the sign-in page saying the session ended (`?next=` back here). When a form is being filled,
 * it stays instead: the screens keep the last answer (ShellMeContext), the form keeps what was typed, and a warning
 * offers "Masuk lagi" (the form cannot be saved any more, but it can be copied first). When `auth/me` names another
 * user (someone else signed in on this browser meanwhile), the screen starts over under that user (lib/me.ts has
 * forgotten the other user's data); nothing typed before is kept. Any other place the gate now sends to (a password
 * that must change first) is followed at once.
 *
 * The frame owns the tab's realtime client (lib/realtime.ts; 1c Task 28): one per tab, started while the session lasts,
 * reading {@link shellChannels} plus the screens' own (useRealtime, through RealtimeContext), by SSE when
 * `me.client.realtime` says so and the browser has EventSource, else by polling. Each batch of events makes the queries
 * its events name stale, each once (realtimeQueryKeys: the bell's count on a `notification`, `['jobs', id]`, `['ops']`,
 * `['backups']`, `['dashboard']`; invalidateRealtimeKeys); an expired cursor makes all of them stale.
 */
export function AppShell() {
  const t = useT();
  const live = useMe();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const warningId = useId();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useShortcuts({ 'mod+k': () => setPaletteOpen((open) => !open) });

  // The last signed-in answer: what the frame shows while auth/me is read again, and after the session ended.
  const last = useRef<SignedIn | null>(null);
  if (live?.authenticated === true) last.current = live;
  const signedOut = live !== undefined && !live.authenticated;
  const keep = signedOut && dirtyForms.count() > 0;
  const me = last.current;

  // The tab's realtime client: what it reads is what the frame shows (a ref, read at each poll or stream).
  const shown = useRef(me);
  shown.current = me;
  const [hub] = useState(() =>
    createRealtimeHub({
      transport: () => (shown.current?.client?.realtime === 'sse' && typeof EventSource === 'function' ? 'sse' : 'polling'),
      scope: () => shown.current?.user.id ?? '',
      // Each key a batch names once, joining a fetch under way; only marked stale while the tab is hidden.
      onEvents: (events) => invalidateRealtimeKeys(queryClient, events.flatMap(realtimeQueryKeys), document.hidden),
      onResync: () => invalidateRealtimeKeys(queryClient, REALTIME_RESYNC_KEYS, document.hidden),
      // A refused channel: the rights changed, and auth/me says which channels are the user's now. Read in the
      // background, as every request the client causes by itself (§7.1: an unattended tab reaches the idle limit).
      onDenied: () => inBackground(() => void queryClient.invalidateQueries({ queryKey: ME_KEY })),
      // SSE refused twice (turned off, 409, no stream free): auth/me says which transport to use now; in the background.
      onTransportStale: () => inBackground(() => void queryClient.invalidateQueries({ queryKey: ME_KEY })),
    }),
  );
  const channels = me === null ? '' : shellChannels(me).join(',');
  const transport = me?.client?.realtime;
  const running = me !== null && !signedOut;
  // Subscribed before the client starts, so that its first read already has the channels.
  useEffect(() => (channels === '' ? undefined : hub.subscribe(channels.split(','), () => {})), [hub, channels]);
  useEffect(() => hub.refresh(), [hub, transport]);
  useEffect(() => {
    if (!running) return;
    hub.start();
    return () => hub.stop();
  }, [hub, running]);

  useEffect(() => {
    if (live === undefined || keep) return;
    // A navigation already under way (signing out, "Masuk lagi" after 2FA) leaves the frame by itself.
    const here = router.latestLocation;
    if (isSignInPath(here.pathname)) return;
    const target = signedOut ? sessionEndedHref(here.href) : gateTarget(live, here.href);
    if (target !== null && target.split('?', 1)[0] !== here.pathname) void router.navigate({ href: target, replace: true });
  }, [live, signedOut, keep, router]);

  if (me === null) return <Pending />;
  // Phase 2 (Task 2): Beranda, then each nav group under its heading (Katalog, OPAC, Sistem; lib/nav.ts).
  const sections = visibleNavSections(me);

  const links = (items: readonly NavItem[], label?: string) => (
    <ul className="flex flex-col gap-1" {...(label === undefined ? {} : { 'aria-label': label })}>
      {items.map((item) => (
        <li key={item.to}>
          <Link
            to={item.to}
            activeOptions={{ exact: item.to === '/admin' }}
            onClick={() => setMenuOpen(false)}
            className="block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground"
          >
            {t(item.labelKey)}
          </Link>
        </li>
      ))}
    </ul>
  );

  const nav = (
    <nav aria-label={t('shell.nav_label')}>
      <div className="flex flex-col gap-4">
        {sections.map((section) =>
          section.group === null ? (
            <div key="top">{links(section.items)}</div>
          ) : (
            // The heading is seen; the list carries the group's name for assistive technology (no id: the menu is
            // rendered twice, for the desktop and the mobile layout).
            <div key={section.group}>
              <p aria-hidden="true" className="px-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t(`nav.group.${section.group}`)}
              </p>
              {links(section.items, t(`nav.group.${section.group}`))}
            </div>
          ),
        )}
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        {t('shell.skip_to_content')}
      </a>
      <aside className="hidden w-60 shrink-0 border-r bg-card md:flex md:flex-col">
        <div className="flex h-14 items-center gap-2 border-b px-4 font-semibold">
          <LibraryIcon className="size-5 text-primary" aria-hidden="true" />
          <span className="truncate">{me.library.name}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3">{nav}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b bg-card px-4 md:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-expanded={menuOpen}
            aria-controls="altis-mobile-nav"
            aria-label={t(menuOpen ? 'shell.menu_close' : 'shell.menu_open')}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
          </Button>
          <span className="truncate font-semibold md:hidden">{me.library.name}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto gap-2 text-muted-foreground"
            aria-label={t('shell.open_palette')}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={() => setPaletteOpen(true)}
          >
            <SearchIcon aria-hidden="true" />
            <span className="hidden sm:inline">{t('shell.open_palette')}</span>
            <kbd className="hidden rounded border bg-muted px-1.5 text-xs sm:inline">{paletteShortcut()}</kbd>
          </Button>
          <div data-slot="notifications">
            <NotificationBell />
          </div>
          <span className="hidden truncate text-sm lg:inline" title={t('shell.user_menu', { name: me.user.name })}>
            {me.user.name}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('palette.logout')}
            title={t('palette.logout')}
            onClick={() =>
              void logout({
                clearMe: () => queryClient.removeQueries({ queryKey: ME_KEY }),
                navigate: (href) => void navigate({ href }),
              })
            }
          >
            <LogOutIcon aria-hidden="true" />
          </Button>
        </header>
        <div id="altis-mobile-nav" className={cn('border-b bg-card p-3 md:hidden', !menuOpen && 'hidden')}>
          {nav}
        </div>
        {keep && (
          <div className="px-4 pt-4 md:px-6">
            <Alert variant="destructive" aria-labelledby={warningId}>
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle id={warningId}>{t('shell.session_ended.title')}</AlertTitle>
              <AlertDescription>
                <p>{t('shell.session_ended.body')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => void router.navigate({ href: sessionEndedHref(router.latestLocation.href) })}
                >
                  {t('shell.session_ended.sign_in')}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        <Banners banners={me.banners} />
        <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none md:p-6">
          {/* The screens see what the frame shows; another user's session starts every screen over. */}
          <ShellMeContext.Provider value={me}>
            <RealtimeContext.Provider value={hub}>
              <Outlet key={me.user.id} />
            </RealtimeContext.Provider>
          </ShellMeContext.Provider>
        </main>
      </div>
      <CommandPalette me={me} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
