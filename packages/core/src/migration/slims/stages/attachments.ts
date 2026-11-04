import { withTx, type DB } from '@altis/db';
import { newId } from '@altis/shared';
import type { Transaction } from 'kysely';
import { ATTACHMENT_URL_MAX, insertUrlAttachments } from '../../../catalog/data/attachments.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { detectType } from '../../../files/magic.js';
import { indexRecords, stampChanged } from '../../../search/index-records.js';
import { readSettings } from '../../../settings/service.js';
import { phpUnserialize } from '../source/php-unserialize.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  EMPTY_SHA256,
  Ledger,
  cachedForRun,
  cutChars,
  fitText,
  keyFits,
  keyOf,
  mappedRows,
  nextPhase,
  oneLine,
  quietText,
  readCursor,
  readSourceFile,
  scanAll,
  sourceCursor,
  sourceKeys,
  stageBBatch,
  stateOf,
  storeBlob,
  tableOf,
  targetsOf,
  textOf,
  writeCursor,
  type SourceFile,
  type StageCursor,
  endOfStage,
} from './stage-b-kit.js';

// Attachments and their files (Phase 2 spec §11.3 step 6, §11.4 rows `biblio_attachment` + `files`, `files_read`; §8;
// D2-30; preflight S4, S10, S13; plan Task 38). Three phases:
//
// 1. `files`, file by file (each link of a file in one transaction of its own): a SLiMS file is linked to records by
//    `biblio_attachment` rows; each link becomes an attachment of its record (entity `biblio_attachment`, key
//    `<biblio_id>|<file_id>`; the file's own map row, entity `files`, names its first attachment).
//    - `file_url` → a URL attachment through `insertUrlAttachments` (S4: http/https, ≤ 2000 characters; anything else
//      → `invalid_url`, the file and its links skipped).
//    - Otherwise the bytes of `repository/<file_dir>/<file_name>` from the files source, opened with
//      `catalog.attachment.maxMb` as its limit (S10), stored through the storage driver after `ensureHeadroom`, as a
//      `files` row of context `catalog.attachment` owned by its attachment, typed by its magic bytes. A file the
//      source lacks (or will not serve: an unsafe path) or that passes the limit → a `files` row `status 'missing'` of
//      size 0 (`missing_file`, `file_too_large`), which an admin can replace later. A file linked to two records is
//      stored once per attachment (a `files` row has one owner).
//    - Access: `private` → `staff`; `public` with a non-empty `access_limit` (SLiMS member types) → `staff`, the list
//      kept in `legacy_access_limit` (Phase 3). `files.access` follows the attachment's.
//    - `file_key` (a PDF password) is not migrated (`file_key_not_migrated`, D2-30); a file no link names is skipped
//      (`unlinked_file`), a link whose record is missing too (`record_missing`).
// 2. `biblio_attachment` rows whose `files` row is missing (`orphan_file`; the others were counted with their file).
// 3. `files_read` → `attachments.read_count`, summed per file (counted `merged`, entity `files_read`); the member and
//    IP columns are never read into anything (privacy).
//
// A dry run reads the same rows and reports alike, checks the files only by their declared size (it opens nothing), and
// writes nothing.

const TF = 'files';
const TA = 'biblio_attachment';
const TR = 'files_read';
const MIB = 1024 * 1024;
/** `attachments.title`, `files.original_name`. */
const NAME_MAX = 191;

/** One `biblio_attachment` row, as the stage needs it. */
interface Link {
  biblioKey: string;
  fileKey: string;
  accessType: string;
  accessLimit: string;
}

/** The links of every file, by file key, in source order (cached for the run). */
function linksByFile(c: SlimsStageContext): Promise<ReadonlyMap<string, readonly Link[]>> {
  return cachedForRun(c, 'attachments:links', async () => {
    const links = new Map<string, Link[]>();
    await scanAll(c, TA, (row) => {
      const link: Link = {
        biblioKey: keyOf(row['biblio_id']),
        fileKey: keyOf(row['file_id']),
        accessType: keyOf(row['access_type']).toLowerCase(),
        accessLimit: quietText(row['access_limit']).trim(),
      };
      if (link.fileKey === '') return;
      const list = links.get(link.fileKey) ?? [];
      list.push(link);
      links.set(link.fileKey, list);
    });
    return links;
  });
}

