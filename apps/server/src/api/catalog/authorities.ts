import {
  archiveAuthority,
  archiveOrphans,
  createAgent,
  createJobRegistry,
  createPublisher,
  createSubject,
  enqueueReindex,
  getAgent,
  getPublisher,
  getSubject,
  listAgents,
  listOrphans,
  listPublishers,
  listSubjects,
  mergeAuthority,
  setSubjectRelations,
  updateAgent,
  updatePublisher,
  updateSubject,
  type AuthorityCreateResult,
  type AuthorityUpdateResult,
  type JobRegistry,
  type ReindexScope,
  type TxCtx,
} from '@altis/core';
import type { DbHandle } from '@altis/db';
import {
  AgentBody,
  AgentPatchBody,
  AuthorityListQuery,
  MergeIntoBody,
  OrphansArchiveBody,
  OrphansQuery,
  PublisherBody,
  PublisherPatchBody,
  SubjectBody,
  SubjectPatchBody,
  SubjectRelationsBody,
  type AuthorityKind,
  type OrphansArchiveResponse,
  type OrphansResponse,
} from '@altis/shared/api/catalog/authorities';
import type { Paged, StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField, versionField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The catalog API routes of agents, subjects and publishers (literal paths, one per kind, M3), orphans (Phase 2 spec
// §3.5, §12.2; plan Task 13, route catalog): 21 routes.
//
// - Each kind has its own literal paths (`catalog/agents`, `catalog/subjects`, `catalog/publishers`, each with `/:id`
//   and `/:id/merge`), never a `catalog/:kind` parameter, which would shadow `catalog/records`, `items`, `config` and
//   `locations` (Hono serves the first match, and these routes come before the records').
// - Reads need `catalog.records.read`, writes `catalog.authorities.manage`; authorities are global (no branch).
// - The writes are `store` routes and answer `StoreResponse` (`{id, version}`, S15); a create answers 201, or 200 when
//   it brought back an archived authority of the same key (as Task 1's resolve* does for a record that names it).
//   Archive takes the row's `version` in its body (`{version}`), as the records' archive does. The orphan archive
//   answers `{archived, skipped}`.
// - The services audit in the handler's transaction (one entry each, `catalog.authority.*`, entity = the kind).
// - Reindex (§3.5): an update that changed what the index holds of it (the name, term, dates or type; a subject's
//   classification, a publisher's place, C08) queues `catalog.reindex` for the authority
//   (`{agentId|subjectId|publisherId: id}`, unique key `catalog.reindex:<kind>:<id>`); a merge queues it for the
//   target (`intoId`), since the merge moved every link there and the source has none (S12). Queued in the handler's
//   transaction, and the worker is woken after the commit. A reindex of the same authority that has not started is
//   joined; one that has started is superseded by a new one, which reads every link after this commit (C04/C24).

const API = '/api/v1/catalog';
const IdParams = z.strictObject({ id: ulidField });
/** The body of archive: the row's version. */
const VersionBody = z.strictObject({ version: versionField });

let fallbackRegistry: JobRegistry | null = null;

/** The handlers of this release: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const runtime = rc.services.jobs;
  if (runtime !== null) return runtime.registry;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** The reindex scope of the authority `id` of `kind`. */
function scopeOf(kind: AuthorityKind, id: string): ReindexScope {
  if (kind === 'agents') return { agentId: id };
  if (kind === 'subjects') return { subjectId: id };
  return { publisherId: id };
}

/** Queues the reindex of `scope` in the handler's transaction and wakes the worker after its commit. */
async function queueReindex(rc: RouteContext<unknown, unknown, unknown>, tx: TxCtx, scope: ReindexScope): Promise<void> {
  await enqueueReindex(tx.trx, registryOf(rc), scope, { now: tx.now, keyring: rc.config.keyring, createdBy: tx.actor.id });
  rc.afterCommit(() => rc.services.jobs?.kick());
}

/** What a kind's routes are built from: its contracts and services. */
interface KindServices<C, U, V extends { id: string; version: number }> {
  createBody: z.ZodType<C>;
  patchBody: z.ZodType<U>;
  list(db: DbHandle['db'], q: AuthorityListQuery): Promise<Paged<V>>;
  get(db: DbHandle['db'], id: string): Promise<V>;
  create(tx: TxCtx, body: C): Promise<AuthorityCreateResult<V>>;
  update(tx: TxCtx, id: string, patch: U): Promise<AuthorityUpdateResult<V>>;
}

/** The list, get, create, update, archive and merge routes of `kind`, on its literal paths. */
function kindRoutes<C, U, V extends { id: string; version: number }>(kind: AuthorityKind, s: KindServices<C, U, V>): RouteDecl[] {
  const base = `${API}/${kind}`;
  return [
    route({
      id: `catalog.${kind}.list`,
      method: 'GET',
      path: base,
      permission: 'catalog.records.read',
      idempotency: 'none',
      audit: null,
      query: AuthorityListQuery,
      handler: async (rc) => ({ body: await s.list(rc.db.db, rc.query) }),
    }),
    route({
      id: `catalog.${kind}.get`,
      method: 'GET',
      path: `${base}/:id`,
      permission: 'catalog.records.read',
      idempotency: 'none',
      audit: null,
      params: IdParams,
      handler: async (rc) => ({ body: await s.get(rc.db.db, rc.params.id) }),
    }),
    route({
      id: `catalog.${kind}.create`,
      method: 'POST',
      path: base,
      permission: 'catalog.authorities.manage',
      idempotency: 'store',
      audit: 'catalog.authority.create',
      body: s.createBody,
      handler: async (rc) => {
        const tx = rc.tx();
        const r = await s.create(tx, rc.body);
        if (r.reindex) await queueReindex(rc, tx, scopeOf(kind, r.view.id));
        const body: StoreResponse = { id: r.view.id, version: r.view.version };
        return { status: r.revived ? 200 : 201, body };
      },
    }),
    route({
      id: `catalog.${kind}.update`,
      method: 'PATCH',
      path: `${base}/:id`,
      permission: 'catalog.authorities.manage',
      idempotency: 'store',
      audit: 'catalog.authority.update',
      params: IdParams,
      body: s.patchBody,
      handler: async (rc) => {
        const tx = rc.tx();
        const r = await s.update(tx, rc.params.id, rc.body);
        if (r.reindex) await queueReindex(rc, tx, scopeOf(kind, rc.params.id));
        const body: StoreResponse = { id: r.view.id, version: r.view.version };
        return { body };
      },
    }),
    route({
      id: `catalog.${kind}.archive`,
      method: 'DELETE',
      path: `${base}/:id`,
      permission: 'catalog.authorities.manage',
      idempotency: 'store',
      audit: 'catalog.authority.archive',
      params: IdParams,
      body: VersionBody,
      handler: async (rc) => {
        const { version } = await archiveAuthority(rc.tx(), kind, rc.params.id, rc.body.version);
        const body: StoreResponse = { id: rc.params.id, version };
        return { body };
      },
    }),
    /** Merges this authority (`:id`, whose `version` the body carries) into `intoId`. */
    route({
      id: `catalog.${kind}.merge`,
      method: 'POST',
      path: `${base}/:id/merge`,
      permission: 'catalog.authorities.manage',
      idempotency: 'store',
      audit: 'catalog.authority.merge',
      params: IdParams,
      body: MergeIntoBody,
      handler: async (rc) => {
        const tx = rc.tx();
        const { version } = await mergeAuthority(tx, kind, rc.params.id, rc.body.intoId, rc.body.version);
        await queueReindex(rc, tx, scopeOf(kind, rc.body.intoId));
        const body: StoreResponse = { id: rc.params.id, version };
        return { body };
      },
    }),
  ];
}

const subjectsRelations = route({
  id: 'catalog.subjects.relations',
  method: 'PUT',
  path: `${API}/subjects/:id/relations`,
  permission: 'catalog.authorities.manage',
  idempotency: 'store',
  audit: 'catalog.authority.update',
  params: IdParams,
  body: SubjectRelationsBody,
  handler: async (rc) => {
    const view = await setSubjectRelations(rc.tx(), rc.params.id, rc.body.relations, rc.body.version);
    const body: StoreResponse = { id: view.id, version: view.version };
    return { body };
  },
});

const orphansList = route({
  id: 'catalog.orphans.list',
  method: 'GET',
  path: `${API}/orphans`,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  query: OrphansQuery,
  handler: async (rc) => {
    const body: OrphansResponse = await listOrphans(rc.db.db, rc.query.kind, rc.query.cursor, rc.query.limit);
    return { body };
  },
});

const orphansArchive = route({
  id: 'catalog.orphans.archive',
  method: 'POST',
  path: `${API}/orphans/archive`,
  permission: 'catalog.authorities.manage',
  idempotency: 'store',
  audit: 'catalog.authority.archive',
  body: OrphansArchiveBody,
  handler: async (rc) => {
    const body: OrphansArchiveResponse = await archiveOrphans(rc.tx(), rc.body.kind, rc.body.ids);
    return { body };
  },
});

export const AUTHORITIES_ROUTES: RouteDecl[] = [
  ...kindRoutes('agents', { createBody: AgentBody, patchBody: AgentPatchBody, list: listAgents, get: getAgent, create: createAgent, update: updateAgent }),
  ...kindRoutes('subjects', {
    createBody: SubjectBody,
    patchBody: SubjectPatchBody,
    list: listSubjects,
    get: getSubject,
    create: createSubject,
    update: updateSubject,
  }),
  subjectsRelations,
  ...kindRoutes('publishers', {
    createBody: PublisherBody,
    patchBody: PublisherPatchBody,
    list: listPublishers,
    get: getPublisher,
    create: createPublisher,
    update: updatePublisher,
  }),
  orphansList,
  orphansArchive,
];
