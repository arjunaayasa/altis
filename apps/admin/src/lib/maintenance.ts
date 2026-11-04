import { t, type Locale } from '@altis/shared';

/**
 * The blocking maintenance screen of the admin (spec §9.4, decision C20; 1c Task 19). When a request meets 503
 * MAINTENANCE and the user does not hold the permission that would take them to the operations page (lib/api.ts), the
 * whole admin is covered by this screen (`maintenance.screen.*`): the app below it is `inert`, nothing can be clicked
 * or typed into, and what was on screen stays as it was. Every 15 s it asks `over()` (lib/api.ts: `GET auth/me`, which
 * a restore refuses and a normal maintenance answers with `maintenance: true`, signed in or not) and lifts itself once
 * the maintenance is over; then it tells the {@link onMaintenanceLifted} listeners (routes.tsx connectApiClient reads
 * the queries the maintenance refused again, so the screen below recovers by itself).
 *
 * It is plain DOM outside React (like the API client that opens it): it must come up whatever the screens are doing,
 * the sign-in pages included, and it renders through `textContent` only. With `o.link` (ruling R1c-9: a user who may
 * open the operations page) it also links that page, a plain link the browser loads (a server page, not the SPA's).
 */

/** How often the screen asks whether the maintenance is over. */
export const MAINTENANCE_RETRY_MS = 15_000;

export interface MaintenanceScreenOptions {
  /** The language of the texts (the user's, else the library's). */
  locale: Locale;
  /** Whether the maintenance is over; a rejection counts as not over. */
  over(): Promise<boolean>;
  /** A page to link under the text (`maintenance.screen.link`), or none. */
  link?: string;
}

interface Shown {
  node: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  /** The app root this screen made inert (not one that already was). */
  inerted: HTMLElement | null;
}

let shown: Shown | null = null;

/** Called after the screen lifted itself, the maintenance being over. */
const liftedListeners = new Set<() => void>();

/** Calls `listener` each time the screen lifts itself (not when {@link hideMaintenanceScreen} is called); returns the undo. */
export function onMaintenanceLifted(listener: () => void): () => void {
  liftedListeners.add(listener);
  return () => liftedListeners.delete(listener);
}

const TITLE_ID = 'altis-maintenance-title';
const BODY_ID = 'altis-maintenance-body';

/** Shows the screen (once: a screen already up stays as it is) and starts asking `o.over()` every 15 s. */
export function showMaintenanceScreen(o: MaintenanceScreenOptions): void {
  if (shown !== null) return;
  const node = document.createElement('div');
  node.setAttribute('data-maintenance-screen', '');
  node.setAttribute('role', 'alertdialog');
  node.setAttribute('aria-modal', 'true');
  node.setAttribute('aria-labelledby', TITLE_ID);
  node.setAttribute('aria-describedby', BODY_ID);
  node.tabIndex = -1;
  node.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-6';
  const card = document.createElement('div');
  card.className = 'w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-lg';
  const title = document.createElement('h1');
  title.id = TITLE_ID;
  title.className = 'text-lg font-semibold';
  title.textContent = t(o.locale, 'maintenance.screen.title');
  const body = document.createElement('p');
  body.id = BODY_ID;
  body.className = 'mt-2 text-sm text-muted-foreground';
  body.textContent = t(o.locale, 'maintenance.screen.body');
  card.append(title, body);
  if (o.link !== undefined) {
    const link = document.createElement('a');
    link.href = o.link;
    link.className = 'mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:underline';
    link.textContent = t(o.locale, 'maintenance.screen.link');
    card.append(link);
  }
  node.append(card);

  const root = document.getElementById('root');
  const inerted = root !== null && !root.hasAttribute('inert') ? root : null;
  inerted?.setAttribute('inert', '');
  document.body.append(node);
  node.focus();
  shown = { node, timer: null, inerted };
  scheduleCheck(o);
}

function scheduleCheck(o: MaintenanceScreenOptions): void {
  const current = shown;
  if (current === null) return;
  current.timer = setTimeout(() => {
    void o
      .over()
      .catch(() => false)
      .then((over) => {
        if (shown !== current) return;
        if (!over) {
          scheduleCheck(o);
          return;
        }
        hideMaintenanceScreen();
        for (const listener of liftedListeners) listener();
      });
  }, MAINTENANCE_RETRY_MS);
}

/** Removes the screen and gives the app back its input; nothing when no screen is up. */
export function hideMaintenanceScreen(): void {
  const current = shown;
  if (current === null) return;
  shown = null;
  if (current.timer !== null) clearTimeout(current.timer);
  current.node.remove();
  current.inerted?.removeAttribute('inert');
}

/** Whether the screen is up. */
export function maintenanceScreenShown(): boolean {
  return shown !== null;
}
