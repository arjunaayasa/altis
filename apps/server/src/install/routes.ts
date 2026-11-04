import { claimInstall, ensureInstallCode } from '@altis/core';
import { AdminBody, ClaimBody, ConfigBody, DbTestBody, ExposureBody, ProfileBody, type ClaimResponse } from '@altis/shared/api/install';
import { DomainError } from '@altis/shared';
import { CSP_NONCE_PLACEHOLDER } from '../admin/serve.js';
import { cspHeader, cspNonce } from '../http/csp.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { probeRoutes } from '../probes/routes.js';
import { printInstallCode, requestInstallOrigin, setInstallCookie } from './gate.js';
import {
  adminPrepare,
  adminStep,
  checksStep,
  configStep,
  cronTestStep,
  dbTestStep,
  exposureStep,
  finishStep,
  migrateStep,
  profileStep,
  progressStep,
} from './steps.js';

// The install wizard's routes (spec §7.7, §9.5; plan Tasks 10 and 27, decisions C19, C35). Every one is `public`,
// `session: 'none'` (no database session, no staff session), `mode: 'system'`, `maintenance: 'allow'` and declares
// `install`, so the chain runs the wizard's own checks (install/gate.ts): the install gate first (installed → 404 in
// every process), then the claim. What each step does is described in install/steps.ts.
//
//   GET  /install                      install.page        the wizard (public/admin/install.html) with the request's
//                                                          nonce, the 1b CSP and no-store; 503 ADMIN_UNAVAILABLE when
//                                                          the release has none. It makes the install code when there
//                                                          is none or it expired, and prints a new one to stdout (never
//                                                          to the log file): "claim and code both expired → the next
//                                                          /install request makes a new code" (§7.7)
//   POST /install/api/claim            install.claim       ClaimBody → the `altis_install` cookie and {csrfToken,
//                                                          installState}
//   GET  /install/api/checks           install.checks      (Task 27; Task 10's stub replaced, M39)
//   POST /install/api/exposure         install.exposure
//   …    /install/api/probe/*          install.probe.*     the browser probes (probes/routes.ts, Task 23)
//   POST /install/api/db/test          install.db_test
//   POST /install/api/config           install.config
//   POST /install/api/migrate          install.migrate
//   GET  /install/api/progress         install.progress
//   POST /install/api/profile          install.profile
//   POST /install/api/admin            install.admin       audit null (`users.create` by createFirstSuperAdmin)
//   POST /install/api/cron/test        install.cron_test
//   POST /install/api/finish           install.finish      audit `install.complete`
//
// Every POST step is `tx: 'self'`: it talks to files, locks and the ops machine, none of which may sit inside a
// re-runnable transaction (R37, D3); its database writes use rc.withTx on the wizard's own handle (MountOptions.dbFor).

/** The DATA_DIR of the app; a wizard route cannot work without one. */
function dataDirOf(rc: RouteContext<unknown, unknown, unknown>): string {
  const dataDir = rc.services.install.dataDir;
  if (dataDir === undefined) throw new TypeError(`route ${rc.c.req.path}: the app has no DATA_DIR (AppDeps.dataDir)`);
  return dataDir;
}

const installPage = route({
  id: 'install.page',
  method: 'GET',
  path: '/install',
  public: true,
  session: 'none',
  install: 'page',
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const info = await ensureInstallCode(dataDirOf(rc), { now: rc.now, env: rc.services.install.env });
    if (info.fresh) printInstallCode(info);
    const html = await rc.services.install.pageHtml();
    if (html === null) throw new DomainError('ADMIN_UNAVAILABLE');
    const nonce = cspNonce();
    return rc.c.body(html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': cspHeader(nonce),
    });
  },
});

const installClaim = route<ClaimBody>({
  id: 'install.claim',
  method: 'POST',
  path: '/install/api/claim',
  public: true,
  session: 'none',
  install: 'claim',
  mode: 'system',
  maintenance: 'allow',
  tx: 'self',
  idempotency: 'none',
  audit: null,
  body: ClaimBody,
  handler: async (rc) => {
    const install = rc.services.install;
    const result = await claimInstall(dataDirOf(rc), {
      code: rc.body.code,
      ip: rc.ip,
      origin: requestInstallOrigin(rc.c),
      now: rc.now,
      env: install.env,
    });
    setInstallCookie(rc.c, result.claimToken, { secure: install.cookieSecure() });
    const body: ClaimResponse = { csrfToken: result.csrfToken, installState: result.installState };
    return { body, headers: { 'Cache-Control': 'no-store' } };
  },
});

/** What every claimed wizard route declares. */
const CLAIMED = {
  public: true,
  session: 'none',
  install: 'claimed',
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
} as const;

const installChecks = route({ ...CLAIMED, id: 'install.checks', method: 'GET', path: '/install/api/checks', audit: null, handler: checksStep });

const installExposure = route<ExposureBody>({
  ...CLAIMED,
  id: 'install.exposure',
  method: 'POST',
  path: '/install/api/exposure',
  tx: 'self',
  audit: null,
  body: ExposureBody,
  handler: exposureStep,
});

const installDbTest = route<DbTestBody>({
  ...CLAIMED,
  id: 'install.db_test',
  method: 'POST',
  path: '/install/api/db/test',
  tx: 'self',
  audit: null,
  body: DbTestBody,
  handler: dbTestStep,
});

const installConfig = route<ConfigBody>({
  ...CLAIMED,
  id: 'install.config',
  method: 'POST',
  path: '/install/api/config',
  tx: 'self',
  audit: null,
  body: ConfigBody,
  handler: configStep,
});

const installMigrate = route({ ...CLAIMED, id: 'install.migrate', method: 'POST', path: '/install/api/migrate', tx: 'self', audit: null, handler: migrateStep });

const installProgress = route({ ...CLAIMED, id: 'install.progress', method: 'GET', path: '/install/api/progress', audit: null, handler: progressStep });

const installProfile = route<ProfileBody>({
  ...CLAIMED,
  id: 'install.profile',
  method: 'POST',
  path: '/install/api/profile',
  tx: 'self',
  audit: null,
  body: ProfileBody,
  handler: profileStep,
});

const installAdmin = route<AdminBody>({
  ...CLAIMED,
  id: 'install.admin',
  method: 'POST',
  path: '/install/api/admin',
  tx: 'self',
  audit: null,
  alsoAudits: ['users.create'],
  body: AdminBody,
  prepare: adminPrepare,
  handler: adminStep,
});

const installCronTest = route({ ...CLAIMED, id: 'install.cron_test', method: 'POST', path: '/install/api/cron/test', tx: 'self', audit: null, handler: cronTestStep });

const installFinish = route({
  ...CLAIMED,
  id: 'install.finish',
  method: 'POST',
  path: '/install/api/finish',
  tx: 'self',
  audit: 'install.complete',
  handler: finishStep,
});

/** The wizard routes, in the order of the route catalog. */
export const INSTALL_ROUTES: RouteDecl[] = [
  installPage,
  installClaim,
  installChecks,
  installExposure,
  // Task 23's probes under the wizard's prefix (spec §13.5 `GET install/api/probe/:nonce`, §9.5 step 1).
  ...probeRoutes({ prefix: '/install/api/probe', access: { install: 'claimed' }, idPrefix: 'install.probe' }),
  installDbTest,
  installConfig,
  installMigrate,
  installProgress,
  installProfile,
  installAdmin,
  installCronTest,
  installFinish,
];
