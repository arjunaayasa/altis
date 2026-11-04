import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { ensureSystemRoles } from '../src/authz/system-roles.js';
import { createExporter, type ExportCheckpoint } from '../src/backup/exporter.js';
import { SCHEDULES } from '../src/scheduler/registry.js';
import { seedSchedules } from '../src/scheduler/tick.js';
import { writeSettings } from '../src/settings/service.js';

// Writes test/fixtures/sqlite-archive/<variant>/ (manifest.json and tables/<t>/<nnnnn>.jsonl.gz): backups exported from
// a SQLite database of another installation (its own install id and session key, so a restore sees no valid HMAC and
// needs `confirmed: true`, M7), for the restore pre-pass tests (Review Focus 4, preflight S5). SQLite enforces neither
// lengths nor integer ranges, and its keys are not PAD SPACE, so it holds rows that MySQL/MariaDB or PostgreSQL refuse:
//
//   pad-space  branches with code_key 'X', 'X ' and 'X\t': one key on MySQL/MariaDB ('X' and 'X '; a tab stays
//              significant, S5a), three keys elsewhere
//   conflicts  user_roles (u, r, 'B') and (u, r, 'B ') (a composite UNIQUE, S5b); a branches.name of 192 code points;
//              a branches.address holding U+0000; an audit_log.meta of 70 000 bytes; staff_users.authz_version 2^31
//
// Run it from the repository root and commit the output:
//
//   node --import tsx packages/core/scripts/gen-restore-fixtures.ts

const OUTPUT = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'sqlite-archive');
const NOW = 1_790_000_000_000;
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;

/** The fixed ids of the fixtures (the folder of a backup is named after its id). */
export const FIXTURE_IDS = {
  'pad-space': '01K5Q8M2X0PADSPACE00000000',
  conflicts: '01K5Q8M2X0C0NF11CTS0000000',
} as const;
/** The installation the fixtures come from. */
const SOURCE_INSTALL_ID = '01K5Q8M2X0S0VRCE0000000000';

type Variant = keyof typeof FIXTURE_IDS;

function branch(id: string, code: string, name: string, address: string | null) {
  return {
    id,
    code_key: code,
    code_display: code,
    name,
    address,
    timezone: 'Asia/Jakarta',
    is_default: 0,
    archived_at: null,
    version: 1,
    created_at: NOW,
    created_by: null,
    updated_at: NOW,
    updated_by: null,
  };
}

async function generate(variant: Variant): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-restore-fixture-'));
  const h = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'cli', dataDir });
  try {
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    const userId = newId(NOW);
    await withTx(h, async (trx) => {
      await ensureSystemRoles(trx, NOW);
      await seedSchedules(trx, NOW, 'Asia/Jakarta', SCHEDULES);
      await writeSettings(trx, { 'library.name': 'Perpustakaan Sumber' }, { keyring: [], now: NOW, actorId: null });
      await trx
        .insertInto('staff_users')
        .values({
          id: userId,
          username_key: 'pustakawan',
          username_display: 'pustakawan',
          name: 'Pustakawan',
          password_hash: 'x',
          status: 'active',
          authz_version: variant === 'conflicts' ? 2 ** 31 : 1,
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      if (variant === 'pad-space') {
        for (const code of ['X', 'X ', 'X\t']) await trx.insertInto('branches').values(branch(newId(NOW), code, `Cabang ${JSON.stringify(code)}`, null)).execute();
        return;
      }
      await trx.insertInto('branches').values(branch(newId(NOW), 'PANJANG', 'n'.repeat(192), null)).execute();
      await trx.insertInto('branches').values(branch(newId(NOW), 'NUL', 'Cabang NUL', 'Jalan\u0000Satu')).execute();
      const role = await trx.selectFrom('roles').select('id').where('key', '=', 'admin').executeTakeFirstOrThrow();
      for (const scope of ['B', 'B ']) {
        await trx
          .insertInto('user_roles')
          .values({ id: newId(NOW), user_id: userId, role_id: role.id, branch_id: null, scope_key: scope, created_at: NOW, created_by: null })
          .execute();
      }
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(NOW),
          seq: 1,
          at: NOW,
          actor_type: 'system',
          actor_id: null,
          action: 'audit.purge',
          entity: null,
          entity_id: null,
          branch_id: null,
          ip: null,
          meta: JSON.stringify({ blob: 'm'.repeat(70_000) }),
          prev_hash: '0'.repeat(64),
          hash: '1'.repeat(64),
        })
        .execute();
    });

    const backupId = FIXTURE_IDS[variant];
    const exporter = createExporter({
      read: h.db,
      dialect: 'sqlite',
      dataDir,
      backupId,
      kind: 'manual',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      installId: SOURCE_INSTALL_ID,
      sessionKey: new Uint8Array(32).fill(0x5a),
      kids: ['sumber'],
      auditHead: variant === 'conflicts' ? { seq: 1, hash: '1'.repeat(64) } : { seq: 0, hash: '0'.repeat(64) },
      clock: () => NOW,
    });
    let cp: ExportCheckpoint | null = null;
    for (;;) {
      const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
      cp = r.checkpoint;
      if (r.done) break;
    }
    const out = path.join(OUTPUT, variant);
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(path.join(dataDir, 'backups', backupId), out, { recursive: true });
    process.stdout.write(`${path.relative(process.cwd(), out)}: backup ${backupId}\n`);
  } finally {
    await h.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

for (const variant of Object.keys(FIXTURE_IDS) as Variant[]) await generate(variant);
