import {
  archiveCollectionType,
  archiveCustomField,
  archiveLanguage,
  archiveMaterialType,
  archiveSupplier,
  createCollectionType,
  createCustomField,
  createJobRegistry,
  createLanguage,
  createMaterialType,
  createSupplier,
  listCollectionTypes,
  listCustomFields,
  listLanguages,
  listMaterialTypes,
  listSuppliers,
  updateCollectionType,
  updateCustomField,
  updateLanguage,
  updateMaterialType,
  updateSupplier,
  type CustomFieldWriteOptions,
  type JobRegistry,
  type TxCtx,
} from '@altis/core';
import type { DbHandle } from '@altis/db';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import {
  CollectionTypeBody,
  CollectionTypePatchBody,
  CustomFieldBody,
  CustomFieldPatchBody,
  LanguageBody,
  LanguagePatchBody,
  MasterListQuery,
  MaterialTypeBody,
  MaterialTypePatchBody,
  SupplierBody,
  SupplierPatchBody,
  type MasterListResponse,
} from '@altis/shared/api/catalog/masters';
import { ulidField, versionField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The catalog API routes of the masters (Phase 2 spec §2.2, §2.6, §3.7, §3.8, §12.2; plan Task 12, route catalog):
// material types (with their templates), languages, collection types, suppliers and custom fields, each with the same
// four routes: `GET catalog/<master>`, `POST catalog/<master>`, `PATCH catalog/<master>/:id`, `DELETE
// catalog/<master>/:id` (archive). 5 × 4 = 20 routes.
//
// - Lists need `catalog.records.read` (the record editor reads them too), writes `catalog.masters.manage`; masters
//   are global (no branch).
// - The writes are `store` routes and answer `StoreResponse` (`{id, version}`), never the view (S15); a create
//   answers 201. Archive takes the row's `version` in its body (`{version}`), as every optimistic write does.
// - The services audit once in the handler's transaction (`catalog.master.create|update|archive`, `entity` = the
//   table). A master that live records or items use is refused with 409 CATALOG_IN_USE (Review Focus 2).
// - A custom field change that alters the search index queues `catalog.reindex` in the same transaction; the worker is
//   woken after the commit.

const CATALOG = '/api/v1/catalog';
const MasterParams = z.strictObject({ id: ulidField });
/** The body of an archive: the master's version. */
const VersionBody = z.strictObject({ version: versionField });

let fallbackRegistry: JobRegistry | null = null;

/** The job handlers of this release: the runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const runtime = rc.services.jobs;
  if (runtime !== null) return runtime.registry;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** Where a custom field write queues the reindex its change needs. */
function reindexQueue(rc: RouteContext<unknown, unknown, unknown>): CustomFieldWriteOptions {
  return { reindex: { registry: registryOf(rc), keyring: rc.config.keyring } };
}

/** One master's services, as its four routes call them. */
interface MasterService<C, P, V> {
  list(db: DbHandle['db'], q: MasterListQuery): Promise<V[]>;
  create(tx: TxCtx, body: C): Promise<{ id: string; version: number }>;
  update(tx: TxCtx, id: string, patch: P, rc: RouteContext<unknown, unknown, unknown>): Promise<{ id: string; version: number }>;
  archive(tx: TxCtx, id: string, version: number, rc: RouteContext<unknown, unknown, unknown>): Promise<{ version: number }>;
}

/**
 * The four routes of one master: `catalog.<key>.{list,create,update,archive}` under `catalog/<path>`, with its strict
 * create and patch bodies.
 */
function masterRoutes<C, P, V>(key: string, path: string, bodies: { create: z.ZodType<C>; patch: z.ZodType<P> }, svc: MasterService<C, P, V>): RouteDecl[] {
  const base = `${CATALOG}/${path}`;
  const list = route({
    id: `catalog.${key}.list`,
    method: 'GET',
    path: base,
    permission: 'catalog.records.read',
    idempotency: 'none',
    audit: null,
    query: MasterListQuery,
    handler: async (rc) => {
      const body: MasterListResponse<V> = { items: await svc.list(rc.db.db, rc.query) };
      return { body };
    },
  });
  const create = route({
    id: `catalog.${key}.create`,
    method: 'POST',
    path: base,
    permission: 'catalog.masters.manage',
    idempotency: 'store',
    audit: 'catalog.master.create',
    body: bodies.create,
    handler: async (rc) => {
      const { id, version } = await svc.create(rc.tx(), rc.body);
      const body: StoreResponse = { id, version };
      return { status: 201, body };
    },
  });
  const update = route({
    id: `catalog.${key}.update`,
    method: 'PATCH',
    path: `${base}/:id`,
    permission: 'catalog.masters.manage',
    idempotency: 'store',
    audit: 'catalog.master.update',
    params: MasterParams,
    body: bodies.patch,
    handler: async (rc) => {
      const { id, version } = await svc.update(rc.tx(), rc.params.id, rc.body, rc as RouteContext<unknown, unknown, unknown>);
      const body: StoreResponse = { id, version };
      return { body };
    },
  });
  const archive = route({
    id: `catalog.${key}.archive`,
    method: 'DELETE',
    path: `${base}/:id`,
    permission: 'catalog.masters.manage',
    idempotency: 'store',
    audit: 'catalog.master.archive',
    params: MasterParams,
    body: VersionBody,
    handler: async (rc) => {
      const { version } = await svc.archive(rc.tx(), rc.params.id, rc.body.version, rc as RouteContext<unknown, unknown, unknown>);
      const body: StoreResponse = { id: rc.params.id, version };
      return { body };
    },
  });
  return [list, create, update, archive];
}

const materialTypes = masterRoutes('material_types', 'material-types', { create: MaterialTypeBody, patch: MaterialTypePatchBody }, {
  list: listMaterialTypes,
  create: createMaterialType,
  update: (tx, id, patch) => updateMaterialType(tx, id, patch),
  archive: (tx, id, version) => archiveMaterialType(tx, id, version),
});

const languages = masterRoutes('languages', 'languages', { create: LanguageBody, patch: LanguagePatchBody }, {
  list: listLanguages,
  create: createLanguage,
  update: (tx, id, patch) => updateLanguage(tx, id, patch),
  archive: (tx, id, version) => archiveLanguage(tx, id, version),
});

const collectionTypes = masterRoutes('collection_types', 'collection-types', { create: CollectionTypeBody, patch: CollectionTypePatchBody }, {
  list: listCollectionTypes,
  create: createCollectionType,
  update: (tx, id, patch) => updateCollectionType(tx, id, patch),
  archive: (tx, id, version) => archiveCollectionType(tx, id, version),
});

const suppliers = masterRoutes('suppliers', 'suppliers', { create: SupplierBody, patch: SupplierPatchBody }, {
  list: listSuppliers,
  create: createSupplier,
  update: (tx, id, patch) => updateSupplier(tx, id, patch),
  archive: (tx, id, version) => archiveSupplier(tx, id, version),
});

const customFields = masterRoutes('custom_fields', 'custom-fields', { create: CustomFieldBody, patch: CustomFieldPatchBody }, {
  list: listCustomFields,
  create: createCustomField,
  update: async (tx, id, patch, rc) => {
    const view = await updateCustomField(tx, id, patch, reindexQueue(rc));
    rc.afterCommit(() => rc.services.jobs?.kick());
    return view;
  },
  archive: async (tx, id, version, rc) => {
    const result = await archiveCustomField(tx, id, version, reindexQueue(rc));
    rc.afterCommit(() => rc.services.jobs?.kick());
    return result;
  },
});

export const MASTERS_ROUTES: RouteDecl[] = [...materialTypes, ...languages, ...collectionTypes, ...suppliers, ...customFields];
