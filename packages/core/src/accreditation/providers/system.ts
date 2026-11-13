import { L12_FEATURES, type L12Feature } from '@altis/shared';
import type { NoteRef } from '@altis/shared/api/accreditation';
import { metricsOfProvider, type AccredMetricId } from '../metric-ids.js';
import type { AccredMetricContext, AccredMetricProvider, AccredMetricValue } from '../types.js';
import { baseUrlClass } from './base-url.js';
import { metricValue, note } from './registers-metrics.js';

// The `system` metric provider: the installation itself, at the time of the evaluation.
//
// - The class of the base address (baseUrlClass: public, private, localhost or unset) and its host. The automation
//   facts add that membership and circulation are not yet kept by this edition (null). An unset address gives no
//   value and says so; a public one is a guess from its name, and says that too.
// - The website features the instrument counts (its `features` parameter): when the library names a website outside
//   ALTIS, the features entered for it on the profile; otherwise, when the base address is not public, none (the
//   website must be publicly reachable); otherwise the OPAC itself, each page the settings map to a feature while the
//   page is live, published and not dated ahead, and the social links when at least one is set.

type SystemMetricId = Extract<AccredMetricId, `system.${string}`>;

/** The page settings of the features read from OPAC pages. */
const PAGE_FEATURES = Object.freeze({
  profile: 'profilePageId',
  services: 'servicesPageId',
  contact: 'contactPageId',
  databases: 'databasesPageId',
  faq: 'faqPageId',
} as const satisfies Partial<Record<L12Feature, string>>);

/** The features the instrument counts (all of them when it names none). */
function countedFeatures(ctx: AccredMetricContext): readonly L12Feature[] {
  const features = ctx.paramsOf('system.website_features')['features'];
  if (!Array.isArray(features)) return L12_FEATURES;
  return L12_FEATURES.filter((f) => features.includes(f));
}

/** The base address notes: none set, or public by its name only. */
function addressNotes(cls: ReturnType<typeof baseUrlClass>['class']): NoteRef[] {
  if (cls === 'unset') return [note('base_url_unset')];
  if (cls === 'public') return [note('base_url_public_guess')];
  return [];
}

/** The mapped pages that are live and published now. */
async function livePages(ctx: AccredMetricContext, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ctx.db
    .selectFrom('pages')
    .select('id')
    .where('id', 'in', [...ids])
    .where('archived_at', 'is', null)
    .where('status', '=', 'published')
    .where('published_at', 'is not', null)
    .where('published_at', '<=', ctx.now)
    .execute();
  return new Set(rows.map((r) => r.id));
}

async function websiteFeatures(ctx: AccredMetricContext, id: AccredMetricId): Promise<AccredMetricValue> {
  const features = countedFeatures(ctx);
  const external = ctx.period.external_website_url;
  if (external !== null && external.trim() !== '') {
    const entered = new Set(ctx.profile.externalWebsiteFeatures ?? []);
    const elements = features.filter((f) => entered.has(f));
    return metricValue(id, elements.length, 'manual', { notes: [note('l12_external', { url: external })], facts: { elements } });
  }
  if (baseUrlClass(ctx.baseUrl).class !== 'public') {
    return metricValue(id, 0, 'setting', { notes: [note('l12_not_public')], facts: { elements: [] } });
  }
  const mapped = ctx.settings.websiteFeatures;
  const pageIds = Object.values(PAGE_FEATURES)
    .map((key) => mapped[key])
    .filter((v): v is string => typeof v === 'string');
  const live = await livePages(ctx, pageIds);
  const has = (f: L12Feature): boolean => {
    if (f === 'opac') return true;
    if (f === 'social') return (mapped.socialUrls ?? []).length > 0;
    const pageId = mapped[PAGE_FEATURES[f]];
    return pageId !== undefined && live.has(pageId);
  };
  const elements = features.filter(has);
  return metricValue(id, elements.length, 'live', { facts: { elements } });
}

const SYSTEM_METRICS: Readonly<Record<SystemMetricId, (ctx: AccredMetricContext, id: AccredMetricId) => Promise<AccredMetricValue>>> = Object.freeze({
  'system.base_url_class': async (ctx, id) => {
    const b = baseUrlClass(ctx.baseUrl);
    return metricValue(id, b.class === 'unset' ? null : 1, 'setting', { notes: addressNotes(b.class), facts: { class: b.class, host: b.host } });
  },
  'system.l11_automation': async (ctx, id) => {
    const b = baseUrlClass(ctx.baseUrl);
    return metricValue(id, b.class === 'unset' ? null : 1, 'setting', {
      notes: addressNotes(b.class),
      facts: { class: b.class, membersUsed: null, circulationUsed: null },
    });
  },
  'system.website_features': websiteFeatures,
});

export const systemProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'system',
  metrics: metricsOfProvider('system'),
  compute: async (ctx, ids) => {
    const values = new Map<AccredMetricId, AccredMetricValue>();
    for (const id of ids) {
      const fn = (SYSTEM_METRICS as Partial<Record<AccredMetricId, (ctx: AccredMetricContext, id: AccredMetricId) => Promise<AccredMetricValue>>>)[id];
      if (fn !== undefined && !values.has(id)) values.set(id, await fn(ctx, id));
    }
    return { done: true, values };
  },
});
