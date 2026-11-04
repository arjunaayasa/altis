import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { lazy, useEffect, type LazyExoticComponent, type ReactNode } from 'react';
import { ReauthDialog } from '@/components/reauth-dialog';
import { AppShell } from '@/components/shell/app-shell';
import { NotFound, Pending, RouteError } from '@/components/shell/route-pages';
import { editionRoutes } from '@/edition';
import { I18nProvider } from '@/i18n';
import { OPS_PAGE_PATH, inBackground, isSignInPath, onAuthLost } from '@/lib/api';
import { lazyWithReload } from '@/lib/lazy-reload';
import { onMaintenanceLifted } from '@/lib/maintenance';
import { ME_KEY, gateTarget, localeOf, meQuery, useMe } from '@/lib/me';
import { page } from '@/lib/page';
import { endHold, signInGate, validateNextSearch, validateSignInSearch } from '@/lib/sign-in';
import { catalogRoutes } from '@/routes/catalog';

/**
 * The admin routes (spec §4.8, §13.3). Every path is a full `/admin/…` path (the server serves index.html for
 * `/admin` and `/admin/*`, D31).
 *
 * - root: the language (`me.user.locale ?? me.library.locale`, also on `<html lang>`) and the reauth dialog; every
 *   navigation ends a hold on `auth/me` (lib/sign-in.ts `endHold`: the codes screen after 2FA was turned on or off).
 * - `/admin` (the shell): the admin frame. Its gate loads `GET auth/me` first (the SPA's first request) and sends a
 *   visitor who is signed out, owes a second factor, or must change the password to the matching page (lib/me.ts).
 *   Sections are its children (`users` → /admin/users); `$` catches the paths that have no screen yet, inside the
 *   frame.
 * - The sign-in pages (`/admin/login…`, `/admin/forgot-password`, `/admin/reset-password`; Task 28) are children of the
 *   root, outside the gate (a static path outranks the shell's `$`); each step page has a gate of its own
 *   (lib/sign-in.ts `signInGate`). A sign-in path no page serves gets the root's "not found", never the shell.
 * - "Profil saya" (`/admin/profile…`; Task 28) is a section of the shell.
 * - `/admin/_update` (1c Task 19) is the operations page, a page the server serves itself (`ops.update_page`): its
 *   route loads it as a page (`page.assign`) whatever leads the router there (a sign-in's `next`, the sign-in gate,
 *   the password page, a link), never renders it.
 * - Pengaturan (`/admin/settings`, one page per group), Konfigurasi Sistem (`/admin/system`), Log audit
 *   (`/admin/audit`) and Tentang (`/admin/about`) are sections of the shell (Task 30).
 * - 1c Task 31: Beranda shows the system dashboard. Tugas dan Jadwal is `/admin/jobs` (the list, where the `job_dead`
 *   notification and the `jobs_dead` alert lead), `/admin/jobs/$jobId` (a job's page) and `/admin/jobs/schedules`
 *   (a static path outranks `$jobId`, and a job id is a ULID).
 * - 1c Task 32: Cadangan is `/admin/backups` (the list, where the backup notifications and alerts lead; its dialogs
 *   prepare a download and restore) and Diagnostik `/admin/diagnostics` (where the clock, exposure, runner and IP
 *   alerts lead).
 * - 1d Task 30: Pembaruan is `/admin/updates` (where the `update.*` notifications and the dashboard's update card lead);
 *   its Perbarui, rollback and package upload load the operations page `/admin/_update`.
 *
 * - The edition's own screens (`editionRoutes`, edition/index.ts; ruling R2) are children of the shell too. The
 *   community edition has none.
 *
 * Screens load lazily through {@link lazyScreen} (one reload when a chunk of an older build is gone).
 */

export interface RouterContext {
  queryClient: QueryClient;
}

declare module '@tanstack/react-router' {
  interface HistoryState {
    /** The page was opened right after its record was created (a create screen's save): it says so once. */
    created?: boolean;
  }
}

/** A screen module's named component, loaded on first use through lazyWithReload. */
export function lazyScreen<M extends Record<string, unknown>>(
  importer: () => Promise<M>,
  name: keyof M & string,
): LazyExoticComponent<() => ReactNode> {
  return lazy(lazyWithReload(async () => ({ default: (await importer())[name] as () => ReactNode })));
}

function Root() {
  const me = useMe();
  const locale = localeOf(me);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <I18nProvider locale={locale}>
      <Outlet />
      <ReauthDialog />
    </I18nProvider>
  );
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({ context, preload }) => {
    if (!preload) endHold(context.queryClient);
  },
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
  pendingComponent: Pending,
});

