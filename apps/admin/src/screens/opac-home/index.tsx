import type { OpacHomePutResponse, OpacHomeView } from '@altis/shared/api/opac-home';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ExternalLinkIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Notice } from '@/components/form-field';
import { Callout, ErrorState, LinkTabs, LoadingState, PageError, PageHeader, SaveBar, StatusText } from '@/components/layout';
import { Button, buttonVariants } from '@/components/ui/button';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { BlocksTab } from './blocks';
import { OPAC_HOME_TABS, bodyOf, comparable, draftOf, tabsWithErrors, withoutErrors, type HomeDraft, type OpacHomeTab } from './draft';
import { GalleryTab } from './gallery';
import { HoursTab } from './hours';
import { HomeEditorContext, type HomeEditor } from './parts';
import { ProfileTab } from './profile';
import { ServicesTab } from './services';
import { SliderTab } from './slider';

/**
 * OPAC › Halaman awal (`/admin/opac/beranda/<tab>`, permission `opac.pages.manage`): the home page of the public site
 * as the library's profile. `GET opac/home` loads the content, both welcome texts and their revision once; the tabs
 * under the page head (the hero's slides, the short profile, the services, the gallery, the hours and contact, the
 * blocks shown) each edit a part of ONE draft held here, so a change of tab keeps what was typed. The bar at the bottom
 * of the window says whether something is unsaved, "Batalkan perubahan" goes back to what was loaded, and `PUT
 * opac/home` saves it all. The draft is checked with the server's schema before it is sent, and the server's field
 * errors land on the same fields: the tabs that hold a refused field are marked, the bar names them, and the first
 * refused field takes the focus (on its own tab, which is opened). A save another admin made first (409
 * CONFLICT_STALE) offers to reload. The logo is set under Identitas situs; the one loaded is sent back unchanged.
 */

const OPAC_HOME_KEY = ['opac', 'home'] as const;

const TAB_LABELS: Readonly<Record<OpacHomeTab, TKey>> = {
  slider: 'opacHome.tab.slider',
  profil: 'opacHome.tab.profile',
  layanan: 'opacHome.tab.services',
  galeri: 'opacHome.tab.gallery',
  jam: 'opacHome.tab.hours',
  blok: 'opacHome.tab.blocks',
};

const tabPath = (tab: OpacHomeTab): string => `/admin/opac/beranda/${tab}`;

/** The tab the address names (the route sends any other address to the first tab). */
function useTab(): OpacHomeTab {
  const tab = useRouterState({ select: (state) => state.location.pathname.replace(/\/+$/, '').split('/').pop() });
  return OPAC_HOME_TABS.find((x) => x === tab) ?? 'slider';
}

/** The tabs under the page head: a tab that holds a refused field says so, the first one counts the slides. */
function HomeTabs({ flagged = [], slides }: { flagged?: readonly OpacHomeTab[]; slides?: number }) {
  const t = useT();
  return (
    <LinkTabs
      label={t('opacHome.tabs')}
      items={OPAC_HOME_TABS.map((tab) => ({
        to: tabPath(tab),
        label: (
          <>
            {t(TAB_LABELS[tab])}
            {tab === 'slider' && slides !== undefined && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{slides}</span>}
            {flagged.includes(tab) && (
              <StatusText tone="bad" className="ml-1.5 text-xs">
                {t('opacHome.tab.check')}
              </StatusText>
            )}
          </>
        ),
      }))}
    />
  );
}

/** The screen: its head and tabs, then the editor once the content is loaded. */
export function OpacHomeScreen() {
  const t = useT();
  const me = useMe();
  const tab = useTab();
  const queryClient = useQueryClient();
  const canManage = me !== undefined && holds(me, 'opac.pages.manage');
  const query = useApiQuery<OpacHomeView>({
    queryKey: OPAC_HOME_KEY,
    path: 'opac/home',
    enabled: canManage,
    // The draft must not be replaced under the admin's hands: while the screen is open the content is read again only
    // after a save or a reload. Nothing is kept once it closes, so opening it again reads what the server holds now
    // (the welcome texts and the accent also change under Pengaturan › OPAC).
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after every save and reload: the editor starts again from what the server holds. */
  const [generation, setGeneration] = useState(0);

  const reload = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: OPAC_HOME_KEY });
    setGeneration((g) => g + 1);
  };

  let body: ReactNode;
  if (me === undefined || (canManage && query.isPending)) {
    body = (
      <>
        <HomeTabs />
        <LoadingState label={t('opacHome.loading')} lines={6} />
      </>
    );
  } else if (!canManage) {
    body = <Callout title={t('opacHome.no_permission')} />;
  } else if (query.isError || query.data === undefined) {
    body = (
      <>
        <HomeTabs />
        <ErrorState title={t('opacHome.load_failed')} error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </>
    );
  } else {
    body = (
      <HomeEditorForm
        key={`${query.data.revision}:${generation}`}
        view={query.data}
        tab={tab}
        notice={notice}
        onEdited={() => setNotice(null)}
        onSaved={async () => {
          await reload();
          setNotice(t('opacHome.saved'));
        }}
        onReload={reload}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t('opacHome.title')}
        description={t('opacHome.intro')}
        actions={
          <a href="/" target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline' })}>
            {t('opacHome.view_site')}
            <ExternalLinkIcon aria-hidden="true" />
          </a>
        }
      />
      {body}
    </div>
  );
}

