import { fullTextFamily, normalizeDbError, type DB } from '@altis/db';
import { DomainError, isDomainError, newId } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { TxCtx } from '../../context.js';
import { agentNameKey, publisherNameKey, subjectTermKey } from './keys.js';

// Authority find-or-create (Phase 2 spec §3.5, §5.3 "Otoritas dicari dulu lewat *_key, dibuat bila belum ada"):
// records, imports, SRU copies and the SLiMS migration all name agents, subjects and publishers either by id or by
// their text, and go through here.
//
// - A text ref is looked up by its key: (type, name_key) for agents (name + dates, agentNameKey), (type, term_key)
//   for subjects, name_key for publishers. Missing → inserted (a new ULID, the actor as created_by).
// - A row merged into another (`merged_into`) resolves to its target, following the chain (a merge flattens it, P2-20,
//   so this is one hop in practice). An archived row that was not merged is brought back (archived_at cleared,
//   version + 1): an authority in use is never archived (§3.5 CATALOG_IN_USE).
// - An `{id}` ref must name an existing row: otherwise VALIDATION_FAILED `{path: '<index>', code: 'not_found'}`,
//   checked for every ref before anything is written. A text ref that does not fit its columns is VALIDATION_FAILED
//   at `<index>.<field>` (`too_small`, `too_big`, `invalid_value`).
// - Two transactions creating the same authority: the loser's INSERT fails with UNIQUE_VIOLATION and it reads the
//   winner's row (a locking read on MySQL/MariaDB, whose REPEATABLE READ snapshot predates the winner's commit). On
//   PostgreSQL the failed INSERT has aborted the transaction, so the error is rethrown at once (the caller's
//   transaction fails and is retried by whoever owns it); SQLite serializes writers, so it never races.
// - No audit entry (decision P2-10): the record's audit counts the authorities it created (`meta.authoritiesCreated`),
//   imports and migrations are audited per run.

export const CATALOG_AGENT_TYPES = Object.freeze(['person', 'organization', 'meeting'] as const);
export const CATALOG_SUBJECT_TYPES = Object.freeze(['topic', 'geographic', 'name', 'temporal', 'genre', 'occupation'] as const);

/** `agents.type`. */
export type CatalogAgentType = (typeof CATALOG_AGENT_TYPES)[number];
/** `subjects.type`. */
export type CatalogSubjectType = (typeof CATALOG_SUBJECT_TYPES)[number];

/** An agent by id, or by its name (and dates) under a type. */
export type AgentRef =
  | { id: string }
  | {
      type: CatalogAgentType;
      name: string;
      dates?: string | null;
      authoritySource?: string | null;
      authorityRef?: string | null;
    };

/** A subject by id, or by its term under a type. */
export type SubjectRef =
  | { id: string }
  | { type: CatalogSubjectType; term: string; classification?: string | null; authoritySource?: string | null };

/** A publisher by id, or by its name. */
export type PublisherRef = { id: string } | { name: string; place?: string | null };

type AuthorityTable = 'agents' | 'subjects' | 'publishers';

/** What every authority table holds for the resolution (the three share these columns). */
interface Found {
  id: string;
  merged_into: string | null;
  archived_at: number | null;
}

/** A merge chain longer than this is taken for a loop (a merge flattens chains, P2-20; a loop is refused there). */
const MAX_MERGE_HOPS = 16;

/** Up to this many ids per `IN (…)` list. */
const ID_BATCH = 500;

/** Trimmed, inner whitespace collapsed; '' becomes null. */
const optionalText = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string().max(max))
    .nullish()
    .transform((s) => (s === undefined || s === null || s === '' ? null : s));

const requiredText = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));

const agentText = z.object({
  type: z.enum(CATALOG_AGENT_TYPES),
  name: requiredText(191),
  dates: optionalText(64),
  authoritySource: optionalText(64),
  authorityRef: optionalText(191),
});

const subjectText = z.object({
  type: z.enum(CATALOG_SUBJECT_TYPES),
  term: requiredText(191),
  classification: optionalText(64),
  authoritySource: optionalText(64),
});

const publisherText = z.object({ name: requiredText(191), place: optionalText(191) });

interface FieldError {
  path: string;
  code: string;
}

function validationFailed(errors: FieldError[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Rujukan otoritas tidak valid / An authority reference is not valid',
    meta: { errors },
  });
}

/** True for an `{id}` ref (a ref with an `id` property, whatever else it has). */
function isIdRef(ref: unknown): ref is { id: string } {
  return typeof ref === 'object' && ref !== null && 'id' in ref;
}

/**
 * Each ref parsed with `schema` (an `{id}` ref kept as it is), or every field error at `<index>.<field>`
 * (`<index>` for a ref that is no object or whose id is no string).
 */