export const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: async ({ context, location }) => {
    // Paths that never belong to the shell: the sign-in pages live outside its gate.
    if (isSignInPath(location.pathname)) throw notFound();
    const me = await context.queryClient.ensureQueryData(meQuery);
    const target = gateTarget(me, location.href);
    if (target !== null && target.split('?', 1)[0] !== location.pathname) throw redirect({ href: target });
  },
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: lazyScreen(() => import('@/screens/home'), 'HomeScreen'),
});

// ---- Profil saya (Task 28) ----------------------------------------------------------------------------------
const profileRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'profile',
  component: lazyScreen(() => import('@/screens/profile/profile'), 'ProfileScreen'),
});
const profilePasswordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'profile/password',
  validateSearch: validateNextSearch,
  component: lazyScreen(() => import('@/screens/profile/password'), 'PasswordScreen'),
});
const profileTwoFactorRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'profile/2fa',
  component: lazyScreen(() => import('@/screens/profile/two-factor'), 'ProfileTwoFactorScreen'),
});
const profileSessionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'profile/sessions',
  component: lazyScreen(() => import('@/screens/profile/sessions'), 'SessionsScreen'),
});
const profileRoutes = [profileRoute, profilePasswordRoute, profileTwoFactorRoute, profileSessionsRoute];

const sectionNotFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$',
  component: NotFound,
});

// ---- Task 29: users, roles, branches (a static `new` outranks the `$id` of the same section) -------------------
const usersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'users',
  component: lazyScreen(() => import('@/screens/users/list'), 'UsersListScreen'),
});
const userNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'users/new',
  component: lazyScreen(() => import('@/screens/users/edit'), 'UserCreateScreen'),
});
const userEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'users/$userId',
  component: lazyScreen(() => import('@/screens/users/edit'), 'UserEditScreen'),
});
const rolesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'roles',
  component: lazyScreen(() => import('@/screens/roles/list'), 'RolesListScreen'),
});
const roleNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'roles/new',
  component: lazyScreen(() => import('@/screens/roles/edit'), 'RoleCreateScreen'),
});
const roleEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'roles/$roleId',
  component: lazyScreen(() => import('@/screens/roles/edit'), 'RoleEditScreen'),
});
const branchesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'branches',
  component: lazyScreen(() => import('@/screens/branches/list'), 'BranchesListScreen'),
});
const branchNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'branches/new',
  component: lazyScreen(() => import('@/screens/branches/edit'), 'BranchCreateScreen'),
});
const branchEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'branches/$branchId',
  component: lazyScreen(() => import('@/screens/branches/edit'), 'BranchEditScreen'),
});

// ---- Task 30: settings (one page per group), system configuration, audit log, about ----------------------------
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings',
  component: lazyScreen(() => import('@/screens/settings/library'), 'LibrarySettingsScreen'),
});
const settingsEmailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings/email',
  component: lazyScreen(() => import('@/screens/settings/email'), 'EmailSettingsScreen'),
});
const settingsSecurityRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings/security',
  component: lazyScreen(() => import('@/screens/settings/security'), 'SecuritySettingsScreen'),
});
const settingsOpacRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'settings/opac',
  component: lazyScreen(() => import('@/screens/settings/opac'), 'OpacSettingsScreen'),
});
const systemRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'system',
  component: lazyScreen(() => import('@/screens/system/config'), 'SystemConfigScreen'),
});
const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'audit',
  component: lazyScreen(() => import('@/screens/audit/log'), 'AuditLogScreen'),
});
const aboutRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'about',
  component: lazyScreen(() => import('@/screens/about'), 'AboutScreen'),
});
const systemSectionRoutes = [
  settingsRoute,
  settingsEmailRoute,
  settingsSecurityRoute,
  settingsOpacRoute,
  systemRoute,
  auditRoute,
  aboutRoute,
];

// ---- 1c Task 31: Tugas dan Jadwal (the dashboard is Beranda's) ----------------------------------------------------
const jobsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'jobs',
  component: lazyScreen(() => import('@/screens/jobs/list'), 'JobsListScreen'),
});
const jobSchedulesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'jobs/schedules',
  component: lazyScreen(() => import('@/screens/jobs/schedules'), 'SchedulesScreen'),
});
const jobDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'jobs/$jobId',
  component: lazyScreen(() => import('@/screens/jobs/detail'), 'JobDetailScreen'),
});
const jobsSectionRoutes = [jobsRoute, jobSchedulesRoute, jobDetailRoute];

// ---- 1c Task 32: Cadangan and Diagnostik -------------------------------------------------------------------------
const backupsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'backups',
  component: lazyScreen(() => import('@/screens/backups/list'), 'BackupsScreen'),
});
const diagnosticsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'diagnostics',
  component: lazyScreen(() => import('@/screens/diagnostics/diagnostics'), 'DiagnosticsScreen'),
});
const operationsSectionRoutes = [backupsRoute, diagnosticsRoute];

