import { AUTHORITY_KINDS, type AuthorityKind } from '@altis/shared/api/catalog/authorities';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { AuthorityList } from './list';
import { OrphansView } from './orphans';
import { isAuthorityKind, kindOf, validateAuthoritiesSearch, type AuthoritiesSearch } from './search';

/**
 * Otoritas (Phase 2 Task 26; spec §13 "Otoritas", §3.5; nav `catalog.records.read`): the tabs Nama (agents), Subjek
 * and Penerbit. Each tab has two views: its list (search, type filter, usage count; list.tsx) and its orphans with the
 * bulk archive (orphans.tsx). An authority's page (edit.tsx) holds its form, the merge and, for a subject, the
 * thesaurus editor.
 *
 * The tab, the view and the list's applied filters are the page's search params (search.ts): a tab is a link that
 * can be shared, and the way back from an authority's page returns to the same tab. Switching the tab keeps the view
 * and drops the filters (each kind has its own types). Adding, merging and archiving need
 * `catalog.authorities.manage`.
 */

const PATH = '/admin/catalog/authorities';

/** The two views of a tab, as toggle buttons. */
function ViewSwitch({ orphans, onChange }: { orphans: boolean; onChange(orphans: boolean): void }) {
  const t = useT();
  const button = (value: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={orphans === value}
      onClick={() => onChange(value)}
      className={cn(
        'h-7.5 rounded-md px-3 text-sm font-semibold transition-colors duration-150 ease-out',
        orphans === value ? 'bg-accent-soft text-accent-text' : 'text-muted-foreground hover:bg-layer-2 hover:text-foreground',
      )}>
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={t('catalog.authorities.views_label')} className="flex gap-1">
      {button(false, t('catalog.authorities.view.list'))}
      {button(true, t('catalog.authorities.view.orphans'))}
    </div>
  );
}

export function AuthoritiesScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.authorities.manage');
  const navigate = useNavigate();
  const search = validateAuthoritiesSearch(useSearch({ strict: false }));
  const kind = kindOf(search);
  const orphans = search.view === 'orphans';

  const go = (next: AuthoritiesSearch): void => {
    void navigate({ to: PATH, search: next });
  };
  /** The search params of `kind` in `view`, without filters. */
  const tabSearch = (k: AuthorityKind, inOrphans: boolean): AuthoritiesSearch => ({
    ...(k === 'agents' ? {} : { kind: k }),
    ...(inOrphans ? { view: 'orphans' as const } : {}),
  });
  /** New list filters, on the current tab and view. */
  const applyFilters = (filters: AuthoritiesSearch): void => go({ ...tabSearch(kind, orphans), ...filters });
  /** The current tab and filters in the other view. */
  const switchView = (inOrphans: boolean): void => {
    const next: AuthoritiesSearch = { ...search };
    if (inOrphans) next.view = 'orphans';
    else delete next.view;
    go(next);
  };

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('catalog.authorities.title')}
        intro={t('catalog.authorities.description')}
        actions={
          canManage ? (
            <Button asChild>
              <Link to={`${PATH}/${kind}/new`}>{t(`catalog.authorities.add.${kind}`)}</Link>
            </Button>
          ) : undefined
        }
      />
      <Tabs value={kind} onValueChange={(value) => isAuthorityKind(value) && value !== kind && go(tabSearch(value, orphans))}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label={t('catalog.authorities.tabs_label')} className={WRAPPING_TABS.list}>
            {AUTHORITY_KINDS.map((k) => (
              <TabsTrigger key={k} value={k} className={WRAPPING_TABS.trigger}>
                {t(`catalog.authorities.tab.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <ViewSwitch orphans={orphans} onChange={(next) => next !== orphans && switchView(next)} />
        </div>
        {AUTHORITY_KINDS.map((k) => (
          <TabsContent key={k} value={k} className="pt-5">
            {orphans ? (
              <OrphansView kind={k} canManage={canManage} />
            ) : (
              <AuthorityList kind={k} search={k === kind ? search : {}} onApply={applyFilters} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
