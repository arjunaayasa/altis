import {
  ACCRED_INSTRUMENTS,
  ACCRED_METRICS,
  ACCRED_METRIC_PROVIDERS,
  BUCKETS,
  CATALOG_HOUSEKEEPING_STEPS,
  ORPHAN_UPLOAD_CONTEXTS,
  REPORTS,
  REPORTS_HOUSEKEEPING_STEPS,
  SCHEDULES,
  SETTINGS,
  UPLOAD_CONTEXTS,
  createSettingsCache,
  type Actor,
  type Mailer,
} from '@altis/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { RESERVED_EDITION_TOKENS, reservedTokenIn } from '../../../packages/shared/test/support/edition-tokens.js';
import { jobHandlers, opKinds } from '../src/jobs/runtime.js';
import { ALL_ROUTES } from '../src/routes.js';
import { sampleConfig } from './support.js';

// The add-on keys of the commercial editions stay out of the core and server registries too (the shared registries
// have their own check, with the same token helper): no settings key or group, schedule, job type, operation kind,
// rate-limit bucket, actor type, upload context, route id, route path segment or key of a route declaration, report,
// instrument, metric, provider or housekeeping step uses one as its name, as the start of its name, or as a segment of it.

const silentMailer: Mailer = { send: async () => {} };
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });

/** Every value of `Actor.type` (the audit log's and the job runner's actors), and the operations' install actor. */
const ACTOR_TYPES = ['staff', 'system', 'cli', 'anonymous'] as const;

/** Every job handler of a server process (one with its housekeeping, Diagnostik and update-check deps). */
const handlers = jobHandlers({
  diagnostics: { dataDir: '/data', appRoot: '/app', baseUrl: () => null },
  housekeeping: { dataDir: '/data', mailer: silentMailer, baseUrl: () => CONFIG.baseUrl, settings: createSettingsCache({ clock: Date.now }) },
  updateCheck: { source: () => ({}) as never },
});

/** The literal segments of a route path (its parameters and their patterns left out). */
const pathSegments = (p: string): string[] => p.split('/').filter((s) => s !== '' && !s.startsWith(':') && !s.startsWith('{'));

const REGISTRIES: Readonly<Record<string, readonly string[]>> = {
  'settings keys': Object.keys(SETTINGS),
  'settings groups': [...new Set(Object.values(SETTINGS).map((d) => d.group))],
  schedules: SCHEDULES.flatMap((d) => [d.name, d.jobType]),
  'job types': handlers.map((h) => h.type),
  'operation kinds': opKinds({ appVersion: '0.1.0', update: () => ({}) as never }).map((k) => k.kind),
  'rate-limit buckets': Object.keys(BUCKETS),
  'actor types': [...ACTOR_TYPES, 'install'],
  'upload contexts': [...Object.keys(UPLOAD_CONTEXTS), ...ORPHAN_UPLOAD_CONTEXTS.flatMap((o) => [o.context, o.sweptBy])],
  'route ids': ALL_ROUTES.map((r) => r.id),
  'route paths': [...new Set(ALL_ROUTES.flatMap((r) => pathSegments(r.path)))],
  'route declaration keys': [...new Set(ALL_ROUTES.flatMap((r) => Object.keys(r)))],
  reports: REPORTS.map((d) => d.id),
  'report parameters and columns': [...new Set(REPORTS.flatMap((d) => [...d.params.map((p) => p.name), ...(d.kind === 'table' && Array.isArray(d.columns) ? d.columns.map((c) => c.key) : [])]))],
  instruments: ACCRED_INSTRUMENTS.map((i) => i.id),
  'metrics and providers': [...Object.keys(ACCRED_METRICS), ...ACCRED_METRIC_PROVIDERS.map((p) => p.id)],
  'housekeeping steps': [...REPORTS_HOUSEKEEPING_STEPS, ...CATALOG_HOUSEKEEPING_STEPS].map((s) => s.name),
};

describe('the core and server registries', () => {
  it('the actor types listed here are every value of Actor.type', () => {
    expectTypeOf<(typeof ACTOR_TYPES)[number]>().toEqualTypeOf<Actor['type']>();
  });

  it('use the six reserved add-on keys of the shared helper', () => {
    expect(RESERVED_EDITION_TOKENS).toHaveLength(6);
  });

  it.each(Object.entries(REGISTRIES))('%s use no reserved token as a name segment', (_registry, names) => {
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => reservedTokenIn(name) !== null)).toEqual([]);
  });

  it('the community job types and schedule are in their registries', () => {
    expect(REGISTRIES['job types']).toEqual(expect.arrayContaining(['reports.export', 'reports.housekeeping', 'accreditation.evaluate', 'accreditation.import_slims_usage']));
    expect(REGISTRIES['schedules']).toContain('reports.housekeeping');
  });
});
