import { createHash } from 'node:crypto';
import { newId } from '@altis/shared';
import { codeKey } from '../../../catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { readSettings } from '../../../settings/service.js';
import { pipelineOf } from '../pipeline.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import { againOnRace, cachedForRun, cutChars, keyOf, mappedRows, oneLine, scanAll, stateOf, tableOf, textOf, type BatchIo, type Ledger } from './stage-b-kit.js';
import { dateCell, localEpoch, mapped, runPeoplePhases, runTimeZone, timeCell, type PeoplePhase } from './people-kit.js';

// Visits (spec K2: the SLiMS tables `mst_visitor_room` and `visitor_count`). SLiMS 9 table/column names
// (interoperability facts, no SLiMS code).
//
// 1. `mst_visitor_room` → rooms of the target branch (entity `mst_visitor_room`): a room of the same name (case and
//    spaces aside) is taken; otherwise a new one, coded from `unique_code` (empty or taken: from the name).
// 2. `visitor_count` → visits `migrated` (entity `visitor_count`), only those checked in before `visitsBefore` (a date,
//    or `auto`: the first visit ALTIS recorded itself in the branch), so that the weeks both systems ran are counted
//    once (the rest skipped `after_visits_before`). A member through the map (one SLiMS no longer has: no member, group
//    `unknown`); an empty id is a guest (the name and institution as typed); the room through `room_code` (none found:
//    no room, `room_unmatched`); the time as SLiMS kept it, in the library's time zone. A member's check-in within
//    `visits.dedupeMinutes` after an earlier migrated one at the branch is a repeat (`is_repeat`: counted raw, left out
//    of the de-duplicated count). The legacy key is the table's primary key, or, for a table without one, a hash of
//    (member, time, room, which of the identical rows), so that identical rows are neither merged nor doubled by a
//    re-run.

const TR = 'mst_visitor_room';
const TV = 'visitor_count';

/** A name compared without case and runs of spaces. */
function looseName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** An ASCII location code of at most 32 characters. */
function roomCode(s: string): string {
  return cutChars(
    s
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^A-Za-z0-9 _-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase(),
    32,
  ).trim();
}

