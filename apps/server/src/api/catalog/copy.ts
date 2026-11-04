import {
  copyDuplicateHint,
  copyMaterialTypeResolver,
  hit,
  lookupIsbn,
  parseIsbn,
  readSettings,
  sruIsbnSource,
  sruSearchDrafts,
  sruTestServer,
  type IsbnSource,
} from '@altis/core';
import { DomainError } from '@altis/shared';
import { SruSearchQuery, SruTestBody, type IsbnLookupResponse, type SruSearchResponse, type SruTestResponse } from '@altis/shared/api/catalog/copy';
import type { SruServer } from '@altis/shared/api/settings';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { validationFailed } from '../../http/validate.js';

// The catalog API routes of copy cataloguing (Phase 2 spec §6.2-§6.4, §12.2, §12.3; plan Task 32, route catalog; K7,
// M11, M13): the ISBN lookup, the SRU search and the SRU server test. None of them stores anything: a picked draft is
// saved by `POST catalog/records` with `source` set (Task 16).
//
// - `GET catalog/lookup/isbn/:isbn` (`catalog.records.manage`): an ISBN-10 or ISBN-13, with or without hyphens; one
//   that does not parse, or whose check digit is wrong, is VALIDATION_FAILED `{path: 'isbn', code: 'invalid'}` (before
//   anything is counted). Then one hit on the per-user bucket `catalog_lookup` (30 a minute, committed in a transaction
//   of its own: a 429 keeps its count), and core lookupIsbn: the live record holding the ISBN, else the candidates of
//   every enabled SRU server, at most 3 at a time within 10 s each and 12 s in all, each scored against the catalog (`catalog.dedupe.threshold`). A source's failure
//   is an entry of `errors`, never the route's.
// - `GET catalog/sru/search?server=&index=&q=&start=` (`catalog.records.manage`): one page of 20 drafts from a
//   configured, enabled server (else VALIDATION_FAILED at `server`: `not_found` / `disabled`), each with its duplicate
//   hint. Its failures are the route's problems: 422 CATALOG_OUTBOUND_BLOCKED, 502 CATALOG_OUTBOUND_FAILED and 502
//   CATALOG_SRU_INVALID: for a server's diagnostic, its message cut to 200 characters is the problem's `detail` (the
//   one 5xx that shows the detail it carries, http/problem.ts), which the SRU dialog shows; an answer that is not SRU
//   has none.
// - `POST catalog/sru/test {url, version}` (`system.settings.manage`, a read-only POST, `tx: 'self'`): always 200
//   `SruTestResponse` (decision P2-17); it counts on the same per-user bucket (M11), so the settings screen's "Uji"
//   cannot be used as a fast scanner of internal addresses. A URL the settings could not hold (credentials, a
//   fragment) is VALIDATION_FAILED `{path: 'url', code: 'invalid_url'}`, before anything is counted.
//
// Every outbound call goes through the guarded client (SSRF guard on every resolved address unless
// `catalog.sru.allowPrivateHosts`, limits) and runs with no transaction open: the GET routes read through `rc.db`, and
// the only transactions are the rate limiter's own. Nothing is kept between requests; each reads the settings it needs.

const COPY = '/api/v1/catalog';

/** An ISBN path parameter longer than this is no ISBN (13 digits with hyphens or spaces between all of them is 25). */
const ISBN_PARAM_MAX = 32;

/** `GET catalog/lookup/isbn/:isbn`: a valid ISBN-10 or ISBN-13 (its check digit right), else `invalid`. */
const IsbnParams = z.strictObject({
  isbn: z.string().check((ctx) => {
    if (ctx.value.length > ISBN_PARAM_MAX || parseIsbn(ctx.value)?.valid !== true) {
      ctx.issues.push({ code: 'custom', params: { code: 'invalid' }, message: 'invalid', input: ctx.value });
    }
  }),
});

/**
 * Whether `url` (already an http(s) URL with a host, SruTestBody) is one `catalog.sru.servers` can hold: no user name or
 * password and no fragment. The test refuses what the settings would refuse, so "Uji" never passes a URL that cannot
 * be saved (the outbound client would drop credentials silently).
 */