/**
 * The editor of one loaded revision (see the top of this file). The outcome of a save is said under the tabs and
 * brought into sight; once saved (`notice`), the save button, which the editor of the new revision draws again, takes
 * the focus back.
 */
function HomeEditorForm({
  view,
  tab,
  notice,
  onEdited,
  onSaved,
  onReload,
}: {
  view: OpacHomeView;
  tab: OpacHomeTab;
  notice: string | null;
  onEdited(): void;
  onSaved(): Promise<void>;
  onReload(): Promise<void>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [baseline] = useState(() => draftOf(view));
  const [draft, setDraft] = useState<HomeDraft>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState('');
  /** Set when a check refuses fields: the first refused field takes the focus once its tab is on screen. */
  const focusRefused = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const outcomeBox = useRef<HTMLDivElement>(null);
  const dirty = comparable(draft) !== comparable(baseline);
  useDirtyGuard(dirty);
  const flagged = tabsWithErrors(errors);

  useEffect(() => {
    if (!focusRefused.current || !flagged.includes(tab)) return;
    focusRefused.current = false;
    // A refused field of this tab, or the edit button of a refused slide (its fields are in its drawer). A frame
    // later: after a change of tab the shell notes where the focus was, and would move it to the heading from there.
    requestAnimationFrame(() => {
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([type=file]), [data-refused] [data-edit]')?.focus();
    });
  });
  useEffect(() => {
    if (notice !== null) saveButton.current?.focus({ preventScroll: true });
  }, [notice]);
  // A conflict, a failure or the save itself is said above the form: it comes into sight (the bar keeps the focus).
  useEffect(() => {
    if (conflict || problem !== null || notice !== null) outcomeBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [conflict, problem, notice]);

  const refuse = (found: Record<string, string>): void => {
    setErrors(found);
    focusRefused.current = true;
    const tabs = tabsWithErrors(found);
    const [first] = tabs;
    if (first !== undefined && !tabs.includes(tab)) void navigate({ to: tabPath(first) });
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setConflict(false);
    const built = bodyOf(draft, view.revision);
    if ('errors' in built) {
      refuse(built.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api<OpacHomePutResponse>('PUT', 'opac/home', built.body);
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT_STALE') setConflict(true);
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && e.errors !== undefined && e.errors.length > 0) {
        refuse(Object.fromEntries(e.errors.map((x) => [x.path, x.code])));
      } else setProblem(e);
      setSaving(false);
    }
  };

  const editor: HomeEditor = {
    view,
    draft,
    edit: (change, clear) => {
      setDraft(change);
      if (clear !== undefined) setErrors((e) => withoutErrors(e, clear));
      onEdited();
    },
    errors,
    errorAt: (path) => {
      const code = errors[path];
      if (code === undefined) return undefined;
      if (code === 'low_contrast') return 'opacHome.brand.low_contrast';
      if (code === 'personal_email') return 'opacHome.contact.personal_email';
      if (code === 'duplicate' && path.endsWith('.fileId')) return 'opacHome.photo.duplicate';
      return fieldErrorKey(code);
    },
    announce: setSaid,
    saving,
  };

  const hasErrors = Object.keys(errors).length > 0;
  const flaggedNames = flagged.map((x) => t(TAB_LABELS[x])).join(', ');
  const outcome = conflict ? (
    <PageError
      title={t('opacHome.conflict')}
      action={
        <Button type="button" size="sm" variant="outline" className="bg-background" onClick={() => void onReload()}>
          {t('opacHome.reload')}
        </Button>
      }
    />
  ) : hasErrors ? (
    <PageError title={flagged.length === 0 ? t('opacHome.fix_fields') : t('opacHome.fix_tabs', { tabs: flaggedNames })} />
  ) : problem !== null ? (
    <PageError title={t('opacHome.save_failed')} error={problem} />
  ) : notice !== null ? (
    <Notice kind="success">{notice}</Notice>
  ) : null;

  return (
    <HomeEditorContext.Provider value={editor}>
      <HomeTabs flagged={flagged} slides={draft.slides.length} />
      {outcome !== null && (
        <div ref={outcomeBox} className="scroll-mt-28">
          {outcome}
        </div>
      )}
      <form ref={form} noValidate aria-label={t('opacHome.title')} className="grid min-w-0 gap-4" onSubmit={(e) => void save(e)}>
        {tab === 'slider' ? <SliderTab /> : tab === 'profil' ? <ProfileTab /> : tab === 'layanan' ? <ServicesTab /> : tab === 'galeri' ? <GalleryTab /> : tab === 'jam' ? <HoursTab /> : <BlocksTab />}
        <p role="status" aria-live="polite" className="sr-only">
          {said}
        </p>
        <SaveBar
          tone={hasErrors ? 'bad' : 'neutral'}
          message={hasErrors ? (flagged.length === 0 ? t('opacHome.fix_fields') : t('opacHome.fix_tabs', { tabs: flaggedNames })) : t(dirty ? 'opacHome.dirty' : 'opacHome.clean')}>
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || saving}
            onClick={() => {
              setErrors({});
              setDraft(baseline);
              onEdited();
            }}>
            {t('opacHome.discard')}
          </Button>
          <Button ref={saveButton} type="submit" disabled={saving}>
            {t(saving ? 'form.saving' : 'opacHome.save')}
          </Button>
        </SaveBar>
      </form>
    </HomeEditorContext.Provider>
  );
}