/** The keys of the `files` rows phase 1 handles (cached for the run). */
function fileKeys(c: SlimsStageContext): Promise<ReadonlySet<string>> {
  return cachedForRun(c, 'attachments:files', async () => {
    const keys = new Set<string>();
    await scanAll(c, TF, (row) => {
      const k = keyOf(row['file_id']);
      if (keyFits(k)) keys.add(k);
    });
    return keys;
  });
}

/** The `href` of `raw` when it is an http/https URL of at most 2000 characters (S4, as insertUrlAttachments keeps it). */
export function attachableUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > ATTACHMENT_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href.length <= ATTACHMENT_URL_MAX ? url.href : null;
}

/** Access per §11.4: `staff` for `private` or a non-empty member-type list, which is kept (JSON) for Phase 3. */
function accessOf(l: Ledger, link: Link): { access: 'public' | 'staff'; legacy: string | null } {
  let legacy: string | null = null;
  if (link.accessLimit !== '') {
    const parsed = phpUnserialize(link.accessLimit);
    const values = parsed.ok
      ? (Array.isArray(parsed.value) ? parsed.value : typeof parsed.value === 'object' && parsed.value !== null ? Object.values(parsed.value) : [parsed.value])
          .filter((v) => typeof v === 'string' || typeof v === 'number')
          .map(String)
      : parsed.strings;
    if (!parsed.ok) {
      l.fixed(`${TA}.access_limit`, ['php'], link.accessLimit, JSON.stringify(values));
      l.report(TA, `${link.biblioKey}|${link.fileKey}`, 'php_broken', `access_limit: ${values.length} teks terbaca / strings recovered`);
    }
    const kept = values.map((v) => oneLine(v)).filter((v) => v !== '');
    if (kept.length > 0) legacy = JSON.stringify(kept);
  }
  return { access: link.accessType === 'private' || legacy !== null ? 'staff' : 'public', legacy };
}

/** The records of the links' biblio keys: through the legacy map (a real run), or the source's `biblio` (a dry run). */
async function recordsOf(c: SlimsStageContext, keys: readonly string[]): Promise<(k: string) => string | null> {
  if (!c.dryRun) {
    const targets = await targetsOf(c, c.h.db, 'biblio', keys);
    return (k) => targets.get(k) ?? null;
  }
  const present = await sourceKeys(c, 'biblio', 'biblio_id');
  return (k) => (present.has(k) ? `~${k}` : null);
}

/** The next free `sort_order` of `recordId`'s attachments. */
async function nextSortOrder(trx: Transaction<DB>, recordId: string): Promise<number> {
  const top = (await trx.selectFrom('attachments').select((eb) => eb.fn.max('sort_order').as('top')).where('record_id', '=', recordId).executeTakeFirst())?.top;
  return top === null || top === undefined ? 0 : Number(top) + 1;
}

/**
 * What ends every attachment written: the record's index (§4.1), then its `changed_at` (§2.1) from the clock read
 * right before the COMMIT (C14: a harvest that ran while the transaction was open still selects it next time).
 */
async function touchRecord(c: SlimsStageContext, trx: Transaction<DB>, recordId: string): Promise<void> {
  await indexRecords(trx, [recordId], c.now);
  await stampChanged(trx, [recordId], c.clock());
}

// ---- phase 1: one file ----------------------------------------------------------------------------------------------

/** The text columns of `files` whose repairs are counted (§11.5). */
const TEXT_COLUMNS = ['file_title', 'file_name', 'file_url', 'file_dir', 'file_desc'] as const;

