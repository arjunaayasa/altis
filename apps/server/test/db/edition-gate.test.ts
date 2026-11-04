import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMMUNITY_EDITION, createUpdateSource, type Mailer } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { BranchListResponse, BranchView } from '@altis/shared/api/branches';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { writeConfig } from '../../src/config.js';
import { communityEditionGate, routeMode, type EditionGate } from '../../src/http/edition-gate.js';
import type { RouteContext, RouteDecl } from '../../src/http/route.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createServices } from '../../src/services.js';
import type { AgentReply } from '../agent.js';
import {
  MATRIX_FIXTURES,
  expected,
  outcomeOf,
  personaSession,
  restoreUsers,
  seedPersona,
  sendCall,
  snapshotUsers,
  type MatrixCall,
  type PersonaUser,
  type SeedContext,
  type UserSnapshot,
} from '../matrix-fixtures.js';
import { removeOp } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { devPackageKeys } from '../update-support.js';

// The edition gate (step 10 of the route chain, http/edition-gate.ts; rulings R1, R2) on the engine picked by
// ALTIS_TEST_DB:
// - the community edition: an app built without an `editionGate` has communityEditionGate and the community
//   EditionService; a super admin's write and read both go through, nothing reads or writes `license_state`, and the
//   routes the community edition dropped (the licence API, the branch active set) answer 404;
// - the seam: an app given a gate that refuses every `write` route (routeMode) has every write route refused at step
//   10, after the permission gate passed and before its `prepare` or handler ran (spies on both, no audit entry),
//   while every `read` and `system` route gets the gate outcome expected() gives a super admin.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR (the backup, the download and the restore ask for headroom).
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();

