import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES } from '@/i18n';
import { CATALOG_AREAS_ID, type CatalogPlaceholderScreen } from '@/i18n/catalog';
import { adminMe, signedIn, startApp } from '../fake-api';

// The catalogue's admin screens of Wave 0 (Phase 2 Task 3, plan decision P2-02): every route of routes/catalog/*.tsx
// exists with its final path, inside the shell, and its lazy screen module is a placeholder with the final export
// name that shows Task 3's own `catalog.placeholder.<screen>` text (S22). Each owning task replaces its screens; the
// integrator adds the screens a merged task replaced to REPLACED, whose routes then only have to render inside the shell.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ULID = '01JZ0000000000000000000ABC';

/**
 * The screens a merged Wave 1 task replaced with the real one: since Tasks 20 and 24-30 every catalogue screen is real,
 * so each route only has to render inside the shell (the placeholder rows below are kept for a screen added later).
 */
const REPLACED: ReadonlySet<CatalogPlaceholderScreen> = new Set<CatalogPlaceholderScreen>([
  'records_list',
  'record_create',
  'record_edit',
  'pages_list',
  'page_create',
  'page_edit',
  'items_list',
  'item_edit',
  'authorities',
  'authority_edit',
  'locations',
  'masters',
  'material_type_edit',
  'catalog_settings',
  'exchange',
  'run_detail',
  'duplicates',
  'labels',
  'migration',
]);

/** Each catalogue path (a parameter filled in), and the placeholder its screen shows. */
const ROUTES: readonly [path: string, screen: CatalogPlaceholderScreen][] = [
  ['/admin/catalog/records', 'records_list'],
  ['/admin/catalog/records/new', 'record_create'],
  [`/admin/catalog/records/${ULID}`, 'record_edit'],
  ['/admin/catalog/items', 'items_list'],
  [`/admin/catalog/items/${ULID}`, 'item_edit'],
  ['/admin/catalog/authorities', 'authorities'],
  [`/admin/catalog/authorities/agents/${ULID}`, 'authority_edit'],
  ['/admin/catalog/locations', 'locations'],
  ['/admin/catalog/masters', 'masters'],
  [`/admin/catalog/masters/material-types/${ULID}`, 'material_type_edit'],
  ['/admin/catalog/exchange', 'exchange'],
  [`/admin/catalog/runs/${ULID}`, 'run_detail'],
  ['/admin/catalog/labels', 'labels'],
  ['/admin/catalog/duplicates', 'duplicates'],
  ['/admin/catalog/migration', 'migration'],
  ['/admin/opac/pages', 'pages_list'],
  ['/admin/opac/pages/new', 'page_create'],
  [`/admin/opac/pages/${ULID}`, 'page_edit'],
  ['/admin/settings/catalog', 'catalog_settings'],
];

/** The route tree's paths as the router keeps them (parameters as `$name`). */
const PATHS = [
  '/admin/catalog/records',
  '/admin/catalog/records/new',
  '/admin/catalog/records/$recordId',
  '/admin/catalog/items',
  '/admin/catalog/items/$itemId',
  '/admin/catalog/authorities',
  '/admin/catalog/authorities/$kind/$id',
  '/admin/catalog/locations',
  '/admin/catalog/masters',
  '/admin/catalog/masters/material-types/$id',
  '/admin/catalog/exchange',
  '/admin/catalog/runs/$runId',
  '/admin/catalog/labels',
  '/admin/catalog/duplicates',
  '/admin/catalog/migration',
  '/admin/opac/pages',
  '/admin/opac/pages/new',
  '/admin/opac/pages/$pageId',
  '/admin/settings/catalog',
];

describe('the catalogue routes and their placeholder screens (Wave 0)', () => {
  it('one placeholder text per screen, and one route per placeholder', () => {
    const keys = Object.keys(CATALOG_AREAS_ID.placeholder).map((k) => k.replace(/^catalog\.placeholder\./, ''));
    expect([...keys].sort()).toEqual(ROUTES.map(([, s]) => s).sort());
  });

  it('the route tree holds every catalogue path as a child of the shell', async () => {
    const { router } = startApp({ me: adminMe(), path: '/admin/catalog/records', routes: {} });
    await waitFor(() => expect(document.querySelector('main#main')).not.toBeNull());
    const byPath = router.routesByPath as Record<string, { parentRoute?: { id: string } } | undefined>;
    for (const p of PATHS) {
      expect(byPath[p], p).toBeDefined();
      expect(byPath[p]!.parentRoute?.id, p).toBe('/admin');
    }
  });

  it.each(ROUTES.filter(([, key]) => REPLACED.has(key)))('%s (replaced: %s) renders inside the shell, not the "not found" page', async (path) => {
    startApp({ me: adminMe(), path, routes: {} });
    await waitFor(() => expect(document.querySelector('main#main')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: ADMIN_MESSAGES.id['page.not_found.title'] })).toBeNull();
  });

  it.each(ROUTES.filter(([, key]) => !REPLACED.has(key)))('%s shows the placeholder %s inside the shell', async (path, key) => {
    startApp({ me: adminMe(), path, routes: {} });
    const heading = await screen.findByRole('heading', { name: ADMIN_MESSAGES.id[`catalog.placeholder.${key}`] });
    expect(heading.closest('[data-screen-placeholder]')?.getAttribute('data-screen-placeholder')).toBe(key);
    // The shell's frame is around it (its <main>), not the "not found" page.
    expect(heading.closest('main#main')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: ADMIN_MESSAGES.id['page.not_found.title'] })).toBeNull();
  });

  // The last placeholder left is checked in English; once every screen is replaced, the screens' own tests cover it.
  const englishCase = ROUTES.find(([, key]) => !REPLACED.has(key));
  it.skipIf(englishCase === undefined)('in English for a user who chose English', async () => {
    const [path, key] = englishCase!;
    const me = signedIn();
    startApp({ me: { ...me, user: { ...me.user, locale: 'en' } }, path, routes: {} });
    expect(await screen.findByRole('heading', { name: ADMIN_MESSAGES.en[`catalog.placeholder.${key}`] })).toBeTruthy();
  });
});
