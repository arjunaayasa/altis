import type { MeResponse } from '@altis/shared/api/auth';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Banners } from '@/components/banners';
import { CommandPalette, logout } from '@/components/command-palette';
import { ShellFrame } from '@/components/shell/frame';
import { Pending } from '@/components/shell/route-pages';
import { useScreenFocus } from '@/components/shell/screen-focus';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { inBackground, isSignInPath, sessionEndedHref } from '@/lib/api';
import { dirtyForms } from '@/lib/dirty-forms';
import { ME_KEY, ShellMeContext, gateTarget, useMe } from '@/lib/me';
import { activeNavPath, visibleNav } from '@/lib/nav';
import { REALTIME_RESYNC_KEYS, RealtimeContext, createRealtimeHub, invalidateRealtimeKeys, realtimeQueryKeys } from '@/lib/realtime';
import { useShortcuts } from '@/lib/shortcuts';

export { paletteShortcut } from '@/components/shell/frame';

type SignedIn = Extract<MeResponse, { authenticated: true }>;

/** The page's main region, where each screen is drawn. */
const mainRegion = (): HTMLElement | null => document.getElementById('main');

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
 * (lib/nav.ts: the module bar and the sidebar of the active module, drawn by ShellFrame), the command palette
 * (Ctrl/⌘+K), the status banners, the notification bell (1c), the user menu (theme, language) and the screen of the
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
 * A change of screen moves the focus to the new screen's heading and names the page in the tab's title (screen-focus.ts).
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
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const warningId = useId();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useShortcuts({ 'mod+k': () => setPaletteOpen((open) => !open) });

  // The last signed-in answer: what the frame shows while auth/me is read again, and after the session ended.
  const last = useRef<SignedIn | null>(null);
  if (live?.authenticated === true) last.current = live;
  const signedOut = live !== undefined && !live.authenticated;
  const keep = signedOut && dirtyForms.count() > 0;
  const me = last.current;

  // The page in the tab's title: the navigation item the path belongs to (never a record's own name).
  const navItems = visibleNav(me ?? undefined);
  const navPath = activeNavPath(navItems, pathname);
  const navItem = navItems.find((item) => item.to === navPath);
  useScreenFocus(mainRegion, pathname, navItem === undefined ? null : t(navItem.labelKey));

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
  // A password that must change first: the server refuses every request but the change, so the client stays off.
  const usable = me !== null && !me.mustChangePassword;
  const channels = usable ? shellChannels(me).join(',') : '';
  const transport = me?.client?.realtime;
  const running = usable && !signedOut;
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
  const signOut = (): void =>
    void logout({
      clearMe: () => queryClient.removeQueries({ queryKey: ME_KEY }),
      navigate: (href) => void navigate({ href }),
    });

  return (
    <ShellFrame me={me} pathname={pathname} onPalette={() => setPaletteOpen(true)} onLogout={signOut}>
      {keep && (
        <div className="px-4 pt-4 lg:px-8">
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
      <main id="main" tabIndex={-1} className="w-full max-w-[1360px] min-w-0 flex-1 px-4 pt-4 pb-10 outline-none lg:px-8 lg:pt-6 lg:pb-12">
        {/* The screens see what the frame shows; another user's session starts every screen over. */}
        <ShellMeContext.Provider value={me}>
          <RealtimeContext.Provider value={hub}>
            <Outlet key={me.user.id} />
          </RealtimeContext.Provider>
        </ShellMeContext.Provider>
      </main>
      <CommandPalette me={me} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </ShellFrame>
  );
}
