import type { FieldWarning } from '@altis/shared/api/catalog/common';
import type { LinkInput } from '@altis/shared/api/catalog/record-data';
import type { TxCtx } from '../../context.js';
import { insertUrlAttachments } from '../data/attachments.js';

// The links of a new record (preflight S4): the 856/URL links of a draft (MARC, CSV, SRU, the editor's copy) become
// public URL attachments through Task 1's insertUrlAttachments, the one way an untrusted URL becomes an attachment.
// A link it refuses (not http/https, broken, over 2000 characters) is skipped with the warning
// `{path: 'links.<i>.url', code: 'invalid_url'}`; the record is saved all the same. Later changes go through the
// attachments API.

/** Stores `links` of `recordId` (public URL attachments, in order after its attachments); the warnings of those skipped. */
export async function storeRecordLinks(tx: TxCtx, recordId: string, links: readonly LinkInput[]): Promise<FieldWarning[]> {
  if (links.length === 0) return [];
  const { invalid } = await insertUrlAttachments(tx.trx, recordId, links, { access: 'public', now: tx.now, actor: tx.actor.id });
  return invalid.map((r) => ({ path: `links.${r.index}.url`, code: r.code }));
}
