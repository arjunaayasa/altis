import type { DB } from '@altis/db';
import { SUBJECT_TYPES, newId, normalizeKey } from '@altis/shared';
import {
  SubjectBody,
  SubjectPatchBody,
  type AuthorityListQuery,
  type SubjectListResponse,
  type SubjectView,
} from '@altis/shared/api/catalog/authorities';
import type { Kysely, Selectable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { subjectTermKey } from '../data/keys.js';
import type { AuthorityCreateResult, AuthorityUpdateResult } from './agents.js';
import {
  authorityStale,
  cursorId,
  isUniqueViolation,
  keyContains,
  keyCursor,
  lockAuthorityRows,
  revivalConflict,
  mergedAuthority,
  oneLine,
  optionalLine,
  optionalText,
  parseOrFail,
  validationFailed,
  type Db,
} from './common.js';
import { getSubject, readSubjectRow, subjectViews } from './thesaurus.js';

// Subjects (Phase 2 spec §2.2, §3.5; plan Task 13): list, read, create, update, as agents.ts does for names. The key
// is subjectTermKey(term), unique per type; a taken one is `{path: 'term', code: 'taken'}`. A change of the term, the
// type or the classification answers `reindex: true` (the route queues `catalog.reindex {subjectId}`): the linked
// records' documents hold the subject's term and classification (search/doc.ts `t_subjects`, C08). The thesaurus is
// thesaurus.ts.

type SubjectRow = Selectable<DB['subjects']>;

/**
 * A page of subjects in key order (`GET catalog/subjects`), as listAgents; each with its relations and cycles.
 *
 * @throws DomainError VALIDATION_FAILED at `type` (`invalid_value`: an agent type) or `cursor` (`invalid`)
 */
export async function listSubjects(db: Kysely<DB>, q: AuthorityListQuery): Promise<SubjectListResponse> {
  if (q.type !== undefined && !(SUBJECT_TYPES as readonly string[]).includes(q.type)) {
    throw validationFailed([{ path: 'type', code: 'invalid_value' }]);
  }
  let query = db.selectFrom('subjects').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  if (q.type !== undefined) query = query.where('type', '=', q.type);
  const needle = q.q === undefined ? '' : normalizeKey(q.q);
  if (needle !== '') query = query.where((eb) => keyContains(eb.ref('term_key'), needle));
  if (q.cursor !== undefined) {
    const id = cursorId(q.cursor);
    const last = await db.selectFrom('subjects').select('term_key').where('id', '=', id).executeTakeFirst();
    if (last === undefined) throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
    query = query.where((eb) => eb.or([eb('term_key', '>', last.term_key), eb.and([eb('term_key', '=', last.term_key), eb('id', '>', id)])]));
  }
  const rows = await query.orderBy('term_key').orderBy('id').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: await subjectViews(db, page), nextCursor: rows.length > q.limit && last !== undefined ? keyCursor(last.id) : null };
}

async function holderOf(db: Db, type: string, key: string): Promise<SubjectRow | undefined> {
  return db.selectFrom('subjects').selectAll().where('type', '=', type).where('term_key', '=', key).executeTakeFirst();
}

const taken = () => validationFailed([{ path: 'term', code: 'taken' }]);

/**
 * Creates a subject, or brings back the archived (unmerged) one of the same key, as createAgent does.
 *
 * @throws DomainError VALIDATION_FAILED (`term` `taken`, or the contract's field errors)
 */
