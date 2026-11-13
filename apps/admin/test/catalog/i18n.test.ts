import { describe, expect, it } from 'vitest';
import { ADMIN_MESSAGES } from '@/i18n';
import { CATALOG_AREAS_EN, CATALOG_AREAS_ID, CATALOG_EN, CATALOG_ID } from '@/i18n/catalog';

// The catalogue's admin copy (Phase 2 Task 3): one file per area (i18n/catalog/<area>.ts, each owned by the task that
// builds its screens), joined in i18n/catalog/index.ts and spread into ADMIN_ID/ADMIN_EN. This aggregator test holds
// every area to the shared i18n rules: the same keys and {placeholders} in `id` and `en`, no empty text, no English
// left in `id`, and keys that carry their area's prefix, so that two areas never write the same key (a spread would
// silently keep one of the two texts).

const placeholders = (text: string): string[] => [...new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))].sort();

/** The prefix of an area's keys: `catalog.<area>.`, except Halaman & Berita (`pages.`). */
const prefixOf = (area: string): string => (area === 'pages' ? 'pages.' : `catalog.${area}.`);

/** Keys whose two texts may be the same (a proper name, a format): none so far. */
const SAME_IN_BOTH: readonly string[] = [];

describe('the catalogue admin copy', () => {
  const areas = Object.keys(CATALOG_AREAS_ID) as (keyof typeof CATALOG_AREAS_ID)[];

  it('is one file per area, in a fixed order, plus Task 3’s placeholder texts', () => {
    expect(areas).toEqual([
      'records',
      'items',
      'authorities',
      'masters',
      'locations',
      'settings',
      'exchange',
      'duplicates',
      'labels',
      'migration',
      'attachments',
      'pages',
      'sru',
      'placeholder',
    ]);
    expect(Object.keys(CATALOG_AREAS_EN)).toEqual(areas);
  });

  it.each(areas)('%s: id and en have the same keys, each with the area prefix', (area) => {
    const id = Object.keys(CATALOG_AREAS_ID[area]).sort();
    expect(Object.keys(CATALOG_AREAS_EN[area]).sort()).toEqual(id);
    for (const key of id) expect(key.startsWith(prefixOf(area)), key).toBe(true);
  });

  it.each(areas)('%s: no empty text, the same placeholders, and no English left in id', (area) => {
    const en = CATALOG_AREAS_EN[area];
    for (const [key, text] of Object.entries(CATALOG_AREAS_ID[area] as Readonly<Record<string, string>>)) {
      for (const value of [text, en[key]!]) expect(value.trim(), key).not.toBe('');
      expect(placeholders(en[key]!), key).toEqual(placeholders(text));
      if (!SAME_IN_BOTH.includes(key)) expect(en[key], `${key}: the id text is the en one`).not.toBe(text);
    }
  });

  it('no key is in two areas, and the joined copy holds every area key', () => {
    const all = areas.flatMap((area) => Object.keys(CATALOG_AREAS_ID[area]));
    expect(all.length).toBe(new Set(all).size);
    expect(Object.keys(CATALOG_ID).sort()).toEqual([...all].sort());
    expect(Object.keys(CATALOG_EN).sort()).toEqual([...all].sort());
  });

  it('ADMIN_ID and ADMIN_EN spread the catalogue copy as it is', () => {
    for (const [key, text] of Object.entries(CATALOG_ID)) {
      expect((ADMIN_MESSAGES.id as Readonly<Record<string, string>>)[key], key).toBe(text);
      expect((ADMIN_MESSAGES.en as Readonly<Record<string, string>>)[key], key).toBe((CATALOG_EN as Readonly<Record<string, string>>)[key]);
    }
  });

  it('the job types and the schedule of the catalogue have their labels (Tugas dan Jadwal)', () => {
    for (const type of ['import', 'export', 'reindex', 'dedupe_scan', 'migrate_slims', 'housekeeping']) {
      expect(ADMIN_MESSAGES.id[`jobs.type.catalog.${type}` as keyof typeof ADMIN_MESSAGES.id], type).toBeTruthy();
    }
    expect(ADMIN_MESSAGES.id['jobs.schedule.catalog.housekeeping']).toBe('Perawatan harian katalog');
  });

  // ---- Komunitas K1 (jobs) ----
  it('the job types, the schedule and the job messages of reports and accreditation have their labels in both languages', () => {
    const keys = [
      'jobs.type.reports.export',
      'jobs.type.reports.housekeeping',
      'jobs.type.accreditation.evaluate',
      'jobs.type.accreditation.import_slims_usage',
      'jobs.schedule.reports.housekeeping',
      'jobs.message.reports.housekeeping.date_jobs_postponed',
      'jobs.message.reports.export.warnings',
    ] as const;
    for (const key of keys) {
      expect(ADMIN_MESSAGES.id[key], key).toBeTruthy();
      expect(ADMIN_MESSAGES.en[key], key).toBeTruthy();
      expect(ADMIN_MESSAGES.id[key], key).not.toBe(ADMIN_MESSAGES.en[key]);
    }
    expect(ADMIN_MESSAGES.id['jobs.message.reports.housekeeping.date_jobs_postponed']).toBe('Tugas berbasis tanggal ditunda: jam sistem melompat');
    expect(ADMIN_MESSAGES.en['jobs.message.reports.export.warnings']).toBe('Finished with warnings; see the export list for details');
  });
});
