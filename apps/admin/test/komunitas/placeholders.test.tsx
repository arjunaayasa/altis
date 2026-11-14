import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceUpload } from '@/components/accreditation/evidence-upload';
import { ADMIN_MESSAGES, I18nProvider } from '@/i18n';
import { KOMUNITAS_AREAS_ID, type KomunitasPlaceholderScreen } from '@/i18n/komunitas';
import { ACCREDITATION_TABS, validateAccreditationSearch } from '@/screens/accreditation/search';
import { HistoryTab } from '@/screens/accreditation/tabs/history';
import { IndicatorsTab } from '@/screens/accreditation/tabs/indicators';
import { PopulationTab } from '@/screens/accreditation/tabs/population';
import { PrintTab } from '@/screens/accreditation/tabs/print';
import { ProfileTab } from '@/screens/accreditation/tabs/profile';
import { RegistersTab } from '@/screens/accreditation/tabs/registers';
import { SnpTab } from '@/screens/accreditation/tabs/snp';
import { SummaryTab } from '@/screens/accreditation/tabs/summary';
import { UsageTab } from '@/screens/accreditation/tabs/usage';
import { adminMe, signedIn, startApp } from '../fake-api';

// The admin screens of reports and accreditation as Wave 0 leaves them: every route exists with its final path, inside
// the shell, and its lazy screen module is a placeholder with the final export name that shows its own
// `komunitas.placeholder.<screen>` text. The tabs of the workspace and the evidence upload exist with their final
// names and props. Each owning task replaces its screens; a replaced screen then only has to render inside the shell.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ULID = '01JZ0000000000000000000ABC';

/** The screens an owning task has replaced with the real one. */
const REPLACED: ReadonlySet<KomunitasPlaceholderScreen> = new Set<KomunitasPlaceholderScreen>(['tab_usage', 'tab_snp', 'tab_print']);

/** Each path (a parameter filled in), and the placeholder its screen shows. */
const ROUTES: readonly [path: string, screen: KomunitasPlaceholderScreen][] = [
  ['/admin/reports', 'reports_catalog'],
  ['/admin/reports/collection.summary', 'report_detail'],
  ['/admin/accreditation', 'accreditation'],
  ['/admin/accreditation/new', 'period_create'],
  [`/admin/accreditation/${ULID}`, 'accreditation'],
  [`/admin/accreditation/${ULID}?tab=register`, 'accreditation'],
  ['/admin/settings/accreditation', 'accreditation_settings'],
];

/** The route tree's paths as the router keeps them (parameters as `$name`). */
const PATHS = [
  '/admin/reports',
  '/admin/reports/$reportId',
  '/admin/accreditation',
  '/admin/accreditation/new',
  '/admin/accreditation/$periodId',
  '/admin/settings/accreditation',
];

/** The workspace tabs and the placeholder each shows. */
const TABS = [
  [SummaryTab, 'tab_summary'],
  [IndicatorsTab, 'tab_indicators'],
  [ProfileTab, 'tab_profile'],
  [PopulationTab, 'tab_population'],
  [RegistersTab, 'tab_registers'],
  [UsageTab, 'tab_usage'],
  [SnpTab, 'tab_snp'],
  [PrintTab, 'tab_print'],
  [HistoryTab, 'tab_history'],
] as const;

describe('the reports and accreditation routes and their placeholder screens', () => {
  it('one placeholder text per screen and tab', () => {
    const keys = Object.keys(KOMUNITAS_AREAS_ID.placeholder).map((k) => k.replace(/^komunitas\.placeholder\./, ''));
    expect([...keys].sort()).toEqual([...new Set([...ROUTES.map(([, s]) => s), ...TABS.map(([, s]) => s)])].sort());
  });

  it('the route tree holds every path as a child of the shell', async () => {
    const { router } = startApp({ me: adminMe(), path: '/admin/reports', routes: {} });
    await waitFor(() => expect(document.querySelector('main#main')).not.toBeNull());
    const byPath = router.routesByPath as Record<string, { parentRoute?: { id: string } } | undefined>;
    for (const p of PATHS) {
      expect(byPath[p], p).toBeDefined();
      expect(byPath[p]!.parentRoute?.id, p).toBe('/admin');
    }
  });

  it.each(ROUTES.filter(([, key]) => !REPLACED.has(key)))('%s shows the placeholder %s inside the shell', async (path, key) => {
    startApp({ me: adminMe(), path, routes: {} });
    const heading = await screen.findByRole('heading', { name: ADMIN_MESSAGES.id[`komunitas.placeholder.${key}`] });
    expect(heading.closest('[data-screen-placeholder]')?.getAttribute('data-screen-placeholder')).toBe(key);
    expect(heading.closest('main#main')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: ADMIN_MESSAGES.id['page.not_found.title'] })).toBeNull();
  });

  it('in English for a user who chose English', async () => {
    const me = signedIn();
    startApp({ me: { ...me, user: { ...me.user, locale: 'en' } }, path: '/admin/reports', routes: {} });
    expect(await screen.findByRole('heading', { name: ADMIN_MESSAGES.en['komunitas.placeholder.reports_catalog'] })).toBeTruthy();
  });

  it('the workspace keeps its tab in the search params, and drops a tab it does not know', () => {
    expect([...ACCREDITATION_TABS]).toEqual(['ringkasan', 'indikator', 'profil', 'populasi', 'register', 'penggunaan', 'snp', 'cetak', 'riwayat']);
    expect(validateAccreditationSearch({ tab: 'cetak' })).toEqual({ tab: 'cetak' });
    expect(validateAccreditationSearch({ tab: 'skor' })).toEqual({});
    expect(validateAccreditationSearch({})).toEqual({});
  });

  it.each(TABS.filter(([, key]) => !REPLACED.has(key)))('a workspace tab shows its placeholder (%#)', (Tab, key) => {
    render(
      <I18nProvider locale="id">
        <Tab periodId={ULID} />
      </I18nProvider>,
    );
    expect(screen.getByRole('heading', { name: ADMIN_MESSAGES.id[`komunitas.placeholder.${key}`] })).toBeTruthy();
  });

  it('the evidence upload is a disabled button with its label until its task fills it', () => {
    const onDone = vi.fn();
    render(
      <I18nProvider locale="id">
        <EvidenceUpload periodId={ULID} indicatorCode="SCH-K3" evidenceCode="policy_document" entity="library_documents" label="Unggah kebijakan" onDone={onDone} />
      </I18nProvider>,
    );
    const button = screen.getByRole('button', { name: 'Unggah kebijakan' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });
});
