import { describe, expect, it } from 'vitest';
import { recordUrlPath } from '../../../../packages/core/src/index.js';
import {
  ADMIN_ROUTES,
  OPAC_ROUTES,
  PHASE2_BUDGETS,
  evaluatePhase2,
  formatPhase2Report,
  oaiResumptionToken,
  parseRunArgs,
  planMix,
  visitorIp,
  type MixSample,
  type Phase2Measurements,
} from '../run.js';

// The runner of K9 and K16 (plan Task 39): which requests make the §15 mix, how their p95 is judged against the budgets,
// and the command line. The measurement itself needs a release zip and an engine (pnpm release, then run.ts).

const sample: MixSample = {
  records: [
    { id: '01JD0000000000000000000001', title: 'Pendidikan anak usia dini', materialTypeCode: 'BUKU', languageCode: 'IND' },
    { id: '01JD0000000000000000000002', title: 'Sejarah kota Bandung', materialTypeCode: 'KARYA-ILMIAH', languageCode: 'IND' },
    { id: '01JD0000000000000000000003', title: 'Introduction to library systems', materialTypeCode: 'BUKU', languageCode: 'ENG' },
  ],
  barcodes: ['P20000001', 'P20000002'],
  agentPrefixes: ['Suri', 'Wati'],
  subjectTerms: ['Pendidikan', 'Hukum'],
  sitemapFiles: 3,
};

const allRoutes = [...OPAC_ROUTES, ...ADMIN_ROUTES];

describe('the budgets', () => {
  it('OPAC p95 < 300 ms, admin catalogue API p95 < 200 ms (K9); zip < 15 MB, cold start < 1.5 s, RSS < 300 MB (K16)', () => {
    expect(PHASE2_BUDGETS).toEqual({ opacP95Ms: 300, adminP95Ms: 200, zipBytes: 15_000_000, coldStartMs: 1500, rssMb: 300, rssIdleMb: 150 });
  });

  it('the mix of §15: home, search of 1-3 words, search + 2 facets, detail, sitemap page, ListRecords page; and the admin catalogue', () => {
    expect(OPAC_ROUTES).toEqual(['opac.home', 'opac.search.1', 'opac.search.2', 'opac.search.3', 'opac.search.facets', 'opac.record', 'opac.sitemap.catalog', 'oai.list_records']);
    expect(ADMIN_ROUTES).toEqual([
      'catalog.records.list',
      'catalog.records.search',
      'catalog.records.get',
      'catalog.items.list',
      'catalog.items.by_barcode',
      'catalog.agents.list',
      'catalog.subjects.list',
      'catalog.material_types.list',
      'catalog.languages.list',
      'catalog.collection_types.list',
      'catalog.suppliers.list',
    ]);
  });
});

describe('planMix', () => {
  const plan = planMix(sample, { perRoute: 40, seed: 7 });

  it('asks every route exactly perRoute times, interleaved, the same plan for the same seed', () => {
    expect(plan).toHaveLength(40 * allRoutes.length);
    for (const route of allRoutes) expect(plan.filter((p) => p.route === route)).toHaveLength(40);
    expect(new Set(plan.slice(0, allRoutes.length).map((p) => p.route)).size).toBeGreaterThan(5);
    expect(planMix(sample, { perRoute: 40, seed: 7 })).toEqual(plan);
    expect(planMix(sample, { perRoute: 40, seed: 8 })).not.toEqual(plan);
  });

  it('searches for words of the sampled titles (1, 2 or 3 of them), and the facets of the record they came from', () => {
    const titleWords = new Set(sample.records.flatMap((r) => r.title.toLowerCase().split(' ')));
    for (const [route, words] of [['opac.search.1', 1], ['opac.search.2', 2], ['opac.search.3', 3]] as const) {
      for (const p of plan.filter((x) => x.route === route)) {
        const url = new URL(p.path, 'http://x');
        expect(url.pathname).toBe('/cari');
        const q = url.searchParams.get('q')!.split(' ');
        expect(q).toHaveLength(words);
        for (const w of q) expect(titleWords.has(w)).toBe(true);
      }
    }
    for (const p of plan.filter((x) => x.route === 'opac.search.facets')) {
      const url = new URL(p.path, 'http://x');
      const q = url.searchParams.get('q')!;
      const rec = sample.records.find((r) => r.title.toLowerCase().split(' ').includes(q))!;
      expect([...url.searchParams.keys()]).toEqual(['q', 'jenis', 'bahasa']);
      expect(url.searchParams.get('jenis')).toBe(rec.materialTypeCode);
      expect(url.searchParams.get('bahasa')).toBe(rec.languageCode);
    }
  });

  it('opens records at their canonical URL, sitemap pages that exist, and the admin catalogue under /api/v1', () => {
    for (const p of plan.filter((x) => x.route === 'opac.record')) {
      expect(sample.records.map((r) => recordUrlPath(r.id, r.title))).toContain(p.path);
    }
    for (const p of plan.filter((x) => x.route === 'opac.sitemap.catalog')) expect(p.path).toMatch(/^\/sitemap\/katalog\/[1-3]$/);
    expect(plan.find((x) => x.route === 'opac.home')!.path).toBe('/');
    expect(plan.find((x) => x.route === 'oai.list_records')!.path).toBe('/oai?verb=ListRecords&metadataPrefix=oai_dc');
    for (const p of plan.filter((x) => (ADMIN_ROUTES as readonly string[]).includes(x.route))) expect(p.path.startsWith('/api/v1/catalog/')).toBe(true);
    const barcodes = plan.filter((x) => x.route === 'catalog.items.by_barcode').map((x) => new URL(x.path, 'http://x').searchParams.get('barcode'));
    for (const b of barcodes) expect(sample.barcodes).toContain(b);
    const gets = plan.filter((x) => x.route === 'catalog.records.get').map((x) => x.path.slice('/api/v1/catalog/records/'.length));
    for (const id of gets) expect(sample.records.map((r) => r.id)).toContain(id);
    expect(plan.find((x) => x.route === 'catalog.agents.list')!.path).toMatch(/^\/api\/v1\/catalog\/agents\?q=(Suri|Wati)&limit=50$/);
    // The masters lists count the live records or items each master is used by (the masters screens).
    expect(plan.find((x) => x.route === 'catalog.material_types.list')!.path).toBe('/api/v1/catalog/material-types');
    expect(plan.find((x) => x.route === 'catalog.languages.list')!.path).toBe('/api/v1/catalog/languages');
    expect(plan.find((x) => x.route === 'catalog.collection_types.list')!.path).toBe('/api/v1/catalog/collection-types');
    expect(plan.find((x) => x.route === 'catalog.suppliers.list')!.path).toBe('/api/v1/catalog/suppliers');
  });

  it('encodes what it puts in a query (a code with a hyphen stays, a space is %20 or +)', () => {
    const p = plan.find((x) => x.route === 'opac.search.2')!;
    expect(p.path).not.toContain(' ');
  });
});