export async function createSubject(tx: TxCtx, body: SubjectBody): Promise<AuthorityCreateResult<SubjectView>> {
  const { trx } = tx;
  const b = parseOrFail(SubjectBody, body);
  const term = oneLine(b.term);
  const classification = optionalLine(b.classification);
  const scopeNote = optionalText(b.scopeNote);
  const authoritySource = optionalLine(b.authoritySource);
  const key = subjectTermKey(term);
  const fields = Object.keys(b).filter((k) => b[k as keyof SubjectBody] !== undefined);

  let existing = await holderOf(trx, b.type, key);
  if (existing !== undefined) {
    await lockAuthorityRows(trx, 'subjects', [existing.id]);
    existing = await readSubjectRow(trx, existing.id);
    if (existing.archived_at === null || existing.merged_into !== null) throw taken();
    const reindex = existing.term_display !== term;
    // The WHERE sees the latest commit on every engine (L01): a merge, revival or rename after our read matches nothing.
    const revived = await trx
      .updateTable('subjects')
      .set((eb) => ({
        term_display: term,
        ...(classification === undefined ? {} : { classification }),
        ...(scopeNote === undefined ? {} : { scope_note: scopeNote }),
        ...(authoritySource === undefined ? {} : { authority_source: authoritySource }),
        archived_at: null,
        updated_at: tx.now,
        updated_by: tx.actor.id,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', existing.id)
      .where('type', '=', b.type)
      .where('term_key', '=', key)
      .where('archived_at', 'is not', null)
      .where('merged_into', 'is', null)
      .executeTakeFirst();
    if (Number(revived.numUpdatedRows) !== 1) throw revivalConflict();
    await tx.audit({ action: 'catalog.authority.create', entity: 'subjects', entityId: existing.id, meta: { fields, revived: true } });
    return { view: await getSubject(trx, existing.id), revived: true, reindex };
  }

  const id = newId(tx.now);
  try {
    await trx
      .insertInto('subjects')
      .values({
        id,
        type: b.type,
        term_display: term,
        term_key: key,
        classification: classification ?? null,
        scope_note: scopeNote ?? null,
        authority_source: authoritySource ?? null,
        merged_into: null,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) throw taken();
    throw error;
  }
  await tx.audit({ action: 'catalog.authority.create', entity: 'subjects', entityId: id, meta: { fields, revived: false } });
  return { view: await getSubject(trx, id), revived: false, reindex: false };
}

/**
 * Changes the fields `patch` sends, as updateAgent does (the relations have their own route, setSubjectRelations).
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged subject; CONFLICT_STALE; VALIDATION_FAILED
 */
export async function updateSubject(tx: TxCtx, id: string, patch: SubjectPatchBody): Promise<AuthorityUpdateResult<SubjectView>> {
  const { trx } = tx;
  const p = parseOrFail(SubjectPatchBody, patch);
  await lockAuthorityRows(trx, 'subjects', [id]);
  const before = await readSubjectRow(trx, id);
  if (before.merged_into !== null) throw mergedAuthority();
  if (Number(before.version) !== p.version) throw authorityStale();

  const changed: string[] = [];
  const set: Partial<Pick<SubjectRow, 'type' | 'term_display' | 'term_key' | 'classification' | 'scope_note' | 'authority_source'>> = {};
  if (p.type !== undefined && p.type !== before.type) {
    changed.push('type');
    set.type = p.type;
  }
  if (p.term !== undefined && oneLine(p.term) !== before.term_display) {
    changed.push('term');
    set.term_display = oneLine(p.term);
  }
  const classification = optionalLine(p.classification);
  if (classification !== undefined && classification !== before.classification) {
    changed.push('classification');
    set.classification = classification;
  }
  const scopeNote = optionalText(p.scopeNote);
  if (scopeNote !== undefined && scopeNote !== before.scope_note) {
    changed.push('scopeNote');
    set.scope_note = scopeNote;
  }
  const authoritySource = optionalLine(p.authoritySource);
  if (authoritySource !== undefined && authoritySource !== before.authority_source) {
    changed.push('authoritySource');
    set.authority_source = authoritySource;
  }

  const type = set.type ?? before.type;
  const key = subjectTermKey(set.term_display ?? before.term_display);
  if (key !== before.term_key || type !== before.type) {
    const holder = await holderOf(trx, type, key);
    if (holder !== undefined && holder.id !== id) throw taken();
    set.term_key = key;
  }
  try {
    const updated = await trx
      .updateTable('subjects')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw authorityStale();
  } catch (error) {
    if (isUniqueViolation(error)) throw taken();
    throw error;
  }
  await tx.audit({ action: 'catalog.authority.update', entity: 'subjects', entityId: id, meta: { fields: changed } });
  return { view: await getSubject(trx, id), reindex: changed.some((f) => f === 'term' || f === 'type' || f === 'classification') };
}