function savableSruUrl(url: string): boolean {
  if (url.includes('#')) return false;
  try {
    const u = new URL(url);
    return u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/**
 * One hit on the caller's `catalog_lookup` bucket, committed in a transaction of its own (a refusal keeps its count).
 *
 * @throws DomainError `AUTH_TOO_MANY_ATTEMPTS` (429, `meta.retryAfterS`) past 30 a minute
 */
async function countLookup<B, Q, P>(rc: RouteContext<B, Q, P>): Promise<void> {
  if (rc.auth === null) throw new TypeError('countLookup: a copy-cataloguing route always runs in a session');
  const subject = rc.auth.subjectId;
  const counted = await rc.withTx((tx) => hit(tx.trx, 'catalog_lookup', subject, rc.now));
  if (!counted.allowed) {
    throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
      detail: 'Terlalu banyak pencarian; coba lagi sebentar lagi / Too many lookups; try again shortly',
      meta: { retryAfterS: counted.retryAfterS },
    });
  }
}

const lookupIsbnRoute = route({
  id: 'catalog.lookup.isbn',
  method: 'GET',
  path: `${COPY}/lookup/isbn/:isbn`,
  permission: 'catalog.records.manage',
  idempotency: 'none',
  audit: null,
  params: IsbnParams,
  handler: async (rc) => {
    await countLookup(rc);
    const db = rc.db.db;
    const settings = await readSettings(
      db,
      ['catalog.sru.servers', 'catalog.sru.allowPrivateHosts', 'catalog.dedupe.threshold'],
      rc.config.keyring,
    );
    const servers = (settings['catalog.sru.servers'] as SruServer[]).filter((s) => s.enabled && s.url !== '');
    const sources: IsbnSource[] = [];
    if (servers.length > 0) {
      const allowPrivate = settings['catalog.sru.allowPrivateHosts'] === true;
      const materialTypeCodeFor = await copyMaterialTypeResolver(db);
      for (const server of servers) sources.push(sruIsbnSource(server, { allowPrivate, materialTypeCodeFor }));
    }
    const body: IsbnLookupResponse = await lookupIsbn(db, rc.params.isbn, {
      sources,
      threshold: settings['catalog.dedupe.threshold'] as number,
      log: rc.log,
    });
    return { body };
  },
});

const sruSearchRoute = route({
  id: 'catalog.sru.search',
  method: 'GET',
  path: `${COPY}/sru/search`,
  permission: 'catalog.records.manage',
  idempotency: 'none',
  audit: null,
  query: SruSearchQuery,
  handler: async (rc) => {
    const db = rc.db.db;
    const settings = await readSettings(db, ['catalog.sru.servers', 'catalog.sru.allowPrivateHosts', 'catalog.dedupe.threshold'], rc.config.keyring);
    const server = (settings['catalog.sru.servers'] as SruServer[]).find((s) => s.id === rc.query.server);
    if (server === undefined) throw validationFailed([{ path: 'server', code: 'not_found' }]);
    if (!server.enabled || server.url === '') throw validationFailed([{ path: 'server', code: 'disabled' }]);
    const start = rc.query.start ?? 1;
    const page = await sruSearchDrafts(server, rc.query.index, rc.query.q, {
      start,
      allowPrivate: settings['catalog.sru.allowPrivateHosts'] === true,
      materialTypeCodeFor: await copyMaterialTypeResolver(db),
    });
    const threshold = settings['catalog.dedupe.threshold'] as number;
    const records: SruSearchResponse['records'] = [];
    for (const draft of page.drafts) records.push({ draft, duplicate: await copyDuplicateHint(db, draft, threshold) });
    const body: SruSearchResponse = { total: page.total, start, records };
    return { body };
  },
});

const sruTestRoute = route({
  id: 'catalog.sru.test',
  method: 'POST',
  path: `${COPY}/sru/test`,
  permission: 'system.settings.manage',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: SruTestBody,
  handler: async (rc) => {
    if (!savableSruUrl(rc.body.url)) throw validationFailed([{ path: 'url', code: 'invalid_url' }]);
    await countLookup(rc);
    const settings = await readSettings(rc.db.db, ['catalog.sru.allowPrivateHosts'], rc.config.keyring);
    const body: SruTestResponse = await sruTestServer(rc.body, { allowPrivate: settings['catalog.sru.allowPrivateHosts'] === true });
    return { body };
  },
});

export const COPY_ROUTES: RouteDecl[] = [lookupIsbnRoute, sruSearchRoute, sruTestRoute];
