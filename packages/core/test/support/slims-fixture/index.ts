import fsp from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { generateSlimsFixture, type FixtureData } from './generate.js';
import { generateUsage, type UsageFixtureExpected, type UsageFixtureOptions } from './generate-usage.js';
import { mutateCatalogAfterFirstRun, type CatalogMutationExpected } from './mutate-catalog.js';

// The synthetic SLiMS fixture (spec §11.7; Phase 2 Task 10): a mysqldump-style dump of a small SLiMS 9 catalogue
// (±300 `biblio`, ±600 `item`, every table §11.4 reads, and the 15 traps), its gzip, and the files zip that goes with
// it. Written by hand from the schema description (clean-room), deterministic for a seed. Tasks 23, 37, 38 and 39 use
// it through `expected`, which holds the source counts and what each trap must come out as.

export { FIXTURE_TABLES, BIBLIO_CUSTOM_COLUMNS, ITEM_CUSTOM_COLUMNS } from './schema.js';
export type { FixtureTable } from './schema.js';
export type { SlimsFixtureExpected, SlimsFixtureTraps, TextTrap } from './generate.js';
// ---- Komunitas K1 (usage and re-sync) ----
export type { FixtureCell, FixtureData, FixtureRow } from './generate.js';
export type { UsageFixtureExpected, UsageFixtureOptions } from './generate-usage.js';
export type { CatalogMutationExpected } from './mutate-catalog.js';

/**
 * What the fixture is built with besides its seed: the usage rows of the aggregate usage import (`usage`), and the
 * catalogue changes a library makes after a first migration (`mutateCatalog`), for a second run with the re-sync.
 */
export interface SlimsFixtureOptions {
  usage?: UsageFixtureOptions;
  mutateCatalog?: boolean;
}

/** What the options add to the expectations: the usage counts, and the changes a re-sync must find (null without). */
export interface SlimsFixtureHookExpected {
  usage: UsageFixtureExpected | null;
  mutation: CatalogMutationExpected | null;
}

/** The fixture's data change for `o`: the usage rows merged in (appended per table), then the catalogue changes. */
function fixtureTransform(o: SlimsFixtureOptions, hooks: SlimsFixtureHookExpected): ((data: FixtureData) => FixtureData) | undefined {
  if (o.usage === undefined && o.mutateCatalog !== true) return undefined;
  return (data) => {
    let out = data;
    if (o.usage !== undefined) {
      const usage = generateUsage(out, o.usage);
      const rows = new Map(out.rows);
      for (const [table, added] of Object.entries(usage.rows)) rows.set(table, [...(rows.get(table) ?? []), ...added]);
      out = { ...out, rows };
      hooks.usage = usage.expected;
    }
    if (o.mutateCatalog === true) {
      const mutated = mutateCatalogAfterFirstRun(out);
      out = mutated.data;
      hooks.mutation = mutated.expected;
    }
    return out;
  };
}

export interface SlimsFixture {
  /** `<dir>/slims-dump.sql`. */
  dumpPath: string;
  /** `<dir>/slims-dump.sql.gz`: the same dump, gzipped. */
  dumpGzPath: string;
  /** `<dir>/slims-files.zip`: `repository/`, `images/docs/`, `images/content/`, some referenced files left out. */
  filesZipPath: string;
  expected: import('./generate.js').SlimsFixtureExpected;
  /** What the options added to the expectations. */
  hooks: SlimsFixtureHookExpected;
}

/** The default seed. */
export const SLIMS_FIXTURE_SEED = 20261030;

/** The fixture's bytes for `seed`, without writing them (the dump, its gzip, the files zip). */
export function slimsFixtureBytes(
  seed: number = SLIMS_FIXTURE_SEED,
  o: SlimsFixtureOptions = {},
): { dump: Buffer; dumpGz: Buffer; filesZip: Buffer; expected: SlimsFixture['expected']; hooks: SlimsFixtureHookExpected } {
  const hooks: SlimsFixtureHookExpected = { usage: null, mutation: null };
  const transform = fixtureTransform(o, hooks);
  const { dump, filesZip, expected } = generateSlimsFixture(seed, transform === undefined ? {} : { transform });
  return { dump, dumpGz: gzipSync(dump, { level: 9 }), filesZip, expected, hooks };
}

/** Writes the fixture into the folder `dir` (created when missing). */
export async function buildSlimsFixture(dir: string, o: { seed?: number } & SlimsFixtureOptions = {}): Promise<SlimsFixture> {
  const { seed, ...options } = o;
  const { dump, dumpGz, filesZip, expected, hooks } = slimsFixtureBytes(seed ?? SLIMS_FIXTURE_SEED, options);
  await fsp.mkdir(dir, { recursive: true });
  const dumpPath = path.join(dir, 'slims-dump.sql');
  const dumpGzPath = path.join(dir, 'slims-dump.sql.gz');
  const filesZipPath = path.join(dir, 'slims-files.zip');
  await fsp.writeFile(dumpPath, dump);
  await fsp.writeFile(dumpGzPath, dumpGz);
  await fsp.writeFile(filesZipPath, filesZip);
  return { dumpPath, dumpGzPath, filesZipPath, expected, hooks };
}
