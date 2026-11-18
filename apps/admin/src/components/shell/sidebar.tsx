import { Link } from '@tanstack/react-router';
import { ChevronDownIcon, ExternalLinkIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from 'lucide-react';
import { useId, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import { SidebarBrand, type BrandProps } from '@/components/shell/brand';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT, type Translate } from '@/i18n';
import { NAV_SECTIONS, type ModuleView, type NavItem, type NavModule } from '@/lib/nav';
import { cn } from '@/lib/utils';

/** The id of the sidebar: what the menu button of the top bar and the collapse button control. */
export const SIDEBAR_ID = 'altis-sidebar';

/** The name of a module: Beranda, or its nav group's heading. */
export function moduleLabel(t: Translate, module: NavModule): string {
  return module === 'home' ? t('nav.home') : t(`nav.group.${module}`);
}

/** A 34 px row of the sidebar: Beranda's link, a group's button, the collapse button. */
const ROW =
  'flex h-8.5 w-full items-center gap-2.5 rounded-md px-2 text-left font-medium text-side-fg transition-colors duration-150 ease-out hover:bg-side-hover hover:text-side-strong focus-visible:-outline-offset-2 [&>svg:first-child]:size-[17px] [&>svg]:shrink-0';
/** The same row in the collapsed sidebar: the icon alone, centred. */
const RAIL = cn(ROW, 'justify-center px-0');
/** A 30 px page link under a group, in line with the group's name. */
const SUB =
  'flex h-7.5 items-center gap-1.5 rounded-md pr-2 pl-[35px] text-ui text-side-fg transition-colors duration-150 ease-out hover:bg-side-hover hover:text-side-strong focus-visible:-outline-offset-2';
const CURRENT = 'bg-side-active font-semibold text-side-strong hover:bg-side-active';

/** A button of the sidebar that shows only an icon (closing the drawer). */
const ICON_BUTTON = 'inline-grid size-7.5 shrink-0 place-items-center rounded-md text-side-fg hover:bg-side-hover hover:text-side-strong [&>svg]:size-4';

/** The collapsed sidebar's name for an icon: shown beside it on hover and on keyboard focus. */
function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The public site (the OPAC) in a tab of its own, listed with the pages that manage it. The other props are the
 * menu's, when the link is a menu item of the collapsed sidebar.
 */
function PublicSiteLink(props: ComponentProps<'a'>) {
  const t = useT();
  return (
    <a {...props} href="/" target="_blank" rel="noopener">
      {t('shell.public_site')}
      <ExternalLinkIcon aria-hidden="true" className="size-3.25 shrink-0" />
      <span className="sr-only">{t('shell.public_site_hint')}</span>
    </a>
  );
}

interface EntryProps {
  view: ModuleView;
  /** The path of the one item the page marks, or null. */
  current: string | null;
  /** The module the page belongs to. */
  active: NavModule;
  onNavigate(): void;
}

/** Beranda: a link of its own, above the groups. */
function HomeEntry({ view, current, rail, onNavigate }: EntryProps & { rail: boolean }) {
  const t = useT();
  const item = view.items[0]!;
  const Icon = view.icon;
  const label = t(item.labelKey);
  const marked = item.to === current;
  const link = (
    <Link
      to={item.to}
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{ className: '' }}
      aria-current={marked ? 'page' : undefined}
      aria-label={rail ? label : undefined}
      onClick={onNavigate}
      className={cn(rail ? RAIL : ROW, marked && CURRENT)}
    >
      <Icon aria-hidden="true" />
      {!rail && <span className="truncate">{label}</span>}
    </Link>
  );
  return <li>{rail ? <RailTip label={label}>{link}</RailTip> : link}</li>;
}

const pageLink = (t: Translate, item: NavItem, current: string | null, onNavigate: () => void, className: string) => (
  <Link
    to={item.to}
    activeOptions={{ exact: true, includeSearch: false }}
    activeProps={{ className: '' }}
    aria-current={item.to === current ? 'page' : undefined}
    onClick={onNavigate}
    className={cn(className, item.to === current && CURRENT)}
  >
    {t(item.labelKey)}
  </Link>
);