/** The file of a SLiMS `files` row in the repository: `repository/<file_dir>/<file_name>` ('' without a name). */
function repositoryPath(dir: string, name: string): string {
  if (name === '') return '';
  const folder = dir.replace(/^\/+|\/+$/g, '');
  return folder === '' ? `repository/${name}` : `repository/${folder}/${name}`;
}

async function fileUnit(c: SlimsStageContext, row: SlimsRow, l: Ledger, maxBytes: number): Promise<void> {
  const key = keyOf(row['file_id']);
  if (!keyFits(key)) {
    l.skipped(TF, 'empty_key');
    l.report(TF, null, 'empty_key', 'file_id kosong / empty');
    return;
  }
  const links = (await linksByFile(c)).get(key) ?? [];
  // The texts (their repairs are counted below, once the file turns out to be one this run handles).
  const title = oneLine(quietText(row['file_title']));
  const name = oneLine(quietText(row['file_name']));
  const url = oneLine(quietText(row['file_url']));
  const dir = oneLine(quietText(row['file_dir']));
  const desc = quietText(row['file_desc']).trim();
  const passworded = keyOf(row['file_key']) !== '';
  if (links.length === 0) {
    l.skipped(TF, 'unlinked');
    l.report(TF, key, 'unlinked_file', cutChars(title || name || url, 80));
    return;
  }
  const isUrl = url !== '';
  const href = isUrl ? attachableUrl(url) : null;
  if (isUrl && href === null) {
    l.skipped(TF, 'invalid_url');
    for (const link of links) {
      l.skipped(TA, 'invalid_url');
      l.report(TA, `${link.biblioKey}|${key}`, 'invalid_url', cutChars(url, 120));
    }
    return;
  }
  const linkKeys = links.map((link) => `${link.biblioKey}|${key}`);
  const mappedLinks = await mappedRows(c, c.h.db, TA, linkKeys);
  const fileMap = (await mappedRows(c, c.h.db, TF, [key])).get(key);
  const record = await recordsOf(c, links.map((link) => link.biblioKey));
  const attachmentTitle = cutChars(title || name || href || `Lampiran ${key}`, NAME_MAX);
  const fresh = links.some((link, i) => stateOf(c, mappedLinks.get(linkKeys[i]!)) === 'fresh' && keyFits(link.biblioKey) && record(link.biblioKey) !== null);
  const replays = links.some((_, i) => stateOf(c, mappedLinks.get(linkKeys[i]!)) === 'replay');
  if (fresh || replays) for (const column of TEXT_COLUMNS) textOf(l, TF, column, row[column]);
  const description = fresh || replays ? fitText(l, TF, key, 'file_desc', desc) : null;

  // The bytes, read once for every link that needs them (again when this run wrote its links already, so that its
  // report rows come out the same); a dry run checks the declared size only.
  const rel = isUrl ? '' : repositoryPath(dir, name);
  let blob: SourceFile | null = null;
  if (!isUrl && (fresh || replays)) {
    blob = await readSourceFile(c, rel, maxBytes, { declaredOnly: c.dryRun });
    if (blob.kind === 'missing') l.report(TF, key, 'missing_file', cutChars(rel === '' ? `repository/${dir}` : rel, 200));
    if (blob.kind === 'too_large') l.report(TF, key, 'file_too_large', `${cutChars(rel, 200)} > ${maxBytes / MIB} MB`);
  }
  if (!isUrl && passworded && (fresh || replays)) l.report(TF, key, 'file_key_not_migrated', cutChars(name, 120));

  let made = false;
  let firstAttachment = fileMap?.targetId ?? null;
  const seen = new Set<string>();
  for (const [i, link] of links.entries()) {
    const linkKey = linkKeys[i]!;
    if (!keyFits(link.biblioKey) || !keyFits(linkKey)) {
      l.skipped(TA, 'empty_key');
      l.report(TA, null, 'empty_key', 'biblio_id kosong / empty');
      continue;
    }
    if (seen.has(linkKey)) {
      l.skipped(TA, 'duplicate_key');
      l.report(TA, linkKey, 'duplicate_key', 'biblio_id|file_id ganda / repeated');
      continue;
    }
    seen.add(linkKey);
    const state = stateOf(c, mappedLinks.get(linkKey));
    if (state === 'done') {
      l.skipped(TA, 'already_migrated');
      continue;
    }
    const recordId = record(link.biblioKey);
    if (recordId === null) {
      l.skipped(TA, 'orphan_record');
      l.report(TA, linkKey, 'record_missing', `biblio_id=${cutChars(link.biblioKey, 40)}`);
      continue;
    }
    const { access, legacy } = accessOf(l, link);
    made = true;
    l.migrated(TA);
    if (c.dryRun || state === 'replay') continue;
    const id = isUrl
      ? await urlAttachment(c, recordId, href!, attachmentTitle, description, access, legacy, linkKey, key, firstAttachment === null)
      : await fileAttachment(c, recordId, blob!, rel, name, attachmentTitle, description, access, legacy, linkKey, key, firstAttachment === null);
    firstAttachment ??= id;
  }
  if (fileMap !== undefined && fileMap.runId !== c.runId) l.skipped(TF, 'already_migrated');
  else if (made) l.migrated(TF);
  else if (links.every((_, i) => stateOf(c, mappedLinks.get(linkKeys[i]!)) === 'done')) l.skipped(TF, 'already_migrated');
  else l.skipped(TF, 'orphan_record');
}