// ---- 1d Task 30: Pembaruan (where the update notifications and the dashboard's update card lead) -----------------
const updatesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: 'updates',
  component: lazyScreen(() => import('@/screens/updates/updates'), 'UpdatesScreen'),
});
const updatesSectionRoutes = [updatesRoute];

// ---- The sign-in pages (Task 28), outside the shell -------------------------------------------------------------
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/login',
  validateSearch: validateSignInSearch,
  beforeLoad: ({ context, search }) => signInGate(context.queryClient, 'login', search),
  component: lazyScreen(() => import('@/screens/login/login'), 'LoginScreen'),
});
const loginTwoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/login/2fa',
  validateSearch: validateSignInSearch,
  beforeLoad: ({ context, search }) => signInGate(context.queryClient, 'mfa', search),
  component: lazyScreen(() => import('@/screens/login/two-factor'), 'TwoFactorScreen'),
});
const loginSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/login/setup-2fa',
  validateSearch: validateSignInSearch,
  beforeLoad: ({ context, search }) => signInGate(context.queryClient, 'mfa_setup', search),
  component: lazyScreen(() => import('@/screens/login/setup-2fa'), 'SetupTwoFactorScreen'),
});
const loginRecoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/login/recovery',
  validateSearch: validateSignInSearch,
  beforeLoad: ({ context, search }) => signInGate(context.queryClient, 'recovery', search),
  component: lazyScreen(() => import('@/screens/login/recovery'), 'RecoveryScreen'),
});
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/forgot-password',
  component: lazyScreen(() => import('@/screens/login/forgot'), 'ForgotPasswordScreen'),
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/reset-password',
  component: lazyScreen(() => import('@/screens/login/reset'), 'ResetPasswordScreen'),
});
const signInRoutes = [loginRoute, loginTwoFactorRoute, loginSetupRoute, loginRecoveryRoute, forgotPasswordRoute, resetPasswordRoute];

// ---- 1c Task 19: the operations page, a server page (ops.update_page) -------------------------------------------
const opsPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: OPS_PAGE_PATH,
  beforeLoad: ({ preload }) => {
    if (preload) return;
    // The server serves this path before the SPA's index (M3). Were this document itself the server's answer here
    // (a server or dev server that does not know the page), loading the page again would only load the SPA again,
    // without end: it says "not found" instead. Only the address the document was loaded at can tell: by now the
    // browser history already shows /admin/_update for every navigation that leads here.
    if (page.loadedPath() === OPS_PAGE_PATH) throw notFound();
    page.assign(OPS_PAGE_PATH);
  },
  component: Pending,
});

export const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    homeRoute,
    ...profileRoutes,
    usersRoute,
    userNewRoute,
    userEditRoute,
    rolesRoute,
    roleNewRoute,
    roleEditRoute,
    branchesRoute,
    branchNewRoute,
    branchEditRoute,
    ...systemSectionRoutes,
    ...jobsSectionRoutes,
    ...operationsSectionRoutes,
    ...updatesSectionRoutes,
    // ---- Phase 2 (catalog): Task 3 ----
    // The catalogue's screens (routes/catalog/*.tsx, one file per area, each owned by its task).
    ...catalogRoutes(shellRoute),
    // The edition's own screens (ruling R2): none in the community edition.
    ...editionRoutes,
    sectionNotFoundRoute,
  ]),
  ...signInRoutes,
  opsPageRoute,
]);

/**
 * Wires the API client (it lives outside React) to the app; main.tsx does this once, the screen tests the same way.
 * Its navigation moves through the router (no reload). When the server says the session is gone (401
 * AUTH_REQUIRED), the cached `auth/me` is forgotten and read again: whoever shows it learns at once (the shell, which
 * then says the session ended, app-shell.tsx), and a hold on it ends. When the blocking maintenance screen lifts
 * itself (lib/maintenance.ts), every query is made stale and the shown ones are read again, in the background (the
 * screen lifted on its own timer, not by the user, §7.1): what the maintenance refused (503) recovers without a click.
 * Returns the function that undoes the wiring.
 */
export function connectApiClient(router: ReturnType<typeof createAppRouter>, queryClient: QueryClient): () => void {
  page.navigate = (href) => {
    void router.navigate({ href });
  };
  const offAuthLost = onAuthLost(() => void queryClient.resetQueries({ queryKey: ME_KEY }));
  const offLifted = onMaintenanceLifted(() => inBackground(() => void queryClient.invalidateQueries()));
  return () => {
    offAuthLost();
    offLifted();
  };
}

export function createAppRouter(o: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: o.queryClient },
    ...(o.history === undefined ? {} : { history: o.history }),
    defaultPendingComponent: Pending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
  });
}