/**
 * A group in the full sidebar: a button with the group's icon, its name and a chevron (`aria-expanded`) that shows or
 * hides the group's pages, text links under it.
 */
function GroupEntry({ view, current, active, open, onToggle, onNavigate }: EntryProps & { open: boolean; onToggle(): void }) {
  const t = useT();
  const listId = useId();
  const Icon = view.icon;
  const label = moduleLabel(t, view.module);
  return (
    <li>
      <button type="button" aria-expanded={open} aria-controls={listId} onClick={onToggle} className={cn(ROW, view.module === active && 'text-side-strong')}>
        <Icon aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronDownIcon aria-hidden="true" className={cn('ml-auto size-3.5 text-side-muted transition-transform duration-150 ease-out', open && 'rotate-180')} />
      </button>
      <ul id={listId} hidden={!open} aria-label={t('shell.sidebar_label', { module: label })} className="pt-0.5 pb-1.5">
        {view.items.map((item) => (
          <li key={item.to}>{pageLink(t, item, current, onNavigate, SUB)}</li>
        ))}
        {view.module === 'opac' && (
          <li>
            <PublicSiteLink className={SUB} />
          </li>
        )}
      </ul>
    </li>
  );
}

const MENU_LINK = 'cursor-pointer aria-[current=page]:font-semibold aria-[current=page]:text-accent-text';

/**
 * A group in the collapsed sidebar: its icon, named by the group (and by a tooltip), opens a menu beside it that lists
 * the group's pages as links. The keyboard reaches every page: Enter or the down arrow opens the menu, the arrows move
 * in it, Enter follows the link, Escape closes it and gives the focus back to the icon.
 */
