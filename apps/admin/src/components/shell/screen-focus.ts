import { useEffect, useRef } from 'react';

/** How long after a change of screen its heading may still take the focus (a screen that loads late draws it late). */
const SETTLE_MS = 2_000;

/**
 * A change of screen for keyboard and screen-reader users (WCAG 2.4.3): when the path changes (not on the first
 * screen), the focus moves to the new screen's `h1` (made focusable with `tabIndex=-1`, without scrolling), so it is
 * read out and Tab goes on from the top of the screen. A screen that focuses a control of its own keeps it (the desk's
 * scan box, a panel opened at once): the heading only takes the focus while it is still where the change left it (on
 * the link or button that changed the screen, or nowhere). And the tab's title names the page (`pageName`, else the
 * document's own title).
 */
export function useScreenFocus(main: () => HTMLElement | null, pathname: string, pageName: string | null): void {
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    baseTitle.current ??= document.title;
    document.title = pageName === null ? baseTitle.current : baseTitle.current === '' ? pageName : `${pageName} · ${baseTitle.current}`;
  }, [pageName]);
  useEffect(
    () => () => {
      if (baseTitle.current !== null) document.title = baseTitle.current;
    },
    [],
  );

  const shown = useRef(pathname);
  useEffect(() => {
    // The first screen, or the same one again (an effect run twice in development), keeps the focus where it is.
    if (shown.current === pathname) return;
    shown.current = pathname;
    const root = main();
    if (root === null) return;
    // Where the change left the focus: the heading takes it only from there (or from nowhere), and once it has, only
    // from nowhere (a heading drawn again by a screen that loaded late).
    let from = document.activeElement;
    let frame = 0;
    const settle = (): void => {
      cancelAnimationFrame(frame);
      // A frame later: a screen's own focus (requested in its effects, often a frame later too) comes first.
      frame = requestAnimationFrame(() => {
        const heading = root.querySelector('h1');
        const active = document.activeElement;
        if (heading === null || active === heading) return;
        const untouched = active === null || active === document.body || active === root || active === from;
        if (!untouched) return;
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        from = null;
      });
    };
    settle();
    const observer = new MutationObserver(settle);
    observer.observe(root, { childList: true, subtree: true });
    const stop = setTimeout(() => observer.disconnect(), SETTLE_MS);
    return () => {
      observer.disconnect();
      clearTimeout(stop);
      cancelAnimationFrame(frame);
    };
  }, [main, pathname]);
}