function parseRefs<S extends z.ZodType>(refs: readonly unknown[], schema: S): { parsed: (z.output<S> | { id: string })[]; errors: FieldError[] } {
  const parsed: (z.output<S> | { id: string })[] = [];
  const errors: FieldError[] = [];
  refs.forEach((ref, i) => {
    if (isIdRef(ref)) {
      if (typeof ref.id !== 'string' || ref.id === '') errors.push({ path: String(i), code: 'invalid_type' });
      parsed.push({ id: String(ref.id) });
      return;
    }
    const r = schema.safeParse(ref);
    if (r.success) {
      parsed.push(r.data);
      return;
    }
    for (const issue of r.error.issues) errors.push({ path: [String(i), ...issue.path.map(String)].join('.'), code: issueCode(issue) });
    parsed.push({ id: '' });
  });
  return { parsed, errors };
}

/** The rows of `table` with the given ids. */
async function rowsById(trx: Transaction<DB>, table: AuthorityTable, ids: readonly string[]): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    // The three tables share these columns; Kysely cannot narrow a union of table names.
    const rows = await trx
      .selectFrom(table as 'agents')
      .select(['id', 'merged_into', 'archived_at'])
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) found.set(r.id, r);
  }
  return found;
}

/** The ids of `refs` that name no row of `table`, as `{path: '<index>', code: 'not_found'}`. */
async function unknownIds(trx: Transaction<DB>, table: AuthorityTable, refs: readonly unknown[]): Promise<FieldError[]> {
  const ids = refs.filter(isIdRef).map((r) => r.id);
  if (ids.length === 0) return [];
  const known = await rowsById(trx, table, ids);
  const errors: FieldError[] = [];
  refs.forEach((ref, i) => {
    if (isIdRef(ref) && !known.has(ref.id)) errors.push({ path: String(i), code: 'not_found' });
  });
  return errors;
}

/**
 * The live id `row` stands for: its merge target (followed to the end of the chain), brought back when it is archived
 * without having been merged.
 */
async function settle(tx: TxCtx, table: AuthorityTable, row: Found): Promise<string> {
  let current = row;
  const seen = new Set<string>([current.id]);
  while (current.merged_into !== null) {
    const next = (await rowsById(tx.trx, table, [current.merged_into])).get(current.merged_into);
    if (next === undefined || seen.has(next.id) || seen.size > MAX_MERGE_HOPS) {
      throw new Error(`${table} ${row.id}: its merge chain is broken or loops (merged_into ${current.merged_into})`);
    }
    seen.add(next.id);
    current = next;
  }
  if (current.archived_at !== null) {
    await tx.trx
      .updateTable(table as 'agents')
      .set((eb) => ({ archived_at: null, version: eb('version', '+', 1), updated_at: tx.now, updated_by: tx.actor.id }))
      .where('id', '=', current.id)
      .execute();
  }
  return current.id;
}

/**
 * Finds the row `find()` reads, or inserts `insert` (then it is created). A concurrent insert of the same key
 * (UNIQUE_VIOLATION) is read back with a locking read, except on PostgreSQL (see the top of this file).
 */
async function findOrCreate(
  tx: TxCtx,
  table: AuthorityTable,
  find: (locking: boolean) => Promise<Found | undefined>,
  insert: () => Promise<void>,
): Promise<{ id: string; created: boolean }> {
  const existing = await find(false);
  if (existing !== undefined) return { id: await settle(tx, table, existing), created: false };
  const family = fullTextFamily(tx.trx);
  try {
    await insert();
  } catch (error) {
    const normalized = normalizeDbError(error);
    if (!isDomainError(normalized) || normalized.code !== 'UNIQUE_VIOLATION' || family === 'pg') throw error;
    const winner = await find(family === 'innodb');
    if (winner === undefined) throw error;
    return { id: await settle(tx, table, winner), created: false };
  }
  return { id: '', created: true };
}

/**
 * The ids of `refs`, in order, each found by id or by key and created when missing (see the top of this file), and
 * how many were created.
 *
 * @throws DomainError VALIDATION_FAILED (`meta.errors`, nothing written): `<index>` `not_found` for an unknown id;
 *   `<index>.type` `invalid_value`, `<index>.name` `too_small`/`too_big`, `<index>.dates` (64),
 *   `<index>.authoritySource` (64) or `<index>.authorityRef` (191) `too_big`
 */
