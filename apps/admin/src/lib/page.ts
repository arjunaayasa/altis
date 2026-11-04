/**
 * The few things the SPA asks of the page itself, behind one object so that tests can replace them (jsdom does not
 * implement navigation, and its `location` cannot be spied on).
 *
 * `navigate` starts as a full page load; main.tsx points it at the router once the router exists, so the API client
 * (which lives outside React) moves to the sign-in pages without reloading the bundle.
 */
/**
 * The path (no query or fragment) the document was loaded at, read once when the bundle starts, before the router
 * exists: whatever the router does to the address bar later, this is where the server answered with the SPA.
 */
const loadedAt = window.location.pathname;

export const page = {
  /** Reloads the page (a newer release is running, or a lazy chunk failed to load). */
  reload(): void {
    window.location.reload();
  },
  /** Goes to an admin path (`/admin/...`, with its query). */
  navigate(href: string): void {
    window.location.assign(href);
  },
  /**
   * Loads `href` as a new page, never through the router (main.tsx re-points `navigate` only): for a page the server
   * serves itself, outside the SPA (1c Task 19: the operations page `/admin/_update`).
   */
  assign(href: string): void {
    window.location.assign(href);
  },
  /**
   * The path the document was loaded at (no query or fragment), not the current one: with the browser's history the
   * router moves the address bar before a route's `beforeLoad` runs.
   */
  loadedPath(): string {
    return loadedAt;
  },
  /** The current path with its query and fragment: what `?next=` brings the user back to. */
  path(): string {
    const { pathname, search, hash } = window.location;
    return `${pathname}${search}${hash}`;
  },
};
