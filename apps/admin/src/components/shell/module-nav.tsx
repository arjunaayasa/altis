import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { useT, type Translate } from '@/i18n';
import type { ModuleView, NavItem, NavModule } from '@/lib/nav';
import { cn } from '@/lib/utils';

/** The name of a module: Beranda, or its nav group's heading. */
export function moduleLabel(t: Translate, module: NavModule): string {
  return module === 'home' ? t('nav.home') : t(`nav.group.${module}`);
}

/** The text of an item in the sidebar: Beranda's own page reads "Ringkasan" under the module "Beranda". */
export function itemLabel(t: Translate, item: NavItem): string {
  return item.to === '/admin' ? t('shell.home_overview') : t(item.labelKey);
}

/**
 * A link that moves through the router (and its unsaved-changes guard) but keeps the `aria-current` it is given: a
 * router `<Link>` marks itself `aria-current="page"` whenever its path is the page's, which a module (the set the page
 * is in) or the library's name is not. A click with a modifier key is left to the browser (a new tab).
 */
export function RouterAnchor({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; 'aria-current'?: 'true'; onClick?(): void }) {
  const router = useRouter();
  const href = router.buildLocation({ to }).href;
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    rest.onClick?.();
    void router.navigate({ to });
  };
  return (
    <a href={href} className={className} aria-current={rest['aria-current']} onClick={onClick}>
      {children}
    </a>
  );
}

/**
 * The module bar under the top bar: one link per module the user sees, opening its first page; the active module is
 * marked (`aria-current="true"`: the set the page belongs to). On a narrow screen the bar scrolls sideways and keeps the
 * active module in view.
 */
export function ModuleBar({ modules, active }: { modules: readonly ModuleView[]; active: NavModule }) {
  const t = useT();
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const current = bar.current?.querySelector<HTMLElement>('[aria-current="true"]');
    // Not in every DOM (jsdom has none).
    if (typeof current?.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <nav ref={bar} aria-label={t('shell.nav_label')} className="flex h-[42px] gap-1 overflow-x-auto px-3 [scrollbar-width:none]">
      {modules.map((m) => (
        <RouterAnchor
          key={m.module}
          to={m.items[0]!.to}
          aria-current={m.module === active ? 'true' : undefined}
          className={cn(
            'flex shrink-0 items-center border-b-2 border-transparent px-3 font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-visible:-outline-offset-2',
            m.module === active && 'border-primary text-foreground',
          )}
        >
          {moduleLabel(t, m.module)}
        </RouterAnchor>
      ))}
    </nav>
  );
}

const ITEM_CLASS =
  'flex min-h-8 items-center rounded-md px-2.5 text-muted-foreground transition-colors duration-150 ease-out hover:bg-layer-2 hover:text-foreground focus-visible:-outline-offset-2';
const CURRENT_CLASS = 'bg-accent-soft font-semibold text-accent-text hover:bg-accent-soft hover:text-accent-text';

/**
 * The sidebar's menu: the pages of the active module, the page of the route marked (`aria-current="page"`), then for
 * Beranda the shortcuts ("Pintasan") and for OPAC the public site. No icons.
 */
export function ModuleMenu({
  view,
  current,
  shortcuts,
  onNavigate,
}: {
  view: ModuleView;
  current: string | null;
  shortcuts: readonly NavItem[];
  onNavigate(): void;
}) {
  const t = useT();
  const shortcutsId = useId();
  const label = moduleLabel(t, view.module);
  const link = (item: NavItem) => (
    <li key={item.to}>
      <Link
        to={item.to}
        activeOptions={{ exact: true, includeSearch: false }}
        activeProps={{ className: '' }}
        aria-current={item.to === current ? 'page' : undefined}
        onClick={onNavigate}
        className={cn(ITEM_CLASS, item.to === current && CURRENT_CLASS)}
      >
        {itemLabel(t, item)}
      </Link>
    </li>
  );
  return (
    <nav aria-label={t('shell.sidebar_label', { module: label })} className="flex flex-col gap-1">
      <p aria-hidden="true" className="px-2.5 pt-0.5 pb-2 text-base font-bold">
        {label}
      </p>
      <ul className="grid gap-px">
        {view.items.map(link)}
        {view.module === 'opac' && (
          <li>
            {/* The library's public site (the OPAC), in a tab of its own. */}
            <a href="/" target="_blank" rel="noopener" className={ITEM_CLASS}>
              {t('shell.public_site')}
            </a>
          </li>
        )}
      </ul>
      {view.module === 'home' && shortcuts.length > 0 && (
        <>
          <p id={shortcutsId} className="px-2.5 pt-4 pb-1 text-xs font-semibold text-faint">
            {t('shell.shortcuts')}
          </p>
          <ul aria-labelledby={shortcutsId} className="grid gap-px">
            {/* A shortcut is never the marked item: the module of its page marks it. */}
            {shortcuts.map((item) => (
              <li key={item.to}>
                <Link to={item.to} activeOptions={{ exact: true, includeSearch: false }} activeProps={{ className: '' }} onClick={onNavigate} className={ITEM_CLASS}>
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
