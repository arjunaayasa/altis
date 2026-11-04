import { randomInt } from 'node:crypto';
import { MIGRATION_SAMPLE_MAX_CHARS } from '@altis/shared/api/catalog/migration';
import { z } from 'zod';
import { SLIMS_CURSOR_MAX, cutText, pipelineOf } from './pipeline.js';
import { cleanText } from './source/clean-text.js';
import type { SlimsRow } from './source/types.js';
import type { SlimsStage, SlimsStageContext } from './stage.js';

// `report`, the last stage (Phase 2 spec §11.3 step 10, §11.6; plan Task 23):
//
// 1. the random check sample (§11.6): up to 20 `biblio` rows this run migrated (its `migration_map` rows of entity
//    `biblio` under the run's source name), picked by random offsets, each with its ALTIS record's title;
// 2. the SLiMS title of each of them, read from the source's `biblio` in keyset batches (sliced; the cursor is the
//    source's), cleaned as the records stage cleans it (§11.5 steps 1–3: NUL, stored backslashes, mojibake, cp1252
//    bytes) and compared with the record's title and subtitle (letters and digits only, case and accents ignored): a
//    title the migration repaired matches; the report shows the SLiMS title as stored;
// 3. the end of the run (pipeline.ts `finish`): the rows of the target tables after the run (M13), the reconciliation,
//    the report file with the framework's rows first (the run, the reconciliation per table, the target counts, the
//    check sample with each record's admin URL, the text repairs, the character sets, the fixed notes on OAI
//    identifiers and the "Fase 3" tables), then the stages' rows; the run `succeeded`, the search index `ready`, and
//    `catalog.migration.finish` by the system actor with the counts.
//
// A dry run migrated nothing, so it has no check sample and goes to step 3 at once.

const CHECKS = 20;
const BATCH = 500;

const reportCursor = z.strictObject({ p: z.literal('scan'), c: z.string().min(1).max(SLIMS_CURSOR_MAX - 64).nullable() });

/** Letters and digits only, without accents, lower case: what a title comparison compares. */
function looseKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

/** A cell as text (bytes as UTF-8, or cp1252 when they are not). */
function textOf(v: SlimsRow[string] | undefined): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) {
    try {
      return utf8.decode(v);
    } catch {
      return cp1252.decode(v);
    }
  }
  return String(v);
}

/** `k` distinct random integers below `n`, ascending. */
function randomOffsets(k: number, n: number): number[] {
  const picked = new Set<number>();
  while (picked.size < Math.min(k, n)) picked.add(randomInt(n));
  return [...picked].sort((a, b) => a - b);
}

/** Step 1 of the top of this file. */
async function pickChecks(c: SlimsStageContext): Promise<void> {
  const p = pipelineOf(c);
  const mapped = p.db
    .selectFrom('migration_map')
    .where('source', '=', p.settings.sourceName)
    .where('entity', '=', 'biblio')
    .where('run_id', '=', p.runId);
  const n = Number((await mapped.select((eb) => eb.fn.countAll<number | string | bigint>().as('n')).executeTakeFirstOrThrow()).n);
  const picks: { legacyId: string; recordId: string }[] = [];
  for (const offset of randomOffsets(CHECKS, n)) {
    const row = await mapped.select(['legacy_key', 'target_id']).orderBy('legacy_key').limit(1).offset(offset).executeTakeFirst();
    if (row !== undefined) picks.push({ legacyId: row.legacy_key, recordId: row.target_id });
  }
  const records =
    picks.length === 0
      ? []
      : await p.db
          .selectFrom('records')
          .select(['id', 'title', 'subtitle'])
          .where(
            'id',
            'in',
            picks.map((x) => x.recordId),
          )
          .execute();
  const titles = new Map(records.map((r) => [r.id, r.subtitle === null || r.subtitle === '' ? r.title : `${r.title}: ${r.subtitle}`]));
  p.state.checks = picks
    .filter((x) => titles.has(x.recordId))
    .map((x) => ({ legacyId: x.legacyId, recordId: x.recordId, title: cutText(titles.get(x.recordId)!, MIGRATION_SAMPLE_MAX_CHARS), matches: false }));
  p.state.checkSource = {};
}

/** The checked rows whose SLiMS title is not read yet. */
function pending(c: SlimsStageContext): Set<string> {
  const p = pipelineOf(c);
  return new Set(p.state.checks.filter((x) => !Object.hasOwn(p.state.checkSource, x.legacyId)).map((x) => x.legacyId));
}

/** Step 2 for one batch of `biblio` rows. */
function compare(c: SlimsStageContext, rows: readonly SlimsRow[], wanted: Set<string>): void {
  const p = pipelineOf(c);
  for (const row of rows) {
    const id = textOf(row['biblio_id']);
    if (!wanted.has(id)) continue;
    wanted.delete(id);
    const stored = row['title'];
    p.state.checkSource[id] = cutText(textOf(stored), MIGRATION_SAMPLE_MAX_CHARS);
    const title = stored === null || stored === undefined ? '' : typeof stored === 'number' ? String(stored) : cleanText(stored).value;
    const check = p.state.checks.find((x) => x.legacyId === id);
    if (check !== undefined) check.matches = looseKey(title) !== '' && looseKey(title) === looseKey(check.title);
  }
}

async function report(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
  const p = pipelineOf(c);
  let at: z.infer<typeof reportCursor> | null = null;
  if (cursor === null) {
    await pickChecks(c);
    const hasBiblio = (await c.source.tables()).some((t) => t.name === 'biblio');
    if (pending(c).size > 0 && hasBiblio) at = { p: 'scan', c: null };
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(cursor);
    } catch {
      throw new TypeError('report: the cursor is not JSON');
    }
    const parsed = reportCursor.safeParse(raw);
    if (!parsed.success) throw new TypeError('report: the cursor is malformed');
    at = parsed.data;
  }
  if (at !== null) {
    const wanted = pending(c);
    // One batch at least per call, so a call always moves; then only while the budget lasts.
    for (let batches = 0; wanted.size > 0; batches += 1) {
      if (batches > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: JSON.stringify(at) };
      const batch = await c.source.rows('biblio', at.c, BATCH);
      compare(c, batch.rows, wanted);
      if (batch.next === null || batch.rows.length === 0) break;
      at = { p: 'scan', c: batch.next };
    }
  }
  await p.finish('succeeded');
  return { done: true, cursor: null };
}

/** The `report` stage (see the top of this file). */
export const slimsReportStage: SlimsStage = Object.freeze({
  name: 'report' as const,
  reads: Object.freeze([]) as readonly string[],
  run: report,
});
