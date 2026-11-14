import { newId, normalizeKey } from '@altis/shared';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import { againOnRace, cachedForRun, cutChars, keyOf, mappedRows, oneLine, scanAll, stateOf, tableOf, textOf, type BatchIo, type Ledger } from './stage-b-kit.js';
import { flagCell, runPeoplePhases, type PeoplePhase } from './people-kit.js';

// Staff (spec K2: the SLiMS tables `user`, `user_group`, `group_access`, `mst_module`, `system_log`). SLiMS 9
// table/column names (interoperability facts, no SLiMS code).
//
// - `user` → staff accounts (entity `user`), so that a migrated loan names who lent it: `username` → the user name (a
//   name ALTIS has already → `-2`, `-3`… and `username_taken`), `realname` → the name; every account `disabled`,
//   without roles, with a password that matches nothing and a forced change: an admin enables the desk staff and sets
//   their passwords before serving (the cut-over checklist). With `staffUsers` off, skipped `staff_users_off`.
// - `user_group`, `group_access`, `mst_module`: not mapped; each group is reported with the modules it may read or
//   write (`role_access`), so that the admin can make the roles again.
// - `system_log`: not migrated (`log_not_migrated`), counted.

const TU = 'user';
/** A password hash no password ever matches (not a PHC string, not a bcrypt hash). */
export const UNUSABLE_PASSWORD = '!slims-migrated-disabled';

async function usersBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  if (!c.options.people.staffUsers) {
    l.skipped(TU, 'staff_users_off', rows.length);
    return;
  }
  const maps = await mappedRows(c, io.db, TU, rows.map((r) => keyOf(r['user_id'])));
  const toMap: LegacyMapping[] = [];
  const planned = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row['user_id']);
    if (key === '') {
      l.skipped(TU, 'empty_key');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TU, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TU);
      continue;
    }
    const username = cutChars(oneLine(textOf(l, TU, 'username', row['username']) ?? ''), 60) || `slims-${key}`;
    const name = cutChars(oneLine(textOf(l, TU, 'realname', row['realname']) ?? ''), 191) || username;
    l.migrated(TU);
    if (io.trx === null) continue;
    let display = username;
    for (let n = 2; ; n += 1) {
      const k = normalizeKey(display);
      const taken = planned.has(k) || (await io.db.selectFrom('staff_users').select('id').where('username_key', '=', k).executeTakeFirst()) !== undefined;
      if (!taken) break;
      display = `${username}-${n}`;
    }
    if (display !== username) l.report(TU, key, 'username_taken', display);
    planned.add(normalizeKey(display));
    const id = newId(c.now);
    await againOnRace(() =>
      io.trx!
        .insertInto('staff_users')
        .values({
          id,
          username_key: normalizeKey(display),
          username_display: display,
          name,
          email_key: null,
          email_display: null,
          password_hash: UNUSABLE_PASSWORD,
          status: 'disabled',
          locale: null,
          must_change_password: 1,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        })
        .execute(),
    );
    toMap.push({ source: c.options.sourceName, entity: TU, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

/** Group id → name, and module id → name, of the source (cached for the run). */
function groupNames(c: SlimsStageContext): Promise<{ groups: Map<string, string>; modules: Map<string, string> }> {
  return cachedForRun(c, 'staff:names', async () => {
    const groups = new Map<string, string>();
    const modules = new Map<string, string>();
    await scanAll(c, 'user_group', (row) => groups.set(keyOf(row['group_id']), cutChars(oneLine(keyOf(row['group_name'])), 80)));
    await scanAll(c, 'mst_module', (row) => modules.set(keyOf(row['module_id']), cutChars(oneLine(keyOf(row['module_name']) || keyOf(row['module_path'])), 80)));
    return { groups, modules };
  });
}

async function groupsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], _io: BatchIo, l: Ledger): Promise<void> {
  for (const row of rows) l.report('user_group', keyOf(row['group_id']) || null, 'role_group', cutChars(oneLine(keyOf(row['group_name'])), 80));
  l.skipped('user_group', 'roles_reported', rows.length);
}

async function accessBatch(c: SlimsStageContext, rows: readonly SlimsRow[], _io: BatchIo, l: Ledger): Promise<void> {
  const { groups, modules } = await groupNames(c);
  for (const row of rows) {
    const g = keyOf(row['group_id']);
    const m = keyOf(row['module_id']);
    const rights = [flagCell(row['r']) === true ? 'r' : '', flagCell(row['w']) === true ? 'w' : ''].join('') || '-';
    l.report('group_access', g || null, 'role_access', `${groups.get(g) ?? g}: ${modules.get(m) ?? m} (${rights})`);
  }
  l.skipped('group_access', 'roles_reported', rows.length);
}

const PHASES: readonly PeoplePhase[] = Object.freeze([
  { table: TU, run: (c, rows, io, l) => usersBatch(c, rows, io, l) },
  { table: 'user_group', run: (c, rows, io, l) => groupsBatch(c, rows, io, l) },
  { table: 'group_access', run: (c, rows, io, l) => accessBatch(c, rows, io, l) },
  { table: 'mst_module', run: async (_c, rows, _io, l) => l.skipped('mst_module', 'roles_reported', rows.length) },
  // Never staged nor read row by row (it can be very long): its rows as the source lists them.
  { table: null, run: async (c, _rows, _io, l) => l.skipped('system_log', 'log_not_migrated', (await tableOf(c, 'system_log'))?.rows ?? 0) },
] satisfies PeoplePhase[]);

/** The staff stage (see the top of this file). */
export const staffStage: SlimsStage = Object.freeze({
  name: 'staff' as const,
  reads: Object.freeze([TU, 'user_group', 'group_access', 'mst_module', 'system_log']) as readonly string[],
  run: (c: SlimsStageContext, cursor: string | null) => runPeoplePhases(c, 'staff', PHASES, cursor),
});
