import type { DB } from '@altis/db';
import type { Kysely } from 'kysely';
import { searchHealth } from '../search/health.js';
import { readSettings } from '../settings/service.js';

// The catalog's dashboard alerts (Phase 2 plan, preflight B2): the hook dashboardSummary calls once for a caller who
// holds `system.diagnostics.read` (Task 2 wired it; Task 15 gives it its causes):
//
//   search_index_mismatch  warning  the index says it is ready, yet its documents of live records differ from the live
//                                   records (a write path that did not index, a document left behind): searchHealth,
//                                   as Diagnostik shows it. While a rebuild runs, or before the first one, the counts
//                                   differ by design and nothing is raised.
//   oai_misconfigured      warning  `opac.oai.enabled` is on while `opac.oai.adminEmail` is empty (OAI-PMH then answers
//                                   503, spec §10). A fresh install has OAI on and no e-mail, so it shows there: the
//                                   spec's prompt to fill it in.
//
// Both are filtered by `system.diagnostics.read`, link to /admin/diagnostics, and carry no params (summary.ts).

/** The alert kinds this hook may raise. */
export type CatalogAlertKind = 'search_index_mismatch' | 'oai_misconfigured';

/** Whether OAI-PMH is on without an admin e-mail (spec §10), from the settings as stored (defaults applied). */
export function oaiMisconfigured(settings: { enabled: unknown; adminEmail: unknown }): boolean {
  return settings.enabled === true && (typeof settings.adminEmail !== 'string' || settings.adminEmail.trim() === '');
}

/**
 * Raises, through `raise`, each catalog alert whose cause is present (see the top of this file), the mismatch first.
 * Cheap reads only, through `db` (no transaction): searchHealth's counts and one settings read.
 */
export async function catalogAlerts(db: Kysely<DB>, raise: (kind: CatalogAlertKind) => void): Promise<void> {
  const health = await searchHealth(db);
  if (health.status === 'ready' && health.docs !== health.records) raise('search_index_mismatch');
  const s = await readSettings(db, ['opac.oai.enabled', 'opac.oai.adminEmail'], []);
  if (oaiMisconfigured({ enabled: s['opac.oai.enabled'], adminEmail: s['opac.oai.adminEmail'] })) raise('oai_misconfigured');
}