export async function resolveAgents(tx: TxCtx, refs: readonly AgentRef[]): Promise<{ ids: string[]; created: number }> {
  const { parsed, errors } = parseRefs(refs, agentText);
  if (errors.length === 0) errors.push(...(await unknownIds(tx.trx, 'agents', refs)));
  if (errors.length > 0) throw validationFailed(errors);
  const ids: string[] = [];
  let created = 0;
  for (const ref of parsed) {
    if ('id' in ref) {
      const row = (await rowsById(tx.trx, 'agents', [ref.id])).get(ref.id) as Found;
      ids.push(await settle(tx, 'agents', row));
      continue;
    }
    const key = agentNameKey(ref.name, ref.dates);
    const id = newId(tx.now);
    const find = (locking: boolean) => {
      const q = tx.trx.selectFrom('agents').select(['id', 'merged_into', 'archived_at']).where('type', '=', ref.type).where('name_key', '=', key);
      return (locking ? q.forUpdate() : q).executeTakeFirst();
    };
    const outcome = await findOrCreate(tx, 'agents', find, async () => {
      await tx.trx
        .insertInto('agents')
        .values({
          id,
          type: ref.type,
          name_display: ref.name,
          name_key: key,
          dates: ref.dates,
          authority_source: ref.authoritySource,
          authority_ref: ref.authorityRef,
          note: null,
          merged_into: null,
          archived_at: null,
          created_at: tx.now,
          created_by: tx.actor.id,
          updated_at: tx.now,
          updated_by: tx.actor.id,
        })
        .execute();
    });
    ids.push(outcome.created ? id : outcome.id);
    if (outcome.created) created += 1;
  }
  return { ids, created };
}

/**
 * The ids of `refs`, in order, as {@link resolveAgents} does for subjects (key: type and term).
 *
 * @throws DomainError VALIDATION_FAILED (`meta.errors`, nothing written): `<index>` `not_found`; `<index>.type`,
 *   `<index>.term` (1–191), `<index>.classification` (64), `<index>.authoritySource` (64)
 */
export async function resolveSubjects(tx: TxCtx, refs: readonly SubjectRef[]): Promise<{ ids: string[]; created: number }> {
  const { parsed, errors } = parseRefs(refs, subjectText);
  if (errors.length === 0) errors.push(...(await unknownIds(tx.trx, 'subjects', refs)));
  if (errors.length > 0) throw validationFailed(errors);
  const ids: string[] = [];
  let created = 0;
  for (const ref of parsed) {
    if ('id' in ref) {
      const row = (await rowsById(tx.trx, 'subjects', [ref.id])).get(ref.id) as Found;
      ids.push(await settle(tx, 'subjects', row));
      continue;
    }
    const key = subjectTermKey(ref.term);
    const id = newId(tx.now);
    const find = (locking: boolean) => {
      const q = tx.trx.selectFrom('subjects').select(['id', 'merged_into', 'archived_at']).where('type', '=', ref.type).where('term_key', '=', key);
      return (locking ? q.forUpdate() : q).executeTakeFirst();
    };
    const outcome = await findOrCreate(tx, 'subjects', find, async () => {
      await tx.trx
        .insertInto('subjects')
        .values({
          id,
          type: ref.type,
          term_display: ref.term,
          term_key: key,
          classification: ref.classification,
          scope_note: null,
          authority_source: ref.authoritySource,
          merged_into: null,
          archived_at: null,
          created_at: tx.now,
          created_by: tx.actor.id,
          updated_at: tx.now,
          updated_by: tx.actor.id,
        })
        .execute();
    });
    ids.push(outcome.created ? id : outcome.id);
    if (outcome.created) created += 1;
  }
  return { ids, created };
}

/**
 * The id of the publisher `ref` names (found by id or by name key, created when missing), or null for no publisher.
 *
 * @throws DomainError VALIDATION_FAILED (`meta.errors`, nothing written): `0` `not_found`; `0.name` (1–191),
 *   `0.place` (191)
 */
export async function resolvePublisher(tx: TxCtx, ref: PublisherRef | null): Promise<{ id: string | null; created: boolean }> {
  if (ref === null) return { id: null, created: false };
  const { parsed, errors } = parseRefs([ref], publisherText);
  if (errors.length === 0) errors.push(...(await unknownIds(tx.trx, 'publishers', [ref])));
  if (errors.length > 0) throw validationFailed(errors);
  const one = parsed[0] as z.output<typeof publisherText> | { id: string };
  if ('id' in one) {
    const row = (await rowsById(tx.trx, 'publishers', [one.id])).get(one.id) as Found;
    return { id: await settle(tx, 'publishers', row), created: false };
  }
  const key = publisherNameKey(one.name);
  const id = newId(tx.now);
  const find = (locking: boolean) => {
    const q = tx.trx.selectFrom('publishers').select(['id', 'merged_into', 'archived_at']).where('name_key', '=', key);
    return (locking ? q.forUpdate() : q).executeTakeFirst();
  };
  const outcome = await findOrCreate(tx, 'publishers', find, async () => {
    await tx.trx
      .insertInto('publishers')
      .values({
        id,
        name_display: one.name,
        name_key: key,
        place: one.place,
        merged_into: null,
        archived_at: null,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  });
  return outcome.created ? { id, created: true } : { id: outcome.id, created: false };
}
