import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MaintenanceFlag } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId, type OpKind } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { writeConfig } from '../../src/config.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import type { RouteDecl } from '../../src/http/route.js';
import { ALL_ROUTES } from '../../src/routes.js';
import type { AgentReply } from '../agent.js';
import { EXPECTED_MAINTENANCE, sendCall, type MatrixCall } from '../matrix-fixtures.js';
import { flagOf, removeOp, writeFlag, writeOp } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';

// Step 5's allowlist for every route (spec §9.4; decision C20; rulings R1c-9, R1c-12; 1c and 1d Task 33) on the engine
// picked by ALTIS_TEST_DB:
// - every declaration's `maintenance` is `EXPECTED_MAINTENANCE[id] ?? 'deny'`, a literal map of §9.4 (matrix-fixtures.ts);
//   1d's routes are `deny` but `updates.status` (`restore-allow`) and the wizard's request code (`allow`);
// - under a frozen backup's flag, and under a manual one (`maintenance:on`), every `deny` route answers 503 MAINTENANCE
//   with the flag's reason and `Retry-After: 30`, and every other route passes step 5;
// - under a restore's flag every route but the `restore-allow` ones answers 503 MAINTENANCE `restore`, and the
//   `restore-allow` ones pass step 5; past the restore's point of no return `auth/reauth` answers 409
//   OPS_POINT_OF_NO_RETURN (R1c-9) while the ops routes, `/_cron` and `/_health` still pass.
//
// Every route is called the way a browser without a session calls it (the pre-session CSRF token, baseUrl's Origin, no
// body): step 5 comes before the session, the CSRF check and validation, so who calls does not matter, and a route
// that passes it goes no further than its own refusal of an anonymous call. The fence looks on every request, so each
// flag the test writes is seen by the next request.

const ctx = testDbContext();
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });

type Maintenance = 'allow' | 'deny' | 'restore-allow';

const codeOf = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const reasonOf = (res: AgentReply): string | undefined => (res.json as { reason?: string } | undefined)?.reason;

/** The maintenance a route must declare. */
const wanted = (decl: RouteDecl): Maintenance => EXPECTED_MAINTENANCE[decl.id] ?? 'deny';

/** Values for the path parameters (step 5 runs before validation: any well-formed value does). */
const PARAM_VALUES: Readonly<Record<string, string>> = {
  nonce: 'Maint_nonce-0123456789',
  group: 'library',
  name: 'retention.events',
  n: '0',
  file: 'tidak-ada.js',
};

/** A call of `decl` with a value for each path parameter and nothing else. */
function callFor(decl: RouteDecl): MatrixCall {
  const params: Record<string, string> = {};
  for (const m of decl.path.matchAll(/:([A-Za-z0-9_]+)/g)) params[m[1]!] = PARAM_VALUES[m[1]!] ?? newId();
  if (decl.path.endsWith('*')) params['*'] = 'pengguna';
  return { params };
}

/** Whether step 5 refused `res`: 503 MAINTENANCE (problem+json), which no later step answers. */
const refusedByMaintenance = (res: AgentReply): boolean => res.status === 503 && codeOf(res) === 'MAINTENANCE';