/** A URL attachment of `recordId` (S4: through insertUrlAttachments), in its own transaction; its id. */
async function urlAttachment(
  c: SlimsStageContext,
  recordId: string,
  href: string,
  title: string,
  description: string | null,
  access: 'public' | 'staff',
  legacy: string | null,
  linkKey: string,
  fileKey: string,
  first: boolean,
): Promise<string> {
  return withTx(c.h, async (trx) => {
    const r = await insertUrlAttachments(trx, recordId, [{ url: href, title }], { access, now: c.now, actor: null });
    if (r.inserted !== 1) throw new TypeError('SLiMS stage attachments: a URL checked as valid was refused');
    const made = await trx
      .selectFrom('attachments')
      .select('id')
      .where('record_id', '=', recordId)
      .where('kind', '=', 'url')
      .where('created_at', '=', c.now)
      .orderBy('sort_order', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    if (description !== null || legacy !== null) {
      await trx.updateTable('attachments').set({ description, legacy_access_limit: legacy }).where('id', '=', made.id).execute();
    }
    await mapLegacy(trx, mapsOf(c, made.id, linkKey, fileKey, first));
    await touchRecord(c, trx, recordId);
    return made.id;
  });
}

/** The map rows of a new attachment: its link, and its file when it is the file's first attachment. */
function mapsOf(c: SlimsStageContext, attachmentId: string, linkKey: string, fileKey: string, first: boolean): LegacyMapping[] {
  const maps: LegacyMapping[] = [{ source: c.options.sourceName, entity: TA, legacyKey: linkKey, targetId: attachmentId, runId: c.runId }];
  if (first) maps.push({ source: c.options.sourceName, entity: TF, legacyKey: fileKey, targetId: attachmentId, runId: c.runId });
  return maps;
}

/**
 * A file attachment of `recordId`: the bytes stored first (outside any transaction), then the `files` row, the
 * attachment and the map rows in one transaction; a missing or too large file gets a `files` row `missing`. Its id.
 */
async function fileAttachment(
  c: SlimsStageContext,
  recordId: string,
  blob: SourceFile,
  rel: string,
  name: string,
  title: string,
  description: string | null,
  access: 'public' | 'staff',
  legacy: string | null,
  linkKey: string,
  fileKey: string,
  first: boolean,
): Promise<string> {
  const fileId = newId(c.now);
  const attachmentId = newId(c.now);
  let row = { size: 0, sha256: EMPTY_SHA256, mime: 'application/octet-stream', status: 'missing' };
  if (blob.kind === 'ok') {
    const files = c.files!;
    const stream = await files.open(rel, { maxBytes: blob.size });
    if (stream === null) throw new TypeError('SLiMS stage attachments: a file read a moment ago is gone');
    await storeBlob(c, fileId, stream, { size: blob.size, sha256: blob.sha256 });
    row = { size: blob.size, sha256: blob.sha256, mime: detectType(blob.head).mime, status: 'ok' };
  }
  try {
    await withTx(c.h, async (trx) => {
      await trx
        .insertInto('files')
        .values({
          id: fileId,
          original_name: cutChars(name === '' ? 'lampiran' : name, NAME_MAX),
          mime: row.mime,
          size: row.size,
          sha256: row.sha256,
          context: 'catalog.attachment',
          owner_type: 'attachments',
          owner_id: attachmentId,
          access,
          status: row.status,
          created_at: c.now,
          created_by: null,
        })
        .execute();
      await trx
        .insertInto('attachments')
        .values({
          id: attachmentId,
          record_id: recordId,
          kind: 'file',
          file_id: fileId,
          url: null,
          title,
          description,
          access,
          legacy_access_limit: legacy,
          read_count: 0,
          sort_order: await nextSortOrder(trx, recordId),
          archived_at: null,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        })
        .execute();
      await mapLegacy(trx, mapsOf(c, attachmentId, linkKey, fileKey, first));
      await touchRecord(c, trx, recordId);
    });
  } catch (error) {
    // The stored bytes have no row: removed (best effort) before the error goes on.
    if (row.status === 'ok') await c.storage.delete(fileId).catch(() => undefined);
    throw error;
  }
  return attachmentId;
}

// ---- phase 2: links to no file ---------------------------------------------------------------------------------------

async function orphanLinks(c: SlimsStageContext, rows: readonly SlimsRow[], l: Ledger): Promise<void> {
  const files = await fileKeys(c);
  for (const row of rows) {
    const fileKey = keyOf(row['file_id']);
    if (files.has(fileKey)) continue; // counted with its file
    const biblioKey = keyOf(row['biblio_id']);
    if (fileKey === '' || biblioKey === '') {
      l.skipped(TA, 'empty_key');
      l.report(TA, null, 'empty_key', 'biblio_id|file_id kosong / empty');
      continue;
    }
    l.skipped(TA, 'orphan_file');
    l.report(TA, cutChars(`${biblioKey}|${fileKey}`, 191), 'orphan_file', `file_id=${cutChars(fileKey, 40)}`);
  }
}

// ---- phase 3: read counts --------------------------------------------------------------------------------------------

/** The files a dry run would make an attachment of (a valid URL or a stored file, with a link to a record; cached). */
function attachableFiles(c: SlimsStageContext): Promise<ReadonlySet<string>> {
  return cachedForRun(c, 'attachments:attachable', async () => {
    const links = await linksByFile(c);
    const biblio = await sourceKeys(c, 'biblio', 'biblio_id');
    const out = new Set<string>();
    await scanAll(c, TF, (row) => {
      const key = keyOf(row['file_id']);
      const url = oneLine(quietText(row['file_url']));
      if (!keyFits(key) || (url !== '' && attachableUrl(url) === null)) return;
      if ((links.get(key) ?? []).some((link) => biblio.has(link.biblioKey))) out.add(key);
    });
    return out;
  });
}

async function readBatch(c: SlimsStageContext, rows: readonly SlimsRow[], at: StageCursor, l: Ledger): Promise<void> {
  const keyColumns = (await tableOf(c, TR))?.primaryKey ?? [];
  const keyed: { key: string; fileKey: string }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const key = keyColumns.length === 0 ? `#${at.n + i + 1}` : keyColumns.map((k) => keyOf(row[k])).join('|');
    if (!keyFits(key) || keyColumns.some((k) => keyOf(row[k]) === '')) {
      l.skipped(TR, 'empty_key');
      return;
    }
    if (seen.has(key)) {
      l.skipped(TR, 'duplicate_key');
      return;
    }
    seen.add(key);
    keyed.push({ key, fileKey: keyOf(row['file_id']) });
  });
  const mapped = await mappedRows(c, c.h.db, TR, keyed.map((k) => k.key));
  const fresh: { key: string; fileKey: string }[] = [];
  for (const k of keyed) {
    const state = stateOf(c, mapped.get(k.key));
    if (state === 'done') l.skipped(TR, 'already_migrated');
    else if (state === 'replay') l.merged(TR);
    else fresh.push(k);
  }
  if (fresh.length === 0) return;
  if (c.dryRun) {
    const attachable = await attachableFiles(c);
    for (const k of fresh) {
      if (attachable.has(k.fileKey)) l.merged(TR);
      else l.skipped(TR, 'no_attachment');
    }
    return;
  }
  await withTx(c.h, async (trx) => {
    const targets = await targetsOf(c, trx, TF, fresh.map((k) => k.fileKey).filter(keyFits));
    const sums = new Map<string, number>();
    const maps: LegacyMapping[] = [];
    let merged = 0;
    for (const k of fresh) {
      const attachment = targets.get(k.fileKey);
      if (attachment === undefined) continue;
      sums.set(attachment, (sums.get(attachment) ?? 0) + 1);
      maps.push({ source: c.options.sourceName, entity: TR, legacyKey: k.key, targetId: attachment, runId: c.runId });
      merged += 1;
    }
    for (const [attachment, n] of sums) {
      await trx
        .updateTable('attachments')
        .set((eb) => ({ read_count: eb('read_count', '+', n) }))
        .where('id', '=', attachment)
        .execute();
    }
    await mapLegacy(trx, maps);
    return merged;
  }).then((merged) => {
    l.merged(TR, merged);
    l.skipped(TR, 'no_attachment', fresh.length - merged);
  });
}

