import type { DB } from '@altis/db';
import type { Insertable } from 'kysely';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import { cutChars, freshRows, keyOf, refsOf, runSteps, type BatchIo, type Ledger, type ScanStep } from './stage-a-kit.js';

// Relations between records (Phase 2 spec §11.3 step 4, §11.4; plan Task 37): `biblio_relation` → `record_relations`
// of type `related`, stored in one direction (the OPAC shows both). SLiMS's `rel_type` is always 1 and is not read.
// Dropped, each with its skip reason: `rel_biblio_id = 0` (`zero`), a record related to itself (`self`, also two
// SLiMS records that the migration made one), a record the run did not migrate (`orphan`, reported), and a pair that
// is already related either way (`duplicate`: SLiMS's own reciprocal rows). Batches of 500, one transaction each,
// with the legacy map; a dry run counts alike and writes nothing (duplicates found within its batch only). A replay (a
// row this very run mapped before its process died, stage-a-kit.ts) was migrated: counted so again, nothing written.

async function relationBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const T = 'biblio_relation';
  const fresh = await freshRows(c, io, l, T, rows, ['biblio_id', 'rel_biblio_id']);
  if (fresh.length === 0) return;
  const records = await refsOf(
    c,
    io,
    'biblio',
    fresh.flatMap(({ row }) => [keyOf(row['biblio_id']), keyOf(row['rel_biblio_id'])]).filter((k) => k !== '0'),
  );
  const pairs = new Set<string>();
  const inserts: Insertable<DB['record_relations']>[] = [];
  const maps: LegacyMapping[] = [];
  for (const { key, row, replay } of fresh) {
    const from = keyOf(row['biblio_id']);
    const to = keyOf(row['rel_biblio_id']);
    if (from === '0' || to === '0') {
      l.skipped(T, 'zero');
      continue;
    }
    if (from === to) {
      l.skipped(T, 'self');
      continue;
    }
    const a = records.get(from);
    const b = records.get(to);
    if (a === undefined || b === undefined) {
      l.skipped(T, 'orphan');
      l.report(T, key, 'record_missing', `biblio_id=${cutChars(a === undefined ? from : to, 40)}`);
      continue;
    }
    if (a === b) {
      l.skipped(T, 'self');
      continue;
    }
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (replay !== null) {
      pairs.add(pair);
      l.migrated(T);
      continue;
    }
    const stored =
      pairs.has(pair) ||
      (await io.db
        .selectFrom('record_relations')
        .select('record_id')
        .where('type', '=', 'related')
        .where((eb) => eb.or([eb.and([eb('record_id', '=', a), eb('related_id', '=', b)]), eb.and([eb('record_id', '=', b), eb('related_id', '=', a)])]))
        .executeTakeFirst()) !== undefined;
    if (stored) {
      l.skipped(T, 'duplicate');
      continue;
    }
    pairs.add(pair);
    inserts.push({ record_id: a, related_id: b, type: 'related' });
    maps.push({ source: c.options.sourceName, entity: T, legacyKey: key, targetId: a, runId: c.runId });
    l.migrated(T);
  }
  if (io.trx === null || inserts.length === 0) return;
  await io.trx.insertInto('record_relations').values(inserts).execute();
  await mapLegacy(io.trx, maps);
}

const STEPS: readonly ScanStep[] = Object.freeze([{ kind: 'scan', table: 'biblio_relation', batch: relationBatch } satisfies ScanStep]);

/**
 * Relations between records (§11.3 step 4, §11.4): `biblio_relation` → `related`.
 */
export const relationsStage: SlimsStage = Object.freeze({
  name: 'relations' as const,
  reads: Object.freeze(['biblio_relation']),
  run: (c: SlimsStageContext, cursor: string | null) => runSteps(c, 'relations', STEPS, cursor),
});
