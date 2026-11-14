import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type AccredPeriodsTable } from '@altis/db';
import { newId } from '@altis/shared';
import type { AccredProfile } from '@altis/shared/api/accreditation';
import type { Selectable } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import type { AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { periodProvider } from '../../src/accreditation/providers/period.js';
import { systemProvider } from '../../src/accreditation/providers/system.js';
import { suggestAnswer } from '../../src/accreditation/scoring/suggest.js';
import type { AccredIndicator, AccredInstrument, AccredMetricContext, AccredMetricProvider, AccredMetricValue } from '../../src/accreditation/types.js';
import { loadAccredSettings, type AccredSettings } from '../../src/settings/accreditation.js';

// The `period` metrics (the period's own entries: population, facilities, services, the profile's NPP) and the
// `system` metrics (how reachable the installation is, and the features of the library website):
// - the school population is the sum of its three parts, and no value while any part is missing;
// - a share is cut to a whole number once, and names the entry that is missing;
// - the website features are read from the OPAC pages the settings map (published ones only), the social links, or,
//   when the library has a website elsewhere, from the features entered for it; a website that only the local network
//   reaches counts no feature.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 7, 1, 3, 0, 0);
const TODAY = '2026-08-01';
const D = '2026-06-30';
const SMA = instrumentById('sch-sma-2025') as AccredInstrument;
const SD = instrumentById('sch-sd-2025') as AccredInstrument;

const paramsOf = (instr: AccredInstrument) => (metric: AccredMetricId) =>
  instr.components.flatMap((c) => c.indicators).find((i) => i.metric === metric)?.metricParams ?? {};
const indicator = (instr: AccredInstrument, code: string): AccredIndicator => instr.components.flatMap((c) => c.indicators).find((i) => i.code === code)!;

describe.skipIf(!ctx.available)(`period and system metric providers [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let settings: AccredSettings;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-period-system-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    settings = await loadAccredSettings(h.db);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('pages').execute();
  });

  const trail = { version: 0, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null };

  /** A period row as the provider reads it (the period provider reads no table). */
  function period(o: Partial<Selectable<AccredPeriodsTable>> = {}): Selectable<AccredPeriodsTable> {
    return {
      id: newId(NOW),
      branch_id: null,
      name: 'Tahun ajaran 2025/2026',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'sch-sma-2025',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{}',
      students: 108,
      teachers: 10,
      edu_staff: 5,
      classes: 3,
      population_served: null,
      teachers_using: 4,
      all_registered_confirmed: 0,
      user_pcs: 4,
      staff_pcs: 1,
      ict_devices: 5,
      scanners: 2,
      floor_m2: 120,
      bandwidth_mbps: 30,
      hours_per_week: 35,
      services: JSON.stringify(['reading_room', 'circulation', 'reference', 'information_literacy', 'speed_reading', 'extension']),
      external_website_url: null,
      archived_at: null,
      ...trail,
      ...o,
    };
  }

  interface CtxOptions {
    profile?: AccredProfile;
    instrument?: AccredInstrument;
    baseUrl?: string | null;
    settings?: Partial<AccredSettings>;
  }

  function metricCtx(p: Selectable<AccredPeriodsTable>, o: CtxOptions = {}): AccredMetricContext {
    const instrument = o.instrument ?? SMA;
    return {
      db: h.db,
      periodId: p.id,
      period: p,
      profile: o.profile ?? {},
      instrument,
      D,
      today: TODAY,
      settings: { ...settings, ...o.settings },
      baseUrl: o.baseUrl === undefined ? 'https://perpus.sma-contoh.sch.id' : o.baseUrl,
      now: NOW,
      budgetLeftMs: () => 20_000,
      paramsOf: paramsOf(instrument),
    };
  }

  async function compute(
    provider: AccredMetricProvider,
    p: Selectable<AccredPeriodsTable>,
    ids: AccredMetricId[],
    o: CtxOptions = {},
  ): Promise<Map<AccredMetricId, AccredMetricValue>> {
    const step = await provider.compute(metricCtx(p, o), ids, null);
    if (!step.done) throw new Error(`the ${provider.id} provider answers in one call`);
    return new Map(step.values);
  }

  const missing = (field: string) => ({ key: 'accred.note.input_missing', params: { field } });

  describe('period provider', () => {
    it('the school population is the sum of its parts, and no value while a part is missing', async () => {
      expect((await compute(periodProvider, period(), ['period.population'])).get('period.population')).toEqual({ value: 123, unit: 'count', basis: 'manual', notes: [] });
      for (const part of ['students', 'teachers', 'edu_staff'] as const) {
        const v = (await compute(periodProvider, period({ [part]: null }), ['period.population'])).get('period.population');
        expect(v, part).toMatchObject({ value: null, notes: [{ key: 'accred.note.population_missing' }] });
      }
    });

    it('the ICT devices per member of the school community, cut to a whole percent', async () => {
      const m = await compute(periodProvider, period(), ['period.ict_devices_pct']);
      expect(m.get('period.ict_devices_pct')).toEqual({
        value: 4,
        numerator: 5,
        denominator: 123,
        unit: 'percent',
        basis: 'manual',
        notes: [{ key: 'accred.note.truncated' }],
      });
      expect(suggestAnswer(indicator(SMA, 'SP4'), m.get('period.ict_devices_pct')!, null).suggestion).toBe('a');
      expect((await compute(periodProvider, period({ ict_devices: null }), ['period.ict_devices_pct'])).get('period.ict_devices_pct')).toMatchObject({
        value: null,
        notes: [missing('jumlah perangkat TIK milik perpustakaan')],
      });
      expect((await compute(periodProvider, period({ teachers: null }), ['period.ict_devices_pct'])).get('period.ict_devices_pct')).toMatchObject({
        value: null,
        notes: [{ key: 'accred.note.population_missing' }],
      });
      expect((await compute(periodProvider, period({ students: 0, teachers: 0, edu_staff: 0 }), ['period.ict_devices_pct'])).get('period.ict_devices_pct')?.value).toBeNull();
    });

    it('the teachers who use the library in their lesson plans, cut to a whole percent', async () => {
      expect((await compute(periodProvider, period(), ['period.teachers_using_pct'])).get('period.teachers_using_pct')).toMatchObject({
        value: 40,
        numerator: 4,
        denominator: 10,
        notes: [{ key: 'accred.note.truncated' }],
      });
      expect((await compute(periodProvider, period({ teachers_using: null }), ['period.teachers_using_pct'])).get('period.teachers_using_pct')).toMatchObject({
        value: null,
        notes: [missing('jumlah guru yang memakai perpustakaan dalam RPP')],
      });
      expect((await compute(periodProvider, period({ teachers: null, teachers_using: null }), ['period.teachers_using_pct'])).get('period.teachers_using_pct')).toMatchObject({
        value: null,
        notes: [missing('jumlah guru dan jumlah guru yang memakai perpustakaan dalam RPP')],
      });
      expect((await compute(periodProvider, period({ teachers: 0, teachers_using: 0 }), ['period.teachers_using_pct'])).get('period.teachers_using_pct')?.value).toBeNull();
    });

    it('the services are counted once each; the stored entries are read as they are', async () => {
      const p = period({ services: JSON.stringify(['reading_room', 'circulation', 'reference', 'information_literacy', 'speed_reading', 'extension', 'circulation']) });
      const m = await compute(periodProvider, p, [
        'period.services_count',
        'period.bandwidth_mbps',
        'period.hours_per_week',
        'period.classes',
        'period.floor_m2',
        'period.user_pcs',
        'period.scanners',
      ]);
      expect(m.get('period.services_count')).toMatchObject({ value: 6, unit: 'count', basis: 'manual', notes: [] });
      expect(m.get('period.bandwidth_mbps')).toMatchObject({ value: 30, unit: 'mbps' });
      expect([...m.entries()].map(([id, v]) => [id, v.value])).toEqual([
        ['period.services_count', 6],
        ['period.bandwidth_mbps', 30],
        ['period.hours_per_week', 35],
        ['period.classes', 3],
        ['period.floor_m2', 120],
        ['period.user_pcs', 4],
        ['period.scanners', 2],
      ]);
      const empty = await compute(periodProvider, period({ services: null, bandwidth_mbps: null, hours_per_week: null }), [
        'period.services_count',
        'period.bandwidth_mbps',
        'period.hours_per_week',
      ]);
      expect(empty.get('period.services_count')).toMatchObject({ value: null, notes: [missing('jenis layanan perpustakaan')] });
      expect(empty.get('period.bandwidth_mbps')).toMatchObject({ value: null, notes: [missing('kecepatan internet (Mbps)')] });
      expect(empty.get('period.hours_per_week')).toMatchObject({ value: null, notes: [missing('jam layanan per minggu')] });
    });

    it('the NPP is present when the profile holds one that is not blank', async () => {
      const ids: AccredMetricId[] = ['period.npp_present'];
      expect((await compute(periodProvider, period(), ids, { profile: { npp: '3201010D0000001' } })).get('period.npp_present')).toMatchObject({ value: 1, notes: [] });
      expect((await compute(periodProvider, period(), ids, { profile: { npp: '   ' } })).get('period.npp_present')?.value).toBe(0);
      expect((await compute(periodProvider, period(), ids)).get('period.npp_present')?.value).toBe(0);
    });
  });

  describe('system provider', () => {
    async function page(status: string, publishedAt: number | null, o: { archived?: boolean; kind?: string } = {}): Promise<string> {
      const id = newId(NOW);
      await h.db
        .insertInto('pages')
        .values({
          id,
          kind: o.kind ?? 'page',
          slug_key: `halaman-${id.toLowerCase()}`,
          status,
          published_at: publishedAt,
          cover_file_id: null,
          archived_at: o.archived === true ? NOW : null,
          ...trail,
        })
        .execute();
      return id;
    }

    async function mappedSite(): Promise<Partial<AccredSettings>> {
      const published = Date.UTC(2025, 6, 1);
      return {
        websiteFeatures: {
          profilePageId: await page('published', published),
          servicesPageId: await page('published', published),
          contactPageId: await page('published', published),
          databasesPageId: await page('draft', null),
          socialUrls: ['https://www.instagram.com/perpus.sma.contoh'],
        },
      };
    }

    it('the website features: the OPAC, the published mapped pages and the social links', async () => {
      const site = await mappedSite();
      const m = await compute(systemProvider, period(), ['system.website_features'], { settings: site });
      expect(m.get('system.website_features')).toEqual({
        value: 5,
        unit: 'count',
        basis: 'live',
        notes: [],
        facts: { elements: ['profile', 'opac', 'services', 'contact', 'social'] },
      });
      expect(suggestAnswer(indicator(SMA, 'L12'), m.get('system.website_features')!, null).suggestion).toBe('b');
      const sd = await compute(systemProvider, period(), ['system.website_features'], { settings: site, instrument: SD });
      expect(suggestAnswer(indicator(SD, 'L12'), sd.get('system.website_features')!, null).suggestion).toBe('a');
    });

    it('a page counts only while it is live: not archived, published, and not dated ahead', async () => {
      const ahead = await page('published', NOW + 86_400_000);
      const archived = await page('published', Date.UTC(2025, 6, 1), { archived: true });
      const faq = await page('published', Date.UTC(2025, 6, 1));
      const v = (
        await compute(systemProvider, period(), ['system.website_features'], {
          settings: { websiteFeatures: { profilePageId: ahead, contactPageId: archived, faqPageId: faq, servicesPageId: newId(NOW) } },
        })
      ).get('system.website_features');
      expect(v).toMatchObject({ value: 2, facts: { elements: ['opac', 'faq'] } });
    });

    it('a website the local network reaches counts no feature, unless the library has a website elsewhere', async () => {
      const site = await mappedSite();
      for (const baseUrl of ['http://192.168.1.10', 'http://localhost:8080', null]) {
        const v = (await compute(systemProvider, period(), ['system.website_features'], { settings: site, baseUrl })).get('system.website_features');
        expect(v, String(baseUrl)).toEqual({ value: 0, unit: 'count', basis: 'setting', notes: [{ key: 'accred.note.l12_not_public' }], facts: { elements: [] } });
      }
      const elsewhere = period({ external_website_url: 'https://sma-contoh.sch.id/perpustakaan' });
      const v = (
        await compute(systemProvider, elsewhere, ['system.website_features'], {
          settings: site,
          baseUrl: 'http://192.168.1.10',
          instrument: SD,
          profile: { externalWebsiteFeatures: ['faq', 'social', 'opac'] },
        })
      ).get('system.website_features');
      expect(v).toEqual({
        value: 2,
        unit: 'count',
        basis: 'manual',
        notes: [{ key: 'accred.note.l12_external', params: { url: 'https://sma-contoh.sch.id/perpustakaan' } }],
        facts: { elements: ['opac', 'social'] },
      });
    });

    it('the automation facts follow the base address; a public one is a guess from its name', async () => {
      const ids: AccredMetricId[] = ['system.base_url_class', 'system.l11_automation'];
      const pub = await compute(systemProvider, period(), ids);
      expect(pub.get('system.base_url_class')).toEqual({
        value: 1,
        unit: 'code',
        basis: 'setting',
        notes: [{ key: 'accred.note.base_url_public_guess' }],
        facts: { class: 'public', host: 'perpus.sma-contoh.sch.id' },
      });
      expect(pub.get('system.l11_automation')).toEqual({
        value: 1,
        unit: 'code',
        basis: 'setting',
        notes: [{ key: 'accred.note.base_url_public_guess' }],
        facts: { class: 'public', membersUsed: null, circulationUsed: null },
      });
      expect(suggestAnswer(indicator(SMA, 'L11'), pub.get('system.l11_automation')!, null)).toMatchObject({ suggestion: 'a' });

      const local = await compute(systemProvider, period(), ids, { baseUrl: 'http://127.0.0.1:3000' });
      expect(local.get('system.l11_automation')).toMatchObject({ value: 1, notes: [], facts: { class: 'localhost' } });
      expect(suggestAnswer(indicator(SMA, 'L11'), local.get('system.l11_automation')!, null).suggestion).toBe('c');

      const unset = await compute(systemProvider, period(), ids, { baseUrl: null });
      expect(unset.get('system.l11_automation')).toEqual({
        value: null,
        unit: 'code',
        basis: 'setting',
        notes: [{ key: 'accred.note.base_url_unset' }],
        facts: { class: 'unset', membersUsed: null, circulationUsed: null },
      });
      expect(unset.get('system.base_url_class')).toMatchObject({ value: null, facts: { class: 'unset', host: null } });
    });
  });
});
