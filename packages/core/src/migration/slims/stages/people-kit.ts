import { createHmac } from 'node:crypto';
import type { DB } from '@altis/db';
import { isCalendarDate } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { readSettings } from '../../../settings/service.js';
import { cleanText } from '../source/clean-text.js';
import { phpUnserialize } from '../source/php-unserialize.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStageContext } from '../stage.js';
import {
  Ledger,
  cachedForRun,
  endOfStage,
  inBatch,
  keyOf,
  nextPhase,
  quietText,
  readCursor,
  scanAll,
  sourceCursor,
  stageBBatch,
  tableOf,
  writeCursor,
  type BatchIo,
  type StageCursor,
} from './stage-b-kit.js';

// What the member, staff, visit and circulation stages of the SLiMS migration share: a runner of phases over source
// tables (one batch of 500 rows per transaction, the cursor of stage-b-kit so a slice that stops after any batch, in
// any process, goes on where it stopped), and the small readers of SLiMS cells (dates, flags, PHP-serialized settings),
// the member keys a run needs again and again, and the subject key of an archived row.
// SLiMS 9 table/column names (interoperability facts, no SLiMS code).
//
// Re-runs and restarts follow stage-b-kit: every source row a phase writes has a legacy map row (or an archive row)
// with the run's id, written in the same transaction; a row an earlier run mapped is `already_migrated` (or re-synced,
// where a mode says so), and one this very run mapped is a replay of a batch whose counts were lost with its slice: it
// is counted again as it was the first time, and nothing is written twice.

type Db = Kysely<DB> | Transaction<DB>;

/** One phase of a stage: a source table read batch by batch, or (`table: null`) one unit of work done once. */
export interface PeoplePhase {
  /** The source table, or null for a phase that runs once (settings, a summary, a clean-up). */
  table: string | null;
  /**
   * Work on the batch outside any transaction, before it (a photo stored); its answer reaches `run` as `pre`, and
   * `undo` is called with it when the batch's transaction failed.
   */
  before?(c: SlimsStageContext, rows: readonly SlimsRow[]): Promise<unknown>;
  undo?(c: SlimsStageContext, pre: unknown): Promise<void>;
  run(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, at: StageCursor, pre: unknown): Promise<void>;
}

/**
 * Runs `phases` of stage `stage` from `cursor`: one batch (or one once-phase) at least per call, then more while the
 * slice's budget lasts. A table the source does not have is passed over.
 */
