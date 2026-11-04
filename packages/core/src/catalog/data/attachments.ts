import type { DB } from '@altis/db';
import { newId } from '@altis/shared';
import type { Transaction } from 'kysely';

// URL attachments from untrusted sources (Phase 2 preflight S4): a link that came from a MARC 856, a CSV, an SRU
// answer, the editor's copy of a draft or a SLiMS migration becomes an attachment only through here. Only `http:` and
// `https:` URLs of at most 2000 characters that `new URL()` parses are kept (as `new URL().href`); anything else
// (`javascript:`, `data:`, `ftp:`, a relative or broken URL, an over-long one) is reported as `invalid_url` and skipped.
// Every renderer still re-checks the scheme before writing an `href`, an 856 or a feed link.
//
// It does not index the record (indexRecords is a Task 3 seam): every caller already indexes it in the same
// transaction (createRecord, the import batch, the migration stage).

/** A URL attachment keeps at most this many characters. */
export const ATTACHMENT_URL_MAX = 2000;
/** `attachments.title` holds at most this many characters. */
const TITLE_MAX = 191;
/** Up to this many rows per INSERT (16 parameters each). */
const INSERT_BATCH = 500;

/** The `href` of `raw` (trimmed) when it is an http/https URL of at most 2000 characters; null otherwise. */
function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > ATTACHMENT_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const href = url.href;
  return href.length <= ATTACHMENT_URL_MAX ? href : null;
}

/** `s` cut to {@link TITLE_MAX} code points, without a trailing blank. */
function fitTitle(s: string): string {
  const points = Array.from(s);
  return points.length <= TITLE_MAX ? s : points.slice(0, TITLE_MAX).join('').trimEnd();
}

/**
 * Adds the valid `links` of `recordId` as attachments of kind `url` (access `o.access`), after the record's existing
 * attachments in `sort_order`, and moves the record's `changed_at` to `o.now` when at least one was added. A link
 * without a title (or with a blank one) is titled by its URL; a title is trimmed and cut to 191 characters.
 *
 * @returns how many were added, and the index of each link refused (`invalid_url`)
 */
export async function insertUrlAttachments(
  trx: Transaction<DB>,
  recordId: string,
  links: readonly { url: string; title?: string | null }[],
  o: { access: 'public' | 'staff'; now: number; actor: string | null },
): Promise<{ inserted: number; invalid: { index: number; code: 'invalid_url' }[] }> {
  if (o.access !== 'public' && o.access !== 'staff') throw new TypeError(`insertUrlAttachments(): unknown access ${JSON.stringify(o.access)}`);
  const invalid: { index: number; code: 'invalid_url' }[] = [];
  const valid: { url: string; title: string }[] = [];
  links.forEach((link, index) => {
    const href = safeHref(link?.url);
    if (href === null) {
      invalid.push({ index, code: 'invalid_url' });
      return;
    }
    const title = typeof link.title === 'string' ? link.title.trim().replace(/\s+/g, ' ') : '';
    valid.push({ url: href, title: fitTitle(title === '' ? href : title) });
  });
  if (valid.length === 0) return { inserted: 0, invalid };

  const last = await trx
    .selectFrom('attachments')
    .select((eb) => eb.fn.max('sort_order').as('top'))
    .where('record_id', '=', recordId)
    .executeTakeFirst();
  const top = last?.top;
  let sortOrder = top === null || top === undefined ? 0 : Number(top) + 1;
  // In batches: a MARC record or a SLiMS row can carry many links, and every engine caps the parameters of a statement.
  for (let i = 0; i < valid.length; i += INSERT_BATCH) {
    await trx
      .insertInto('attachments')
      .values(
        valid.slice(i, i + INSERT_BATCH).map((v) => ({
          id: newId(o.now),
          record_id: recordId,
          kind: 'url',
          file_id: null,
          url: v.url,
          title: v.title,
          description: null,
          access: o.access,
          legacy_access_limit: null,
          read_count: 0,
          sort_order: sortOrder++,
          archived_at: null,
          created_at: o.now,
          created_by: o.actor,
          updated_at: o.now,
          updated_by: o.actor,
        })),
      )
      .execute();
  }
  await trx.updateTable('records').set({ changed_at: o.now }).where('id', '=', recordId).execute();
  return { inserted: valid.length, invalid };
}
