import { newId } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { ItemBatchBody, type ItemBatchResponse } from '@altis/shared/api/catalog/items';
import type { BarcodePattern } from '@altis/shared/api/settings';
import type { TxCtx } from '../../context.js';
import { readSettings } from '../../settings/service.js';
import { loadCustomDefs } from '../data/custom-fields.js';
import { barcodeProblem, normalizeBarcode } from '../lib/barcode.js';
import { lockBarcodePattern, nextBarcodes } from './patterns.js';
import {
  afterItemsWrite,
  barcodeTaken,
  checkBranch,
  insertItems,
  itemValidationFailed,
  lockLiveRecord,
  parseItemBody,
  templateColumns,
} from './service.js';

// Batches of items (Phase 2 spec §3.4): up to 100 items of one record in one transaction, numbered by a barcode
// pattern (patterns.ts) or given as barcodes, all with the batch's `template`. One audit entry
// `catalog.item.batch_create` (`meta {count, skipped, patternId}`), one `created` history row per item, and
// `catalog.item.changed` per item last.
//
// With a pattern, the pattern's lock row is the transaction's **first** statement (before any read: on MySQL/MariaDB
// the snapshot of the reads is then taken after the previous batch of the pattern committed), the record's row is
// locked next (the order every batch takes, so two never deadlock), by a write that matches only a live record
// (lockLiveRecord: an archive or a merge committed meanwhile is seen). The lock row was made by ensureBarcodeLockRow
// before the transaction (the route's `prepare`, M8); a pattern that exists while its row does not is a TypeError.
// Given barcodes are normalised and checked like one item's (`barcodes.<i>`: their problem, `duplicate` within the
// list, `taken`); the whole batch is refused then.

/**
 * Creates `body.count` items of `body.recordId` in `branchId` (see the top of this file) and answers them with the
 * barcodes found taken at their check (B4).
 *
 * @throws DomainError NOT_FOUND for a branch that is not live; VALIDATION_FAILED with every field error (nothing
 *   written; `patternId` `not_found`/`exhausted`); TX_CONFLICT (a barcode stored concurrently after its check: the
 *   caller's withTx runs again); TypeError when the pattern's lock row is absent
 */
export async function batchCreateItems(tx: TxCtx, branchId: string, body: ItemBatchBody): Promise<ItemBatchResponse> {
  const { trx } = tx;
  const b = parseItemBody(ItemBatchBody, body);
  const locked = b.patternId === undefined ? 0 : await lockBarcodePattern(trx, b.patternId);
  const rec = await lockLiveRecord(trx, b.recordId);
  await checkBranch(trx, branchId);

  const errors: FieldWarning[] = [];
  if (rec !== null) errors.push(rec);
  let pattern: BarcodePattern | undefined;
  const given: string[] = [];
  if (b.patternId !== undefined) {
    const patterns = (await readSettings(trx, ['catalog.barcode.patterns'], []))['catalog.barcode.patterns'] as BarcodePattern[];
    pattern = patterns.find((p) => p.id === b.patternId);
    if (pattern === undefined) errors.push({ path: 'patternId', code: 'not_found' });
  } else {
    const seen = new Set<string>();
    for (const [i, raw] of (b.barcodes ?? []).entries()) {
      const key = normalizeBarcode(raw);
      const problem = barcodeProblem(key);
      if (problem !== null) errors.push({ path: `barcodes.${i}`, code: problem });
      else if (seen.has(key)) errors.push({ path: `barcodes.${i}`, code: 'duplicate' });
      else if (await barcodeTaken(trx, key)) errors.push({ path: `barcodes.${i}`, code: 'taken' });
      seen.add(key);
      given.push(key);
    }
  }
  const defs = await loadCustomDefs(trx, 'items');
  const t = await templateColumns(trx, branchId, b.template, defs, errors, { prefix: 'template.', now: tx.now });
  if (errors.length > 0) throw itemValidationFailed(errors);

  let barcodes = given;
  let skipped: string[] = [];
  if (pattern !== undefined) {
    if (locked === 0) throw new TypeError(`batchCreateItems(): the lock row of pattern ${pattern.id} is absent; call ensureBarcodeLockRow() before the transaction`);
    ({ barcodes, skipped } = await nextBarcodes(trx, pattern, b.count));
  }
  const made = barcodes.map((barcode) => ({ id: newId(tx.now), barcode }));
  await insertItems(tx, branchId, b.recordId, made, t.columns, { values: t.custom, defs }, 'created');
  await afterItemsWrite(
    tx,
    made.map((m) => ({ id: m.id, recordId: b.recordId })),
    {
      publicRecords: [b.recordId],
      audit: {
        action: 'catalog.item.batch_create',
        entity: 'records',
        entityId: b.recordId,
        branchId,
        meta: { count: made.length, skipped: skipped.length, patternId: b.patternId ?? null },
      },
      publish: true,
    },
  );
  return { created: made.map((m) => ({ id: m.id, barcode: m.barcode })), skipped: skipped.map((barcode) => ({ barcode, reason: 'taken' as const })) };
}