export async function runPeoplePhases(
  c: SlimsStageContext,
  stage: string,
  phases: readonly PeoplePhase[],
  cursor: string | null,
  warm?: (c: SlimsStageContext) => Promise<unknown>,
): Promise<{ done: boolean; cursor: string | null }> {
  // The values a batch reads of ALTIS once per run are read here, outside any transaction (on SQLite a read through
  // the pool while the batch's transaction holds the one connection would wait for ever).
  await runTimeZone(c);
  await installKey(c);
  await warm?.(c);
  let at = readCursor(stage, cursor);
  let units = 0;
  while (at.p < phases.length) {
    if (units > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
    const phase = phases[at.p]!;
    if (phase.table === null) {
      const { ledger } = await inBatch(c, at, (io, l) => phase.run(c, [], io, l, at, undefined));
      ledger.apply(c);
      at = { ...nextPhase(at), ...ledger.state() };
      units += 1;
      continue;
    }
    if ((await tableOf(c, phase.table)) === null) {
      at = nextPhase(at);
      continue;
    }
    const batch = await c.source.rows(phase.table, at.c, stageBBatch());
    const here = at;
    const pre = phase.before === undefined ? undefined : await phase.before(c, batch.rows);
    let ledger: Ledger;
    try {
      ({ ledger } = await inBatch(c, here, (io, l) => phase.run(c, batch.rows, io, l, here, pre)));
    } catch (error) {
      if (phase.undo !== undefined) await phase.undo(c, pre).catch(() => undefined);
      throw error;
    }
    ledger.apply(c);
    units += 1;
    const next = sourceCursor(stage, batch.next);
    const st = ledger.state();
    at = batch.rows.length === 0 || next === null ? { ...nextPhase(at), ...st } : { ...at, c: next, n: at.n + batch.rows.length, ...st };
    if (units % 4 === 0) await c.heartbeat(0, stage);
  }
  return endOfStage(c, stage, at);
}

// ---------------------------------------------------------------------------------------------------------------
// Cells

/**
 * A cell of personal data as clean text (stage-b-kit's textOf), its repairs counted under `<table>.<column>` with the
 * values masked: a run's report and summary never show a person's name, address or note.
 */
export function personalText(l: Ledger, table: string, column: string, v: SlimsRow[string] | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(v);
  const { value, fixes } = cleanText(v);
  if (fixes.length > 0) l.fixed(`${table}.${column}`, fixes, '***', '***');
  return value;
}

/** A SLiMS integer cell (digits, a number), or null. */
export function intCell(v: SlimsRow[string] | undefined): number | null {
  const s = keyOf(v);
  if (!/^[+-]?\d{1,15}(\.0+)?$/.test(s)) return null;
  return Math.trunc(Number(s));
}

/** A SLiMS decimal cell as a number (`12500.00`, `12500`), or null. */
export function decimalCell(v: SlimsRow[string] | undefined): number | null {
  const s = keyOf(v);
  if (!/^[+-]?\d{1,15}(\.\d{1,6})?$/.test(s)) return null;
  return Number(s);
}

/** A SLiMS flag (`1`, `0`, `Y`, `N`): true, false, or null when it is neither. */
export function flagCell(v: SlimsRow[string] | undefined): boolean | null {
  const s = keyOf(v).toLowerCase();
  if (s === '1' || s === 'y' || s === 'yes' || s === 'true') return true;
  if (s === '0' || s === 'n' || s === 'no' || s === 'false' || s === '') return false;
  return null;
}

/**
 * The calendar date of a SLiMS DATE or DATETIME cell (`YYYY-MM-DD`), or null for NULL, a zero date (`0000-00-00`), a
 * date that does not exist, and, with `placeholder`, `1970-01-01` (SLiMS fills it in for an unknown date).
 */
export function dateCell(v: SlimsRow[string] | undefined, o: { placeholder?: boolean } = {}): string | null {
  const s = keyOf(v).slice(0, 10);
  if (!isCalendarDate(s)) return null;
  if (s < '1900-01-01') return null;
  if (o.placeholder === true && s === '1970-01-01') return null;
  return s;
}

/** The local time `HH:MM:SS` of a SLiMS DATETIME cell, or `00:00:00`. */
export function timeCell(v: SlimsRow[string] | undefined): string {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(keyOf(v));
  if (m === null) return '00:00:00';
  const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
  return h > 23 || mi > 59 || se > 59 ? '00:00:00' : `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of instant `t` in `timeZone`, written as if it were UTC. */
function wallClock(t: number, timeZone: string): number {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(t)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']! % 24, p['minute']!, p['second']!);
}

/** The instant of the local date and time `date` `time` in `timeZone` (SLiMS keeps the server's local time). */
export function localEpoch(timeZone: string, date: string, time = '00:00:00'): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, s] = time.split(':').map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - (wallClock(wall, timeZone) - wall);
  t = wall - (wallClock(t, timeZone) - t);
  return t;
}

/** A setting value as SLiMS stores it (PHP-serialized, or plain): its scalar, or null. */
export function settingScalar(raw: string): string | number | boolean | null {
  const parsed = phpUnserialize(raw);
  if (parsed.ok) {
    const v = parsed.value;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    return null;
  }
  const t = raw.trim();
  return t === '' ? null : t;
}

/** A setting's scalar as a flag (true for 1, `1`, true), or null when it says neither. */
export function settingFlag(v: string | number | boolean | null): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return null;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'y') return true;
  if (s === '0' || s === 'false' || s === 'n' || s === '') return false;
  return null;
}

/** The source's `setting` rows by name (cached for the run; the masters stage counts them, this only reads). */
export function slimsSettings(c: SlimsStageContext): Promise<ReadonlyMap<string, string>> {
  return cachedForRun(c, 'people:settings', async () => {
    const out = new Map<string, string>();
    await scanAll(c, 'setting', (row) => {
      const name = keyOf(row['setting_name']).toLowerCase();
      if (name !== '') out.set(name, quietText(row['setting_value']));
    });
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Keys a run needs again and again

/** The library's time zone (read once per run in a process). */
export function runTimeZone(c: SlimsStageContext): Promise<string> {
  return cachedForRun(c, 'people:tz', async () => {
    const branch = await c.h.db.selectFrom('branches').select('timezone').where('id', '=', c.options.branchId).executeTakeFirst();
    if (branch?.timezone !== undefined && branch.timezone !== null && branch.timezone !== '') return branch.timezone;
    return (await readSettings(c.h.db, ['library.timezone'], []))['library.timezone'] as string;
  });
}

/** The source's `item` rows: item code (trimmed, as stored) → item id (cached for the run). */
export function sourceItemIds(c: SlimsStageContext): Promise<ReadonlyMap<string, string>> {
  return cachedForRun(c, 'people:item-codes', async () => {
    const out = new Map<string, string>();
    await scanAll(c, 'item', (row) => {
      const code = keyOf(row['item_code']);
      const id = keyOf(row['item_id']);
      if (code !== '' && id !== '' && !out.has(code)) out.set(code, id);
    });
    return out;
  });
}

/** The ALTIS items of SLiMS item codes `codes`, through the source's `item` and the legacy map (code → item id). */
export async function altisItemsOf(c: SlimsStageContext, db: Db, codes: readonly string[]): Promise<Map<string, string>> {
  const ids = await sourceItemIds(c);
  const byLegacy = new Map<string, string[]>();
  for (const code of new Set(codes)) {
    const legacy = ids.get(code);
    if (legacy === undefined) continue;
    byLegacy.set(legacy, [...(byLegacy.get(legacy) ?? []), code]);
  }
  const out = new Map<string, string>();
  const keys = [...byLegacy.keys()];
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await db
      .selectFrom('migration_map')
      .select(['legacy_key', 'target_id'])
      .where('source', '=', c.options.sourceName)
      .where('entity', '=', 'item')
      .where('legacy_key', 'in', keys.slice(i, i + 500))
      .execute();
    for (const r of rows) for (const code of byLegacy.get(r.legacy_key) ?? []) out.set(code, r.target_id);
  }
  return out;
}

/** The targets of legacy keys `keys` of `entity` under the run's source name (keys trimmed, blanks dropped). */
export async function mapped(c: SlimsStageContext, db: Db, entity: string, keys: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(keys.filter((k) => k !== '' && k.trim() === k && Array.from(k).length <= 191))];
  const out = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 500) {
    const rows = await db
      .selectFrom('migration_map')
      .select(['legacy_key', 'target_id'])
      .where('source', '=', c.options.sourceName)
      .where('entity', '=', entity)
      .where('legacy_key', 'in', wanted.slice(i, i + 500))
      .execute();
    for (const r of rows) out.set(r.legacy_key, r.target_id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The subject of an archived row

/** The installation's id (`schema_meta.install_id`), the key of a subject hash (read once per run in a process). */
function installKey(c: SlimsStageContext): Promise<string> {
  return cachedForRun(c, 'people:install', async () => {
    const meta = await c.h.db.selectFrom('schema_meta').select('install_id').where('id', '=', 1).executeTakeFirst();
    return meta?.install_id ?? 'altis';
  });
}

/** The subject key of a row about the ALTIS member `memberId` (anonymising that member removes the row by it). */
export function memberSubjectKey(install: string, memberId: string): string {
  return createHmac('sha256', install).update(`migration-subject:member:${memberId}`, 'utf8').digest('hex');
}

/**
 * The subject key of an archived row about the SLiMS member `slimsMemberId`: the ALTIS member's when the run mapped
 * one, else a key of the source's own id (a member who never came to ALTIS); null for a row about no one.
 */
export async function subjectKeyOf(c: SlimsStageContext, slimsMemberId: string, altisMemberId: string | null): Promise<string | null> {
  if (slimsMemberId === '' && altisMemberId === null) return null;
  const install = await installKey(c);
  if (altisMemberId !== null) return memberSubjectKey(install, altisMemberId);
  return createHmac('sha256', install).update(`migration-subject:${c.options.sourceName}:${slimsMemberId}`, 'utf8').digest('hex');
}

/** The subject key of the ALTIS member `memberId` in `db` (for the anonymisation step). */
export async function memberSubjectKeyIn(db: Db, memberId: string): Promise<string> {
  const meta = await db.selectFrom('schema_meta').select('install_id').where('id', '=', 1).executeTakeFirst();
  return memberSubjectKey(meta?.install_id ?? 'altis', memberId);
}

/** A whole SLiMS row as archive JSON: bytes as text, at most 60 000 bytes of JSON (cut values marked). */
export function archiveJson(row: SlimsRow): string {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null || v === undefined ? null : typeof v === 'number' ? v : quietText(v);
  let json = JSON.stringify(out);
  if (Buffer.byteLength(json, 'utf8') <= 60_000) return json;
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === 'string' && v.length > 1000) out[k] = `${v.slice(0, 1000)}…`;
  }
  json = JSON.stringify(out);
  return Buffer.byteLength(json, 'utf8') <= 60_000 ? json : JSON.stringify({ truncated: true });
}