function RailGroupEntry({ view, current, active, onNavigate }: EntryProps) {
  const t = useT();
  const Icon = view.icon;
  const label = moduleLabel(t, view.module);
  return (
    <li>
      <DropdownMenu>
        <RailTip label={label}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={label} className={cn(RAIL, view.module === active && 'bg-side-active text-side-strong hover:bg-side-active')}>
              <Icon aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </RailTip>
        <DropdownMenuContent side="right" align="start" sideOffset={8} className="min-w-52">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {view.items.map((item) => (
            <DropdownMenuItem key={item.to} asChild>
              {pageLink(t, item, current, onNavigate, MENU_LINK)}
            </DropdownMenuItem>
          ))}
          {view.module === 'opac' && (
            <DropdownMenuItem asChild>
              <PublicSiteLink className={MENU_LINK} />
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export interface SidebarProps {
  /** The library's name, and its logo and icon once it has them. */
  brand: BrandProps;
  /** The modules the user sees (lib/nav.ts `visibleModules`). */
  modules: readonly ModuleView[];
  /** The module the page belongs to: its group is open, and marked in the collapsed sidebar. */
  active: NavModule;
  /** The path of the navigation item the page marks, or null. */
  current: string | null;
  /** Icons only (the wide layout). */
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  /** Open as the drawer of a narrow screen: a modal dialog, always at its full width. */
  drawer: boolean;
  /** The drawer's close button. */
  onClose(): void;
  /** A link of the sidebar was followed (the drawer closes). */
  onNavigate(): void;
  ref?: Ref<HTMLElement>;
}

/**
 * The one sidebar of the admin: a solid charcoal column at the full height of the window. From the top: the library's
 * brand, the navigation in three labelled sections (Beranda as a link, each group the user sees as an entry with its
 * icon that opens its pages), and at the foot the button that collapses it.
 *
 * - The page shown is marked `aria-current="page"`. Its group is open; the other groups open and close by their
 *   buttons, and a group the user opened stays open while the session's page lasts.
 * - Collapsed (56 px), an entry is its icon with its name as the accessible name and a tooltip, and a group opens a
 *   menu of its pages ({@link RailGroupEntry}).
 * - On a narrow screen it is off the page until the top bar's menu button opens it as a drawer (`drawer`): a modal
 *   dialog with a close button. The frame makes the rest of the page inert meanwhile, which keeps the focus inside.
 */
export function Sidebar({ brand, modules, active, current, collapsed, onCollapsedChange, drawer, onClose, onNavigate, ref }: SidebarProps) {
  const t = useT();
  // The drawer always shows the full menu.
  const rail = collapsed && !drawer;
  // The groups the user opened or closed by hand; every other group is open only while the page is in it.
  const [toggled, setToggled] = useState<Partial<Record<NavModule, boolean>>>({});
  const isOpen = (module: NavModule): boolean => toggled[module] ?? module === active;
  const sectionId = useId();
  const collapseLabel = t(collapsed ? 'shell.sidebar_expand' : 'shell.sidebar_collapse');
  const CollapseIcon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  const collapseButton = (
    <button
      type="button"
      aria-controls={SIDEBAR_ID}
      aria-expanded={!collapsed}
      aria-label={rail ? collapseLabel : undefined}
      onClick={() => onCollapsedChange(!collapsed)}
      className={cn(rail ? RAIL : ROW, 'text-side-muted')}
    >
      <CollapseIcon aria-hidden="true" />
      {!rail && <span>{collapseLabel}</span>}
    </button>
  );

  return (
    <aside
      ref={ref}
      id={SIDEBAR_ID}
      data-slot="sidebar"
      data-collapsed={rail ? '' : undefined}
      role={drawer ? 'dialog' : undefined}
      aria-modal={drawer ? true : undefined}
      aria-label={t('shell.menu')}
      className={cn(
        'flex min-w-0 flex-col bg-side text-side-fg',
        'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:w-[272px] max-lg:transition-[translate,visibility] max-lg:duration-200 max-lg:ease-out',
        drawer ? 'max-lg:visible max-lg:translate-x-0 max-lg:shadow-pop' : 'max-lg:invisible max-lg:-translate-x-full',
        'lg:sticky lg:top-0 lg:h-dvh',
      )}
    >
      <div className={cn('flex h-13 shrink-0 items-center border-b border-side-line', rail ? 'justify-center' : 'gap-2 px-4')}>
        <SidebarBrand {...brand} compact={rail} />
        {drawer && (
          <button type="button" aria-label={t('shell.menu_close')} onClick={onClose} className={cn(ICON_BUTTON, 'ml-auto lg:hidden')}>
            <XIcon aria-hidden="true" />
          </button>
        )}
      </div>
      <nav aria-label={t('shell.nav_label')} className={cn('flex-1 overflow-y-auto px-2 pb-3', rail ? 'pt-3' : 'pt-1')}>
        {NAV_SECTIONS.map((section) => {
          const entries = modules.filter((view) => view.section === section);
          if (entries.length === 0) return null;
          const labelId = `${sectionId}-${section}`;
          return (
            <div key={section}>
              {/* Collapsed, the label is still what names the list. */}
              <p id={labelId} className={rail ? 'sr-only' : 'px-2 pt-3.5 pb-1 text-xs text-side-muted'}>
                {t(`nav.section.${section}`)}
              </p>
              <ul aria-labelledby={labelId} className="grid gap-px">
                {entries.map((view) => {
                  const entry = { view, current, active, onNavigate };
                  if (view.module === 'home') return <HomeEntry key="home" {...entry} rail={rail} />;
                  if (rail) return <RailGroupEntry key={view.module} {...entry} />;
                  return <GroupEntry key={view.module} {...entry} open={isOpen(view.module)} onToggle={() => setToggled((was) => ({ ...was, [view.module]: !isOpen(view.module) }))} />;
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      {/* The drawer has no narrow form: the button is the wide layout's. */}
      <div className="shrink-0 border-t border-side-line p-2 max-lg:hidden">{rail ? <RailTip label={collapseLabel}>{collapseButton}</RailTip> : collapseButton}</div>
    </aside>
  );
}
