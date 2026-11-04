import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { mapLegacy } from '../../../catalog/data/legacy-map.js';
import { detectType } from '../../../files/magic.js';
import { stripImageMetadata, type StrippableImage } from '../../../files/strip-metadata.js';
import { indexRecords, stampChanged } from '../../../search/index-records.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  Ledger,
  cutChars,
  keyFits,
  keyOf,
  mappedRows,
  nextPhase,
  oneLine,
  quietText,
  readCursor,
  readSourceFile,
  sha256Of,
  sourceCursor,
  stageBBatch,
  stateOf,
  storeBlob,
  tableOf,
  targetsOf,
  textOf,
  writeCursor,
  endOfStage,
} from './stage-b-kit.js';

// Covers (Phase 2 spec §11.3 step 7, §11.4 row `biblio.image`, §8; preflight S10; plan Task 38): for each `biblio` row
// with an `image`, the file `images/docs/<image>` from the files source becomes the record's cover: a `catalog.cover`
// file (JPEG, PNG or WebP by its magic bytes, at most the context's 2 MiB) with its metadata stripped (EXIF, XMP, text
// chunks; Task 18's stripImageMetadata), public, owned by its record, set as `cover_file_id` (entity `biblio_image`).
// A file the source lacks → `missing_file`; one past 2 MiB → `file_too_large`; one that is no such image or whose
// structure does not hold → `cover_invalid`; a record that has a cover already keeps it (`cover_kept`). The rows of
// `biblio` are the records stage's to count: this stage counts nothing, it only reports.
//
// One cover per transaction (the bytes stored before it). A dry run reads and checks every cover as a real run does,
// and writes nothing.

const TB = 'biblio';
/** The `catalog.cover` context's limit (§8). */
const COVER_MAX_BYTES = 2 * 1024 * 1024;
const NAME_MAX = 191;
const IMAGE_KINDS: ReadonlySet<string> = new Set<StrippableImage>(['jpeg', 'png', 'webp']);

async function coverUnit(c: SlimsStageContext, row: SlimsRow, l: Ledger): Promise<boolean> {
  const key = keyOf(row['biblio_id']);
  if (oneLine(quietText(row['image'])) === '' || !keyFits(key)) return false;
  const state = stateOf(c, (await mappedRows(c, c.h.db, 'biblio_image', [key])).get(key));
  if (state === 'done') return true;
  const image = oneLine(textOf(l, TB, 'image', row['image']) ?? '');
  if (state === 'replay') return true; // stored by this run: a stored cover reports nothing
  const recordId = c.dryRun ? `~${key}` : ((await targetsOf(c, c.h.db, TB, [key])).get(key) ?? null);
  if (recordId === null) {
    l.report(TB, key, 'record_missing', `image=${cutChars(image, 120)}`);
    return true;
  }
  const rel = `images/docs/${image}`;
  const file = await readSourceFile(c, rel, COVER_MAX_BYTES, { keep: true });
  if (file.kind === 'missing') {
    l.report(TB, key, 'missing_file', cutChars(rel, 200));
    return true;
  }
  if (file.kind === 'too_large') {
    l.report(TB, key, 'file_too_large', `${cutChars(rel, 200)} > 2 MB`);
    return true;
  }
  const type = detectType(file.head);
  if (!IMAGE_KINDS.has(type.kind)) {
    l.report(TB, key, 'cover_invalid', `${cutChars(rel, 200)}: ${type.kind}`);
    return true;
  }
  let bytes: Uint8Array;
  try {
    bytes = stripImageMetadata(file.bytes!, type.kind as StrippableImage);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    l.report(TB, key, 'cover_invalid', `${cutChars(rel, 200)}: rusak / damaged`);
    return true;
  }
  if (!c.dryRun) {
    const current = await c.h.db.selectFrom('records').select('cover_file_id').where('id', '=', recordId).executeTakeFirst();
    if (current?.cover_file_id !== null && current?.cover_file_id !== undefined) {
      l.report(TB, key, 'cover_kept', cutChars(rel, 200));
      return true;
    }
    const fileId = newId(c.now);
    const meta = { size: bytes.byteLength, sha256: sha256Of(bytes) };
    await storeBlob(c, fileId, bytes, meta);
    let set = false;
    try {
      set = await withTx(c.h, async (trx) => {
        const r = await trx.selectFrom('records').select('cover_file_id').where('id', '=', recordId).executeTakeFirst();
        if (r === undefined || r.cover_file_id !== null) return false;
        await trx
          .insertInto('files')
          .values({
            id: fileId,
            original_name: cutChars(image.split('/').pop() ?? image, NAME_MAX),
            mime: type.mime,
            size: meta.size,
            sha256: meta.sha256,
            context: 'catalog.cover',
            owner_type: 'records',
            owner_id: recordId,
            access: 'public',
            status: 'ok',
            created_at: c.now,
            created_by: null,
          })
          .execute();
        await trx.updateTable('records').set({ cover_file_id: fileId }).where('id', '=', recordId).execute();
        await mapLegacy(trx, [{ source: c.options.sourceName, entity: 'biblio_image', legacyKey: key, targetId: fileId, runId: c.runId }]);
        await indexRecords(trx, [recordId], c.now);
        // The datestamp last, from the clock read right before the COMMIT (C14).
        await stampChanged(trx, [recordId], c.clock());
        return true;
      });
    } finally {
      // The stored bytes have no row when the cover was not set: removed (best effort).
      if (!set) await c.storage.delete(fileId).catch(() => undefined);
    }
    if (!set) l.report(TB, key, 'cover_kept', cutChars(rel, 200));
  }
  return true;
}

/** Covers (§11.3 step 7, §11.4): see the top of this file. */
export const coversStage: SlimsStage = Object.freeze({
  name: 'covers' as const,
  reads: Object.freeze([TB]) as readonly string[],
  async run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
    let at = readCursor('covers', cursor);
    let units = 0;
    while (at.p < 1) {
      if (units > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
      if ((await tableOf(c, TB)) === null) {
        at = nextPhase(at);
        continue;
      }
      const batch = await c.source.rows(TB, at.c, stageBBatch());
      const next = sourceCursor('covers', batch.rows.length === 0 ? null : batch.next);
      let i = at.i;
      for (; i < batch.rows.length; i += 1) {
        if (units > 0 && c.budgetLeftMs() <= 0) break;
        const l = Ledger.of(at);
        if (await coverUnit(c, batch.rows[i]!, l)) units += 1;
        l.apply(c);
        at = { ...at, i: i + 1, ...l.state() };
      }
      if (i < batch.rows.length) return { done: false, cursor: writeCursor(at) };
      units += 1;
      at = next === null ? nextPhase(at) : { ...at, c: next, i: 0, n: at.n + batch.rows.length };
    }
    return endOfStage(c, 'covers', at);
  },
});
