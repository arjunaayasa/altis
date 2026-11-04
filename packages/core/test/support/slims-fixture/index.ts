import fsp from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { generateSlimsFixture } from './generate.js';

// The synthetic SLiMS fixture (spec §11.7; Phase 2 Task 10): a mysqldump-style dump of a small SLiMS 9 catalogue
// (±300 `biblio`, ±600 `item`, every table §11.4 reads, and the 15 traps), its gzip, and the files zip that goes with
// it. Written by hand from the schema description (clean-room), deterministic for a seed. Tasks 23, 37, 38 and 39 use
// it through `expected`, which holds the source counts and what each trap must come out as.

export { FIXTURE_TABLES, BIBLIO_CUSTOM_COLUMNS, ITEM_CUSTOM_COLUMNS } from './schema.js';
export type { FixtureTable } from './schema.js';
export type { SlimsFixtureExpected, SlimsFixtureTraps, TextTrap } from './generate.js';

export interface SlimsFixture {
  /** `<dir>/slims-dump.sql`. */
  dumpPath: string;
  /** `<dir>/slims-dump.sql.gz`: the same dump, gzipped. */
  dumpGzPath: string;
  /** `<dir>/slims-files.zip`: `repository/`, `images/docs/`, `images/content/`, some referenced files left out. */
  filesZipPath: string;
  expected: import('./generate.js').SlimsFixtureExpected;
}

/** The default seed. */
export const SLIMS_FIXTURE_SEED = 20261030;

/** The fixture's bytes for `seed`, without writing them (the dump, its gzip, the files zip). */
export function slimsFixtureBytes(seed: number = SLIMS_FIXTURE_SEED): { dump: Buffer; dumpGz: Buffer; filesZip: Buffer; expected: SlimsFixture['expected'] } {
  const { dump, filesZip, expected } = generateSlimsFixture(seed);
  return { dump, dumpGz: gzipSync(dump, { level: 9 }), filesZip, expected };
}

/** Writes the fixture into the folder `dir` (created when missing). */
export async function buildSlimsFixture(dir: string, o: { seed?: number } = {}): Promise<SlimsFixture> {
  const { dump, dumpGz, filesZip, expected } = slimsFixtureBytes(o.seed ?? SLIMS_FIXTURE_SEED);
  await fsp.mkdir(dir, { recursive: true });
  const dumpPath = path.join(dir, 'slims-dump.sql');
  const dumpGzPath = path.join(dir, 'slims-dump.sql.gz');
  const filesZipPath = path.join(dir, 'slims-files.zip');
  await fsp.writeFile(dumpPath, dump);
  await fsp.writeFile(dumpGzPath, dumpGz);
  await fsp.writeFile(filesZipPath, filesZip);
  return { dumpPath, dumpGzPath, filesZipPath, expected };
}
