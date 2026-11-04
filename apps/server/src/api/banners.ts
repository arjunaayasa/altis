import { can, readClockAnomaly } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { OP_KIND_PERMISSION } from '@altis/shared';
import type { Banner } from '@altis/shared/api/auth';
import type { AuthState } from '../http/auth-state.js';
import { OPS_ANY_PERMISSIONS } from '../http/ops-auth.js';
import type { OpsFence } from '../http/ops-fence.js';
import type { Logger } from '../logger.js';
import { OPS_PAGE_PATH } from '../ops/update-page.js';
import { loggableError } from '../safe-error.js';

// The status banners of the admin shell (decision D32), which `GET auth/me` carries for a full session. Each provider
// looks at the instance and answers one banner or null. The community edition has two: the clock (1c Task 14) and
// maintenance (1c Task 19). BANNER_PROVIDERS is where an edition appends its own (ruling R2).

/**
 * What a provider sees: the database, the request's session (stage `full`), the request's clock reading and (1c, M11)
 * the process's ops fence: the maintenance flag and the active op as the fence last saw them (null in an app without
 * DATA_DIR).
 */
export interface BannerContext {
  db: DbHandle;
  auth: AuthState;
  now: number;
  fence: OpsFence | null;
}

export type BannerProvider = (ctx: BannerContext) => Promise<Banner | null>;

// ---- 1c Task 14: clock (spec §10.4). While clock_anomaly is active, for the holders of system.diagnostics.read: the
// Diagnostik page shows why and lets an admin with system.diagnostics.manage confirm the clock.
export const clockBanner: BannerProvider = async (ctx) => {
  if (!can(ctx.auth.grants, 'system.diagnostics.read')) return null;
  if ((await readClockAnomaly(ctx.db.db)) === null) return null;
  return { kind: 'clock', severity: 'warning', messageKey: 'banner.clock', link: '/admin/diagnostics' };
};

// ---- 1c Task 19: maintenance (spec §9.4, decision C20). While a maintenance flag other than a restore's is on, for
// everyone: `GET auth/me` stays allowed during maintenance (a restore refuses it, and then no banner is asked for). The
// link to the operations page goes only to those whom the page lets in (http/ops-auth.ts: the active op kind's
// permission; without an op, any op permission), the others would meet a 403 there.
export const maintenanceBanner: BannerProvider = async (ctx) => {
  const fence = ctx.fence;
  if (fence === null || fence.maintenance() === null || fence.restoreInProgress()) return null;
  const kind = fence.op()?.kind;
  const opens = kind === undefined ? OPS_ANY_PERMISSIONS : [OP_KIND_PERMISSION[kind]];
  const banner: Banner = { kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance' };
  return opens.some((p) => can(ctx.auth.grants, p)) ? { ...banner, link: OPS_PAGE_PATH } : banner;
};

/** Every provider, asked in order. */
export const BANNER_PROVIDERS: BannerProvider[] = [
  clockBanner, // 1c Task 14
  maintenanceBanner, // 1c Task 19
];

/**
 * The banners of every provider, in order. A provider that fails is logged and left out: a banner is never worth
 * an `auth/me` that fails (the SPA could not start).
 */
export async function collectBanners(ctx: BannerContext, log: Logger): Promise<Banner[]> {
  const banners: Banner[] = [];
  for (const provider of BANNER_PROVIDERS) {
    try {
      const banner = await provider(ctx);
      if (banner !== null) banners.push(banner);
    } catch (error) {
      log.error('banner provider failed', { err: loggableError(error) });
    }
  }
  return banners;
}