/** 5 s into a minute, in the past (an audit entry may not be dated ahead of the real clock). */
const NOW = Date.UTC(2026, 9, 26, 9, 15, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
/** The detail of the fake gate's refusal: what tells it apart from any other AUTHZ_DENIED. */
const GATE_DETAIL = 'refused by the test edition gate';

const codeOf = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const detailOf = (res: AgentReply): string | undefined => (res.json as { detail?: string } | undefined)?.detail;

/** Mail goes nowhere. */
const silentMailer: Mailer = { send: async () => {} };

describe('communityEditionGate and the services default (rulings R1, R2)', () => {
  it('the community gate lets every route through; routeMode is the declared mode, else GET read and any other write', async () => {
    for (const decl of ALL_ROUTES) await expect(communityEditionGate({} as RouteContext, decl)).resolves.toBeUndefined();
    const byId = new Map(ALL_ROUTES.map((d) => [d.id, d]));
    expect(['branches.list', 'branches.create', 'users.roles.put', 'catalog.exports.create'].map((id) => routeMode(byId.get(id)!))).toEqual([
      'read',
      'write',
      'system',
      'system',
    ]);
  });

  it('an app without a DATA_DIR still has the community edition and its gate', async () => {
    const services = createServices({ phase: 'ready' }, { state: { phase: 'ready' }, version: '0.1.0', buildId: 't', log: recordingLogger() });
    expect(services.editionGate).toBe(communityEditionGate);
    expect(await services.edition.check()).toBe(COMMUNITY_EDITION);
    expect((await services.edition.check()).notEntitled('2999-12-31')).toBeNull();
  });

  it('no route of the community edition is a licence or active-set route', () => {
    expect(ALL_ROUTES.filter((d) => /^(?:license\.|install\.license|branches\.active_set$)/.test(d.id)).map((d) => d.id)).toEqual([]);
    expect(ALL_ROUTES.filter((d) => /\/license(?:\/|$)|\/active-set$/.test(d.path)).map((d) => d.path)).toEqual([]);
  });
});

describe.skipIf(!ctx.available)(`the edition gate: the community edition refuses nothing; a gate refusing writes stops them at step 10 [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let community: ReturnType<typeof createApp>;
  let gated: ReturnType<typeof createApp>;
  let superAdmin: PersonaUser;
  let snapshot: UserSnapshot;
  let peerSerial = 0;
  /** The route ids the fake gate was asked about, and those whose `prepare` or handler ran, in the gated app. */
  const asked = new Set<string>();
  const ran = new Set<string>();

  const nextPeer = (): string => {
    peerSerial += 1;
    return `198.18.${(peerSerial >> 8) & 255}.${peerSerial & 255}`;
  };
  const seed = (): SeedContext => ({ h, now: NOW, keyring: CONFIG.keyring, dataDir });
  const lastSeq = async (): Promise<number> =>
    Number((await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);

  async function asSuperAdmin(app: ReturnType<typeof createApp>, decl: RouteDecl, call: MatrixCall): Promise<AgentReply> {
    const token = await personaSession(h, superAdmin, { now: NOW });
    return sendCall(app, CONFIG, decl, call, { token, peer: nextPeer() });
  }

  /** A route that is not declared (any more): only what sendCall reads of a declaration. */
  const undeclared = (method: RouteDecl['method'], p: string): RouteDecl => ({ id: `gone ${method} ${p}`, method, path: p }) as RouteDecl;

  /** `decl` with spies on its `prepare` and handler: each records the route id in `ran` before it does its work. */
  function spied(decl: RouteDecl): RouteDecl {
    const { handler, prepare } = decl;
    return {
      ...decl,
      handler: (rc) => {
        ran.add(decl.id);
        return handler(rc);
      },
      ...(prepare === undefined
        ? {}
        : {
            prepare: (rc: RouteContext) => {
              ran.add(decl.id);
              return prepare(rc);
            },
          }),
    };
  }

  /** The fake edition gate: asked about every route that reaches step 10, it refuses the `write` ones. */
  const refusingWrites: EditionGate = async (_rc, decl) => {
    asked.add(decl.id);
    if (routeMode(decl) === 'write') throw new DomainError('AUTHZ_DENIED', { detail: GATE_DETAIL });
  };

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-edition-gate-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    dataDir = path.join(root, 'data');
    await writeConfig(dataDir, CONFIG);
    // As the permission matrix builds its app: no feed, the dev root as the package keys.
    const source = createUpdateSource({
      feedBase: () => null,
      dataDir,
      roots: [],
      sources: async () => [],
      refuseDevKids: false,
      allowLoopbackHttp: false,
      clock: () => NOW,
      log: { info() {}, warn() {}, error() {} },
      persistKeysets: async () => {},
      onSignedTime: async () => {},
      env: {},
    });
    const deps = {
      state: { phase: 'ready' as const, db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'edition-gate',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      dataDir,
    };
    const services = { mailer: silentMailer, emailTestMailer: silentMailer, updates: { source, packageKeys: devPackageKeys } };
    community = createApp({ ...deps, services });
    gated = createApp({ ...deps, routes: ALL_ROUTES.map(spied), services: { ...services, editionGate: refusingWrites } });
    const user = await seedPersona(seed(), 'super_admin');
    if (user === null) throw new Error('no super admin');
    superAdmin = user;
    snapshot = await snapshotUsers(h, [superAdmin.id]);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await restoreUsers(h, snapshot);
    await removeOp(dataDir);
  });

  afterEach(async () => {
    await removeOp(dataDir); // an op an ops fixture made (a takeover leaves it current) ends with its test
  });

  describe('the community edition', () => {
    it('a super admin creates a branch (write) and lists the branches (read); no license_state row is written', async () => {
      const byId = new Map(ALL_ROUTES.map((d) => [d.id, d]));
      const created = await asSuperAdmin(community, byId.get('branches.create')!, {
        body: { code: 'CABANG-2', name: 'Cabang Kedua', timezone: 'Asia/Jakarta' },
      });
      expect(created.status, created.text).toBe(201);
      const listed = await asSuperAdmin(community, byId.get('branches.list')!, { query: { includeArchived: 'true' } });
      expect(listed.status, listed.text).toBe(200);
      const items = (listed.json as BranchListResponse).items;
      expect(items.map((b) => b.code)).toContain('CABANG-2');
      // Every live branch is active, an archived one never (no branch limit).
      expect(items.every((b: BranchView) => b.active === (b.archivedAt === null))).toBe(true);
      expect(await h.db.selectFrom('license_state').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('settings').select('key').where('key', 'like', 'license.%').execute()).toEqual([]);
    });

    it('the routes the community edition dropped answer 404', async () => {
      const gone: [RouteDecl['method'], string][] = [
        ['GET', '/api/v1/license'],
        ['GET', '/api/v1/license/request-code'],
        ['POST', '/api/v1/license/upload'],
        ['POST', '/api/v1/license/clock'],
        ['POST', '/api/v1/license/deactivate'],
        ['GET', '/api/v1/license/history'],
        ['PUT', '/api/v1/branches/active-set'],
      ];
      const answers: [string, number, string | undefined][] = [];
      for (const [method, p] of gone) {
        const res = await asSuperAdmin(community, undeclared(method, p), { body: {} });
        answers.push([`${method} ${p}`, res.status, codeOf(res)]);
      }
      expect(answers).toEqual(gone.map(([method, p]) => [`${method} ${p}`, 404, 'NOT_FOUND']));
    });
  });

  describe('the seam: a gate that refuses every write route', () => {
    for (const decl of ALL_ROUTES) {
      const mode = routeMode(decl);
      const what = mode === 'write' ? '403 at step 10, no prepare or handler run, nothing written' : `the gate outcome ${expected(decl, 'super_admin')}`;
      it(`${decl.id} (${decl.method} ${decl.path}, ${mode}) → ${what}`, async () => {
        const fixture = MATRIX_FIXTURES[decl.id];
        if (fixture === undefined) throw new Error(`MATRIX_FIXTURES has no fixture for ${decl.id}`);
        const call = await fixture({ ...seed(), persona: 'super_admin', user: superAdmin });
        asked.delete(decl.id);
        ran.delete(decl.id);
        const before = await lastSeq();
        const res = await asSuperAdmin(gated, decl, call);
        const got = outcomeOf(res.headers.get('x-altis-test-gate'));
        if (mode === 'write') {
          expect([res.status, codeOf(res), detailOf(res), got], res.text).toEqual([403, 'AUTHZ_DENIED', GATE_DETAIL, 'allowed']);
          expect(asked.has(decl.id)).toBe(true);
          expect(ran.has(decl.id)).toBe(false); // refused at step 10: neither prepare nor the handler ran
          expect(await lastSeq()).toBe(before);
        } else {
          expect(detailOf(res), res.text).not.toBe(GATE_DETAIL);
          expect(got, `${res.status} ${res.text}`).toBe(expected(decl, 'super_admin', call.op));
          // A wizard route of this installed app answers 404 at the install gate, before step 10.
          if (decl.install !== undefined) expect(asked.has(decl.id)).toBe(false);
          else if (got === 'allowed') expect(asked.has(decl.id)).toBe(true);
        }
      }, 60_000);
    }
  });
});
