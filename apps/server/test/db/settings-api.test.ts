import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS, groupKeys, readSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { TEST_KEYRING, seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The settings API of Task 22 on the engine picked by ALTIS_TEST_DB (spec §6.5, §13.3; decisions D26, D41): one
// `GET settings/:group` for the four groups an admin edits, and one PUT per group with its own strict body whose keys
// are the setting's name without its group prefix. A PUT writes through Task 8's writeSettings in the handler's
// transaction, audits `settings.update` with the names of the changed keys (never a value) and invalidates the
// settings cache after its COMMIT (M17), so that its own process uses the new value at once.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig({ keyring: TEST_KEYRING.map((entry) => ({ ...entry })) });
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const SETTINGS_PATH = '/api/v1/settings';
const CHANGE = '/api/v1/auth/password/change';
/** 11 characters, not a common password: passes a minimum of 10 and fails one of 12. */
const ELEVEN = 'xq7-Lumba2!';

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

/** The leaves of a JSON object (`null` counts as one): every value a view has. */
function leaves(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [value];
  return Object.values(value as Record<string, unknown>).flatMap(leaves);
}

async function audits(action: string) {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'meta'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

/** A browser signed in as one staff user. */
interface Client {
  userId: string;
  password: string;
  get(path: string): Promise<AgentReply>;
  put(path: string, body: unknown): Promise<AgentReply>;
  post(path: string, body: unknown): Promise<AgentReply>;
}


// ---- Komunitas (notices) ----
/** A member notice template not set: both languages read as the catalog text. */
const NOTICE_TEMPLATE = { id: { subject: null, body: null }, en: { subject: null, body: null } };

describe.skipIf(!ctx.available)(`settings API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let serial = 0;

  async function signedIn(o: { roles: Parameters<typeof seedStaff>[1]['roles']; reauth?: boolean }): Promise<Client> {
    const user = await seedStaff(h, { username: `pengaturan_${(serial += 1)}`, now: NOW, roles: o.roles ?? [] });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: o.reauth === true ? NOW : null });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      userId: user.id,
      password: user.password,
      get: (p) => agent.get(p),
      put: (p, body) => agent.put(p, body, csrf),
      post: (p, body) => agent.post(p, body, csrf),
    };
  }

  const manager = (reauth = false) => signedIn({ roles: [{ permissions: ['system.settings.read', 'system.settings.manage'] }], reauth });

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-settings-api-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('audit_log').execute();
    // A new app per test: a settings cache of its own.
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
  });

  describe('GET settings/:group', () => {
    it('answers each group with every key filled, the defaults for what is not stored', async () => {
      const admin = await manager();
      const library = await admin.get(`${SETTINGS_PATH}/library`);
      expect(library.status).toBe(200);
      expect(library.json).toEqual({ name: 'Perpustakaan', type: null, address: null, timezone: 'Asia/Jakarta', locale: 'id' });

      const email = await admin.get(`${SETTINGS_PATH}/email`);
      expect(email.status).toBe(200);
      expect(email.json).toEqual({
        senderName: null,
        templates: {
          passwordReset: { id: { subject: null, body: null }, en: { subject: null, body: null } },
          // ---- Komunitas (notices) ----
          circulationDueSoon: NOTICE_TEMPLATE,
          circulationOverdue: NOTICE_TEMPLATE,
          circulationHoldReady: NOTICE_TEMPLATE,
        },
      });

      const security = await admin.get(`${SETTINGS_PATH}/security`);
      expect(security.status).toBe(200);
      expect(security.json).toEqual({ passwordMinLength: 10, sessionIdleMinutes: 30 });

      const opac = await admin.get(`${SETTINGS_PATH}/opac`);
      expect(opac.status).toBe(200);
      expect(opac.json).toEqual({
        welcome: { id: null, en: null },
        accent: 'teal',
        // Phase 2 (Task 2): the six new OPAC keys.
        resultsPerPage: 20,
        indexable: true,
        oai: { enabled: true, adminEmail: '' },
        showShelfMap: true,
        newTitlesCount: 12,
      });

      // Every registered key of the group is in its view, once.
      for (const [group, res] of [['library', library], ['email', email], ['security', security], ['opac', opac]] as const) {
        expect(leaves(res.json)).toHaveLength(groupKeys(group).length);
      }
    });

    it('shows what is stored', async () => {
      const admin = await manager();
      const put = await admin.put(`${SETTINGS_PATH}/email`, {
        senderName: 'Perpus SMA 1',
        templates: { passwordReset: { en: { subject: 'Reset at {library}' } } },
      });
      expect(put.status, put.text).toBe(200);
      const email = await admin.get(`${SETTINGS_PATH}/email`);
      expect(email.json).toEqual({
        senderName: 'Perpus SMA 1',
        templates: {
          passwordReset: { id: { subject: null, body: null }, en: { subject: 'Reset at {library}', body: null } },
          // ---- Komunitas (notices) ----
          circulationDueSoon: NOTICE_TEMPLATE,
          circulationOverdue: NOTICE_TEMPLATE,
          circulationHoldReady: NOTICE_TEMPLATE,
        },
      });
    });

    it('settings/unknown, and the groups served elsewhere (smtp, system) → 404', async () => {
      const admin = await manager();
      for (const group of ['unknown', 'smtp', 'system']) {
        const res = await admin.get(`${SETTINGS_PATH}/${group}`);
        expect({ group, status: res.status, code: code(res) }).toEqual({ group, status: 404, code: 'NOT_FOUND' });
      }
    });

    it('needs system.settings.read: a user without it → 403 AUTHZ_DENIED', async () => {
      const other = await signedIn({ roles: [{ permissions: ['system.settings.manage'] }] });
      const res = await other.get(`${SETTINGS_PATH}/library`);
      expect({ status: res.status, code: code(res) }).toEqual({ status: 403, code: 'AUTHZ_DENIED' });
    });
  });

  describe('PUT settings/<group>', () => {
    it('library {name}: 200, stored, audited as settings.update with the changed keys only (no values)', async () => {
      const admin = await manager();
      const res = await admin.put(`${SETTINGS_PATH}/library`, { name: 'Perpus SMA 1' });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ changed: ['library.name'] });
      expect((await readSettings(h.db, ['library.name'], []))['library.name']).toBe('Perpus SMA 1');

      const entries = await audits('settings.update');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor_type: 'staff', actor_id: admin.userId, meta: { group: 'library', keys: ['library.name'] } });
      expect(JSON.stringify(entries)).not.toContain('Perpus SMA 1');

      // The same value again changes nothing, and says so.
      const again = await admin.put(`${SETTINGS_PATH}/library`, { name: 'Perpus SMA 1' });
      expect(again.json).toEqual({ changed: [] });
      expect((await audits('settings.update')).at(-1)?.meta).toEqual({ group: 'library', keys: [] });
    });

    it('library: null clears an optional value; every key of the group can be written at once', async () => {
      const admin = await manager();
      const res = await admin.put(`${SETTINGS_PATH}/library`, {
        name: 'Perpus Kota',
        type: 'umum',
        address: 'Jl. Merdeka 1\nBandung',
        timezone: 'Asia/Makassar',
        locale: 'en',
      });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ changed: ['library.name', 'library.type', 'library.address', 'library.timezone', 'library.locale'] });
      const cleared = await admin.put(`${SETTINGS_PATH}/library`, { address: null });
      expect(cleared.json).toEqual({ changed: ['library.address'] });
      expect((await admin.get(`${SETTINGS_PATH}/library`)).json).toEqual({
        name: 'Perpus Kota',
        type: 'umum',
        address: null,
        timezone: 'Asia/Makassar',
        locale: 'en',
      });
    });

    it('security {passwordMinLength: 12}: 401 without reauth, 200 with it, and this process applies it at once', async () => {
      const stale = await manager(false);
      const denied = await stale.put(`${SETTINGS_PATH}/security`, { passwordMinLength: 12 });
      expect({ status: denied.status, code: code(denied) }).toEqual({ status: 401, code: 'AUTH_REAUTH_REQUIRED' });

      const admin = await manager(true);
      // The cache holds the minimum of 10 first: an 11-character password passes the policy (the current one is wrong).
      const before = await admin.post(CHANGE, { current: 'not-the-password', next: ELEVEN });
      expect({ status: before.status, code: code(before) }).toEqual({ status: 401, code: 'AUTH_INVALID_CREDENTIALS' });

      const res = await admin.put(`${SETTINGS_PATH}/security`, { passwordMinLength: 12 });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ changed: ['security.password_min_length'] });

      // Same process, same clock: only the invalidation after COMMIT lets the next request see 12 (M17).
      const after = await admin.post(CHANGE, { current: admin.password, next: ELEVEN });
      expect(after.status, after.text).toBe(422);
      expect(after.json).toMatchObject({ code: 'PASSWORD_TOO_WEAK', reason: 'too_short' });
    });

    it('security outside its range → 422 VALIDATION_FAILED at the field, nothing written', async () => {
      const admin = await manager(true);
      const res = await admin.put(`${SETTINGS_PATH}/security`, { passwordMinLength: 9, sessionIdleMinutes: 241 });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      expect(errors(res).map((e) => e.path).sort()).toEqual(['passwordMinLength', 'sessionIdleMinutes']);
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);
    });

    it('opac {accent: "pink"} → 422 with errors[0].path "accent"; a known accent and the welcome texts are stored', async () => {
      const admin = await manager();
      const bad = await admin.put(`${SETTINGS_PATH}/opac`, { accent: 'pink' });
      expect(bad.status).toBe(422);
      expect(code(bad)).toBe('VALIDATION_FAILED');
      expect(errors(bad)[0]?.path).toBe('accent');

      const ok = await admin.put(`${SETTINGS_PATH}/opac`, { accent: 'purple', welcome: { id: 'Selamat datang', en: 'Welcome' } });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json).toEqual({ changed: ['opac.welcome.id', 'opac.welcome.en', 'opac.accent'] });
      expect((await admin.get(`${SETTINGS_PATH}/opac`)).json).toMatchObject({ welcome: { id: 'Selamat datang', en: 'Welcome' }, accent: 'purple' });
    });

    it('the accents and library types of the bodies are the registry\'s', () => {
      for (const accent of ['teal', 'blue', 'green', 'purple', 'red', 'slate']) {
        expect(SETTINGS['opac.accent'].schema.safeParse(accent).success).toBe(true);
      }
      expect(SETTINGS['opac.accent'].schema.safeParse('pink').success).toBe(false);
      for (const type of ['sekolah', 'perguruan_tinggi', 'umum', 'khusus']) {
        expect(SETTINGS['library.type'].schema.safeParse(type).success).toBe(true);
      }
    });

    it('a password-reset body without {link} → 422 {path: templates.passwordReset.<locale>.body, code: missing_link}; nothing written', async () => {
      const admin = await manager();
      const res = await admin.put(`${SETTINGS_PATH}/email`, {
        templates: { passwordReset: { id: { body: 'Klik tautan berikut: {tautan}' }, en: { body: 'Open {link}' } } },
      });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      expect((res.json as { errors: unknown }).errors).toEqual([{ path: 'templates.passwordReset.id.body', code: 'missing_link' }]);
      expect(res.text).not.toContain('tautan');
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);

      const ok = await admin.put(`${SETTINGS_PATH}/email`, { templates: { passwordReset: { id: { body: 'Buka {link}' }, en: { body: '' } } } });
      expect(ok.status, ok.text).toBe(200);
    });

    it('each body is strict: library with an `accent` key → 422, nested objects too', async () => {
      const admin = await manager();
      const res = await admin.put(`${SETTINGS_PATH}/library`, { name: 'X', accent: 'teal' });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      const nested = await admin.put(`${SETTINGS_PATH}/email`, { templates: { passwordReset: { id: { subject: 'S', footer: 'x' } } } });
      expect(nested.status).toBe(422);
      const welcome = await admin.put(`${SETTINGS_PATH}/opac`, { welcome: { de: 'Willkommen' } });
      expect(welcome.status).toBe(422);
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);
    });

    it('needs system.settings.manage: a reader → 403 AUTHZ_DENIED', async () => {
      const reader = await signedIn({ roles: [{ permissions: ['system.settings.read'] }], reauth: true });
      for (const group of ['library', 'email', 'security', 'opac', 'catalog']) {
        const res = await reader.put(`${SETTINGS_PATH}/${group}`, {});
        expect({ group, status: res.status, code: code(res) }).toEqual({ group, status: 403, code: 'AUTHZ_DENIED' });
      }
    });
  });

  // ---- Phase 2 (catalog): Task 2 ----
  // The catalog group (Phase 2 spec §12.6) and `GET catalog/config` (for the catalogue screens without
  // system.settings.read), with M11: only a super admin may change `catalog.sru.allowPrivateHosts`.
  describe('Phase 2: settings/catalog and catalog/config', () => {
    const PRIVATE = 'catalog.sru.allowPrivateHosts';

    /** The default catalog view, from the registry. */
    function defaultCatalog() {
      return {
        marcOrgCode: null,
        defaultMaterialTypeId: null,
        defaultCollectionTypeId: null,
        currency: 'IDR',
        barcode: { patterns: SETTINGS['catalog.barcode.patterns'].default, symbology: 'code128' },
        labelProfiles: SETTINGS['catalog.labelProfiles'].default,
        sru: { servers: SETTINGS['catalog.sru.servers'].default, allowPrivateHosts: false },
        isbn: { arsyaEnabled: false },
        attachment: { maxMb: 200 },
        dedupe: { threshold: 80 },
      };
    }

    const pattern = { id: 'ref', name: 'Referensi', prefix: 'ref-', digits: 5, suffix: '' };

    it('GET settings/catalog answers the defaults on an empty table, every key once', async () => {
      const admin = await manager();
      const res = await admin.get(`${SETTINGS_PATH}/catalog`);
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual(defaultCatalog());
      expect(Object.keys(res.json as object)).toEqual(Object.keys(defaultCatalog()));
      expect(groupKeys('catalog')).toHaveLength(12);
    });

    it('PUT settings/catalog round-trips (affixes upper case), audited as settings.update {group, keys}; a second PUT changes nothing', async () => {
      const admin = await manager();
      const body = {
        marcOrgCode: 'IdJaPN',
        currency: 'USD',
        barcode: { patterns: [pattern], symbology: 'code39' },
        attachment: { maxMb: 500 },
        dedupe: { threshold: 90 },
      };
      const put = await admin.put(`${SETTINGS_PATH}/catalog`, body);
      expect(put.status, put.text).toBe(200);
      expect(put.json).toEqual({
        changed: ['catalog.marcOrgCode', 'catalog.currency', 'catalog.barcode.patterns', 'catalog.barcode.symbology', 'catalog.attachment.maxMb', 'catalog.dedupe.threshold'],
      });
      const view = (await admin.get(`${SETTINGS_PATH}/catalog`)).json;
      expect(view).toEqual({
        ...defaultCatalog(),
        marcOrgCode: 'IdJaPN',
        currency: 'USD',
        barcode: { patterns: [{ ...pattern, prefix: 'REF-' }], symbology: 'code39' },
        attachment: { maxMb: 500 },
        dedupe: { threshold: 90 },
      });
      expect((await audits('settings.update')).map((a) => a.meta)).toEqual([
        { group: 'catalog', keys: (put.json as { changed: string[] }).changed },
      ]);
      expect((await admin.put(`${SETTINGS_PATH}/catalog`, body)).json).toEqual({ changed: [] });
      // `null` clears what may be cleared: it reads as its default again.
      const cleared = await admin.put(`${SETTINGS_PATH}/catalog`, { marcOrgCode: null });
      expect(cleared.json).toEqual({ changed: ['catalog.marcOrgCode'] });
      expect(((await admin.get(`${SETTINGS_PATH}/catalog`)).json as { marcOrgCode: unknown }).marcOrgCode).toBeNull();
    });

    it('a bad value → 422 at its body path; a 21st pattern, a profile that does not fit, an unknown key; nothing written', async () => {
      const admin = await manager();
      const many = Array.from({ length: 21 }, (_, i) => ({ ...pattern, id: `p-${i}` }));
      const cases: [unknown, string][] = [
        [{ barcode: { patterns: [{ ...pattern, digits: 13 }] } }, 'barcode.patterns.0.digits'],
        [{ barcode: { patterns: many } }, 'barcode.patterns'],
        [{ currency: 'rp' }, 'currency'],
        [{ dedupe: { threshold: 101 } }, 'dedupe.threshold'],
      ];
      for (const [body, path] of cases) {
        const res = await admin.put(`${SETTINGS_PATH}/catalog`, body);
        expect({ status: res.status, code: code(res), path: errors(res)[0]?.path }, JSON.stringify(body)).toEqual({
          status: 422,
          code: 'VALIDATION_FAILED',
          path,
        });
      }
      const profile = { ...(SETTINGS['catalog.labelProfiles'].default as Record<string, unknown>[])[0], labelWMm: 80 };
      const tooWide = await admin.put(`${SETTINGS_PATH}/catalog`, { labelProfiles: [profile] });
      expect({ status: tooWide.status, errors: errors(tooWide) }).toEqual({ status: 422, errors: [{ path: 'labelProfiles.0', code: 'does_not_fit' }] });
      expect((await admin.put(`${SETTINGS_PATH}/catalog`, { sru: { allowPrivate: true } })).status).toBe(422);
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);
    });

    it('PUT settings/opac takes the six new keys', async () => {
      const admin = await manager();
      const put = await admin.put(`${SETTINGS_PATH}/opac`, {
        resultsPerPage: 30,
        indexable: false,
        oai: { enabled: true, adminEmail: 'pustakawan@perpus.example.id' },
        showShelfMap: false,
        newTitlesCount: 0,
      });
      expect(put.status, put.text).toBe(200);
      expect(put.json).toEqual({
        changed: ['opac.resultsPerPage', 'opac.indexable', 'opac.oai.adminEmail', 'opac.showShelfMap', 'opac.newTitlesCount'],
      });
      expect((await admin.get(`${SETTINGS_PATH}/opac`)).json).toMatchObject({
        resultsPerPage: 30,
        indexable: false,
        oai: { enabled: true, adminEmail: 'pustakawan@perpus.example.id' },
        showShelfMap: false,
        newTitlesCount: 0,
      });
      const bad = await admin.put(`${SETTINGS_PATH}/opac`, { oai: { adminEmail: 'bukan-email' } });
      expect({ status: bad.status, errors: errors(bad) }).toEqual({ status: 422, errors: [{ path: 'oai.adminEmail', code: 'invalid_format' }] });
    });

    it('M11: an admin changing allowPrivateHosts → 403 AUTHZ_DENIED, nothing written; the same body without that change → 200', async () => {
      const admin = await signedIn({ roles: [{ key: 'admin' }] });
      const denied = await admin.put(`${SETTINGS_PATH}/catalog`, { currency: 'USD', sru: { allowPrivateHosts: true } });
      expect({ status: denied.status, code: code(denied) }).toEqual({ status: 403, code: 'AUTHZ_DENIED' });
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);
      expect(await audits('settings.update')).toEqual([]);
      // Counted and audited like a refusal of step 9 (the route's own permission is named).
      expect((await audits('authz.denied')).map((a) => a.meta)).toEqual([{ route: 'settings.catalog.put', permission: 'system.settings.manage' }]);

      const same = await admin.put(`${SETTINGS_PATH}/catalog`, { currency: 'USD', sru: { allowPrivateHosts: false } });
      expect(same.status, same.text).toBe(200);
      expect(same.json).toEqual({ changed: ['catalog.currency'] });
      const without = await admin.put(`${SETTINGS_PATH}/catalog`, { currency: 'EUR' });
      expect(without.status, without.text).toBe(200);
    });

    it('M11: a super admin may change it (and an admin may then send the stored value back unchanged)', async () => {
      const superAdmin = await signedIn({ roles: [{ key: 'super_admin' }] });
      const on = await superAdmin.put(`${SETTINGS_PATH}/catalog`, { sru: { allowPrivateHosts: true } });
      expect(on.status, on.text).toBe(200);
      expect(on.json).toEqual({ changed: [PRIVATE] });
      expect((await readSettings(h.db, [PRIVATE], CONFIG.keyring))[PRIVATE]).toBe(true);

      const admin = await signedIn({ roles: [{ key: 'admin' }] });
      expect((await admin.put(`${SETTINGS_PATH}/catalog`, { sru: { allowPrivateHosts: true } })).status).toBe(200);
      const off = await admin.put(`${SETTINGS_PATH}/catalog`, { sru: { allowPrivateHosts: false } });
      expect({ status: off.status, code: code(off) }).toEqual({ status: 403, code: 'AUTHZ_DENIED' });
      expect((await readSettings(h.db, [PRIVATE], CONFIG.keyring))[PRIVATE]).toBe(true);
    });

    it('GET catalog/config as a holder of catalog.records.read only → 200 with the default pattern; without it → 403', async () => {
      const reader = await signedIn({ roles: [{ permissions: ['catalog.records.read'] }] });
      const res = await reader.get('/api/v1/catalog/config');
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({
        barcodePatterns: [{ id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' }],
        symbology: 'code128',
        labelProfiles: [
          { id: 'spine-a4', name: 'Label punggung A4 (3 × 10)', kind: 'spine' },
          { id: 'barcode-a4', name: 'Label barkod A4 (3 × 8)', kind: 'barcode' },
          { id: 'spine-barcode-a4', name: 'Label punggung dan barkod A4 (2 × 7)', kind: 'spine_barcode' },
        ],
        currency: 'IDR',
        dedupeThreshold: 80,
        defaultMaterialTypeId: null,
        defaultCollectionTypeId: null,
        sruServers: [
          { id: 'perpusnas', name: 'Perpustakaan Nasional RI', enabled: false },
          { id: 'loc', name: 'Library of Congress', enabled: false },
        ],
        arsyaEnabled: false,
      });
      // Never a URL or the private-hosts switch: the reader has no system.settings.read.
      expect(res.text).not.toContain('loc.gov');
      const settingsReader = await signedIn({ roles: [{ permissions: ['system.settings.read'] }] });
      const denied = await settingsReader.get('/api/v1/catalog/config');
      expect({ status: denied.status, code: code(denied) }).toEqual({ status: 403, code: 'AUTHZ_DENIED' });
    });

    it('GET catalog/config shows a stored change at once', async () => {
      const admin = await manager();
      expect((await admin.put(`${SETTINGS_PATH}/catalog`, { barcode: { patterns: [pattern] }, currency: 'USD' })).status).toBe(200);
      const reader = await signedIn({ roles: [{ permissions: ['catalog.records.read'] }] });
      const res = (await reader.get('/api/v1/catalog/config')).json as { barcodePatterns: unknown; currency: string };
      expect(res.barcodePatterns).toEqual([{ ...pattern, prefix: 'REF-' }]);
      expect(res.currency).toBe('USD');
    });
  });

  // ---- Komunitas K1 (settings) ----
  // The accreditation group: `GET settings/accreditation` (the existing settings.get) and `PUT settings/accreditation`
  // (settings.accreditation.put, system.settings.manage, audited as settings.update).
  describe('settings/accreditation', () => {
    const DEFAULTS = {
      schoolYearStartMonth: 7,
      fiction: { collectionTypeCodes: ['FIKSI'], callNumberPrefixes: [], ddcPrefixes: [] },
      referenceCollectionTypeCodes: ['REF'],
      electronicMaterialTypeCodes: ['EBOOK'],
      usedUnit: 'titles',
      websiteFeatures: {},
      liveFrom: null,
      evidence: { maxMb: 5, componentLimitMb: 9 },
      textbookCollectionTypeCodes: [],
      k7: { processedThresholdPct: 100 },
      undatedShareMaxPct: 10,
      visits: { dedupeLegacy: true },
      unknownMemberGroup: { default: 'auto' },
    };

    it('GET answers the defaults on an empty table, every key of the group once', async () => {
      const admin = await manager();
      const res = await admin.get(`${SETTINGS_PATH}/accreditation`);
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual(DEFAULTS);
      expect(groupKeys('accreditation')).toHaveLength(16);
      // The visits group has its screen now: it is served too.
      expect((await admin.get(`${SETTINGS_PATH}/visits`)).status).toBe(200);
    });

    it('PUT round-trips (codes upper case), audited as settings.update with the changed keys; a second PUT changes nothing', async () => {
      const admin = await manager();
      const body = {
        schoolYearStartMonth: 1,
        fiction: { collectionTypeCodes: ['fiksi', 'novel'], callNumberPrefixes: ['F'] },
        usedUnit: 'items',
        websiteFeatures: { profilePageId: '01JZ0000000000000000000ABC', socialUrls: ['https://instagram.com/perpus'] },
        liveFrom: '2025-07-01',
        k7: { processedThresholdPct: 95 },
        unknownMemberGroup: { default: null },
      };
      const put = await admin.put(`${SETTINGS_PATH}/accreditation`, body);
      expect(put.status, put.text).toBe(200);
      expect(put.json).toEqual({
        changed: [
          'accreditation.schoolYearStartMonth',
          'accreditation.fiction.collectionTypeCodes',
          'accreditation.fiction.callNumberPrefixes',
          'accreditation.usedUnit',
          'accreditation.websiteFeatures',
          'accreditation.liveFrom',
          'accreditation.k7.processedThresholdPct',
          'accreditation.unknownMemberGroup.default',
        ],
      });
      const view = await admin.get(`${SETTINGS_PATH}/accreditation`);
      expect(view.json).toEqual({
        ...DEFAULTS,
        schoolYearStartMonth: 1,
        fiction: { collectionTypeCodes: ['FIKSI', 'NOVEL'], callNumberPrefixes: ['F'], ddcPrefixes: [] },
        usedUnit: 'items',
        websiteFeatures: body.websiteFeatures,
        liveFrom: '2025-07-01',
        k7: { processedThresholdPct: 95 },
        unknownMemberGroup: { default: null },
      });
      expect(await audits('settings.update')).toEqual([
        { actor_type: 'staff', actor_id: admin.userId, entity: 'settings', entity_id: null, meta: { group: 'accreditation', keys: (put.json as { changed: string[] }).changed } },
      ]);
      const again = await admin.put(`${SETTINGS_PATH}/accreditation`, body);
      expect(again.json).toEqual({ changed: [] });
    });

    it('a threshold under 50 → 422 VALIDATION_FAILED at the body path; an unknown key → 422', async () => {
      const admin = await manager();
      const low = await admin.put(`${SETTINGS_PATH}/accreditation`, { k7: { processedThresholdPct: 40 } });
      expect([low.status, code(low)]).toEqual([422, 'VALIDATION_FAILED']);
      expect(errors(low)).toEqual([{ path: 'k7.processedThresholdPct', code: 'too_small' }]);
      const unknown = await admin.put(`${SETTINGS_PATH}/accreditation`, { dedupeMinutes: 30 });
      expect([unknown.status, code(unknown)]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('needs system.settings.manage: a reader of the settings → 403 AUTHZ_DENIED', async () => {
      const reader = await signedIn({ roles: [{ permissions: ['system.settings.read', 'accreditation.workspace.manage'] }] });
      const res = await reader.put(`${SETTINGS_PATH}/accreditation`, { usedUnit: 'items' });
      expect({ status: res.status, code: code(res) }).toEqual({ status: 403, code: 'AUTHZ_DENIED' });
    });
  });
});
