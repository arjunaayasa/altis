import type { DB } from '@altis/db';
import { AGENT_TYPES, newId, normalizeKey, type AgentType } from '@altis/shared';
import { AgentBody, AgentPatchBody, type AgentListResponse, type AgentView, type AuthorityListQuery } from '@altis/shared/api/catalog/authorities';
import type { Kysely, Selectable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { agentNameKey } from '../data/keys.js';
import {
  authorityNotFound,
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
import { authorityUsage } from './usage.js';

// Names (agents: persons, organizations, meetings; Phase 2 spec §2.2, §3.5; plan Task 13): list, read, create,
// update. Archive, merge and orphans are shared by the three kinds (archive.ts, merge.ts, orphans.ts).
//
// - The key is agentNameKey(name, dates) and is unique per type: a taken one is `{path: 'name', code: 'taken'}`.
// - Creating the key of an archived agent that was not merged brings that agent back (archived_at cleared, version
//   + 1, the fields the body sends written), as Task 1's resolveAgents does for a record that names it: the unique key
//   allows no second row. The key of a merged agent is taken (it stands for its target). The revival's UPDATE also
//   requires the row still archived, unmerged and of that key (L01: on MySQL/MariaDB the read before it may predate a
//   merge, a revival or a rename); when it matches nothing the transaction runs again (TX_CONFLICT).
// - An update writes the fields its patch sends and bumps `version` (CONFLICT_STALE on a stale one); a merged agent
//   is CATALOG_MERGE_INVALID. It answers `reindex: true` when the name, the dates or the type changed: the records
//   that name the agent must be indexed again (the route queues `catalog.reindex {agentId}`, §3.5).
// - Each create and update is audited once (`catalog.authority.create` / `.update`, entity `agents`, `meta.fields`:
//   the names of the fields sent or changed, never their values).
// - Single-line texts are trimmed with their inner whitespace collapsed; '' is stored as null.

type AgentRow = Selectable<DB['agents']>;

/** What a create answers: the view, and whether an archived agent was brought back (and its records need indexing). */
export interface AuthorityCreateResult<V> {
  view: V;
  revived: boolean;
  reindex: boolean;
}

/** What an update answers: the view, and whether the records that name the authority need indexing again. */
export interface AuthorityUpdateResult<V> {
  view: V;
  reindex: boolean;
}

function toView(r: AgentRow, usage: number): AgentView {
  return {
    id: r.id,
    type: r.type as AgentType,
    name: r.name_display,
    dates: r.dates,
    authoritySource: r.authority_source,
    authorityRef: r.authority_ref,
    note: r.note,
    usage,
    mergedInto: r.merged_into,
    archived: r.archived_at !== null,
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

async function views(db: Db, rows: readonly AgentRow[]): Promise<AgentView[]> {
  const usage = await authorityUsage(
    db,
    'agents',
    rows.map((r) => r.id),
  );
  return rows.map((r) => toView(r, usage.get(r.id) ?? 0));
}

async function readRow(db: Db, id: string): Promise<AgentRow> {
  const row = await db.selectFrom('agents').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw authorityNotFound('agents');
  return row;
}

/**
 * The agent `id` in any state (archived and merged ones too).
 *
 * @throws DomainError NOT_FOUND
 */
export async function getAgent(db: Db, id: string): Promise<AgentView> {
  const [view] = await views(db, [await readRow(db, id)]);
  return view as AgentView;
}

/**
 * A page of agents in key order (`GET catalog/agents`): live ones unless `includeArchived`, `q` a substring of the key
 * (name and dates, normalizeKey; LIKE wildcards in it are literal), `type` one of the agent types.
 *
 * @throws DomainError VALIDATION_FAILED at `type` (`invalid_value`: a subject type) or `cursor` (`invalid`)
 */
export async function listAgents(db: Kysely<DB>, q: AuthorityListQuery): Promise<AgentListResponse> {
  if (q.type !== undefined && !(AGENT_TYPES as readonly string[]).includes(q.type)) {
    throw validationFailed([{ path: 'type', code: 'invalid_value' }]);
  }
  let query = db.selectFrom('agents').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  if (q.type !== undefined) query = query.where('type', '=', q.type);
  const needle = q.q === undefined ? '' : normalizeKey(q.q);
  if (needle !== '') query = query.where((eb) => keyContains(eb.ref('name_key'), needle));
  if (q.cursor !== undefined) {
    const id = cursorId(q.cursor);
    const last = await db.selectFrom('agents').select('name_key').where('id', '=', id).executeTakeFirst();
    if (last === undefined) throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
    query = query.where((eb) => eb.or([eb('name_key', '>', last.name_key), eb.and([eb('name_key', '=', last.name_key), eb('id', '>', id)])]));
  }
  const rows = await query.orderBy('name_key').orderBy('id').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: await views(db, page), nextCursor: rows.length > q.limit && last !== undefined ? keyCursor(last.id) : null };
}

/** The agent holding `(type, key)`, if any (this one included). */
async function holderOf(db: Db, type: string, key: string): Promise<AgentRow | undefined> {
  return db.selectFrom('agents').selectAll().where('type', '=', type).where('name_key', '=', key).executeTakeFirst();
}

const taken = () => validationFailed([{ path: 'name', code: 'taken' }]);

/**
 * Creates an agent, or brings back the archived one of the same key (see the top of this file).
 *
 * @throws DomainError VALIDATION_FAILED (`name` `taken`, or the contract's field errors)
 */
export async function createAgent(tx: TxCtx, body: AgentBody): Promise<AuthorityCreateResult<AgentView>> {
  const { trx } = tx;
  const b = parseOrFail(AgentBody, body);
  const name = oneLine(b.name);
  const dates = optionalLine(b.dates);
  const authoritySource = optionalLine(b.authoritySource);
  const authorityRef = optionalLine(b.authorityRef);
  const note = optionalText(b.note);
  const key = agentNameKey(name, dates);
  const fields = Object.keys(b).filter((k) => b[k as keyof AgentBody] !== undefined);

  let existing = await holderOf(trx, b.type, key);
  if (existing !== undefined) {
    await lockAuthorityRows(trx, 'agents', [existing.id]);
    existing = await readRow(trx, existing.id);
    if (existing.archived_at === null || existing.merged_into !== null) throw taken();
    const reindex = existing.name_display !== name || (dates !== undefined && dates !== existing.dates);
    // The WHERE sees the latest commit on every engine (L01): a merge, revival or rename after our read matches nothing.
    const revived = await trx
      .updateTable('agents')
      .set((eb) => ({
        name_display: name,
        ...(dates === undefined ? {} : { dates }),
        ...(authoritySource === undefined ? {} : { authority_source: authoritySource }),
        ...(authorityRef === undefined ? {} : { authority_ref: authorityRef }),
        ...(note === undefined ? {} : { note }),
        archived_at: null,
        updated_at: tx.now,
        updated_by: tx.actor.id,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', existing.id)
      .where('type', '=', b.type)
      .where('name_key', '=', key)
      .where('archived_at', 'is not', null)
      .where('merged_into', 'is', null)
      .executeTakeFirst();
    if (Number(revived.numUpdatedRows) !== 1) throw revivalConflict();
    await tx.audit({ action: 'catalog.authority.create', entity: 'agents', entityId: existing.id, meta: { fields, revived: true } });
    return { view: await getAgent(trx, existing.id), revived: true, reindex };
  }

  const id = newId(tx.now);
  try {
    await trx
      .insertInto('agents')
      .values({
        id,
        type: b.type,
        name_display: name,
        name_key: key,
        dates: dates ?? null,
        authority_source: authoritySource ?? null,
        authority_ref: authorityRef ?? null,
        note: note ?? null,
        merged_into: null,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  } catch (error) {
    // A concurrent create of the same key won; on PostgreSQL the transaction is aborted, so nothing else runs.
    if (isUniqueViolation(error)) throw taken();
    throw error;
  }
  await tx.audit({ action: 'catalog.authority.create', entity: 'agents', entityId: id, meta: { fields, revived: false } });
  return { view: toView(await readRow(trx, id), 0), revived: false, reindex: false };
}

/**
 * Changes the fields `patch` sends (see the top of this file).
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged agent; CONFLICT_STALE; VALIDATION_FAILED (`name`
 *   `taken`, or the contract's field errors)
 */
export async function updateAgent(tx: TxCtx, id: string, patch: AgentPatchBody): Promise<AuthorityUpdateResult<AgentView>> {
  const { trx } = tx;
  const p = parseOrFail(AgentPatchBody, patch);
  await lockAuthorityRows(trx, 'agents', [id]);
  const before = await readRow(trx, id);
  if (before.merged_into !== null) throw mergedAuthority();
  if (Number(before.version) !== p.version) throw authorityStale();

  const changed: string[] = [];
  const set: Partial<Pick<AgentRow, 'type' | 'name_display' | 'name_key' | 'dates' | 'authority_source' | 'authority_ref' | 'note'>> = {};
  if (p.type !== undefined && p.type !== before.type) {
    changed.push('type');
    set.type = p.type;
  }
  if (p.name !== undefined && oneLine(p.name) !== before.name_display) {
    changed.push('name');
    set.name_display = oneLine(p.name);
  }
  const dates = optionalLine(p.dates);
  if (dates !== undefined && dates !== before.dates) {
    changed.push('dates');
    set.dates = dates;
  }
  const authoritySource = optionalLine(p.authoritySource);
  if (authoritySource !== undefined && authoritySource !== before.authority_source) {
    changed.push('authoritySource');
    set.authority_source = authoritySource;
  }
  const authorityRef = optionalLine(p.authorityRef);
  if (authorityRef !== undefined && authorityRef !== before.authority_ref) {
    changed.push('authorityRef');
    set.authority_ref = authorityRef;
  }
  const note = optionalText(p.note);
  if (note !== undefined && note !== before.note) {
    changed.push('note');
    set.note = note;
  }

  const type = set.type ?? before.type;
  const key = agentNameKey(set.name_display ?? before.name_display, set.dates !== undefined ? set.dates : before.dates);
  if (key !== before.name_key || type !== before.type) {
    const holder = await holderOf(trx, type, key);
    if (holder !== undefined && holder.id !== id) throw taken();
    set.name_key = key;
  }
  try {
    const updated = await trx
      .updateTable('agents')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw authorityStale();
  } catch (error) {
    if (isUniqueViolation(error)) throw taken();
    throw error;
  }
  await tx.audit({ action: 'catalog.authority.update', entity: 'agents', entityId: id, meta: { fields: changed } });
  const reindex = changed.some((f) => f === 'type' || f === 'name' || f === 'dates');
  return { view: await getAgent(trx, id), reindex };
}