describe.skipIf(!ctx.available)(`the maintenance allowlist of every route [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let peerSerial = 0;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-maint-allow-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    dataDir = path.join(root, 'data');
    await writeConfig(dataDir, CONFIG);
    // A fence that looks on every request, so that each flag the test writes is seen by the next request.
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => Date.now(), onEpoch() {}, onOpEnded() {} });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'maint',
      log: recordingLogger(),
      env: {},
      dataDir,
      services: { opsFence },
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await writeFlag(dataDir, null);
    await removeOp(dataDir);
  });

  /** `decl` called by a browser without a session, at a peer address of its own. */
  function call(decl: RouteDecl): Promise<AgentReply> {
    peerSerial += 1;
    return sendCall(app, CONFIG, decl, callFor(decl), { token: null, peer: `198.18.${(peerSerial >> 8) & 255}.${peerSerial & 255}` });
  }

  /** An op of `kind` in `state` holding the ops lock, with the maintenance flag `reason` (null: no op, a manual flag). */
  async function maintenance(reason: MaintenanceFlag['reason'], op?: { kind: OpKind; state: string; pointOfNoReturn?: boolean }): Promise<void> {
    if (op === undefined) {
      await writeFlag(dataDir, flagOf(reason, null));
      return;
    }
    const written = await writeOp(dataDir, { kind: op.kind, state: op.state, pointOfNoReturn: op.pointOfNoReturn ?? false });
    await writeFlag(dataDir, flagOf(reason, written.op.opId));
  }

  it('every declaration: maintenance = EXPECTED_MAINTENANCE[id] ?? deny', () => {
    const declared = Object.fromEntries(ALL_ROUTES.map((d) => [d.id, d.maintenance ?? 'deny']));
    const want = Object.fromEntries(ALL_ROUTES.map((d) => [d.id, wanted(d)]));
    expect(declared).toEqual(want);
  });

  it('the map: only routes of ALL_ROUTES; every opsAuth route restore-allow; every wizard route allow; R1c-9 and R1c-12', () => {
    const ids = new Set(ALL_ROUTES.map((d) => d.id));
    expect(Object.keys(EXPECTED_MAINTENANCE).filter((id) => !ids.has(id))).toEqual([]);
    expect(Object.values(EXPECTED_MAINTENANCE).filter((m) => m === 'deny')).toEqual([]);
    for (const d of ALL_ROUTES.filter((r) => r.opsAuth === true)) expect(wanted(d), d.id).toBe('restore-allow');
    for (const d of ALL_ROUTES.filter((r) => r.install !== undefined)) expect(wanted(d), d.id).toBe('allow');
    // §9.4's restore list beyond the ops routes; R1c-9's changed rows; R1c-12's two that stay closed.
    expect(['health', 'cron.run', 'auth.reauth'].map((id) => EXPECTED_MAINTENANCE[id])).toEqual(['restore-allow', 'restore-allow', 'restore-allow']);
    expect(['admin.root', 'admin.index'].map((id) => EXPECTED_MAINTENANCE[id])).toEqual(['allow', 'allow']);
    expect(['diagnostics.get', 'dashboard.get'].map((id) => EXPECTED_MAINTENANCE[id] ?? 'deny')).toEqual(['deny', 'deny']);
  });

  it('1d (Task 33): updates.status restore-allow, every other 1d route deny', () => {
    // The 1d route catalog: `updates.status` follows an update through maintenance (app.js's page and the server's);
    // nothing else of 1d opens during an op.
    const phase1d = ALL_ROUTES.filter((d) => /^updates\./.test(d.id));
    const declared = Object.fromEntries(phase1d.map((d) => [d.id, d.maintenance ?? 'deny']));
    expect(declared).toEqual({
      'updates.get': 'deny',
      'updates.check': 'deny',
      'updates.apply': 'deny',
      'updates.status': 'restore-allow',
      'updates.upload': 'deny',
      'updates.rollback': 'deny',
      'updates.channel': 'deny',
      'updates.history': 'deny',
    });
    expect(Object.fromEntries(phase1d.map((d) => [d.id, wanted(d)]))).toEqual(declared);
  });

  for (const [what, setUp, reason] of [
    ['a frozen backup', () => maintenance('backup', { kind: 'backup', state: 'exporting' }), 'backup'],
    ['a manual flag (maintenance:on)', () => maintenance('manual'), 'manual'],
  ] as const) {
    it(`under ${what}: every deny route → 503 MAINTENANCE reason ${reason}; allow and restore-allow routes pass step 5`, async () => {
      await setUp();
      const wrong: { id: string; status: number; code: string | undefined }[] = [];
      for (const decl of ALL_ROUTES) {
        const res = await call(decl);
        if (wanted(decl) === 'deny') {
          const ok =
            refusedByMaintenance(res) &&
            reasonOf(res) === reason &&
            res.headers.get('retry-after') === '30' &&
            res.headers.get('x-altis-test-gate') === null;
          if (!ok) wrong.push({ id: decl.id, status: res.status, code: codeOf(res) });
        } else if (refusedByMaintenance(res)) {
          wrong.push({ id: decl.id, status: res.status, code: codeOf(res) });
        }
      }
      expect(wrong).toEqual([]);
    }, 60_000);
  }

  it('under a restore (before its point of no return): every route but restore-allow → 503 MAINTENANCE reason restore', async () => {
    await maintenance('restore', { kind: 'restore', state: 'prechecked' });
    const wrong: { id: string; status: number; code: string | undefined }[] = [];
    for (const decl of ALL_ROUTES) {
      const res = await call(decl);
      if (wanted(decl) === 'restore-allow') {
        if (refusedByMaintenance(res)) wrong.push({ id: decl.id, status: res.status, code: codeOf(res) });
      } else if (!(refusedByMaintenance(res) && reasonOf(res) === 'restore' && res.headers.get('retry-after') === '30')) {
        wrong.push({ id: decl.id, status: res.status, code: codeOf(res) });
      }
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('past the restore point of no return: auth/reauth → 409 OPS_POINT_OF_NO_RETURN (R1c-9); ops routes, /_cron and /_health pass', async () => {
    await maintenance('restore', { kind: 'restore', state: 'loading', pointOfNoReturn: true });
    const byId = new Map(ALL_ROUTES.map((d) => [d.id, d]));
    const reauth = await call(byId.get('auth.reauth')!);
    expect([reauth.status, codeOf(reauth)]).toEqual([409, 'OPS_POINT_OF_NO_RETURN']);
    // The ops routes read no session past that point: without the op's cookie → 401 OPS_AUTH_REQUIRED, not 503.
    const current = await call(byId.get('ops.current')!);
    expect([current.status, codeOf(current)]).toEqual([401, 'OPS_AUTH_REQUIRED']);
    const cron = await call(byId.get('cron.run')!);
    expect([cron.status, codeOf(cron)]).toEqual([401, 'CRON_TOKEN_INVALID']);
    const health = await call(byId.get('health')!);
    expect([health.status, health.json]).toEqual([503, { status: 'maintenance', version: '0.1.0' }]);
    // Sign-in stays closed during a restore (R1c-9).
    const login = await call(byId.get('auth.login')!);
    expect([login.status, codeOf(login), reasonOf(login)]).toEqual([503, 'MAINTENANCE', 'restore']);
  });
});