describe('a visitor per request', () => {
  it('visitorIp gives distinct addresses of 10.0.0.0/8 (each OPAC request is its own visitor: opac_search is 120/min per IP)', () => {
    const ips = new Set(Array.from({ length: 70_000 }, (_, i) => visitorIp(i)));
    expect(ips.size).toBe(70_000);
    for (const ip of [visitorIp(0), visitorIp(65_536), visitorIp(16_777_215)]) expect(ip).toMatch(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    expect(visitorIp(0)).toBe('10.0.0.1');
  });
});

describe('oaiResumptionToken', () => {
  it('reads the token of a ListRecords page, null at the end of the list or on an error', () => {
    expect(oaiResumptionToken('<OAI-PMH><ListRecords><record/><resumptionToken completeListSize="9" cursor="0">abc.12-x</resumptionToken></ListRecords></OAI-PMH>')).toBe('abc.12-x');
    expect(oaiResumptionToken('<ListRecords><resumptionToken completeListSize="9" cursor="100"/></ListRecords>')).toBeNull();
    expect(oaiResumptionToken('<ListRecords><resumptionToken completeListSize="9" cursor="100"></resumptionToken></ListRecords>')).toBeNull();
    expect(oaiResumptionToken('<OAI-PMH><error code="badResumptionToken">x</error></OAI-PMH>')).toBeNull();
    expect(oaiResumptionToken('<ListRecords><resumptionToken>a&amp;b</resumptionToken></ListRecords>')).toBe('a&b');
  });
});

/** Measurements inside every budget. */
const good = (): Phase2Measurements => ({
  p95Ms: Object.fromEntries(allRoutes.map((r) => [r, 50])),
  errors: Object.fromEntries(allRoutes.map((r) => [r, 0])),
  rssLoadMb: 200,
  coldStartMs: 900,
  rssIdleMb: 120,
  zipBytes: 3_000_000,
  reindexMs: 60_000,
  rssReindexMb: 250,
  importMs: 1_000_000,
  rssImportMb: 280,
  migrateMs: 900_000,
  rssMigrateMb: 290,
});

describe('evaluatePhase2', () => {
  it('passes measurements inside every budget', () => {
    expect(evaluatePhase2(good(), ['opac', 'import', 'migrate'])).toEqual({ ok: true, failures: [] });
  });

  it('fails an OPAC p95 of 300 ms and an admin p95 of 200 ms (strict upper bounds), passes 299 and 199', () => {
    const m = good();
    m.p95Ms['opac.search.3'] = 300;
    m.p95Ms['catalog.records.get'] = 200;
    expect(evaluatePhase2(m, ['opac']).failures).toEqual([
      'p95 opac.search.3 300 ms is over the budget (< 300 ms)',
      'p95 catalog.records.get 200 ms is over the budget (< 200 ms)',
    ]);
    m.p95Ms['opac.search.3'] = 299;
    m.p95Ms['catalog.records.get'] = 199;
    expect(evaluatePhase2(m, ['opac']).ok).toBe(true);
  });

  it('a route with an error answer, or never measured, fails', () => {
    const m = good();
    m.errors['opac.record'] = 2;
    m.p95Ms['oai.list_records'] = null;
    expect(evaluatePhase2(m, ['opac']).failures).toEqual(['opac.record: 2 answers were not 200', 'p95 oai.list_records: not measured']);
  });

  it('K16: zip, cold start and every RSS (load, reindex, import, migration) against their budgets', () => {
    const m = { ...good(), zipBytes: 15_000_000, coldStartMs: 1500, rssLoadMb: 300, rssIdleMb: 150, rssReindexMb: 301, rssImportMb: 300, rssMigrateMb: 400 };
    expect(evaluatePhase2(m, ['opac', 'import', 'migrate']).failures.map((f) => f.split(' ')[0])).toEqual(['zipBytes', 'coldStartMs', 'rssIdleMb', 'rssLoadMb', 'rssReindexMb', 'rssImportMb', 'rssMigrateMb']);
  });

  it('only judges the modes that ran; an RSS that could not be sampled (Windows) is not asserted', () => {
    const m = { ...good(), importMs: null, rssImportMb: null, migrateMs: null, rssMigrateMb: null };
    expect(evaluatePhase2(m, ['opac']).ok).toBe(true);
    expect(evaluatePhase2(m, ['opac', 'import']).failures).toEqual(['importMs: not measured']);
    expect(evaluatePhase2({ ...good(), rssLoadMb: null, rssIdleMb: null }, ['opac']).ok).toBe(true);
    expect(evaluatePhase2({ ...good(), coldStartMs: null }, ['opac']).failures).toEqual(['coldStartMs: not measured']);
  });
});

describe('parseRunArgs', () => {
  const env = {};
  it('takes the zip and the engine, all modes, the full seed and 200 requests per route by default', () => {
    expect(parseRunArgs(['--zip', 'dist/altis-0.1.0-test.zip', '--db', 'sqlite'], env, '/repo')).toEqual({
      zip: '/repo/dist/altis-0.1.0-test.zip',
      db: 'sqlite',
      modes: ['opac', 'import', 'migrate'],
      scale: 1,
      requests: 200,
      keep: false,
      assert: false,
      nodeOptions: null,
    });
  });

  it('--node-options goes to the processes of the install (server and commands), to try a V8 heap policy', () => {
    expect(parseRunArgs(['--zip', 'a.zip', '--db', 'sqlite', '--node-options=--max-old-space-size=192'], env, '/repo').nodeOptions).toBe('--max-old-space-size=192');
    expect(() => parseRunArgs(['--zip', 'a.zip', '--db', 'sqlite', '--node-options', 'x'.repeat(201)], env, '/repo')).toThrow(/^USAGE: /);
    expect(() => parseRunArgs(['--zip', 'a.zip', '--db', 'sqlite', '--node-options', 'a\nb'], env, '/repo')).toThrow(/^USAGE: /);
  });

  it('takes the modes, a scale, a request count, --keep and --assert', () => {
    expect(parseRunArgs(['--', '--zip', '/z.zip', '--db', 'mariadb106', '--mode', 'opac,migrate', '--scale', '0.1', '--requests', '50', '--keep', '--assert'], env, '/repo')).toMatchObject({
      db: 'mariadb106',
      modes: ['opac', 'migrate'],
      scale: 0.1,
      requests: 50,
      keep: true,
      assert: true,
    });
  });

  it('refuses a missing zip, an unknown engine or mode, a scale or request count out of range', () => {
    for (const argv of [
      ['--db', 'sqlite'],
      ['--zip', 'a.zip', '--db', 'oracle'],
      ['--zip', 'a.zip', '--db', 'sqlite', '--mode', 'opac,fast'],
      ['--zip', 'a.zip', '--db', 'sqlite', '--scale', '0'],
      ['--zip', 'a.zip', '--db', 'sqlite', '--scale', '3'],
      ['--zip', 'a.zip', '--db', 'sqlite', '--requests', '0'],
      ['--zip', 'a.zip', '--db', 'sqlite', '--bogus'],
    ]) {
      expect(() => parseRunArgs(argv, env, '/repo')).toThrow(/^USAGE: /);
    }
  });
});

describe('formatPhase2Report', () => {
  it('is one JSON line with the budgets beside the numbers', () => {
    const line = formatPhase2Report({ db: 'sqlite', node: 'v26.0.0', seed: 'perf-phase2', counts: { records: 1, items: 1, agents: 1, subjects: 1, attachments: 1 }, modes: ['opac'], measurements: good(), budgetsAsserted: false, failures: [] });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['db', 'node', 'seed', 'counts', 'modes', 'measurements', 'budgets', 'budgetsAsserted', 'failures']);
    expect(parsed['budgets']).toEqual(PHASE2_BUDGETS);
  });
});