async function roomsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger): Promise<void> {
  const maps = await mappedRows(c, io.db, TR, rows.map((r) => keyOf(r['room_id'])));
  const rooms = await io.db
    .selectFrom('locations')
    .select(['id', 'name', 'code_key'])
    .where('branch_id', '=', c.options.branchId)
    .where('kind', '=', 'room')
    .where('archived_at', 'is', null)
    .execute();
  const byName = new Map(rooms.map((r) => [looseName(r.name), r.id]));
  const codes = new Set((await io.db.selectFrom('locations').select('code_key').where('branch_id', '=', c.options.branchId).execute()).map((r) => r.code_key));
  const toMap: LegacyMapping[] = [];
  for (const row of rows) {
    const key = keyOf(row['room_id']);
    if (key === '') {
      l.skipped(TR, 'empty_key');
      continue;
    }
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TR, 'already_migrated');
      continue;
    }
    const name = cutChars(oneLine(textOf(l, TR, 'room_name', row['room_name']) ?? ''), 191) || `Ruang ${key}`;
    const found = byName.get(looseName(name));
    if (state === 'replay') {
      // A room this run made (after the run began, by no one) was counted migrated; one it found, merged.
      const target = maps.get(key)!.targetId;
      const made = await io.db.selectFrom('locations').select(['created_at', 'created_by']).where('id', '=', target).executeTakeFirst();
      if (made !== undefined && made.created_by === null && Number(made.created_at) >= Number(pipelineOf(c).run.created_at)) l.migrated(TR);
      else l.merged(TR);
      continue;
    }
    if (found !== undefined) {
      l.merged(TR);
      l.report(TR, key, 'room_matched', name);
      toMap.push({ source: c.options.sourceName, entity: TR, legacyKey: key, targetId: found, runId: c.runId });
      continue;
    }
    let code = roomCode(keyOf(row['unique_code']));
    if (code === '' || codes.has(codeKey(code))) code = roomCode(name);
    if (code === '' || codes.has(codeKey(code))) code = cutChars(`R-${key}`, 32);
    if (codes.has(codeKey(code))) code = cutChars(`R-${key}-${newId(c.now).slice(-4)}`, 32);
    codes.add(codeKey(code));
    l.migrated(TR);
    l.report(TR, key, 'room_created', `${code}: ${name}`);
    if (io.trx === null) continue;
    const id = newId(c.now);
    byName.set(looseName(name), id);
    await againOnRace(() =>
      io.trx!
        .insertInto('locations')
        .values({
          id,
          branch_id: c.options.branchId,
          parent_id: null,
          kind: 'room',
          code_display: code,
          code_key: codeKey(code),
          name,
          shelf_hint: null,
          class_from: null,
          class_to: null,
          map_file_id: null,
          map_x: null,
          map_y: null,
          map_w: null,
          map_h: null,
          is_public: 1,
          sort_order: 0,
          archived_at: null,
          version: 0,
          created_at: c.now,
          created_by: null,
          updated_at: c.now,
          updated_by: null,
        })
        .execute(),
    );
    toMap.push({ source: c.options.sourceName, entity: TR, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

/** `unique_code` → room id of the source (cached for the run). */
function roomIdsByCode(c: SlimsStageContext): Promise<ReadonlyMap<string, string>> {
  return cachedForRun(c, 'visits:rooms', async () => {
    const out = new Map<string, string>();
    await scanAll(c, TR, (row) => {
      const code = keyOf(row['unique_code']);
      if (code !== '' && !out.has(code)) out.set(code, keyOf(row['room_id']));
    });
    return out;
  });
}

/** The first day `visitsBefore` lets through no more (null: every visit), resolved once per run in a process. */
export function visitsCutoff(c: SlimsStageContext): Promise<string | null> {
  return cachedForRun(c, 'visits:cutoff', async () => {
    const v = c.options.people.visitsBefore;
    if (v !== 'auto') return v;
    const row = await c.h.db
      .selectFrom('visits')
      .select((eb) => eb.fn.min('visited_on').as('first'))
      .where('branch_id', '=', c.options.branchId)
      .where('source', '<>', 'migrated')
      .executeTakeFirst();
    return row?.first === undefined || row.first === null ? null : String(row.first);
  });
}

/** The (member, time, room) of a visit row, trimmed: the identity of identical rows. */
function tupleOf(row: SlimsRow): string {
  return [keyOf(row['member_id']), keyOf(row['checkin_date']), keyOf(row['room_code'])].join('\u0000');
}

/** Per row position of the source, which of the identical rows it is (for a table without a primary key). */
function occurrences(c: SlimsStageContext): Promise<readonly number[]> {
  return cachedForRun(c, 'visits:occurrences', async () => {
    const seen = new Map<string, number>();
    const out: number[] = [];
    await scanAll(c, TV, (row) => {
      const t = tupleOf(row);
      const n = (seen.get(t) ?? 0) + 1;
      seen.set(t, n);
      out.push(n);
    });
    return out;
  });
}

/** The legacy key of a visit row at `position`: its primary key, or a hash of its identity and occurrence. */
async function visitKey(c: SlimsStageContext, row: SlimsRow, position: number): Promise<string> {
  const info = await tableOf(c, TV);
  const pk = info?.primaryKey ?? [];
  if (pk.length > 0) {
    const parts = pk.map((k) => keyOf(row[k]));
    if (parts.every((p) => p !== '')) return cutChars(parts.join('|'), 191);
  }
  const occ = (await occurrences(c))[position] ?? 1;
  return createHash('sha256').update(`${tupleOf(row)}\u0000${occ}`, 'utf8').digest('hex').slice(0, 32);
}

/** The source's member ids (cached for the run). */
function sourceMembers(c: SlimsStageContext): Promise<ReadonlySet<string>> {
  return cachedForRun(c, 'visits:members', async () => {
    const out = new Set<string>();
    await scanAll(c, 'member', (row) => {
      const k = keyOf(row['member_id']);
      if (k !== '') out.add(k);
    });
    return out;
  });
}

async function visitsBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, at: { n: number }): Promise<void> {
  const tz = await runTimeZone(c);
  const cutoff = await visitsCutoff(c);
  const keys: string[] = [];
  for (let i = 0; i < rows.length; i += 1) keys.push(await visitKey(c, rows[i]!, at.n + i));
  const maps = await mappedRows(c, io.db, TV, keys);
  const memberIds = await mapped(c, io.db, 'member', rows.map((r) => keyOf(r['member_id'])));
  const rooms = await roomIdsByCode(c);
  const locations = await mapped(c, io.db, TR, [...new Set(rows.map((r) => rooms.get(keyOf(r['room_code'])) ?? ''))]);
  const members = new Map<string, { type: string; group: string | null; className: string | null }>();
  const ids = [...new Set(memberIds.values())];
  for (let i = 0; i < ids.length; i += 500) {
    for (const m of await io.db
      .selectFrom('members as m')
      .leftJoin('member_types as t', 't.id', 'm.member_type_id')
      .select(['m.id', 'm.member_type_id', 'm.class_name', 't.accred_group'])
      .where('m.id', 'in', ids.slice(i, i + 500))
      .execute()) {
      members.set(m.id, { type: m.member_type_id, group: m.accred_group ?? null, className: m.class_name });
    }
  }
  const window = Number((await readSettings(io.db, ['visits.dedupeMinutes'], []))['visits.dedupeMinutes']) * 60_000;
  // The migrated visits of the batch's members at the branch: the earlier check-ins a repeat looks back to.
  const plan = rows.map((row) => {
    const date = dateCell(row['checkin_date']);
    return { row, date, at: date === null ? null : localEpoch(tz, date, timeCell(row['checkin_date'])) };
  });
  const times = plan.flatMap((p) => (p.at === null ? [] : [p.at]));
  const earlier = new Map<string, number[]>();
  if (window > 0 && ids.length > 0 && times.length > 0) {
    for (let i = 0; i < ids.length; i += 500) {
      for (const v of await io.db
        .selectFrom('visits')
        .select(['member_id', 'visited_at'])
        .where('member_id', 'in', ids.slice(i, i + 500))
        .where('branch_id', '=', c.options.branchId)
        .where('source', '=', 'migrated')
        .where('visited_at', '>=', Math.min(...times) - window)
        .where('visited_at', '<=', Math.max(...times))
        .execute()) {
        earlier.set(v.member_id!, [...(earlier.get(v.member_id!) ?? []), Number(v.visited_at)]);
      }
    }
  }
  const known = io.trx === null ? await sourceMembers(c) : new Set<string>();
  const toMap: LegacyMapping[] = [];
  for (let i = 0; i < plan.length; i += 1) {
    const { row, date, at: t } = plan[i]!;
    const key = keys[i]!;
    const state = stateOf(c, maps.get(key));
    if (state === 'done') {
      l.skipped(TV, 'already_migrated');
      continue;
    }
    if (state === 'replay') {
      l.migrated(TV);
      continue;
    }
    if (date === null || t === null) {
      l.skipped(TV, 'invalid_date');
      l.report(TV, key, 'invalid_date', keyOf(row['checkin_date']) || '-');
      continue;
    }
    if (cutoff !== null && date >= cutoff) {
      l.skipped(TV, 'after_visits_before');
      continue;
    }
    const slimsMember = keyOf(row['member_id']);
    const memberId = slimsMember === '' ? null : (memberIds.get(slimsMember) ?? null);
    const member = memberId === null ? undefined : members.get(memberId);
    const roomKey = keyOf(row['room_code']);
    const locationId = roomKey === '' ? null : (locations.get(rooms.get(roomKey) ?? '') ?? null);
    if (roomKey !== '' && locationId === null && !(io.trx === null && rooms.has(roomKey))) l.report(TV, key, 'room_unmatched', cutChars(roomKey, 40));
    let repeat = 0;
    if (memberId !== null && window > 0) {
      const before = earlier.get(memberId) ?? [];
      if (before.some((b) => b > t - window && b <= t)) repeat = 1;
      earlier.set(memberId, [...before, t]);
    }
    l.migrated(TV);
    if (io.trx === null) {
      if (slimsMember !== '' && !known.has(slimsMember)) l.report(TV, key, 'member_missing', slimsMember);
      continue;
    }
    if (slimsMember !== '' && memberId === null) l.report(TV, key, 'member_missing', slimsMember);
    const guest = slimsMember === '';
    const id = newId(c.now);
    await io.trx
      .insertInto('visits')
      .values({
        id,
        branch_id: c.options.branchId,
        location_id: locationId,
        visited_on: date,
        visited_at: t,
        source: 'migrated',
        member_id: memberId,
        member_type_id: member?.type ?? null,
        accred_group: guest ? 'guest' : memberId === null ? 'unknown' : (member?.group ?? null),
        class_name: member?.className ?? null,
        guest_name: guest ? cutChars(oneLine(textOf(l, TV, 'member_name', row['member_name']) ?? ''), 191) || null : null,
        guest_institution: guest ? cutChars(oneLine(textOf(l, TV, 'institution', row['institution']) ?? ''), 191) || null : null,
        purpose: null,
        headcount: 1,
        is_repeat: repeat,
        station_id: null,
        day_key: null,
        note: null,
        voided_at: null,
        voided_by: null,
        created_by: null,
      })
      .execute();
    toMap.push({ source: c.options.sourceName, entity: TV, legacyKey: key, targetId: id, runId: c.runId });
  }
  if (io.trx !== null) await mapLegacy(io.trx, toMap);
}

const PHASES: readonly PeoplePhase[] = Object.freeze([
  { table: TR, run: (c, rows, io, l) => roomsBatch(c, rows, io, l) },
  { table: TV, run: (c, rows, io, l, at) => visitsBatch(c, rows, io, l, at) },
] satisfies PeoplePhase[]);

/** The visits stage (see the top of this file). */
export const visitsStage: SlimsStage = Object.freeze({
  name: 'visits' as const,
  reads: Object.freeze([TR, TV]) as readonly string[],
  run: (c: SlimsStageContext, cursor: string | null) => runPeoplePhases(c, 'visits', PHASES, cursor, (x) => visitsCutoff(x)),
});