// ---- the stage ------------------------------------------------------------------------------------------------------

/** The phases: the files (with their links), the links to no file, the read counts. */
const PHASES = [TF, TA, TR] as const;

/** Attachments (§11.3 step 6, §11.4): see the top of this file. */
export const attachmentsStage: SlimsStage = Object.freeze({
  name: 'attachments' as const,
  reads: Object.freeze([TA, TF, TR]) as readonly string[],
  async run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
    let at = readCursor('attachments', cursor);
    let units = 0;
    const maxMb = (await readSettings(c.h.db, ['catalog.attachment.maxMb'], []))['catalog.attachment.maxMb'] as number;
    const maxBytes = maxMb * MIB;
    while (at.p < PHASES.length) {
      if (units > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
      const table = PHASES[at.p]!;
      if ((await tableOf(c, table)) === null) {
        at = nextPhase(at);
        continue;
      }
      const batch = await c.source.rows(table, at.c, stageBBatch());
      const next = sourceCursor('attachments', batch.rows.length === 0 ? null : batch.next);
      if (table === TF) {
        // One file per unit: the cursor keeps how many of the batch are done.
        let i = at.i;
        for (; i < batch.rows.length; i += 1) {
          if (units > 0 && c.budgetLeftMs() <= 0) break;
          const l = Ledger.of(at);
          await fileUnit(c, batch.rows[i]!, l, maxBytes);
          l.apply(c);
          units += 1;
          at = { ...at, i: i + 1, ...l.state() };
        }
        if (i < batch.rows.length) return { done: false, cursor: writeCursor(at) };
      } else {
        const l = Ledger.of(at);
        if (table === TA) await orphanLinks(c, batch.rows, l);
        else await readBatch(c, batch.rows, at, l);
        l.apply(c);
        units += 1;
        at = { ...at, ...l.state() };
      }
      at = next === null ? nextPhase(at) : { ...at, c: next, i: 0, n: at.n + batch.rows.length };
    }
    return endOfStage(c, 'attachments', at);
  },
});
